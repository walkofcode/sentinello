import type { GemnasiumAdvisoryRow, GemnasiumRange } from '@sentinello/db'
import { severityFromCvss } from './gemnasium-cvss'

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
    // A record we can't match on at all (no range AND no enumerated version) is not worth caching.
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

type ParsedRange = {
    ranges: GemnasiumRange[]
    versions: string[]
}

// Maps gemnasium's machine-readable `affected_range` (+ the authoritative `fixed_versions`) into the
// half-open [introduced, fixed) intervals the matcher consumes. Handles:
//   - semver comparator form:  "<4.17.12", ">=4.0.0 <4.0.1", ">=1 <2 || >=3 <4"
//   - maven-style interval notation: "(,4.1.2)", "[1.0.0,2.0.0)", "[1.0.0,)"
//   - bare/"=" exact versions → enumerated `versions`
// `||` separates disjoint ranges. When a single disjoint range is produced and a fixed version is known,
// the authoritative `fixed_versions[0]` overrides the parsed upper bound (correctly handling `<=X`, where
// the first fixed version is X's successor, which the comparator string can't express).
export function parseAffectedRange(affectedRange: string, fixedVersions: string[]): ParsedRange {
    const ranges: GemnasiumRange[] = []
    const versions: string[] = []
    const trimmed = affectedRange.trim()
    const disjuncts = trimmed.length > 0 ? trimmed.split('||').map(trimToken).filter(nonEmpty) : []

    if (disjuncts.length === 0) {
        // No machine-readable range. If a fix is known, assume "everything before the fix is affected".
        const fixed = fixedVersions[0]
        if (fixed !== undefined) return { ranges: [{ introduced: '0', fixed }], versions }
        return { ranges, versions }
    }

    for (const disjunct of disjuncts) {
        const interval = parseDisjunct(disjunct)
        if (!interval) continue
        if (interval.exact !== null) {
            versions.push(interval.exact)
        } else {
            ranges.push({ introduced: interval.introduced, fixed: interval.fixed })
        }
    }

    // Single range + a known fixed version: trust the authoritative fixed boundary over the parsed upper.
    const only = ranges[0]
    const authoritativeFixed = fixedVersions[0]
    if (ranges.length === 1 && versions.length === 0 && only && authoritativeFixed !== undefined) {
        ranges[0] = { introduced: only.introduced, fixed: authoritativeFixed }
    }

    return { ranges, versions }
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
