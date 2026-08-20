import { isSourceUnavailableReason, reasonCodeLabel, type Locale, type ReasonCode } from '@sentinello/core'
import type { ProjectCatalogRow, ProjectScanState } from '@sentinello/db'
import { sourceLabel } from '@/components/findings/source-order'

// How the dashboard's State column reads a project's per-source scan verdicts.
//
// Lives here rather than in projects-filter-view.tsx because .tsx is outside the coverage globs: the
// decisions below are the ones worth pinning, and in the component they would ship untested.

// The sources that could not answer. A source that returned ok contributes nothing, so a project whose
// enabled sources all succeeded shows an empty State cell rather than a row of green reassurance.
export function problemScanStates(row: ProjectCatalogRow): ProjectScanState[] {
    return row.scanStates.filter(function notOk(state) {
        return state.status !== 'ok'
    })
}

// Healthy = every source that answered said ok, and nothing was found.
//
// `every` is vacuously true on an empty array, so the length check is what preserves the old behaviour
// for a project nothing has ever scanned: it is not healthy, it is unexamined. It also fixes a quieter
// bug the single-latest-scan version had — a project whose npm audit errored while OSV returned ok read
// as healthy and was hidden by default, because OSV's row was the one that won the race.
export function isProjectHealthy(row: ProjectCatalogRow, findingCount: number): boolean {
    if (row.scanStates.length === 0) return false
    if (findingCount !== 0) return false
    return row.scanStates.every(function ok(state) {
        return state.status === 'ok'
    })
}

// The badge text for one failing source: the source name, then what went wrong.
//
// The name is dropped when the reason code is one of SOURCE_UNAVAILABLE_REASON_CODES, because those four
// are the codes ABOUT a particular source and their labels already name it in all ten locales (asserted
// in the test beside this). Prefixing them produced "OSV · OSV database not downloaded yet" on the most
// common case of all. Every other reason is generic — "No lockfile" says nothing about who was asking —
// so those keep the prefix.
//
// The coupling is deliberate but worth knowing: widening SOURCE_UNAVAILABLE_REASON_CODES for the CI-gate
// reason it exists for would also silence the prefix here. If a code is ever added whose label does not
// name its source, the test beside this fails rather than the UI quietly losing the attribution.
export function scanStateLabel(state: ProjectScanState, locale: Locale): string {
    const reason = reasonCodeLabel((state.reasonCode as ReasonCode | null) || null, locale)
    if (state.reasonCode && isSourceUnavailableReason(state.reasonCode)) return reason
    return sourceLabel(state.source) + ' · ' + reason
}
