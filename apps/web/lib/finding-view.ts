// The detail pages' view over already-loaded findings: a severity floor and a sort, carried in the URL as
// ?sev= and ?sort= — the same values, and the same meaning, as the dashboard's psev / psort, so a project
// opened from the dashboard shows what the dashboard row was filtered and sorted by. Pure presentation,
// like the ?src= and ?eco= filters: the dep type is the only filter that changes the SQL.

import { meetsSeverityFloor } from '@sentinello/core'
import { VALID_MIN_SEVERITY, VALID_SORT, type MinSeverity, type SortKey } from './project-filters'

export const MIN_SEVERITY_PARAM = 'sev'
export const SORT_PARAM = 'sort'
export const DEFAULT_SORT: SortKey = 'severity'

export function parseMinSeverityParam(raw: string | null | undefined): MinSeverity {
    if (raw && (VALID_MIN_SEVERITY as string[]).includes(raw)) return raw as MinSeverity
    return ''
}

export function parseSortParam(raw: string | null | undefined): SortKey {
    if (raw && (VALID_SORT as string[]).includes(raw)) return raw as SortKey
    return DEFAULT_SORT
}

export function atOrAboveSeverity<T extends { severity: string }>(rows: T[], minSeverity: MinSeverity): T[] {
    if (!minSeverity) return rows
    return rows.filter(function meets(row) { return meetsSeverityFloor(row.severity, minSeverity) })
}

// Both producers (mergeFindings, groupByLibrary) already order worst-first, so 'severity' is their order.
// 'name' re-sorts by package name; the sort is stable, so severity still orders a package's own rows.
export function sortForView<T extends { packageName: string }>(rows: T[], sort: SortKey): T[] {
    if (sort === 'severity') return rows
    return rows.slice().sort(function byName(a, b) { return a.packageName.localeCompare(b.packageName) })
}
