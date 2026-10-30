import { REASON_CODE_VALUES, type Locale, type ReasonCode } from './types'

// Whose fix a scan failure is. `project`: something in the scanned folder stops it from being read — no
// lockfile, a lockfile format nobody parses, a manifest that pins nothing — and committing or changing a
// file there is the reader's fix. `environment`: this Sentinello install could not do the scan — a tool
// missing from PATH, an advisory database not downloaded, a timeout, an audit that crashed — and it is the
// operator's fix. The project itself may be perfectly scannable.
export type ScanStateSide = 'project' | 'environment'

// Every scan reason code but 'ok', classified. A Record over the whole union is what makes a new code fail
// to compile until someone decides whose side it is on.
export const REASON_SIDE: Record<Exclude<ReasonCode, 'ok'>, ScanStateSide> = {
    no_lockfile: 'project',
    unknown_pm: 'project',
    yarn_v1_unsupported: 'project',
    partial_dependency_graph: 'project',
    ambiguous_dependency_spec: 'project',
    unsupported_lockfile: 'project',
    pm_missing: 'environment',
    nvm_missing: 'environment',
    node_below_min: 'environment',
    npm_below_min: 'environment',
    pnpm_below_min: 'environment',
    audit_spawn_error: 'environment',
    audit_parse_error: 'environment',
    audit_schema_mismatch: 'environment',
    audit_empty_output: 'environment',
    audit_no_advisories: 'environment',
    legacy_npm6_format: 'environment',
    nvm_node_missing: 'environment',
    nvm_install_failed: 'environment',
    bash_missing: 'environment',
    audit_unknown_failure: 'environment',
    osv_db_not_seeded: 'environment',
    osv_db_unavailable: 'environment',
    gemnasium_db_not_seeded: 'environment',
    gemnasium_db_unavailable: 'environment',
    ecosystem_source_disabled: 'environment',
    timeout: 'environment'
}

export type FailureReasonCode = Exclude<ReasonCode, 'ok'>

// A failed scan's reason as it was stored. A non-ok scan always carries a code today, but the column is a
// free string: an absent, 'ok' or unrecognised one is read as the generic "audit failed (unknown)" rather
// than dropped, so a failure can never vanish from the state because its code was not understood.
export function failureReasonCode(code: string | null): FailureReasonCode {
    if (code === null || code === 'ok' || !(REASON_CODE_VALUES as string[]).includes(code)) return 'audit_unknown_failure'
    return code as FailureReasonCode
}

export function reasonSide(code: string | null): ScanStateSide {
    return REASON_SIDE[failureReasonCode(code)]
}

// `scanned` — every expected source's latest scan is ok and every detected ecosystem's coverage is known and ok.
// `partial` — at least one expected source answered, but something else did not: another source failed,
//   one has not run yet, or an ecosystem could not be fully read. Shown as "cannot be fully scanned".
// `cannot_scan` — no expected source answered, and at least one tried and failed.
// `not_scanned_yet` — no expected source has ever scanned the project: the existing "never scanned".
export type ScanStateValue = 'scanned' | 'partial' | 'cannot_scan' | 'not_scanned_yet'

// One reason the project is not `scanned`. A source's failed scan names the source; an ecosystem whose
// dependencies could not be (fully) read names the ecosystem. `not_yet_run` is something the next sweep
// does that no scan has done yet: an expected source with no scan at all, or a detected ecosystem the
// latest scan recorded no coverage for (a scan written before every scan recorded coverage, or before the
// ecosystem was detected). It is nobody's fix, so it has no side, and it is never a failure.
export type ScanStateReason =
    | { source: string; ecosystem: null; reasonCode: FailureReasonCode; side: ScanStateSide }
    | { source: null; ecosystem: string; reasonCode: FailureReasonCode; side: ScanStateSide }
    | { source: string; ecosystem: null; reasonCode: 'not_yet_run'; side: null }
    | { source: null; ecosystem: string; reasonCode: 'not_yet_run'; side: null }

export type ScanState = {
    state: ScanStateValue
    reasons: ScanStateReason[]
}

// A source's latest scan of the project for one ecosystem — one (source, ecosystem) cell — as the scans
// table holds it. A feed source writes one scan per cell it ran, so two cells of one source can disagree:
// OSV can have read Ruby fine and failed on Python.
export type LatestSourceScan = {
    source: string
    ecosystem: string
    status: string
    reasonCode: string | null
    finishedAt: number
}

// A (source, ecosystem) cell the project should have heard from.
export type ExpectedCell = {
    source: string
    ecosystem: string
}

// What a project can be missing a source for. An ecosystem today; 3.9 adds `{ kind: 'runtime', id }`.
export type ScanSubject = { kind: 'ecosystem'; id: string }

// One ecosystem's resolver coverage, from the project's latest scan.
export type ScanStateCoverage = {
    ecosystem: string
    status: 'ok' | 'partial' | 'unauditable'
    reasonCode: string | null
}

// Everything the state is computed from. `expectedCells` is the set the project should have heard from
// (its runnable source cells, restricted to its detected ecosystems): it is passed in, never inferred from
// the scans that exist, because an absent scan means "has not run", never "is fine". `sourceDisabled` is
// every detected subject no runnable cell answers for: nothing will ever scan it until the operator turns
// a source on, so it reads as a reason, never as clean. In the same way, `detectedEcosystems` is what the
// coverage must answer for: an ecosystem with no coverage entry, or `coverage: null` (the latest scan
// recorded none), is unknown — never read as fully covered.
export type ScanStateInputs = {
    expectedCells: readonly ExpectedCell[]
    latestScans: readonly LatestSourceScan[]
    detectedEcosystems: readonly string[]
    sourceDisabled: readonly ScanSubject[]
    coverage: readonly ScanStateCoverage[] | null
}

function cellKey(source: string, ecosystem: string): string {
    return source + '|' + ecosystem
}

export function projectScanState(inputs: ScanStateInputs): ScanState {
    const expected = new Map<string, ExpectedCell>()
    for (const cell of inputs.expectedCells) expected.set(cellKey(cell.source, cell.ecosystem), cell)
    const latestByCell = new Map<string, LatestSourceScan>()
    for (const scan of inputs.latestScans) {
        const key = cellKey(scan.source, scan.ecosystem)
        if (expected.has(key)) latestByCell.set(key, scan)
    }
    const disabledEcosystems = inputs.sourceDisabled.map(function id(subject) { return subject.id })
    const disabledReasons: ScanStateReason[] = disabledEcosystems.map(function reason(ecosystem): ScanStateReason {
        return { source: null, ecosystem, reasonCode: 'ecosystem_source_disabled', side: REASON_SIDE.ecosystem_source_disabled }
    })
    if (latestByCell.size === 0) {
        // Nothing is expected to scan it at all: no sweep will ever change that, so it is not "not scanned
        // yet" — it cannot be scanned until a source is turned on.
        if (expected.size === 0 && disabledReasons.length > 0) return { state: 'cannot_scan', reasons: disabledReasons }
        return { state: 'not_scanned_yet', reasons: [] }
    }
    const reasons: ScanStateReason[] = []
    let answered = 0
    for (const [key, cell] of expected) {
        const scan = latestByCell.get(key)
        if (!scan) {
            addReason(reasons, { source: cell.source, ecosystem: null, reasonCode: 'not_yet_run', side: null })
            continue
        }
        if (scan.status === 'ok') {
            answered += 1
            continue
        }
        const reasonCode = failureReasonCode(scan.reasonCode)
        addReason(reasons, { source: cell.source, ecosystem: null, reasonCode, side: REASON_SIDE[reasonCode] })
    }
    const coverage = inputs.coverage ?? []
    for (const entry of coverage) {
        if (entry.status === 'ok') continue
        const reasonCode = failureReasonCode(entry.reasonCode)
        addReason(reasons, { source: null, ecosystem: entry.ecosystem, reasonCode, side: REASON_SIDE[reasonCode] })
    }
    for (const ecosystem of inputs.detectedEcosystems) {
        if (disabledEcosystems.includes(ecosystem)) continue
        if (coverage.some(function recorded(entry) { return entry.ecosystem === ecosystem })) continue
        addReason(reasons, { source: null, ecosystem, reasonCode: 'not_yet_run', side: null })
    }
    for (const reason of disabledReasons) addReason(reasons, reason)
    if (answered === 0) return { state: 'cannot_scan', reasons }
    if (reasons.length > 0) return { state: 'partial', reasons }
    return { state: 'scanned', reasons }
}

// Two cells of one source failing the same way (OSV not downloaded for Python and for Ruby), or two
// manifests of one ecosystem with the same gap, are one reason to the reader.
function addReason(reasons: ScanStateReason[], reason: ScanStateReason): void {
    if (reasons.some(function same(r) { return r.source === reason.source && r.ecosystem === reason.ecosystem && r.reasonCode === reason.reasonCode })) return
    reasons.push(reason)
}

// The label of the side-less reason, in the same ten locales as REASON_CODE_LABELS. Every other reason is
// labelled by reasonCodeLabel.
export const NOT_YET_RUN_LABELS: Record<Locale, string> = {
    'en': 'Has not run yet',
    'es': 'Aún no se ha ejecutado',
    'fr': 'Pas encore exécuté',
    'de': 'Noch nicht ausgeführt',
    'pt-BR': 'Ainda não foi executado',
    'it': 'Non ancora eseguito',
    'ja': 'まだ実行されていません',
    'zh-CN': '尚未运行',
    'ko': '아직 실행되지 않음',
    'ru': 'Ещё не запускался'
}

// Why a finding still listed was not re-checked: its source's latest scan of the project failed, so the
// row is what an earlier scan left behind. Read-time only, never stored. `lastOkScanAt` is when that
// source last scanned the project successfully, or null when it never did.
export type NotRecheckedBecause = {
    reasonCode: FailureReasonCode
    side: ScanStateSide
    projectState: ScanStateValue
    lastOkScanAt: number | null
}

// What a findings query knows about the row's source: its latest scan of the project and the last ok one.
export type FindingScanContext = {
    latestStatus: string | null
    latestReasonCode: string | null
    lastOkScanAt: number | null
    projectState: ScanStateValue
}

// Null when the source's latest scan was ok (the row was re-checked by it) or when the source has no scan
// of the project at all (nothing failed). Otherwise the row was retained by a failed scan, settled or not.
export function notRecheckedBecause(context: FindingScanContext | null): NotRecheckedBecause | null {
    if (context === null || context.latestStatus === null || context.latestStatus === 'ok') return null
    const reasonCode = failureReasonCode(context.latestReasonCode)
    return { reasonCode, side: REASON_SIDE[reasonCode], projectState: context.projectState, lastOkScanAt: context.lastOkScanAt }
}
