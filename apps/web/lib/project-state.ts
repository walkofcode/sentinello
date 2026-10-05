import { groupScanReasons, type Locale, type ScanState, type ScanStateSide } from '@sentinello/core'
import type { ProjectCatalogRow } from '@sentinello/db'

// How the dashboard's State column reads a project's scan state.
//
// Lives here rather than in projects-filter-view.tsx because .tsx is outside the coverage globs: the
// decisions below are the ones worth pinning, and in the component they would ship untested.

// Healthy = the project was fully scanned (every expected source answered, every detected ecosystem was
// read) and nothing was found. Anything less is not healthy: a project nothing could read has zero
// findings because nothing looked, and one nothing has scanned yet is unexamined, not clean.
export function isProjectHealthy(row: ProjectCatalogRow, findingCount: number): boolean {
    return row.scanState.state === 'scanned' && findingCount === 0
}

// The State badge: the scan state as one word, or null for a fully scanned project, which shows nothing
// rather than a row of green reassurance.
export function scanStateBadge(state: ScanState): 'cannotScan' | 'partial' | 'notScannedYet' | null {
    if (state.state === 'cannot_scan') return 'cannotScan'
    if (state.state === 'partial') return 'partial'
    if (state.state === 'not_scanned_yet') return 'notScannedYet'
    return null
}

// The badge's tooltip: every reason, labelled in the reader's locale, with whose fix it is — "No lockfile
// (the project) · OSV database not downloaded yet (this Sentinello install) · npm: Has not run yet".
// `sides` carries the two side words in the same locale.
export function scanStateReasonsText(state: ScanState, locale: Locale, sides: Record<ScanStateSide, string>): string {
    return groupScanReasons(state.reasons, locale).map(function line(group) {
        if (group.side === null) return group.subjects.join(', ') + ': ' + group.label
        return group.label + ' (' + sides[group.side] + ')'
    }).join(' · ')
}
