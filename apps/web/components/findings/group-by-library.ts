import type { CurrentFindingRow } from '@sentinello/db'
import { maxSeverity, severityRank, type Severity } from '@sentinello/core'

export type LibraryGroup = {
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

// Group current findings by package name. One library can hit the same project from multiple
// dependency paths or even at multiple installed versions when hoisting fails; we keep all
// underlying findings on the group for the expanded sub-row and just summarize at the top.
export function groupByLibrary(findings: CurrentFindingRow[]): LibraryGroup[] {
    const byPackage = new Map<string, CurrentFindingRow[]>()
    for (const f of findings) {
        const bucket = byPackage.get(f.packageName) || []
        bucket.push(f)
        byPackage.set(f.packageName, bucket)
    }
    const groups: LibraryGroup[] = []
    byPackage.forEach(function buildGroup(rows, packageName) {
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
            packageName,
            installedVersions,
            maxSeverity: maxSeverity(severities),
            severities,
            advisoryCount: rows.length,
            fixedCount,
            recommendedUpgrade: pickHighestVersion(fixVersions),
            partial,
            allMuted,
            devOnly,
            findings: rows
        })
    })
    groups.sort(function order(a, b) {
        const ra = severityRank(a.maxSeverity)
        const rb = severityRank(b.maxSeverity)
        if (ra !== rb) return ra - rb
        return a.packageName.localeCompare(b.packageName)
    })
    return groups
}

function uniq<T>(values: T[]): T[] {
    return Array.from(new Set(values))
}

// fixVersion values are extracted from advisory ranges by the scanner via regex
// (pickFirstVersionFromRange in packages/scanners/src/npm-audit.ts), so they're plain
// "x.y.z" or "x.y.z-prerelease" strings. We compare numerically segment by segment to
// avoid pulling in a full semver dep for what's a 20-line problem.
function pickHighestVersion(versions: string[]): string | null {
    if (versions.length === 0) return null
    let best = versions[0]
    for (let i = 1; i < versions.length; i++) {
        if (compareVersions(versions[i], best) > 0) best = versions[i]
    }
    return best
}

export function compareVersions(a: string, b: string): number {
    const [aBase, aPre] = splitPrerelease(a)
    const [bBase, bPre] = splitPrerelease(b)
    const aParts = aBase.split('.').map(toIntOrZero)
    const bParts = bBase.split('.').map(toIntOrZero)
    const len = Math.max(aParts.length, bParts.length)
    for (let i = 0; i < len; i++) {
        const ai = aParts[i] || 0
        const bi = bParts[i] || 0
        if (ai > bi) return 1
        if (ai < bi) return -1
    }
    // Stable semver rule: a version with a prerelease tag is LOWER than the same version without.
    if (aPre === null && bPre !== null) return 1
    if (aPre !== null && bPre === null) return -1
    if (aPre === null && bPre === null) return 0
    return (aPre as string).localeCompare(bPre as string)
}

function splitPrerelease(v: string): [string, string | null] {
    const stripped = v.replace(/^[v=]+/, '')
    const dash = stripped.indexOf('-')
    if (dash === -1) return [stripped, null]
    return [stripped.slice(0, dash), stripped.slice(dash + 1)]
}

function toIntOrZero(s: string): number {
    const n = parseInt(s, 10)
    return Number.isFinite(n) ? n : 0
}
