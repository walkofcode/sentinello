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
    fixedCount: number
    recommendedUpgrade: string | null
    partial: boolean
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
        const fixVersions = rows
            .map(function pickFix(r) { return r.fixVersion })
            .filter(function nonNull(v): v is string { return Boolean(v) })
        const fixedCount = rows.filter(function isFixed(r) { return r.fixAvailable && Boolean(r.fixVersion) }).length
        const partial = rows.some(function unfixed(r) { return !r.fixAvailable || !r.fixVersion })
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
