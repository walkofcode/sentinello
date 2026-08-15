import type { CurrentFindingRow } from '@sentinello/db'
import { compareSeverity, severityWeight, type Severity } from '@sentinello/core'
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
    // Every source's own grade for this vulnerability, worst first — the surviving row's included. This
    // is what makes the escalation legible: a row shown as critical because ONE source graded it so,
    // while the others called it high, is a different fact from three sources agreeing on critical.
    grades: { source: string; advisoryId: string; severity: Severity }[]
}

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

// The bucket is typed non-empty, so `first` is definite and every field below reads from a real row
// without an unreachable emptiness guard.
function mergeBucket(key: string, bucket: [CurrentFindingRow, ...CurrentFindingRow[]]): MergedFinding {
    const [first] = bucket
    let severity = first.severity
    let malicious = false
    let isProd = false
    let isDev = false
    let firstDetectedAt: number | null = null
    let lastSeenAt: number | null = null
    let advisoryRow = first
    let fixRow: CurrentFindingRow | null = null
    const scannerSet = new Set<string>()
    const identityKeys = new Set<string>()
    const identities: { source: string; ecosystem: string; scanner: string; advisoryId: string }[] = []
    const gradeKeys = new Set<string>()
    const grades: { source: string; advisoryId: string; severity: Severity }[] = []
    const depPathKeys = new Set<string>()
    const depPaths: string[][] = []
    for (const r of bucket) {
        if (severityWeight(r.severity) > severityWeight(severity)) severity = r.severity
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
        // A source that reported this same advisory at scan time but was reconciled away still counts
        // as having reported it: its badge belongs here exactly as much as a row-level one.
        for (const c of r.corroborations) {
            scannerSet.add(c.source)
            if (!gradeKeys.has(c.source)) {
                gradeKeys.add(c.source)
                grades.push({ source: c.source, advisoryId: c.advisoryId, severity: c.severity as Severity })
            }
        }
        if (!gradeKeys.has(r.source)) {
            gradeKeys.add(r.source)
            grades.push({ source: r.source, advisoryId: r.advisoryId, severity: r.severity as Severity })
        }
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
    grades.sort(function worstFirst(a, b) {
        return compareSeverity(a.severity, b.severity) || a.source.localeCompare(b.source)
    })
    const scanners = [...scannerSet].sort(function order(a, b) {
        return (SCANNER_ORDER[a] ?? 9) - (SCANNER_ORDER[b] ?? 9) || a.localeCompare(b)
    })
    // Shortest dep path first — it's the most direct route, the one worth showing.
    depPaths.sort(function byLength(a, b) { return a.length - b.length })
    return {
        key,
        ecosystem: first.ecosystem,
        packageName: first.packageName,
        installedVersion: unionInstalledVersions(bucket),
        severity: severity as Severity,
        malicious,
        scanners,
        grades,
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
    const groups = new Map<string, [CurrentFindingRow, ...CurrentFindingRow[]]>()
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
        const sev = compareSeverity(a.severity, b.severity)
        if (sev !== 0) return sev
        return a.packageName.localeCompare(b.packageName) || a.installedVersion.localeCompare(b.installedVersion)
    })
    return out
}
