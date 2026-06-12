import type { CurrentFindingRow } from '@sentinello/db'
import type { Severity } from '@sentinello/core'
import { parseJsonArray } from '@/lib/format'

// A findings row collapsed across sources and dependency paths. The raw table stores one row per
// (scanner, advisory, dep-path), so the same vulnerability shows up many times: once per route into the
// tree, and again for each source that reports it (npm audit AND OSV). We merge by (ecosystem, package,
// advisory identity) so each real vulnerability is ONE row carrying every source as a tag, the best
// available fix (OSV often has none while npm audit does), the union of installed versions, and the union
// of dep paths. The ecosystem is part of the key so an npm `requests` and a PyPI `requests` sharing a
// CVE/title never collapse into one row (issue-019).
export type MergedFinding = {
    key: string
    ecosystem: string
    packageName: string
    installedVersion: string
    severity: Severity
    malicious: boolean
    scanners: string[]
    advisoryId: string
    advisoryTitle: string | null
    advisoryUrl: string | null
    vulnerableRange: string
    fixAvailable: boolean
    fixVersion: string | null
    depPaths: string[][]
    isProd: boolean
    isDev: boolean
    firstDetectedAt: number | null
    lastSeenAt: number | null
    // One entry per underlying source advisory. `source`/`ecosystem` are the persisted mute identity
    // (issue-016); `scanner` is kept for provenance/display. Keyed by (source, ecosystem, advisory).
    identities: { source: string; ecosystem: string; scanner: string; advisoryId: string }[]
}

const SEVERITY_RANK: Record<string, number> = { critical: 5, high: 4, moderate: 3, low: 2, info: 1 }
// npm audit before OSV before gemnasium before anything else, so the source tags read consistently across rows.
const SCANNER_ORDER: Record<string, number> = { 'npm-audit': 0, osv: 1, gemnasium: 2 }

// Two findings are the same vulnerability when they sit on the same package@version and describe the
// same advisory. npm audit and OSV use different ids for the same CVE, but share the advisory title, so
// the title (when present) is the cross-source key; we fall back to the id for title-less records.
// Cross-source identity of a vulnerability. npm-audit and OSV assign different ids to the same CVE
// but share the title, so the normalized title is the identity when present, else the id. The
// 't:'/'a:' prefixes keep a title from ever colliding with an id. Mirrors advisoryIdentitySql in
// packages/db so SQL counts and these JS counts agree. Exported so the library views dedupe the same way.
export function advisoryIdentity(title: string | null, id: string): string {
    const normalized = title ? title.trim().toLowerCase() : ''
    return normalized.length > 0 ? 't:' + normalized : 'a:' + id
}

function advisoryKey(row: CurrentFindingRow): string {
    return advisoryIdentity(row.advisoryTitle, row.advisoryId)
}

function compareSemver(a: string, b: string): number {
    const pa = a.split('.')
    const pb = b.split('.')
    const len = Math.max(pa.length, pb.length)
    for (let i = 0; i < len; i++) {
        const na = parseInt(pa[i] ?? '0', 10)
        const nb = parseInt(pb[i] ?? '0', 10)
        const va = Number.isNaN(na) ? 0 : na
        const vb = Number.isNaN(nb) ? 0 : nb
        if (va !== vb) return va - vb
    }
    return 0
}

// npm audit joins multiple hoisted copies into one comma-separated installedVersion ("4.17.21, 4.17.11")
// while OSV emits one concrete version per row; union them across the bucket so the merged row shows every
// affected version once, sorted, regardless of which source contributed it.
function unionInstalledVersions(bucket: CurrentFindingRow[]): string {
    const seen = new Set<string>()
    for (const r of bucket) {
        for (const part of r.installedVersion.split(',')) {
            const v = part.trim()
            if (v.length > 0) seen.add(v)
        }
    }
    return [...seen].sort(compareSemver).join(', ')
}

// The advisory text/link shown for a merged row: prefer a row that actually has a URL, and among those
// the npm-audit one (its advisory tends to carry the remediation), so the link is the actionable one.
function preferAdvisory(candidate: CurrentFindingRow, current: CurrentFindingRow): boolean {
    const candidateHasUrl = Boolean(candidate.advisoryUrl)
    const currentHasUrl = Boolean(current.advisoryUrl)
    if (candidateHasUrl !== currentHasUrl) return candidateHasUrl
    const candidateNpm = candidate.scanner === 'npm-audit'
    const currentNpm = current.scanner === 'npm-audit'
    if (candidateNpm !== currentNpm) return candidateNpm
    return false
}

function mergeBucket(key: string, bucket: CurrentFindingRow[]): MergedFinding {
    let severity = bucket[0].severity
    let malicious = false
    let isProd = false
    let isDev = false
    let firstDetectedAt: number | null = null
    let lastSeenAt: number | null = null
    let advisoryRow = bucket[0]
    let fixRow: CurrentFindingRow | null = null
    const scannerSet = new Set<string>()
    const identityKeys = new Set<string>()
    const identities: { source: string; ecosystem: string; scanner: string; advisoryId: string }[] = []
    const depPathKeys = new Set<string>()
    const depPaths: string[][] = []
    for (const r of bucket) {
        if ((SEVERITY_RANK[r.severity] ?? 0) > (SEVERITY_RANK[severity] ?? 0)) severity = r.severity
        if (r.advisoryId.startsWith('MAL-')) malicious = true
        if (r.isProd) isProd = true
        if (r.isDev) isDev = true
        if (r.firstDetectedAt !== null) {
            firstDetectedAt = firstDetectedAt === null ? r.firstDetectedAt : Math.min(firstDetectedAt, r.firstDetectedAt)
        }
        if (r.lastSeenAt !== null) {
            lastSeenAt = lastSeenAt === null ? r.lastSeenAt : Math.max(lastSeenAt, r.lastSeenAt)
        }
        scannerSet.add(r.scanner)
        const identityKey = r.source + '\x00' + r.ecosystem + '\x00' + r.advisoryId
        if (!identityKeys.has(identityKey)) {
            identityKeys.add(identityKey)
            identities.push({ source: r.source, ecosystem: r.ecosystem, scanner: r.scanner, advisoryId: r.advisoryId })
        }
        if (!depPathKeys.has(r.depPathJson)) {
            depPathKeys.add(r.depPathJson)
            depPaths.push(parseJsonArray(r.depPathJson))
        }
        if (preferAdvisory(r, advisoryRow)) advisoryRow = r
        if (r.fixAvailable && r.fixVersion) {
            if (!fixRow || compareSemver(r.fixVersion, fixRow.fixVersion as string) > 0) fixRow = r
        }
    }
    const scanners = [...scannerSet].sort(function order(a, b) {
        return (SCANNER_ORDER[a] ?? 9) - (SCANNER_ORDER[b] ?? 9) || a.localeCompare(b)
    })
    // Shortest dep path first — it's the most direct route, the one worth showing.
    depPaths.sort(function byLength(a, b) { return a.length - b.length })
    return {
        key,
        ecosystem: bucket[0].ecosystem,
        packageName: bucket[0].packageName,
        installedVersion: unionInstalledVersions(bucket),
        severity: severity as Severity,
        malicious,
        scanners,
        advisoryId: advisoryRow.advisoryId,
        advisoryTitle: advisoryRow.advisoryTitle,
        advisoryUrl: advisoryRow.advisoryUrl,
        vulnerableRange: (fixRow ?? advisoryRow).vulnerableRange,
        fixAvailable: Boolean(fixRow),
        fixVersion: fixRow ? fixRow.fixVersion : null,
        depPaths,
        isProd,
        isDev,
        firstDetectedAt,
        lastSeenAt,
        identities
    }
}

export function mergeFindings(rows: CurrentFindingRow[]): MergedFinding[] {
    const groups = new Map<string, CurrentFindingRow[]>()
    for (const row of rows) {
        const key = row.ecosystem + '\x00' + row.packageName + '\x00' + advisoryKey(row)
        const bucket = groups.get(key)
        if (bucket) bucket.push(row)
        else groups.set(key, [row])
    }
    const out: MergedFinding[] = []
    for (const [key, bucket] of groups) {
        out.push(mergeBucket(key, bucket))
    }
    // Keep the worst first; stable tiebreak on name/version so paging is deterministic.
    out.sort(function bySeverityThenName(a, b) {
        const rank = (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0)
        if (rank !== 0) return rank
        return a.packageName.localeCompare(b.packageName) || a.installedVersion.localeCompare(b.installedVersion)
    })
    return out
}
