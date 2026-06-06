// Pure source-ordering / param helpers shared by the (client) SourceFilter control and the (server)
// project/library pages. Kept in a non-'use client' module so server components can call orderSources
// to build the enabled-source list without importing across the client boundary.

export const SOURCE_PARAM = 'src'

// npm audit before OSV before anything else, matching the row source-tag order so the filter reads
// consistently with the table.
const SOURCE_ORDER: Record<string, number> = { 'npm-audit': 0, osv: 1 }

// Distinct sources, in display order. Used both for the enabled-source universe and to normalize order.
export function orderSources(scanners: Iterable<string>): string[] {
    return [...new Set(scanners)].sort(function order(a, b) {
        return (SOURCE_ORDER[a] ?? 9) - (SOURCE_ORDER[b] ?? 9) || a.localeCompare(b)
    })
}

// Parse the ?src= param into the selected source set, intersected with what's actually available so a
// stale / unknown / now-disabled source in the URL is silently ignored. Empty result = "all".
export function parseSourceParam(raw: string | null | undefined, available: string[]): string[] {
    if (!raw) return []
    const wanted = raw.split(',').map(function trim(s) { return s.trim() }).filter(Boolean)
    return available.filter(function isWanted(s) { return wanted.includes(s) })
}
