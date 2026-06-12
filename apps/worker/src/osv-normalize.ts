import type { OsvAdvisoryRow, OsvRange } from '@sentinello/db'

// Parses a single OSV record (one *.json file from a per-ecosystem export, or one /v1/vulns response) into
// the denormalized advisory→package rows we cache. One record can affect multiple packages, each with its
// own ranges, so this returns 0..N rows. Only the affected entries for the TARGET ecosystem are kept — the
// caller passes the canonical OSV ecosystem id (e.g. 'npm' | 'PyPI' | 'Go' | 'crates.io') it is syncing,
// because one OSV record can list packages across several ecosystems and each ecosystem is synced
// independently from its own export/cursor (mixing them would let one ecosystem's sync clobber another's).
//
// Two record families matter:
//   - GHSA/CVE : a real advisory with version ranges (introduced/fixed/last_affected events) and a severity
//                bucket. Ranges may be SEMVER (npm/Go/Rust) or ECOSYSTEM (PyPI PEP 440); both are retained.
//   - MAL-xxxx : a malicious package; the whole package is bad (introduced "0", no fix). Flagged
//                `malicious: true` so the scanner and UI treat it as a distinct threat class.

type OsvEvent = { introduced?: string; fixed?: string; last_affected?: string }
type OsvRangeRaw = { type?: string; events?: OsvEvent[] }
type OsvPackage = { name?: string; ecosystem?: string; purl?: string }
type OsvAffected = { package?: OsvPackage; ranges?: OsvRangeRaw[]; versions?: string[] }
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

export function normalizeOsvRecord(record: unknown, ecosystem: string): OsvAdvisoryRow[] {
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
        // Keep only the ecosystem currently being synced (OSV uses the canonical ids 'npm'/'PyPI'/'Go'/
        // 'crates.io' verbatim in `package.ecosystem`). Other ecosystems are handled by their own sync.
        if (!pkg || pkg.ecosystem !== ecosystem) continue
        const packageName = typeof pkg.name === 'string' ? pkg.name : null
        if (!packageName) continue
        // One advisory can list the same package twice; collapse to a single row with merged ranges.
        if (seenPackages.has(packageName)) continue
        seenPackages.add(packageName)
        // Parse the real affected set for ALL records, malware included. Malware advisories pin the
        // compromised builds in `versions` (e.g. ["4.4.2"]) and frequently carry a usable range too
        // (e.g. fsevents >=1.0.0 <1.2.11) — discarding either (the old `maliciousRange()` shortcut) is
        // what made the matcher flag clean, remediated versions as compromised.
        const ranges = extractRanges(affected.ranges)
        const versions = extractVersions(affected.versions)
        // A record we can't match on at all (no range AND no enumerated version) is only worth keeping
        // for malware, where the engine falls back to flag-by-presence; otherwise skip it.
        if (ranges.length === 0 && versions.length === 0 && !malicious) continue
        rows.push({
            advisoryId,
            ecosystem,
            packageName,
            aliases,
            ranges,
            versions,
            severity,
            summary,
            url,
            malicious,
            withdrawn
        })
    }
    return rows
}

function extractVersions(versions: string[] | undefined): string[] {
    if (!Array.isArray(versions)) return []
    const out: string[] = []
    for (const v of versions) {
        if (typeof v === 'string' && v.length > 0) out.push(v)
    }
    return out
}

function extractRanges(ranges: OsvRangeRaw[] | undefined): OsvRange[] {
    if (!Array.isArray(ranges)) return []
    const out: OsvRange[] = []
    for (const range of ranges) {
        // Retain SEMVER (npm/Go/Rust) and ECOSYSTEM (PyPI PEP 440) ranges — the ecosystem's comparator
        // interprets the version strings. GIT ranges carry commit hashes, not versions, and no comparator
        // can evaluate them, so they are dropped (keeping them would only add unmatchable noise).
        const type = typeof range.type === 'string' ? range.type : 'SEMVER'
        if (type !== 'SEMVER' && type !== 'ECOSYSTEM') continue
        if (!Array.isArray(range.events)) continue
        let introduced: string | null = null
        let lastAffected: string | null = null
        for (const event of range.events) {
            if (typeof event.introduced === 'string') {
                // A new `introduced` opens a fresh interval. Flush any prior open interval that only had a
                // last_affected bound (no fixed) before starting the next one.
                if (introduced !== null) {
                    out.push({ type, introduced, fixed: null, lastAffected })
                    lastAffected = null
                }
                introduced = event.introduced
                continue
            }
            if (typeof event.fixed === 'string' && introduced !== null) {
                out.push({ type, introduced, fixed: event.fixed, lastAffected: null })
                introduced = null
                lastAffected = null
                continue
            }
            if (typeof event.last_affected === 'string' && introduced !== null) {
                // Inclusive upper bound with no clean fix — remember it for the current interval.
                lastAffected = event.last_affected
            }
        }
        // A trailing introduced with no fixed = open-ended (or last_affected-bounded) vulnerable range.
        if (introduced !== null) {
            out.push({ type, introduced, fixed: null, lastAffected })
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
