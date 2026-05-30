import type { OsvAdvisoryRow, OsvRange } from '@sentinello/db'

// Parses a single OSV record (one *.json file from the npm export, or one /v1/vulns response) into the
// denormalized advisory→package rows we cache. One record can affect multiple packages, each with its
// own ranges, so this returns 0..N rows. Only npm-ecosystem affected entries are kept.
//
// Two record families matter for npm:
//   - GHSA-xxxx : a real advisory with SEMVER ranges (introduced/fixed events) and a severity bucket.
//   - MAL-xxxx  : a malicious package; the whole package is bad (introduced "0", no fix). Flagged
//                 `malicious: true` so the scanner and UI treat it as a distinct threat class.

type OsvEvent = { introduced?: string; fixed?: string; last_affected?: string }
type OsvRangeRaw = { type?: string; events?: OsvEvent[] }
type OsvPackage = { name?: string; ecosystem?: string; purl?: string }
type OsvAffected = { package?: OsvPackage; ranges?: OsvRangeRaw[] }
type OsvSeverity = { type?: string; score?: string }
type OsvRecord = {
    id?: string
    aliases?: string[]
    summary?: string
    withdrawn?: string
    affected?: OsvAffected[]
    references?: Array<{ type?: string; url?: string }>
    database_specific?: { severity?: string; source?: string }
    severity?: OsvSeverity[]
}

const NPM_ECOSYSTEM = 'npm'

export function normalizeOsvRecord(record: unknown): OsvAdvisoryRow[] {
    if (!record || typeof record !== 'object') return []
    const r = record as OsvRecord
    const advisoryId = typeof r.id === 'string' ? r.id : null
    if (!advisoryId) return []
    if (!Array.isArray(r.affected)) return []
    const malicious = advisoryId.startsWith('MAL-')
    const aliases = Array.isArray(r.aliases) ? r.aliases.filter(isNonEmptyString) : []
    const severity = pickSeverity(r)
    const summary = typeof r.summary === 'string' ? r.summary : null
    const url = pickUrl(r, advisoryId)
    const withdrawn = typeof r.withdrawn === 'string' ? Date.parse(r.withdrawn) || null : null
    const rows: OsvAdvisoryRow[] = []
    const seenPackages = new Set<string>()
    for (const affected of r.affected) {
        const pkg = affected.package
        if (!pkg || pkg.ecosystem !== NPM_ECOSYSTEM) continue
        const packageName = typeof pkg.name === 'string' ? pkg.name : null
        if (!packageName) continue
        // One advisory can list the same package twice; collapse to a single row with merged ranges.
        if (seenPackages.has(packageName)) continue
        seenPackages.add(packageName)
        const ranges = malicious ? maliciousRange() : extractRanges(affected.ranges)
        // A non-malicious advisory with no parseable SEMVER range can't be matched — skip it rather
        // than store a row that would never produce a finding.
        if (!malicious && ranges.length === 0) continue
        rows.push({
            advisoryId,
            ecosystem: NPM_ECOSYSTEM,
            packageName,
            aliases,
            ranges,
            severity,
            summary,
            url,
            malicious,
            withdrawn
        })
    }
    return rows
}

function maliciousRange(): OsvRange[] {
    return [{ introduced: '0', fixed: null }]
}

function extractRanges(ranges: OsvRangeRaw[] | undefined): OsvRange[] {
    if (!Array.isArray(ranges)) return []
    const out: OsvRange[] = []
    for (const range of ranges) {
        if (range.type !== 'SEMVER') continue
        if (!Array.isArray(range.events)) continue
        let introduced: string | null = null
        for (const event of range.events) {
            if (typeof event.introduced === 'string') {
                introduced = event.introduced
                continue
            }
            if (typeof event.fixed === 'string' && introduced !== null) {
                out.push({ introduced, fixed: event.fixed })
                introduced = null
            }
        }
        // A trailing introduced with no fixed = open-ended vulnerable range.
        if (introduced !== null) {
            out.push({ introduced, fixed: null })
        }
    }
    return out
}

// GHSA records carry the severity bucket in database_specific.severity (e.g. "MODERATE"). Some records
// only ship a CVSS vector under severity[] — we ignore those here and let the scanner default, since
// computing a bucket from a vector is out of scope for the cache.
function pickSeverity(r: OsvRecord): string | null {
    const ds = r.database_specific && r.database_specific.severity
    if (typeof ds === 'string' && ds.length > 0) return ds
    return null
}

function pickUrl(r: OsvRecord, advisoryId: string): string | null {
    if (Array.isArray(r.references)) {
        const advisory = r.references.find(function isAdvisory(ref) {
            return ref.type === 'ADVISORY' && isNonEmptyString(ref.url)
        })
        if (advisory && advisory.url) return advisory.url
        const web = r.references.find(function hasUrl(ref) {
            return isNonEmptyString(ref.url)
        })
        if (web && web.url) return web.url
    }
    if (r.database_specific && isNonEmptyString(r.database_specific.source)) {
        return r.database_specific.source as string
    }
    return 'https://osv.dev/vulnerability/' + advisoryId
}

function isNonEmptyString(v: unknown): v is string {
    return typeof v === 'string' && v.length > 0
}
