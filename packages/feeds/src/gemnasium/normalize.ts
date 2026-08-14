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
// half-open [introduced, fixed) intervals the matcher consumes. Handles:
//   - semver comparator form:  "<4.17.12", ">=4.0.0 <4.0.1", ">=1 <2 || >=3 <4"
//   - maven-style interval notation: "(,4.1.2)", "[1.0.0,2.0.0)", "[1.0.0,)"
//   - bare/"=" exact versions -> enumerated `versions`
// `||` separates disjoint ranges.
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
// fully-patched 7.6.5 as a critical RCE. With one entry the override is still right and still needed: it is
// the only way to express `<=X`, whose fix is X's successor.
//
// The count check costs one record across the whole multi-ecosystem database: npm/sauce-connect-launcher
// GMS-2014-4 is `<=0.3.3` with `fixed_versions: ["0.3.5", "0.4.0"]`, so it now stores [0, 0.3.3) and
// under-includes 0.3.3 and 0.3.4. Repairing that properly needs a version comparator here — picking the
// lowest fix above the parsed bound — which the feeds layer deliberately does not carry. Under-including
// two patch versions of one dormant package is the acceptable side of this trade; the alternative is the
// arbitrary pick that produced the false criticals above.
export function parseAffectedRange(affectedRange: string, fixedVersions: string[]): ParsedRange {
    const ranges: GemnasiumRange[] = []
    const versions: string[] = []
    const trimmed = affectedRange.trim()
    const disjuncts = trimmed.length > 0 ? trimmed.split('||').map(trimToken).filter(nonEmpty) : []

    for (const disjunct of disjuncts) {
        const interval = parseDisjunct(disjunct)
        if (!interval) continue
        if (interval.exact !== null) {
            versions.push(interval.exact)
        } else {
            ranges.push({ introduced: interval.introduced, fixed: interval.fixed })
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
        ranges[0] = { introduced: only.introduced, fixed: authoritativeFixed }
    }

    return { ranges, versions }
}

// An interval that can never match: an explicit upper bound at or below the lower bound. `<0` parses to
// {introduced: '0', fixed: '0'} and lands here, as does the `<0.0.0` spelling of the same sentinel and any
// other degenerate bound upstream may emit.
function isEmptyInterval(range: GemnasiumRange): boolean {
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
    fixed: string | null
    // Set when the disjunct is a single exact version ("=1.2.3" / "1.2.3"); goes to enumerated versions.
    exact: string | null
}

function parseDisjunct(disjunct: string): Disjunct | null {
    const first = disjunct[0]
    if (first === '(' || first === '[') return parseIntervalNotation(disjunct)
    return parseComparatorForm(disjunct)
}

// Maven-style interval notation: "(," / "[" open, "," separates lower,upper, ")" / "]" close. We map to
// a half-open [introduced, fixed) range; close-bracket inclusivity is ignored (rare for npm).
function parseIntervalNotation(disjunct: string): Disjunct | null {
    const close = disjunct[disjunct.length - 1]
    if (close !== ')' && close !== ']') return null
    const inner = disjunct.slice(1, -1)
    const comma = inner.indexOf(',')
    if (comma < 0) {
        // "[1.2.3]" — a single exact version.
        const exact = inner.trim()
        return exact.length > 0 ? { introduced: '0', fixed: null, exact } : null
    }
    const lo = inner.slice(0, comma).trim()
    const hi = inner.slice(comma + 1).trim()
    return {
        introduced: lo.length > 0 ? lo : '0',
        fixed: hi.length > 0 ? hi : null,
        exact: null
    }
}

// Comparator form: space-separated tokens like ">=1.0.0", "<2.0.0", "<=2", ">1", "=1.2.3", or a bare
// "1.2.3". Builds a single [introduced, fixed) interval (or an exact version for "="/bare).
function parseComparatorForm(disjunct: string): Disjunct | null {
    const tokens = disjunct.split(/\s+/).filter(nonEmpty)
    if (tokens.length === 0) return null
    let introduced = '0'
    let fixed: string | null = null
    for (const token of tokens) {
        const op = readOperator(token)
        if (!op) continue
        if (op.operator === '=' ) {
            // A single pinned version: surface as an exact version rather than a range.
            return { introduced: '0', fixed: null, exact: op.version }
        }
        if (op.operator === '>=' || op.operator === '>') {
            // ">" is treated as inclusive lower bound (introduced is inclusive in our half-open model); at
            // worst this flags the exact boundary version, which is the security-conservative direction.
            introduced = op.version
        } else if (op.operator === '<') {
            fixed = op.version
        } else if (op.operator === '<=') {
            // "<=X" means X is affected, but the half-open [introduced, fixed) model can't include X
            // without its successor. The authoritative fixed_versions override (in the caller) fixes this
            // when a fix is known; absent that, fall back to fixed=X — under-including only the exact
            // boundary X, which is far safer than null (which would flag every version forever).
            fixed = op.version
        }
    }
    return { introduced, fixed, exact: null }
}

type Operator = { operator: '>=' | '>' | '<=' | '<' | '='; version: string }

function readOperator(token: string): Operator | null {
    if (token.startsWith('>=')) return { operator: '>=', version: stripV(token.slice(2)) }
    if (token.startsWith('<=')) return { operator: '<=', version: stripV(token.slice(2)) }
    if (token.startsWith('>')) return { operator: '>', version: stripV(token.slice(1)) }
    if (token.startsWith('<')) return { operator: '<', version: stripV(token.slice(1)) }
    if (token.startsWith('=')) return { operator: '=', version: stripV(token.slice(1)) }
    // Bare version → exact pin.
    const bare = stripV(token)
    return bare.length > 0 ? { operator: '=', version: bare } : null
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
