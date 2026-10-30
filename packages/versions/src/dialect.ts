import { validRange } from 'semver'
import type { VersionComparator } from './comparator'
import { normalizeBound, type SpecifierSemantics } from './match'
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
// Every other dialect is an operator dialect — PEP 440 specifiers, Go and crates.io comparators, Gem
// requirements — and is rewritten by canonicaliseOperatorRange below into the one comparator form the
// parser reads. None of them is node-semver: PEP 440's `==1.0` is an exact pin (only `==1.0.*` is a
// wildcard), so npm's reading applied to a PyPI record would invent findings that record never claimed.
// That is why this is keyed by ECOSYSTEM rather than by comparator: crates.io shares npm's comparator but
// not its range dialect.
export function canonicaliseRange(raw: string, dialect: string): string | null {
    if (dialect !== 'npm') {
        const rules = OPERATOR_DIALECTS[dialect]
        return rules === undefined ? raw : canonicaliseOperatorRange(raw, rules)
    }
    const trimmed = raw.trim()
    // A RANGE THAT NAMES NO VERSION IS NOT A RANGE. node-semver reads `''`, `*`, `x` and `||` all as "any
    // version", because that is what an unconstrained dependency spec means when npm installs a package.
    // Here the input is an advisory's `affected_range`, where the same strings are indistinguishable from a
    // missing or malformed field — and the two readings differ by the entire package. Taking npm's would
    // turn every record with an empty range into "every version vulnerable, forever, with no fix", which is
    // the exact defect class this module exists to end. Requiring a digit is the whole test: a record that
    // means "everything" still has `>=0` to say it with, and that is what the corpus actually uses.
    if (!/[0-9]/.test(trimmed)) return null
    // A zero exclusive lower bound is gemnasium's idiom for "every version", and npm reads it as `>=1.0.0`
    // — which would clear all of 0.x. npm/pandora-doomsday CVE-2017-16127 is the record that matters:
    // `affected_range: ">0"`, `affected_versions: "All Versions"`, `solution: "Omit this package."`, a
    // malicious package unpublished from the registry. Canonicalising it would report 0.x of that as clean.
    // Deliberately kept as the one place we depart from node-semver, rather than reported as agreement.
    if (ZERO_EXCLUSIVE_LOWER.test(trimmed)) return stripVersionPrefixes(raw)
    // No upper-case `v` fold before this call. node-semver reads `>=v1` but not `>=V1`, so folding one
    // spelling into the other looks free — but zero of the 12,472 ranges in the frozen corpus use it, in any
    // of the four ecosystems, and nothing downstream could observe the fold either: a comparator form
    // survives it anyway via `stripV`, and the caret/tilde/x-range forms it would actually rescue do not
    // occur. If gemnasium ever starts publishing one, `refuses nothing in the npm corpus` fails on the next
    // fixture refresh, which is a louder signal than a fold no test exercises.
    const canonical = validRange(trimmed)
    // gemnasium also carries numeric version spellings npm itself declines (date releases, leading-zero
    // segments, and comma-separated PEP 440 intersections). Hand those back to the source parser. The
    // digit gate above still refuses tokens such as `<banana` before they can become an unreadable bound.
    if (canonical === null) return stripVersionPrefixes(raw)
    // `*` is how node-semver writes "every version" (it is what `>=0` canonicalises to). The parsers
    // downstream have no wildcard syntax and refuse the token, which would drop the record entirely, so
    // state the same thing as a bound they can read. `>=0` rather than `>=0.0.0` so the bottom of the
    // version space keeps its short spelling — formatRange tests `introduced === '0'` to decide whether to
    // render it as `0` or `0.0.0`, and padding here would silently take that branch away from it.
    if (canonical === '*' || canonical.length === 0) return '>=0'
    return stripSynthesisedPrereleaseMarker(canonical, raw)
}

// How a range written in this dialect is matched beyond the ordering of its versions — see
// SpecifierSemantics. A source that states ranges in an ecosystem's own requirement syntax (gemnasium)
// carries this onto every set it builds; one that states intervals of the order (OSV) does not.
export function specifierSemantics(dialect: string): SpecifierSemantics | undefined {
    return OPERATOR_DIALECTS[dialect]?.specifier
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
// Only an EXCLUSIVE UPPER bound npm synthesized is stripped. `-0` is also a perfectly real prerelease —
// five ranges in the corpus pin one (`=1.0.8-0||=1.0.10`) — and it can be a real upper bound too. Any
// prerelease-zero version present in the raw range is therefore preserved; only a new one in npm's
// canonical output is synthetic.
//
// Dropping the marker widens each bound by the prereleases of the fix version, which is the safe direction:
// it reports a prerelease of the boundary as affected rather than clearing one that is not.
const SYNTHESISED_PRERELEASE_MARKER = /<([0-9][0-9A-Za-z.+-]*)-0(?![0-9A-Za-z.-])/g
const EXPLICIT_PRERELEASE_ZERO = /[0-9][0-9A-Za-z.+-]*-0(?![0-9A-Za-z.-])/g

function stripSynthesisedPrereleaseMarker(canonical: string, raw: string): string {
    const explicit = new Set(raw.match(EXPLICIT_PRERELEASE_ZERO) ?? [])
    return canonical.replace(SYNTHESISED_PRERELEASE_MARKER, function keepExplicit(whole: string, base: string) {
        return explicit.has(base + '-0') ? whole : '<' + base
    })
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
// The interval is ordered through the ECOSYSTEM'S OWN comparator. This used to consult ordering only for a
// SEMVER-typed range, because a range's `type` was the only dialect signal it carried and running semver
// over PEP 440 would mis-order the very spellings PEP 440 exists to express (1.0.post1, 1!2.0) and delete
// live advisories. Passing the comparator retires that trade-off: every range is ordered the way the matcher
// will read it, so a dead PyPI, Go or RubyGems interval is caught as surely as an npm one. An interval is
// ordered only after BOTH bounds normalize; unreadable means unknown, never empty.
//
// An inclusive zero lower bound is the bottom of the version space, exactly as versionInRange reads it, so
// nothing is below it: `[0, 0.0.0-20180523222229-09b5706aa936)` is the Go advisory for every pseudo-version
// before that commit, not an inverted interval. Ordering its bounds as the release 0.0.0 would drop it.
//
// A refused part of an affected set is unknown, never empty, for the same reason.
export function canMatchSomething(range: VersionRange, comparator: VersionComparator): boolean {
    if (range.refused !== undefined) return true
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
    if (range.introducedExclusive !== true && isZeroVersion(range.introduced)) return true
    const normalizedUpper = normalizeBound(upper, comparator)
    const normalizedIntroduced = normalizeBound(range.introduced, comparator)
    // An unreadable bound is UNKNOWN, not empty. Dropping it would delete the advisory on the strength of
    // a comparison the comparator never made; callers may still apply their source-specific recovery.
    if (normalizedUpper === null || normalizedIntroduced === null) return true
    const order = comparator.compare(normalizedUpper, normalizedIntroduced)
    if (order === 0) return inclusiveUpper !== null && range.introducedExclusive !== true
    return order > 0
}

// The operator dialects. Each states how its own operators map onto the five the parser reads
// (`>=`, `>`, `<=`, `<`, `=`), and nothing else differs between them.
type OperatorRules = {
    // Rewrites one operator-version pair into comparator tokens, or null to refuse it. `!=` never reaches
    // here: an exclusion is the same thing in every dialect and is expanded by the caller.
    rewrite(operator: string, version: string): string[] | null
    // Whether `!=` may exclude this version. Absent: any version the caller accepts.
    excludes?(version: string): boolean
    // How ranges written in this dialect are matched beyond the ordering. Absent: ordering is the whole
    // meaning.
    specifier?: SpecifierSemantics
}

const PASS_THROUGH: OperatorRules = {
    rewrite(operator: string, version: string): string[] | null {
        return COMPARATOR_OPERATORS.has(operator) ? [operator + version] : null
    }
}

const OPERATOR_DIALECTS: Record<string, OperatorRules> = {
    // PEP 440 (https://packaging.python.org/en/latest/specifications/version-specifiers/). The rewrite is
    // text only; what makes these SPECIFIERS rather than intervals of the order is `specifier: 'pep440'`,
    // which every reader applies when it evaluates the result: a public specifier ignores the candidate's
    // local label, so `==2.2.0` and `<=2.2.0` select `2.2.0+cpu` and `>2.2.0` does not.
    //
    // `==X` is an exact pin (strict, local label included, when X carries one). Refused rather than
    // approximated, each kept as a refused part of the record so its affected set reads incomplete:
    //   - `===X`, arbitrary equality, is plain string equality — `===1.0` does not select `1.0.0` — and no
    //     interval or normalized pin can say that;
    //   - a local label on an ordered comparison, which PEP 440 does not permit;
    //   - a local label on an exclusion: `!=1.0+local` is valid PEP 440 (an exclusion takes `==`'s
    //     identifiers) and excludes that one build, but the public-candidate reading above cannot carve a
    //     single local build out of a set, so it is unsupported here rather than approximated;
    //   - a `==X.*` prefix match and the compatible release `~=`.
    // None occurs in the frozen corpus; the refusal ratchet names the record the day one does.
    //
    // Two PEP 440 exclusions are deliberately NOT applied, both in the over-reporting direction the Gem `~>`
    // below also takes: `<V` keeps V's own prereleases (`2.0rc1` is inside `<2.0`) and `>V` keeps V's
    // post-releases. Whether a prerelease of the fix carries the fix, or a post-release of the last clean
    // version is clean, is exactly what an advisory does not say; reporting it is the safe answer.
    PyPI: {
        rewrite(operator: string, version: string): string[] | null {
            if (version.includes('*')) return null
            if (operator === '==') return ['=' + version]
            if (version.includes('+')) return null
            return PASS_THROUGH.rewrite(operator, version)
        },
        excludes(version: string): boolean {
            return !version.includes('+')
        },
        specifier: 'pep440'
    },
    // Go advisories use the comparator form already; only spacing and the `v` change — and a partial
    // version. A Go module version is always a full vX.Y.Z (the toolchain refuses anything else), so a
    // bound gemnasium writes as `<1.1` can only mean v1.1.0, which is how semver coercion read it before Go
    // had a comparator of its own. Anything else Go cannot read is left for the parser to refuse.
    Go: {
        rewrite(operator: string, version: string): string[] | null {
            // Zero stays as written: it is the bottom of the version space, however it is spelled.
            const partial = /^0(\.0)*$/.test(version) ? null : /^[0-9]+(\.[0-9]+)?$/.exec(version)
            const full = partial ? version + (partial[1] === undefined ? '.0.0' : '.0') : version
            return PASS_THROUGH.rewrite(operator, full)
        }
    },
    'crates.io': PASS_THROUGH,
    // Gem requirements (Gem::Requirement::OPS). `~> X` is the pessimistic operator: `>= X` and below
    // Gem::Version#bump of X, so `~> 2.2` is `>= 2.2, < 3` and `~> 2.2.0` is `>= 2.2.0, < 2.3`.
    //
    // Gem itself compares the candidate's RELEASE against the bump, which excludes the prereleases of the
    // bump version (`3.a` is not inside `~> 2.2`); the interval below includes them. That over-reports a
    // prerelease of the next line as affected, the safe direction for an affected range.
    RubyGems: {
        rewrite(operator: string, version: string): string[] | null {
            if (operator !== '~>') return PASS_THROUGH.rewrite(operator, version)
            const bumped = gemBump(version)
            return bumped === null ? null : ['>=' + version, '<' + bumped]
        }
    }
}

const COMPARATOR_OPERATORS = new Set(['>=', '>', '<=', '<', '='])

// Longest first, so `>=` is never read as `>` followed by a version starting with `=`.
const OPERATOR = /^(===|==|!=|~=|~>|>=|<=|>|<|=)?(.*)$/

// Rewrites one disjunct of an operator dialect into space-separated comparator tokens. Whitespace between
// an operator and its version is insignificant in every one of these dialects (`< 0.5.2`, `>= 1.0 , < 2`),
// and a comma is PEP 440's intersection, so both become the one separator the parser splits on.
//
// An EXCLUSION (`!=X`) cannot live inside one interval, so it splits the conjunction in two: everything
// else plus `<X`, and everything else plus `>X`. The parser intersects each conjunction's bounds through
// the comparator and canMatchSomething drops a half that selects nothing, so this stays a rewrite of text
// and never needs to order versions itself. The result is a `||` disjunction the caller splits again.
function canonicaliseOperatorRange(raw: string, rules: OperatorRules): string | null {
    const trimmed = raw.trim()
    // The same digit gate as npm's: a range that names no version is a missing field, not "everything".
    if (!/[0-9]/.test(trimmed)) return null
    // Maven-style interval notation (`[1.0,2.0)`, `(,1.2]`) is its own grammar, with its own parser
    // downstream; only the `v` comes off.
    if (trimmed.startsWith('[') || trimmed.startsWith('(')) return stripVersionPrefixes(trimmed)
    const bound = trimmed.replace(/(===|==|!=|~=|~>|>=|<=|>|<|=)\s+/g, '$1')
    const conjunction: string[] = []
    const exclusions: string[] = []
    for (const token of bound.split(/[\s,]+/)) {
        if (token.length === 0) continue
        const match = OPERATOR.exec(token) as RegExpExecArray
        const operator = match[1] ?? ''
        const version = stripVersionPrefix(match[2] as string)
        // Every version starts with a digit, in every one of these dialects; anything else is an operator
        // this dialect does not define (`^1.0` in PEP 440) or no version at all.
        if (!/^[0-9]/.test(version)) return null
        if (operator === '!=') {
            if (version.includes('*') || rules.excludes?.(version) === false) return null
            exclusions.push(version)
            continue
        }
        // A bare version is a pin in every one of these dialects.
        const rewritten = operator === '' ? ['=' + version] : rules.rewrite(operator, version)
        if (rewritten === null) return null
        conjunction.push(...rewritten)
    }
    let alternatives: string[][] = [conjunction]
    for (const excluded of exclusions) {
        alternatives = alternatives.flatMap(function split(tokens) {
            return [[...tokens, '<' + excluded], [...tokens, '>' + excluded]]
        })
    }
    return alternatives.map(function join(tokens) { return tokens.join(' ') }).join(' || ')
}

// Gem::Version#bump: drop every segment from the first string (prerelease) segment on, then the last
// remaining one when more than one is left, and increment the new last. Null for a version Gem would not
// accept, so `~>` on garbage is refused rather than bounded by a guess.
function gemBump(version: string): string | null {
    if (!/^[0-9]+(\.[0-9a-zA-Z]+)*$/.test(version)) return null
    const segments = version.match(/[0-9]+|[a-z]+/gi) as string[]
    const firstString = segments.findIndex(function isString(s) { return !/^[0-9]+$/.test(s) })
    // The pattern above starts with a digit, so at least one numeric segment precedes any string one.
    const release = (firstString < 0 ? segments : segments.slice(0, firstString)).map(Number)
    if (release.length > 1) release.pop()
    release[release.length - 1] = (release[release.length - 1] as number) + 1
    return release.join('.')
}

// A leading `v` on a version (`v1.2.3`, Go's canonical spelling, also accepted by PEP 440). Versions are
// handed to the parser without it, so no reader downstream has to know any dialect allows one.
function stripVersionPrefix(version: string): string {
    return /^[vV][0-9]/.test(version) ? version.slice(1) : version
}

// The same, for every version in a whole range string: a `v` directly after the start, whitespace, a
// separator or an operator, and directly before a digit.
function stripVersionPrefixes(range: string): string {
    return range.replace(/(^|[\s,|<>=~!^])[vV](?=[0-9])/g, '$1')
}
