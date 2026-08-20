// The dashboard filter bar's URL contract, in one place. It used to live inside
// projects-filter-view.tsx, which the coverage globs exclude for being .tsx — so the one param that
// was serialized somewhere else (`pdep`, written by router.replace rather than by the shared merge)
// silently fell out of the remembered back-link and nothing caught it. Every `p*` param the dashboard
// owns is now written by mergeProjectFiltersIntoParams and read by parseProjectFiltersFromSearch,
// including pdep, so "which params does the dashboard have" has exactly one answer.

import type { DepTypeFilter } from '@sentinello/core'

export type MinSeverity = '' | 'critical' | 'high' | 'moderate' | 'low'
export type SortKey = 'name' | 'severity'

export type ProjectFiltersState = {
    query: string
    // Root ids, not paths: an absolute path may legally contain the comma these are joined on, and a
    // relabelled or moved root would otherwise invalidate every bookmarked filter URL.
    roots: string[]
    // Tag names. Safe to comma-join because TagEditor's input is itself comma-separated, so a tag can
    // never contain one (see components/triage/tag-editor.tsx).
    tags: string[]
    minSeverity: MinSeverity
    showHealthy: boolean
    showMuted: boolean
    sort: SortKey
    depType: DepTypeFilter
}

export const VALID_MIN_SEVERITY: MinSeverity[] = ['', 'critical', 'high', 'moderate', 'low']
export const VALID_SORT: SortKey[] = ['name', 'severity']
const VALID_DEP_TYPE: DepTypeFilter[] = ['all', 'prod', 'dev']

// Split a CSV param and intersect it with the available universe, mirroring parseSourceParam in
// components/findings/source-order.ts. The intersection is the point: a root deleted in Settings or a
// tag removed from every project leaves a stale id in a bookmarked URL, and dropping it silently beats
// filtering the table down to nothing with no visible control to clear.
export function parseCsvParam(raw: string | null | undefined, available: string[]): string[] {
    if (!raw) return []
    const wanted = raw.split(',').map(function trim(s) { return s.trim() }).filter(Boolean)
    return available.filter(function isWanted(v) { return wanted.includes(v) })
}

type Universe = {
    roots: string[]
    tags: string[]
}

export function parseProjectFiltersFromSearch(search: string, universe: Universe): Partial<ProjectFiltersState> {
    const params = new URLSearchParams(search)
    const out: Partial<ProjectFiltersState> = {}
    const q = params.get('pq')
    if (q) out.query = q
    const roots = parseCsvParam(params.get('proot'), universe.roots)
    if (roots.length > 0) out.roots = roots
    const tags = parseCsvParam(params.get('ptag'), universe.tags)
    if (tags.length > 0) out.tags = tags
    const sev = params.get('psev')
    if (sev && (VALID_MIN_SEVERITY as string[]).includes(sev)) out.minSeverity = sev as MinSeverity
    if (params.get('phealthy') === '1') out.showHealthy = true
    if (params.get('pmuted') === '1') out.showMuted = true
    const s = params.get('psort')
    if (s && (VALID_SORT as string[]).includes(s)) out.sort = s as SortKey
    const dep = params.get('pdep')
    if (dep && (VALID_DEP_TYPE as string[]).includes(dep)) out.depType = dep as DepTypeFilter
    return out
}

// Merges INTO the caller's params rather than building fresh, so unrelated params on the same URL
// (the libraries view's l* family) survive a dashboard filter change.
export function mergeProjectFiltersIntoParams(
    params: URLSearchParams,
    state: ProjectFiltersState,
    defaultDepType: DepTypeFilter
): URLSearchParams {
    upsertParam(params, 'pq', state.query)
    upsertParam(params, 'proot', state.roots.length > 0 && state.roots.join(','))
    upsertParam(params, 'ptag', state.tags.length > 0 && state.tags.join(','))
    upsertParam(params, 'psev', state.minSeverity)
    upsertParam(params, 'phealthy', state.showHealthy && '1')
    upsertParam(params, 'pmuted', state.showMuted && '1')
    upsertParam(params, 'psort', state.sort !== 'severity' && state.sort)
    // The operator's configured default is not worth carrying — a URL that spells out the setting the
    // instance already has is noise, and omitting it keeps a shared link honest if that default moves.
    upsertParam(params, 'pdep', state.depType !== defaultDepType && state.depType)
    return params
}

export function upsertParam(params: URLSearchParams, key: string, value: string | false | undefined): void {
    if (value) params.set(key, value)
    else params.delete(key)
}

// Builds the full same-document URL for a filter state, preserving path, sibling params and hash.
export function buildProjectFiltersUrl(
    location: { pathname: string; search: string; hash: string },
    state: ProjectFiltersState,
    defaultDepType: DepTypeFilter
): string {
    const params = mergeProjectFiltersIntoParams(new URLSearchParams(location.search), state, defaultDepType)
    const search = params.toString()
    return location.pathname + (search && '?' + search) + location.hash
}
