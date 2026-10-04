import { parseRemediation, type Remediation } from './remediation'
import type { FixStatus } from './types'

// What the registry said when a finding's fix was settled. `ok` — fresh package data; `stale` — a refetch
// failed and the last good data was used; `not_found` — the registry has no such package; `error` — the
// registry could not be reached; `skipped` — the registry was not asked because it does not cover the
// ecosystem yet; `offline` — the registry was not asked because the run was told to make no network
// request (the CLI's --offline).
export type FixRegistryOutcome = 'ok' | 'stale' | 'not_found' | 'error' | 'skipped' | 'offline'

// Why the evidence itself could not settle the fix, whatever the registry said: a source's affected
// range could not be evaluated, an installed version did not parse, a patched range did not parse, or
// no source gave any evidence at all.
export type FixUnevaluableReason = 'no_evidence' | 'installed_unknown' | 'affected_incomplete' | 'patched_unparseable'

export const FIX_UNEVALUABLE_REASONS: readonly FixUnevaluableReason[] = ['no_evidence', 'installed_unknown', 'affected_incomplete', 'patched_unparseable']

const FIX_REGISTRY_OUTCOMES: readonly FixRegistryOutcome[] = ['ok', 'stale', 'not_found', 'error', 'skipped', 'offline']

// What one source said about the fix: the installed copies it saw, its affected set as text, its patched
// range, the fix it states, and whether it said outright that no patched version exists. Enough to
// re-check the settlement from the row alone, against the registry data it names.
export type FixCheckSource = {
    source: string
    installed: string[]
    affected: string
    // A genuine patched range; null when the source states none (or states the no-patch sentinel).
    patched: string | null
    statedFix: string | null
    noPatchedSentinel: boolean
}

// The verification snapshot stored on every settled finding. Everything a reader needs to say WHEN the
// fix was checked and on WHAT data is read from here, never from today's registry cache: a cache refresh
// after the scan must not change what the finding says about its own check.
export type FixCheck = {
    v: 1
    // When this finding was settled (the scan's settlement time).
    checkedAt: number
    registry: FixRegistryOutcome
    // When the registry data used was fetched. Null when no registry data was used.
    packageDataAsOf: number | null
    unevaluable: FixUnevaluableReason | null
    sources: FixCheckSource[]
}

// Degrades to null rather than throwing, like parseFindingCorroborations: a corrupt or future-shaped
// snapshot reads as "not re-checked yet", which is honest, instead of taking down every query on the row.
export function parseFixCheck(json: string | null): FixCheck | null {
    if (json === null) return null
    let parsed: unknown
    try {
        parsed = JSON.parse(json)
    } catch {
        return null
    }
    if (!parsed || typeof parsed !== 'object') return null
    const p = parsed as Partial<FixCheck>
    if (p.v !== 1 || typeof p.checkedAt !== 'number') return null
    if (typeof p.registry !== 'string' || !FIX_REGISTRY_OUTCOMES.includes(p.registry)) return null
    if (p.packageDataAsOf !== null && typeof p.packageDataAsOf !== 'number') return null
    if (p.unevaluable !== null && (typeof p.unevaluable !== 'string' || !FIX_UNEVALUABLE_REASONS.includes(p.unevaluable))) return null
    if (!Array.isArray(p.sources)) return null
    const sources: FixCheckSource[] = []
    for (const entry of p.sources as unknown[]) {
        if (!entry || typeof entry !== 'object') return null
        const s = entry as Partial<FixCheckSource>
        if (typeof s.source !== 'string' || typeof s.affected !== 'string') return null
        if (!Array.isArray(s.installed) || !s.installed.every(function isString(v) { return typeof v === 'string' })) return null
        if (s.patched !== null && typeof s.patched !== 'string') return null
        if (s.statedFix !== null && typeof s.statedFix !== 'string') return null
        if (typeof s.noPatchedSentinel !== 'boolean') return null
        sources.push({ source: s.source, installed: s.installed, affected: s.affected, patched: s.patched, statedFix: s.statedFix, noPatchedSentinel: s.noPatchedSentinel })
    }
    return { v: 1, checkedAt: p.checkedAt, registry: p.registry, packageDataAsOf: p.packageDataAsOf, unevaluable: p.unevaluable, sources }
}

const FIX_STATUSES: readonly FixStatus[] = ['released', 'none_released', 'unverified']

export function isFixStatus(value: unknown): value is FixStatus {
    return typeof value === 'string' && FIX_STATUSES.includes(value as FixStatus)
}

// The fix fields as every reader sees them. A row the settlement never wrote (fix_status null — written
// before this release, or by a scan that stopped between merge and settlement) has a fix value nobody
// checked: it is withheld, never shown and never attributed to the advisory, until the next scan
// settles the row. `fixCheck: null` is what marks it, so it renders "rescan pending".
//
// The way out travels with them: it exists only for a settled 'none_released' finding, so a remediation
// left on a row of any other status (or an unsettled one) is never read.
export type FixFields = {
    fixStatus: FixStatus
    fixVersion: string | null
    fixAvailable: boolean
    fixCheck: FixCheck | null
    remediation: Remediation | null
}

export function readFixFields(row: { fixStatus: string | null; fixVersion: string | null; fixAvailable: boolean; fixCheckJson: string | null; remediationJson: string | null }): FixFields {
    const fixCheck = parseFixCheck(row.fixCheckJson)
    // A `released` row without its version is not something settlement writes; read it as unsettled too.
    const releasedWithoutVersion = row.fixStatus === 'released' && !row.fixVersion
    if (!isFixStatus(row.fixStatus) || fixCheck === null || releasedWithoutVersion) {
        return { fixStatus: 'unverified', fixVersion: null, fixAvailable: false, fixCheck: null, remediation: null }
    }
    const remediation = row.fixStatus === 'none_released' ? parseRemediation(row.remediationJson) : null
    return { fixStatus: row.fixStatus, fixVersion: row.fixVersion, fixAvailable: row.fixAvailable, fixCheck, remediation }
}

export type FixFacts = Pick<FixFields, 'fixStatus' | 'fixVersion' | 'fixAvailable' | 'fixCheck'> & { packageName: string }

export type FixTextStyle = {
    // How a version or package name is set off: a markdown code span in the export, bare in a chat message.
    code: (value: string) => string
    // How the "no fixed version released" lead is emphasised.
    strong: (value: string) => string
}

export const PLAIN_FIX_STYLE: FixTextStyle = {
    code: function bare(value) { return value },
    strong: function bare(value) { return value }
}

function isoDate(at: number): string {
    return new Date(at).toISOString().slice(0, 10)
}

function unverifiedReason(check: FixCheck): string {
    if (check.unevaluable === 'affected_incomplete') return ' (affected range could not be evaluated)'
    if (check.unevaluable === 'installed_unknown') return ' (installed version could not be read)'
    if (check.unevaluable === 'patched_unparseable') return ' (patched range could not be evaluated)'
    if (check.unevaluable === 'no_evidence') return ' (no source evidence to check)'
    if (check.registry === 'error') return ' (registry not reachable)'
    if (check.registry === 'not_found') return ' (not on the npm registry)'
    if (check.registry === 'offline') return ' (offline)'
    return ''
}

function staleSuffix(check: FixCheck): string {
    if (check.registry !== 'stale' || check.packageDataAsOf === null) return ''
    return ' · cached data from ' + isoDate(check.packageDataAsOf)
}

// The one wording of a finding's fix, shared by the advisory export, the notifications and the CLI so they
// can never say different things. Only a `released` fix is phrased as an instruction: "upgrade to X" for
// a version nobody checked against the registry is how agents came to chase releases that never existed.
export function describeFix(f: FixFacts, style: FixTextStyle): string {
    const check = f.fixCheck
    if (check === null) return 'fix not re-checked yet — rescan pending'
    if (f.fixStatus === 'released' && f.fixVersion) {
        return 'upgrade to ' + style.code(f.fixVersion) + staleSuffix(check)
    }
    if (f.fixStatus === 'none_released') {
        return style.strong('No fixed version released') + ' — no published version of ' + style.code(f.packageName) +
            ' is outside the vulnerable range (registry checked ' + isoDate(check.checkedAt) + ')' + staleSuffix(check)
    }
    const tail = ' · not checked against the registry' + unverifiedReason(check) + staleSuffix(check)
    if (f.fixVersion) return 'advisory names ' + style.code(f.fixVersion) + ' as the fix' + tail
    if (f.fixAvailable) return 'npm reports ' + style.code('npm audit fix') + ' resolves it (no version of this package stated)' + tail
    return 'no fix stated by the advisory' + tail
}

// When the reporting sources describe different affected sets, say so: the settled fix is outside all of
// them, which is why it may be higher than the one a single source names. Null when they agree.
export function describeFixDisagreement(f: FixFacts, style: FixTextStyle): string | null {
    const check = f.fixCheck
    if (check === null) return null
    const distinct = new Set(check.sources.map(function affectedOf(s) { return s.affected }))
    if (distinct.size < 2) return null
    const listed = check.sources.map(function one(s) { return s.source + ' ' + style.code(s.affected) }).join(', ')
    if (f.fixStatus !== 'released' || !f.fixVersion) return 'sources disagree: ' + listed
    const outside = distinct.size === 2 ? 'both' : 'all of them'
    return 'sources disagree: ' + listed + ' — ' + style.code(f.fixVersion) + ' is outside ' + outside
}
