// Pure source-ordering / param helpers shared by the (client) SourceFilter control and the (server)
// project/library pages. Kept in a non-'use client' module so server components can call orderSources
// to build the enabled-source list without importing across the client boundary.

import { ECOSYSTEMS } from '@sentinello/core'

export const SOURCE_PARAM = 'src'
export const ECOSYSTEM_PARAM = 'eco'

// npm audit before OSV before gemnasium before anything else, matching the row source-tag order so the
// filter reads consistently with the table.
const SOURCE_ORDER: Record<string, number> = { 'npm-audit': 0, osv: 1, gemnasium: 2 }

// Distinct sources, in display order. Used both for the enabled-source universe and to normalize order.
export function orderSources(scanners: Iterable<string>): string[] {
    return [...new Set(scanners)].sort(function order(a, b) {
        return (SOURCE_ORDER[a] ?? 9) - (SOURCE_ORDER[b] ?? 9) || a.localeCompare(b)
    })
}

// Short-form source label for chips and badges: 'npm', 'OSV', 'gemnasium'. Deliberately shorter than
// the registry's displayName ('npm audit', 'GitLab gemnasium') — these sit inside dense table cells,
// next to a reason phrase in the dashboard's State column. Never localized: source names are proper
// nouns everywhere in this repo. Lives here rather than in a component so the server-rendered State
// column and the client SourceFilter read the same table.
export function sourceLabel(source: string): string {
    if (source === 'npm-audit') return 'npm'
    if (source === 'osv') return 'OSV'
    if (source === 'gemnasium') return 'gemnasium'
    return source
}

// Parse the ?src= param into the selected source set, intersected with what's actually available so a
// stale / unknown / now-disabled source in the URL is silently ignored. Empty result = "all".
export function parseSourceParam(raw: string | null | undefined, available: string[]): string[] {
    if (!raw) return []
    const wanted = raw.split(',').map(function trim(s) { return s.trim() }).filter(Boolean)
    return available.filter(function isWanted(s) { return wanted.includes(s) })
}

// Ecosystem ordering for the language filter: registry order (JavaScript, Python, Go, Rust) first, then
// any unknown id alphabetically. Mirrors orderSources so the language filter reads consistently.
const ECOSYSTEM_ORDER: Record<string, number> = (function buildOrder() {
    const out: Record<string, number> = {}
    ECOSYSTEMS.forEach(function assign(eco, index) {
        out[eco.id] = index
    })
    return out
})()

export function orderEcosystems(ecosystems: Iterable<string>): string[] {
    return [...new Set(ecosystems)].sort(function order(a, b) {
        return (ECOSYSTEM_ORDER[a] ?? 99) - (ECOSYSTEM_ORDER[b] ?? 99) || a.localeCompare(b)
    })
}

// Parse the ?eco= param into the selected ecosystem set, intersected with the available universe so a
// stale id is ignored. Empty result = "all".
export function parseEcosystemParam(raw: string | null | undefined, available: string[]): string[] {
    if (!raw) return []
    const wanted = raw.split(',').map(function trim(s) { return s.trim() }).filter(Boolean)
    return available.filter(function isWanted(s) { return wanted.includes(s) })
}
