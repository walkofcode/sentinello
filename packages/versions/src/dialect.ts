import { validRange } from 'semver'
import { compareVersions } from './compare'
import { isZeroVersion, type VersionRange } from './range'

// The dialect layer: what a range STRING means, and what a parsed interval may never be.
//
// Every advisory source states its ranges in some registry's syntax, and each source's normalizer used to
// interpret that syntax itself. That is how four range defects shipped in a row — a `>` read as `>=`, a
// `<=` read as `<`, a PEP 440 comma making one token of `>=5.0,<5.8`, and a SPACE between an operator and
// its version turning npm/fresh's `< 0.5.2` into a pin on the version that FIXED it. Each was a local
// decision about version syntax, made in a file whose job is reading YAML or JSON.
//
// The split this module exists to enforce: PARSING A SOURCE'S SHAPE is per-source and has to be — gemnasium
// states a range as a string, OSV as an ordered event list, npm-audit as already-resolved JSON, and no one
// function reads all three. DECIDING WHAT A VERSION BOUND MEANS is not per-source, and every one of those
// four defects came from treating it as though it were.

// Rewrites a range into the canonical form its registry defines, so the parser downstream never has to
// know the syntax — only the shape.
//
// For npm that registry is node-semver, and this is a delegation rather than a reimplementation: gemnasium's
// own field reference calls `affected_range` "machine-readable syntax used by the package manager", so
// node-semver is the specification and `validRange` is it, executable. It collapses the whole edge-case
// surface in one call — whitespace (`< 0.5.2` → `<0.5.2`), partial versions (`<=3.3` → `<3.4.0`, `=103` →
// `>=103.0.0 <104.0.0`), `v` prefixes, and the caret, tilde, x-range and hyphen forms the parser refuses
// outright. Measured across all 4,696 distinct npm ranges gemnasium publishes: parsing the raw string
// disagrees with npm on 9 of them, parsing the canonical form disagrees on none.
//
// EVERY OTHER DIALECT IS LEFT ALONE, and that is the point of the parameter rather than an omission. PEP
// 440's `==1.0` is an exact pin — only `==1.0.*` is a wildcard — so npm's reading applied to a PyPI record
// would invent findings that record never claimed. Go and crates.io share the semver COMPARATOR (see
// packages/scanners/src/engine/comparators/index.ts) but are not node-semver range DIALECTS, so keying this
// off the comparator instead of the ecosystem would over-apply npm's rule to two of them.
export function canonicaliseRange(raw: string, dialect: string): string {
    if (dialect !== 'npm') return raw
    const trimmed = raw.trim()
    // A RANGE THAT NAMES NO VERSION IS NOT A RANGE. node-semver reads `''`, `*`, `x` and `||` all as "any
    // version", because that is what an unconstrained dependency spec means when npm installs a package.
    // Here the input is an advisory's `affected_range`, where the same strings are indistinguishable from a
    // missing or malformed field — and the two readings differ by the entire package. Taking npm's would
    // turn every record with an empty range into "every version vulnerable, forever, with no fix", which is
    // the exact defect class this module exists to end. Requiring a digit is the whole test: a record that
    // means "everything" still has `>=0` to say it with, and that is what the corpus actually uses.
    if (!/[0-9]/.test(trimmed)) return raw
    // A zero exclusive lower bound is gemnasium's idiom for "every version", and npm reads it as `>=1.0.0`
    // — which would clear all of 0.x. npm/pandora-doomsday CVE-2017-16127 is the record that matters:
    // `affected_range: ">0"`, `affected_versions: "All Versions"`, `solution: "Omit this package."`, a
    // malicious package unpublished from the registry. Canonicalising it would report 0.x of that as clean.
    // Deliberately kept as the one place we depart from node-semver, rather than reported as agreement.
    if (ZERO_EXCLUSIVE_LOWER.test(trimmed)) return raw
    const canonical = validRange(trimmed)
    // Syntax node-semver cannot read either. Hand back the original so the caller's own refuse-rather-than-
    // guess path runs, instead of substituting an empty string it would read as "no range at all".
    if (canonical === null) return raw
    // `*` is how node-semver writes "every version" (it is what `>=0` canonicalises to). The parsers
    // downstream have no wildcard syntax and refuse the token, which would drop the record entirely, so
    // state the same thing as a bound they can read. `>=0` rather than `>=0.0.0` so the bottom of the
    // version space keeps its short spelling — formatRange tests `introduced === '0'` to decide whether to
    // render it as `0` or `0.0.0`, and padding here would silently take that branch away from it.
    if (canonical === '*' || canonical.length === 0) return '>=0'
    return stripSynthesisedPrereleaseMarker(canonical)
}

// `>0`, `> v0.0`, and the other spellings of an exclusive bound at zero — but ONLY when that is the whole
// range, so a genuine intersection like `>0 <2.0.0` still canonicalises normally.
const ZERO_EXCLUSIVE_LOWER = /^>\s*v?0(\.0)*$/i

// node-semver appends `-0` to an upper bound it synthesised from a partial version, meaning "and not the
// prereleases of this version": `<=1.0` becomes `<1.1.0-0`. This repo does not model prerelease visibility
// at all — range-fidelity.test.ts says so and excludes prereleases from its probes — so the marker buys
// nothing here, and it costs twice. It leaks into the bound shown beside a finding ("upgrade to 3.4.0-0" is
// not an installable version), and `<0` canonicalises to `<0.0.0-0`, which isZeroVersion does not recognise,
// so gemnasium's empty-set sentinel would survive as a live row that silently matches nothing.
//
// Only an EXCLUSIVE UPPER bound is stripped. `-0` is also a perfectly real prerelease — five ranges in the
// corpus pin one (`=1.0.8-0||=1.0.10`) — and a blanket strip corrupts every one of them into a duplicate of
// its release version. Anchoring to `<` leaves those untouched.
//
// Dropping the marker widens each bound by the prereleases of the fix version, which is the safe direction:
// it reports a prerelease of the boundary as affected rather than clearing one that is not.
function stripSynthesisedPrereleaseMarker(canonical: string): string {
    return canonical.replace(/<([0-9][0-9A-Za-z.+-]*)-0(?![0-9A-Za-z.-])/g, '<$1')
}

// Whether an interval admits any version at all.
//
// `fixed` is an EXCLUSIVE upper bound, so `[X, X)` selects nothing and `[2.0.0, 1.0.0)` selects less than
// nothing. Either way the row sits in the cache looking like a live advisory and can never report — the
// same silent failure the PEP 440 comma bug had, where 2,830 cached records matched nothing for months
// while every test stayed green.
//
// This is one function because it was two. gemnasium had `isEmptyInterval` and OSV had nothing until the
// npm/fresh investigation, then OSV got its own copy — the same rule, written twice, which is exactly how
// the two sources came to disagree about what a degenerate interval means while feeding one matcher.
//
// ORDERING IS CONSULTED ONLY FOR A SEMVER-TYPED RANGE, and that asymmetry is deliberate. Comparing two
// versions requires knowing the dialect's ordering, and `type` is the only signal a range carries about
// which dialect it is. compareVersions is semver; running it over a PEP 440 range would mis-order the very
// spellings PEP 440 exists to express (1.0.post1, 1!2.0) and DELETE live advisories. Caching a dead range
// is a bug; deleting a live one is a worse bug, so an unset or ECOSYSTEM type keeps the range and only the
// two ordering-free tests below apply to it.
export function canMatchSomething(range: VersionRange): boolean {
    const inclusiveUpper = range.lastAffected ?? null
    const upper = inclusiveUpper !== null ? inclusiveUpper : range.fixed
    if (upper === null) return true
    // Identical bound strings need no ordering. An inclusive upper bound admits its own version unless the
    // lower bound excludes it — `>=X <=X` is "exactly this version" and is NOT empty, which is why
    // inclusivity became load-bearing here the moment `<=` stopped collapsing into `fixed`.
    if (upper === range.introduced) return inclusiveUpper !== null && range.introducedExclusive !== true
    // gemnasium's empty-set sentinel in both its spellings: `<0` and `<0.0.0`. A valid node-semver range
    // that happens to select nothing, and the record means it — the caller drops the advisory rather than
    // caching an interval it never claimed.
    if (inclusiveUpper === null && isZeroVersion(range.introduced) && isZeroVersion(upper)) return false
    if (range.type !== 'SEMVER') return true
    const order = compareVersions(upper, range.introduced)
    if (order > 0) return true
    return order === 0 && inclusiveUpper !== null && range.introducedExclusive !== true
}
