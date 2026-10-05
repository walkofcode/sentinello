import { getSource } from './ecosystems'
import { reasonCodeLabel } from './reason-code-labels'
import { NOT_YET_RUN_LABELS, type ScanState, type ScanStateReason, type ScanStateSide, type ScanStateValue } from './scan-state'
import type { Locale } from './types'

// The words every surface outside the portal uses for a project's scan state — the CLI, the advisory
// markdown, MCP and the notifications — so "cannot be scanned" never reads differently in two places. The
// portal renders the same structure from its own messages, in the reader's locale.

// One reason with its label in the requested locale. What MCP, the webhook and the CLI's JSON carry.
export type LabelledScanStateReason = ScanStateReason & { label: string }

export type LabelledScanState = {
    state: ScanStateValue
    reasons: LabelledScanStateReason[]
}

// The label of one reason: the scan reason code's label, or "Has not run yet" for the side-less one.
export function scanReasonLabel(reason: Pick<ScanStateReason, 'reasonCode'>, locale: Locale = 'en'): string {
    if (reason.reasonCode === 'not_yet_run') return NOT_YET_RUN_LABELS[locale]
    return reasonCodeLabel(reason.reasonCode, locale)
}

export function labelScanState(state: ScanState, locale: Locale = 'en'): LabelledScanState {
    return {
        state: state.state,
        reasons: state.reasons.map(function labelled(reason) {
            return { ...reason, label: scanReasonLabel(reason, locale) }
        })
    }
}

// What a reason is about: the source's display name ("npm audit", "OSV") or the ecosystem id ("npm",
// "PyPI"). An ecosystem keeps its id rather than a display name so "npm" (the dependencies) reads apart
// from "npm audit" (the source).
export function scanReasonSubject(reason: ScanStateReason): string {
    if (reason.source === null) return reason.ecosystem
    return getSource(reason.source)?.displayName ?? reason.source
}

// Whose fix it is, short: the parenthesis after a reason in a one-line summary.
export const SCAN_STATE_SIDE_SHORT: Record<ScanStateSide, string> = {
    project: 'the project',
    environment: 'this Sentinello install'
}

// Whose fix it is, spelled out: a document or a tool description, read by someone deciding what to do.
export const SCAN_STATE_SIDE_LONG: Record<ScanStateSide, string> = {
    project: "on the project's side: a file in the project stops it from being read, and changing it there is the fix",
    environment: "on this Sentinello install's side: the install could not do the scan, and it is the operator's fix"
}

const NOT_YET_RUN_LONG = 'nobody\'s fix: nothing has looked yet, and the next scan does'

// The headline of a state that is not `scanned`, or null for one that needs none. `not_scanned_yet` is the
// existing "never scanned": it is not a failure and never "cannot be scanned".
export function scanStateHeadline(state: ScanStateValue): string | null {
    if (state === 'cannot_scan') return 'Project cannot be scanned'
    if (state === 'partial') return 'Project cannot be fully scanned'
    if (state === 'not_scanned_yet') return 'Project not scanned yet'
    return null
}

// Reasons that say the same thing about several sources and ecosystems, folded into one. A project with
// no lockfile is refused by npm audit, by OSV and in its npm coverage alike: one "No lockfile", naming all
// three, says it once.
export type GroupedScanReason = {
    reasonCode: ScanStateReason['reasonCode']
    side: ScanStateSide | null
    label: string
    subjects: string[]
}

export function groupScanReasons(reasons: readonly ScanStateReason[], locale: Locale = 'en'): GroupedScanReason[] {
    const out: GroupedScanReason[] = []
    for (const reason of reasons) {
        const subject = scanReasonSubject(reason)
        const group = out.find(function same(g) { return g.reasonCode === reason.reasonCode && g.side === reason.side })
        if (group) {
            if (!group.subjects.includes(subject)) group.subjects.push(subject)
            continue
        }
        out.push({ reasonCode: reason.reasonCode, side: reason.side, label: scanReasonLabel(reason, locale), subjects: [subject] })
    }
    return out
}

// One line: "No lockfile (the project) · npm: Has not run yet". A failure says whose fix it is; the
// side-less "has not run yet" says instead what has not run, since that is all there is to it.
export function describeScanReasons(reasons: readonly ScanStateReason[], locale: Locale = 'en'): string {
    return groupScanReasons(reasons, locale).map(function line(g) {
        if (g.side === null) return g.subjects.join(', ') + ': ' + g.label
        return g.label + ' (' + SCAN_STATE_SIDE_SHORT[g.side] + ')'
    }).join(' · ')
}

// One reason, spelled out for a document: "No lockfile — npm audit, OSV, npm — on the project's side: …".
export function describeGroupedReasonLong(group: GroupedScanReason): string {
    const whose = group.side === null ? NOT_YET_RUN_LONG : SCAN_STATE_SIDE_LONG[group.side]
    return group.label + ' — ' + group.subjects.join(', ') + ' — ' + whose
}
