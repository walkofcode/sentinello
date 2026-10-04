import type { CurrentFindingRow } from '@sentinello/db'
import { compareSeverity, maxSeverity, type Severity } from '@sentinello/core'
import { highestVersion } from '@sentinello/versions'

export type LibraryGroup = {
    ecosystem: string
    packageName: string
    installedVersions: string[]
    maxSeverity: Severity
    severities: string[]
    advisoryCount: number
    // Rows whose fix is released, i.e. a version that exists and clears the row.
    fixedCount: number
    // The highest RELEASED fix, never one a source merely states.
    recommendedUpgrade: string | null
    // True when some row has no released fix. `noFixReleased` says whether any of them is proven to
    // have none, which is what the column shows instead of an upgrade.
    partial: boolean
    noFixReleased: boolean
    allMuted: boolean
    // True iff every finding for this library is reachable only from a dev dep — used to render
    // the "dev" chip at the group row. Matches the per-row chip rule (isDev && !isProd).
    devOnly: boolean
    findings: CurrentFindingRow[]
}

// Group current findings by (ecosystem, package name). One library can hit the same project from
// multiple dependency paths or even at multiple installed versions when hoisting fails; we keep all
// underlying findings on the group for the expanded sub-row and just summarize at the top. The ecosystem
// is part of the key so an npm `requests` and a PyPI `requests` stay distinct libraries (issue-019).
export function groupByLibrary(findings: CurrentFindingRow[]): LibraryGroup[] {
    // Buckets are typed non-empty: seeding with the first row instead of an empty array means every
    // rows[0] below is definite, with no unreachable emptiness guard to write or to leave uncovered.
    const byLibrary = new Map<string, [CurrentFindingRow, ...CurrentFindingRow[]]>()
    for (const f of findings) {
        const key = f.ecosystem + '\x00' + f.packageName
        const bucket = byLibrary.get(key)
        if (bucket) bucket.push(f)
        else byLibrary.set(key, [f])
    }
    const groups: LibraryGroup[] = []
    byLibrary.forEach(function buildGroup(rows) {
        const [head] = rows
        const ecosystem = head.ecosystem
        const packageName = head.packageName
        const installedVersions = uniq(rows.map(function pickVer(r) { return r.installedVersion }))
        const severities = uniq(rows.map(function pickSev(r) { return r.severity }))
        const released = rows.filter(function isReleased(r) { return r.fixStatus === 'released' && r.fixVersion !== null })
        const fixVersions = released.map(function pickFix(r) { return r.fixVersion as string })
        const fixedCount = released.length
        const partial = fixedCount < rows.length
        const noFixReleased = rows.some(function proven(r) { return r.fixStatus === 'none_released' })
        const allMuted = rows.length > 0 && rows.every(function muted(r) { return r.isMuted })
        const devOnly = rows.length > 0 && rows.every(function devish(r) { return r.isDev && !r.isProd })
        groups.push({
            ecosystem,
            packageName,
            installedVersions,
            maxSeverity: maxSeverity(severities),
            severities,
            advisoryCount: rows.length,
            fixedCount,
            recommendedUpgrade: highestVersion(fixVersions),
            partial,
            noFixReleased,
            allMuted,
            devOnly,
            findings: rows
        })
    })
    groups.sort(function order(a, b) {
        const sev = compareSeverity(a.maxSeverity, b.maxSeverity)
        if (sev !== 0) return sev
        return a.packageName.localeCompare(b.packageName) || a.ecosystem.localeCompare(b.ecosystem)
    })
    return groups
}

function uniq<T>(values: T[]): T[] {
    return Array.from(new Set(values))
}
