import type { GemnasiumAdvisoryRow, GemnasiumRange } from '@sentinello/core'
import { severityFromCvss } from './cvss'

// Parses a single gemnasium-db advisory (one *.yml file, already YAML-parsed to an object) into the
// denormalized advisory→package rows we cache. A gemnasium file is per package_slug, so this yields 0..1
// rows. The caller resolves the file's package-type directory to a registry ecosystem (Phase 4 — npm,
// PyPI, Go, crates.io) and passes both the canonical `ecosystem` id (stamped on the row + queried by the
// scanner) and the `slugPrefix` (the gemnasium package-type segment, e.g. "pypi/") used to strip the
// package name out of `package_slug`. The CVE/GHSA/GMS `identifiers` become aliases so reconcile can
// collapse a gemnasium finding that npm-audit or OSV already reported under the same id for the same package.

type GemnasiumYaml = {
    identifier?: string
    identifiers?: unknown
    package_slug?: string
    title?: string
    description?: string
    affected_range?: string
    affected_versions?: string
    fixed_versions?: unknown
    urls?: unknown
    cvss_v2?: string
    cvss_v3?: string
}

export function normalizeGemnasiumRecord(record: unknown, ecosystem: string, slugPrefix: string): GemnasiumAdvisoryRow[] {
    if (!record || typeof record !== 'object') return []
    const r = record as GemnasiumYaml
    const slug = typeof r.package_slug === 'string' ? r.package_slug : null
    if (!slug || !slug.startsWith(slugPrefix)) return []
    // Everything after the package-type prefix is the (possibly scoped) package name, e.g.
    // "npm/@babel/cli" → "@babel/cli", "pypi/Django" → "Django".
    const rawName = slug.slice(slugPrefix.length)
    if (rawName.length === 0) return []
    // An advisory upstream has retracted contributes nothing, whatever versions it still names.
    if (isRetractedUpstream(r)) return []
    // PyPI advisories must key on the PEP 503 canonical name (lower-case, runs of -_. collapsed) so they
    // match the resolver's normalized names; other ecosystems use the slug name as-is.
    const packageName = ecosystem === 'PyPI' ? normalizePyName(rawName) : rawName

    const identifiers = stringArray(r.identifiers)
    // Primary id: the explicit `identifier` (CVE preferred, else GMS), falling back to the first listed
    // identifier. Without any id we cannot key/dedup the row, so skip.
    const advisoryId = typeof r.identifier === 'string' && r.identifier.length > 0
        ? r.identifier
        : (identifiers[0] ?? null)
    if (!advisoryId) return []

    const fixedVersions = stringArray(r.fixed_versions)
    const parsed = parseAffectedRange(typeof r.affected_range === 'string' ? r.affected_range : '', fixedVersions)
    // `affected_range` is the authoritative statement of what this advisory affects, and a record whose
    // range matches nothing affects nothing. That is not a gap to be filled from somewhere else: for npm it
    // is node-semver, where `<0` is a perfectly ordinary range that happens to select no version. Caching
    // such a record could only ever produce a finding it does not claim.
    if (parsed.ranges.length === 0 && parsed.versions.length === 0) return []

    const severity = severityFromCvss(
        typeof r.cvss_v3 === 'string' ? r.cvss_v3 : null,
        typeof r.cvss_v2 === 'string' ? r.cvss_v2 : null
    )
    const summary = typeof r.title === 'string' && r.title.length > 0 ? r.title : null
    const urls = stringArray(r.urls)
    const url = urls[0] ?? null
    // aliases = the cross-reference identifiers MINUS the primary id (which lands in advisoryId), so
    // reconcile matches against the others (e.g. advisoryId=CVE, aliases=[GHSA-…, GMS-…]).
    const aliases = identifiers.filter(function notPrimary(id) {
        return id !== advisoryId
    })

    return [{
        advisoryId,
        ecosystem,
        packageName,
        aliases,
        ranges: parsed.ranges,
        versions: parsed.versions,
        severity,
        summary,
        url,
        malicious: false,
        withdrawn: null
    }]
}

// Whether gemnasium has retracted this advisory upstream.
//
// This exists because of a gap in gemnasium's schema, not a quirk of one record. OSV has a formal
// `withdrawn` field (an RFC3339 timestamp; absent means not withdrawn) and we filter on it. GitHub drops
// withdrawn advisories from the database npm-audit reads, so they never arrive. gemnasium-db's documented
// schema — see its own README's field reference — has NO withdrawn, status or retracted field at all. Its
// only way to retract is to rewrite the record in place: the title becomes the marker, the description
// explains, and `affected_range` is usually set to an empty range.
//
// What it does NOT do is clear `affected_versions` or `fixed_versions`, so a retracted record still names
// the versions it claimed before retraction — npm/express CVE-2024-51999 is titled "False Positive" and
// still carries "All versions before 4.22.0, all versions starting from 5.0.0 before 5.2.0". Anything that
// reads those fields reinstates precisely the finding gemnasium withdrew.
//
// Three markers, all inherited from the GitHub advisories gemnasium imports, covering 372 records across
// npm/PyPI/Go/crates.io: 278 "Duplicate Advisory:", 43 "Withdrawn Advisory:", 35 false positives, plus 16
// whose title reads normally and whose description alone carries the withdrawal.
//
// The false-positive test is deliberately an EXACT title match rather than a substring, because a real
// advisory can be *about* a false positive: go/github.com/sigstore/cosign CVE-2026-39395 is titled
// "Cosign's verify-blob-attestation reports false positive when payload parsing fails" and must keep
// reporting. Same reason the other two anchor to the start of the title.
// The description phrasings, taken from the export rather than guessed at. Retracting by description
// alone — leaving the original title in place — is what 36 records do, and their titles read like ordinary
// advisories ("Incorrect Comparison", "Uncontrolled Resource Consumption"), so the title tests cannot find
// them. Each phrase is a statement ABOUT the advisory, never a description of a vulnerability, which is
// what keeps this from matching real records: an advisory that discusses false positives in its own
// subject matter says so in other words entirely.
const RETRACTION_PHRASES = [
    'marked as false positive',
    'marked as a false positive',
    'this is a false positive',
    'this advisory has been withdrawn',
    'has been invalidated',
    'cve being rejected',
    'cve has been rejected'
] as const

function isRetractedUpstream(record: GemnasiumYaml): boolean {
    const title = typeof record.title === 'string' ? record.title.trim().toLowerCase() : ''
    if (title === 'false positive') return true
    if (title.startsWith('withdrawn advisory:')) return true
    if (title.startsWith('duplicate advisory:')) return true
    const description = typeof record.description === 'string' ? record.description.replace(/\s+/g, ' ').toLowerCase() : ''
    return RETRACTION_PHRASES.some(function stated(phrase) {
        return description.includes(phrase)
    })
}

type ParsedRange = {
    ranges: GemnasiumRange[]
    versions: string[]
}

// Maps gemnasium's machine-readable `affected_range` (+ the authoritative `fixed_versions`) into the
// bounded intervals the matcher consumes. Handles:
//   - semver comparator form:  "<4.17.12", ">=4.0.0 <4.0.1", ">1.2.8", "<=2.0.0", ">=1 <2 || >=3 <4"
//   - maven-style interval notation: "(,4.1.2)", "[1.0.0,2.0.0)", "[1.0.0,2.0.0]", "(1.0.0,)"
//   - bare/"=" exact versions -> enumerated `versions`
// `||` separates disjoint ranges.
//
// EVERY BOUND KEEPS ITS OWN INCLUSIVITY. This function used to emit half-open [introduced, fixed) intervals
// exclusively, because that was the only shape the range type could hold, so `>` was stored as `>=` and
// `<=` as `<`. Both roundings were defended in comments as erring in the safe direction. Neither did:
//   - `>X` → `>=X` reports the boundary version as vulnerable. gemnasium states the 2021 `rc` hijack as
//     `>1.2.8`, and 1.2.8 is the last CLEAN release — the version the advisory's own `solution` field tells
//     you to downgrade TO. Rounding reported it as critical malware, unfixable, on every project using it.
//   - `<=X` → `<X` silently drops a genuinely affected version, and when the two bounds coincided
//     (`>=X <=X`, "exactly this version") the interval read as empty and the whole record was discarded.
//
// `affected_range` is the ONLY input. gemnasium's own field reference calls it "the range of affected
// versions, machine-readable syntax used by the package manager", and calls `affected_versions` "the range
// of affected versions, human-readable version for display" — so the second one is display text and is not
// read here. A range that selects no version (`<0`, and it is a valid node-semver range rather than a
// sentinel) means the record affects nothing, and the caller drops it.
//
// The authoritative-fixed override applies ONLY when `fixed_versions` holds exactly one entry.
// `fixed_versions` is an UNORDERED set with one fix per release branch, so `fixed_versions[0]` on a
// multi-branch advisory is an arbitrary pick — and pairing it with a single `[0, …)` interval claims every
// version below some other branch's fix is vulnerable. That is precisely how protobufjs
// GHSA-xq3m-2v4x-88gg (`fixed_versions: ["8.0.1", "7.5.5"]`) became `[0, 8.0.1)` and reported the
// fully-patched 7.6.5 as a critical RCE. With one entry the override still earns its place: a known fix
// version is a better upper bound than a parsed one, and it names the remediation target.
//
// It is no longer needed to express `<=X` — that has its own representation now — which also settles the
// npm/sauce-connect-launcher GMS-2014-4 case this comment used to concede: `<=0.3.3` with two branch fixes
// skips the override and is stored as `[0, 0.3.3]`, including 0.3.3 exactly as the advisory states.
export function parseAffectedRange(affectedRange: string, fixedVersions: string[]): ParsedRange {
    const ranges: BuiltRange[] = []
    const versions: string[] = []
    const trimmed = affectedRange.trim()
    const disjuncts = trimmed.length > 0 ? trimmed.split('||').map(trimToken).filter(nonEmpty) : []

    for (const disjunct of disjuncts) {
        const interval = parseDisjunct(disjunct)
        if (!interval) continue
        if (interval.exact !== null) {
            versions.push(interval.exact)
        } else {
            ranges.push(toRange(interval.introduced, interval.introducedExclusive, interval.fixed, interval.lastAffected))
        }
    }

    // Every parsed interval selects no version (`<0`, or any other degenerate bound), or there was no
    // range at all. Either way the record states no affected set, so return nothing and let the caller
    // drop it rather than reporting an interval the advisory never claimed.
    if (versions.length === 0 && ranges.every(isEmptyInterval)) return { ranges: [], versions: [] }

    // Single range + exactly one known fixed version: trust the authoritative fixed boundary over the
    // parsed upper bound. See rule 2 above for why the count check is load-bearing.
    const only = ranges[0]
    const authoritativeFixed = fixedVersions[0]
    if (ranges.length === 1 && versions.length === 0 && only && fixedVersions.length === 1 && authoritativeFixed !== undefined) {
        // A known fix version supersedes the parsed upper bound, inclusive or not — `fixed` IS the
        // remediation target. The lower bound and its inclusivity are the advisory's own and are kept.
        ranges[0] = toRange(only.introduced, only.introducedExclusive === true, authoritativeFixed, null)
    }

    return { ranges, versions }
}

// Both upper bounds are optional on the shared range type (OSV-shaped sources may omit them), but every
// range built HERE sets both explicitly. Saying so in the type keeps `undefined` out of the predicates
// below instead of leaving them with an arm nothing can reach.
type BuiltRange = GemnasiumRange & { fixed: string | null; lastAffected: string | null }

// `introducedExclusive` is a sparse flag: an absent one and an explicit `false` mean the same thing, so
// only `true` is ever written. Keeps the cached JSON — and every test expectation — to one shape.
function toRange(introduced: string, introducedExclusive: boolean, fixed: string | null, lastAffected: string | null): BuiltRange {
    const range: BuiltRange = { introduced, fixed, lastAffected }
    if (introducedExclusive) range.introducedExclusive = true
    return range
}

// An interval that can never match. `<0` parses to {introduced: '0', fixed: '0'} and lands here, as does
// the `<0.0.0` spelling of the same sentinel and any other degenerate bound upstream may emit.
//
// Inclusivity is load-bearing here, which it was not when every upper bound was exclusive: `[X, X]` matches
// exactly X and is NOT empty, while `[X, X)` and `(X, X]` both are. Before `<=` had its own representation
// it collapsed into `fixed`, so an advisory spelled `>=X <=X` — "exactly this one version is affected" —
// became {introduced: X, fixed: X}, was judged empty here, and the ENTIRE record was dropped by the caller.
function isEmptyInterval(range: BuiltRange): boolean {
    if (range.lastAffected !== null) {
        // An inclusive upper bound admits its own version unless the lower bound excludes it.
        return range.introducedExclusive === true && range.lastAffected === range.introduced
    }
    if (range.fixed === null) return false
    if (range.fixed === range.introduced) return true
    return isZeroVersion(range.introduced) && isZeroVersion(range.fixed)
}

// "0", "0.0", "0.0.0" — the bottom of the version space however upstream spelled it.
function isZeroVersion(version: string): boolean {
    return /^0(\.0)*$/.test(version)
}

type Disjunct = {
    introduced: string
    // ">" rather than ">=": the lower bound itself is not affected.
    introducedExclusive: boolean
    // Exclusive upper bound ("<X") — also the fix target.
    fixed: string | null
    // Inclusive upper bound ("<=X", or a maven "]" close): vulnerable THROUGH this version.
    lastAffected: string | null
    // Set when the disjunct is a single exact version ("=1.2.3" / "1.2.3"); goes to enumerated versions.
    exact: string | null
}

function parseDisjunct(disjunct: string): Disjunct | null {
    const first = disjunct[0]
    if (first === '(' || first === '[') return parseIntervalNotation(disjunct)
    return parseComparatorForm(disjunct)
}

// Maven-style interval notation: "(" / "[" open, "," separates lower,upper, ")" / "]" close. Bracket
// inclusivity is the whole meaning of the notation — "[" and "(" differ, and so do "]" and ")" — so both
// ends are read. Treating "]" as ")" (which this did before) silently excludes a version the advisory
// explicitly includes.
function parseIntervalNotation(disjunct: string): Disjunct | null {
    const open = disjunct[0]
    const close = disjunct[disjunct.length - 1]
    if (close !== ')' && close !== ']') return null
    const inner = disjunct.slice(1, -1)
    const comma = inner.indexOf(',')
    if (comma < 0) {
        // "[1.2.3]" — a single exact version.
        const exact = inner.trim()
        return exact.length > 0
            ? { introduced: '0', introducedExclusive: false, fixed: null, lastAffected: null, exact }
            : null
    }
    const lo = inner.slice(0, comma).trim()
    const hi = inner.slice(comma + 1).trim()
    const hasUpper = hi.length > 0
    return {
        introduced: lo.length > 0 ? lo : '0',
        // An open "(" excludes the lower bound — but only when one was actually given; "(,2.0.0)" has no
        // lower bound at all and starts from the bottom of the version space inclusively.
        introducedExclusive: open === '(' && lo.length > 0,
        fixed: hasUpper && close === ')' ? hi : null,
        lastAffected: hasUpper && close === ']' ? hi : null,
        exact: null
    }
}

// Comparator form: space-separated tokens like ">=1.0.0", "<2.0.0", "<=2", ">1", "=1.2.3", or a bare
// "1.2.3". Builds a single bounded interval (or an exact version for "="/bare). Every operator keeps its
// own inclusivity — none is rounded into another.
function parseComparatorForm(disjunct: string): Disjunct | null {
    const tokens = disjunct.split(/\s+/).filter(nonEmpty)
    if (tokens.length === 0) return null
    let introduced = '0'
    let introducedExclusive = false
    let fixed: string | null = null
    let lastAffected: string | null = null
    for (const token of tokens) {
        const op = readOperator(token)
        if (!op) return null
        if (op.operator === '=') {
            // A single pinned version: surface as an exact version rather than a range.
            return { introduced: '0', introducedExclusive: false, fixed: null, lastAffected: null, exact: op.version }
        }
        if (op.operator === '>=' || op.operator === '>') {
            introduced = op.version
            introducedExclusive = op.operator === '>'
        } else if (op.operator === '<') {
            fixed = op.version
            lastAffected = null
        } else {
            // "<=X" says X ITSELF is affected. That is an inclusive upper bound, which the range type now
            // carries directly — no successor version needed, and nothing to under-include.
            lastAffected = op.version
            fixed = null
        }
    }
    return { introduced, introducedExclusive, fixed, lastAffected, exact: null }
}

type Operator = { operator: '>=' | '>' | '<=' | '<' | '='; version: string }

// A concrete version: digits, dot-separated, with an optional prerelease/build tail. Deliberately NOT a
// full semver/PEP 440 grammar — it only has to tell a version apart from range syntax this parser does not
// implement.
const BARE_VERSION = /^[0-9]+(\.[0-9]+)*([-+][0-9A-Za-z.-]*)?$/

function readOperator(token: string): Operator | null {
    if (token.startsWith('>=')) return { operator: '>=', version: stripV(token.slice(2)) }
    if (token.startsWith('<=')) return { operator: '<=', version: stripV(token.slice(2)) }
    if (token.startsWith('>')) return { operator: '>', version: stripV(token.slice(1)) }
    if (token.startsWith('<')) return { operator: '<', version: stripV(token.slice(1)) }
    if (token.startsWith('=')) return { operator: '=', version: stripV(token.slice(1)) }
    // Bare version → exact pin, but ONLY if it really is a version. The old fallthrough pinned any
    // unrecognised token verbatim, so "^1.0.0", "~1.0.0" and "!=1.0.0" each became an "exact version" that
    // no installed version can ever equal — a row cached as a live advisory that matches nothing, ever.
    // Refusing the token drops the record instead, which is the honest outcome for syntax we cannot read.
    const bare = stripV(token)
    return BARE_VERSION.test(bare) ? { operator: '=', version: bare } : null
}

function stripV(raw: string): string {
    const t = raw.trim()
    return t.startsWith('v') || t.startsWith('V') ? t.slice(1) : t
}

// PEP 503 name normalization (lower-case, runs of -_. collapsed to a single -). Mirrors the Python
// resolver so a gemnasium PyPI advisory keys on the same name the resolved package does.
function normalizePyName(name: string): string {
    return name.trim().toLowerCase().replace(/[-_.]+/g, '-')
}

function stringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return []
    const out: string[] = []
    for (const v of value) {
        if (typeof v === 'string' && v.length > 0) out.push(v)
        else if (typeof v === 'number') out.push(String(v))
    }
    return out
}

function trimToken(s: string): string {
    return s.trim()
}

function nonEmpty(s: string): boolean {
    return s.length > 0
}
