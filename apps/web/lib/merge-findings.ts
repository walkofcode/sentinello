import type { CurrentFindingRow } from '@sentinello/db'
import { compareSeverity, maxSeverity, requireComparator, type FindingInstallation, type FixCheck, type FixStatus, type NotRecheckedBecause, type Remediation, type Severity } from '@sentinello/core'
import { compareVersions } from '@sentinello/versions'
import { parseJsonArray } from '@/lib/format'

// A findings row collapsed across sources and dependency paths. The raw table stores one row per
// (scanner, advisory, dep-path), so the same vulnerability shows up many times: once per route into the
// tree, and again for each source that reports it (npm audit AND OSV). We merge by (ecosystem, package,
// advisory identity) so each real vulnerability is ONE row carrying every source as a tag, the best
// settled fix (see betterFix), the union of installed versions, and the union
// of dep paths. The ecosystem is part of the key so an npm `requests` and a PyPI `requests` sharing a
// CVE/title never collapse into one row (issue-019).
export type MergedFinding = {
    key: string
    ecosystem: string
    packageName: string
    installedVersion: string
    // Every (manifest, version) any merged row was installed through, each once, by manifest path: a library
    // in two Gemfile.locks lists both. Empty when every row predates 3.8.
    installations: FindingInstallation[]
    severity: Severity
    // Set when every row of the group is a notice, not a vulnerability: anyone reporting it as a vulnerability
    // makes it one, and then only those rows speak for it (gradedRows). A notice row has no place in the counts
    // (notNoticeSql), and the page lists it apart.
    noticeKind: string | null
    malicious: boolean
    scanners: string[]
    advisoryId: string
    advisoryTitle: string | null
    advisoryUrl: string | null
    vulnerableRange: string
    // The best-settled fix among the merged rows (see betterFix): released over unverified over
    // none_released.
    fixStatus: FixStatus
    fixAvailable: boolean
    fixVersion: string | null
    fixCheck: FixCheck | null
    // The way out, carried with the chosen fix: set only when that fix is 'none_released'.
    remediation: Remediation | null
    // Carried with the chosen fix too: set when the source whose row gave the fix last failed to scan the
    // project, so the fix shown is what an earlier scan left, not re-checked since.
    notRecheckedBecause: NotRecheckedBecause | null
    // Non-empty by construction: a bucket always has at least one row, and every row carries a dep path.
    // Typed as a tuple so consumers reading depPaths[0] need no fallback for an empty case that the
    // merge cannot produce. A row's path is empty when its lockfile records no dependency graph
    // (requirements.txt, go.mod): the chain is unknown, and every surface says so.
    depPaths: [string[], ...string[][]]
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

// Cross-source identity of a vulnerability: the key refreshAdvisoryKeys wrote from ids and aliases, never the
// title, since a generic title merges different vulnerabilities (SENTINEL-174). The fallback covers only an old
// resolved row and the moment between migration and boot: the row's own source and id. Mirrors advisoryIdentitySql
// in packages/db, so SQL counts and these JS counts agree. Exported so the library views dedupe the same way.
export function advisoryIdentity(row: { advisoryKey: string | null; source: string; advisoryId: string }): string {
    return row.advisoryKey ?? row.source + ':' + row.advisoryId
}

// A group holding both kinds is a vulnerability, and a notice claims no grade: its severity, its fix and its
// advisory text come from the rows that report a vulnerability, exactly as the SQL buckets exclude notices
// (notNoticeSql) before taking their maximum. A notice row keeps its place in the group's sources, identities and
// installed copies. This can happen when a source that failed keeps its old row while another refreshes its own to
// a notice. An all-notice group has only its notices to read.
function gradedRows(bucket: [CurrentFindingRow, ...CurrentFindingRow[]]): [CurrentFindingRow, ...CurrentFindingRow[]] {
    const real = bucket.filter(function vulnerability(r) { return r.noticeKind === null })
    return real.length > 0 ? real as [CurrentFindingRow, ...CurrentFindingRow[]] : bucket
}

// The library views list rows rather than merged ones, so they apply the same rule by dropping the notice rows of
// a project's group that also holds a vulnerability; list_libraries' distinct_notices does so in SQL. Only rows
// the caller passes are weighed, as with the counts' own filters.
export function withoutMixedGroupNotices<T extends { projectId: string; noticeKind: string | null; advisoryKey: string | null; source: string; advisoryId: string }>(rows: readonly T[]): T[] {
    function groupOf(row: T): string { return row.projectId + '\x00' + advisoryIdentity(row) }
    const vulnerable = new Set(rows.filter(function real(r) { return r.noticeKind === null }).map(groupOf))
    return rows.filter(function keep(r) { return r.noticeKind === null || !vulnerable.has(groupOf(r)) })
}

// npm audit joins multiple hoisted copies into one comma-separated installedVersion ("4.17.21, 4.17.11")
// while OSV emits one concrete version per row; union them across the bucket so the merged row shows every
// affected version once, sorted, regardless of which source contributed it.
function unionInstalledVersions(bucket: [CurrentFindingRow, ...CurrentFindingRow[]]): string {
    const comparator = requireComparator(bucket[0].ecosystem)
    const seen = new Set<string>()
    for (const r of bucket) {
        for (const part of r.installedVersion.split(',')) {
            const v = part.trim()
            if (v.length > 0) seen.add(v)
        }
    }
    return [...seen].sort(function byVersion(a, b) { return compareVersions(a, b, comparator) }).join(', ')
}

// The advisory text/link shown for a merged row: prefer a row that actually has a URL, and among those
// the npm-audit one (its advisory tends to carry the remediation), so the link is the actionable one. The
// npm-audit preference only ever applies to npm rows: npm audit reports npm alone, and a bucket never mixes
// ecosystems (the merge key starts with it), so a PyPI, Go, Rust or Ruby row is chosen on its URL alone.
function preferAdvisory(candidate: CurrentFindingRow, current: CurrentFindingRow): boolean {
    const candidateHasUrl = Boolean(candidate.advisoryUrl)
    const currentHasUrl = Boolean(current.advisoryUrl)
    if (candidateHasUrl !== currentHasUrl) return candidateHasUrl
    const candidateNpm = candidate.scanner === 'npm-audit'
    const currentNpm = current.scanner === 'npm-audit'
    if (candidateNpm !== currentNpm) return candidateNpm
    return false
}

// The order a merged row's fix is chosen in. A row no settlement has written yet ranks below every
// settled one: its fix is withheld, and "rescan pending" must not hide what another row proved. Among
// settled rows a released fix is a fact and wins, the highest one when rows disagree (it clears every
// row's range). An unverified row beats none_released, because "no fixed version" is only true for the
// row that proved it; among unverified rows a stated version beats "npm says a parent fixes it", which
// beats nothing.
const FIX_STATUS_RANK: Record<FixStatus, number> = { released: 3, unverified: 2, none_released: 1 }

function fixRank(row: CurrentFindingRow): number {
    return row.fixCheck === null ? 0 : FIX_STATUS_RANK[row.fixStatus]
}

function betterFix(candidate: CurrentFindingRow, current: CurrentFindingRow): boolean {
    const byStatus = fixRank(candidate) - fixRank(current)
    if (byStatus !== 0) return byStatus > 0
    const byVersion = Number(candidate.fixVersion !== null) - Number(current.fixVersion !== null)
    if (byVersion !== 0) return byVersion > 0
    // Equal on the line above, so both carry a version or neither does.
    if (candidate.fixVersion !== null) return compareVersions(candidate.fixVersion, current.fixVersion as string, requireComparator(candidate.ecosystem)) > 0
    return candidate.fixAvailable && !current.fixAvailable
}

// The bucket is typed non-empty, so `first` is definite and every field below reads from a real row
// without an unreachable emptiness guard.
function mergeBucket(key: string, bucket: [CurrentFindingRow, ...CurrentFindingRow[]]): MergedFinding {
    const [first] = bucket
    const graded = gradedRows(bucket)
    let severity = graded[0].severity
    let malicious = false
    let isProd = false
    let isDev = false
    let firstDetectedAt: number | null = null
    let lastSeenAt: number | null = null
    let advisoryRow = graded[0]
    let fixRow = graded[0]
    const scannerSet = new Set<string>()
    const identityKeys = new Set<string>()
    const identities: { source: string; ecosystem: string; scanner: string; advisoryId: string }[] = []
    const gradeKeys = new Set<string>()
    const grades: { source: string; advisoryId: string; severity: Severity }[] = []
    // Seeded from `first` rather than filled entirely by the loop, so the tuple type holds. The loop
    // still visits `first` and the key check skips it, leaving the resulting order unchanged.
    const depPathKeys = new Set<string>([first.depPathJson])
    const depPaths: [string[], ...string[][]] = [parseJsonArray(first.depPathJson)]
    const installations = new Map<string, FindingInstallation>()
    for (const r of bucket) {
        for (const i of r.installations) installations.set(i.manifestPath + '\x00' + i.version, i)
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
        for (const c of r.corroborations) scannerSet.add(c.source)
        const identityKey = r.source + '\x00' + r.ecosystem + '\x00' + r.advisoryId
        if (!identityKeys.has(identityKey)) {
            identityKeys.add(identityKey)
            identities.push({ source: r.source, ecosystem: r.ecosystem, scanner: r.scanner, advisoryId: r.advisoryId })
        }
        if (!depPathKeys.has(r.depPathJson)) {
            depPathKeys.add(r.depPathJson)
            depPaths.push(parseJsonArray(r.depPathJson))
        }
    }
    for (const r of graded) {
        severity = maxSeverity([severity, r.severity])
        for (const c of r.corroborations) {
            if (!gradeKeys.has(c.source)) {
                gradeKeys.add(c.source)
                grades.push({ source: c.source, advisoryId: c.advisoryId, severity: c.severity as Severity })
            }
        }
        if (!gradeKeys.has(r.source)) {
            gradeKeys.add(r.source)
            grades.push({ source: r.source, advisoryId: r.advisoryId, severity: r.severity as Severity })
        }
        if (preferAdvisory(r, advisoryRow)) advisoryRow = r
        if (betterFix(r, fixRow)) fixRow = r
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
        installations: [...installations.values()].sort(function byManifest(a, b) { return a.manifestPath.localeCompare(b.manifestPath) || a.version.localeCompare(b.version) }),
        severity: severity as Severity,
        // `first` is one row of the group, so `every` holding means its kind is the group's.
        noticeKind: bucket.every(function isNotice(r) { return r.noticeKind !== null }) ? first.noticeKind : null,
        malicious,
        scanners,
        grades,
        advisoryId: advisoryRow.advisoryId,
        advisoryTitle: advisoryRow.advisoryTitle,
        advisoryUrl: advisoryRow.advisoryUrl,
        // The range the chosen fix was measured against, when there is a version to measure.
        vulnerableRange: (fixRow.fixVersion !== null ? fixRow : advisoryRow).vulnerableRange,
        fixStatus: fixRow.fixStatus,
        fixAvailable: fixRow.fixAvailable,
        fixVersion: fixRow.fixVersion,
        fixCheck: fixRow.fixCheck,
        remediation: fixRow.remediation,
        notRecheckedBecause: fixRow.notRecheckedBecause,
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
        const key = row.ecosystem + '\x00' + row.packageName + '\x00' + advisoryIdentity(row)
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
