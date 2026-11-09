import { join } from 'node:path'
import { describeScanReasons, type Locale, type NotificationTarget, type ScanRequestOrigin } from '@sentinello/core'
import {
    applyScanRecoveries,
    findingScanContexts,
    getConfigValue,
    getProjectById,
    listEnabledNotificationTargets,
    listOwedResolvedFindings,
    listUnscannableTold,
    readScanRecoveries,
    recordAttempt,
    recordFailure,
    recordRunSummaryDelivered,
    selectPendingEventsForTarget,
    unscannableForTarget,
    type DrizzleDb,
    type ResolvedCandidate,
    type UnscannableProject
} from '@sentinello/db'
import {
    redactErrorText,
    redactTarget,
    renderFleetSummary,
    sortFleetLines,
    summarizeFleetFindings,
    type FleetResolvedLine,
    type FleetUnscannableLine,
    type NotificationSender
} from '@sentinello/notifications'
import { isExcludedPath, rediscoverProject } from '@sentinello/scanners'
import { inSummaryQueue } from './capability-baseline'
import { CONFIG_KEYS, DEFAULT_GLOBAL_IGNORE } from './config-loader'
import { matchEventsToFindings } from './notifier'
import { sendByKind } from './transport'

// One message per run to a target that opted in, instead of its per-project messages (notifications-design.md, Run
// summary dispatch). The notifier still records every scan's events; this is the only path that tells them to a
// 'run_summary' target.

export type RunKind = 'scheduled' | ScanRequestOrigin

export type RunFinished = {
    kind: RunKind
    // What the run scanned; null is every project.
    projectIds: readonly string[] | null
    completed: boolean
    send?: NotificationSender
    // A completed sweep's baseline work. Its summaries wait in the same queue as everything here, so it starts once
    // this run's recoveries are read and queued.
    baselines?: () => Promise<void>
}

// What a run does once it has ended. An aborted or failed run does nothing, and everything stays owed. Every completed
// run observes recoveries, because that records a fact and sends nothing: read now, since a scan does not wait for this
// queue and could replace what this one saw, and applied in the queue, after any send in flight has recorded what it
// told. An automatic run stops there: what it found waits for the next scheduled sweep, or a manual scan of that project.
export async function onRunFinished(db: DrizzleDb, run: RunFinished): Promise<void> {
    if (!run.completed) return
    const recovered = readScanRecoveries(db, run.projectIds)
    const applied = inSummaryQueue(async function applyRecoveries() { applyScanRecoveries(db, recovered) })
    await Promise.all([applied, run.baselines?.()])
    if (run.kind === 'automatic') return
    await inSummaryQueue(async function summaries() {
        for (const target of listEnabledNotificationTargets(db)) {
            if (target.delivery !== 'run_summary') continue
            // One target failing outright fails only that target: the channel's own failures come back as a result,
            // and whatever this was is still owed to the next run.
            await dispatchForTarget(db, target, run).catch(function logged(err: unknown) {
                console.error('[run-summary] dispatch to ' + redactTarget(target) + ' failed: ' + (err instanceof Error ? err.message : String(err)))
            })
        }
    })
}

function projectNames(db: DrizzleDb): (projectId: string) => string {
    const names = new Map<string, string>()
    return function nameOf(projectId) {
        const known = names.get(projectId)
        if (known !== undefined) return known
        const project = getProjectById(db, projectId)
        const name = project?.alias ?? project?.name ?? projectId
        names.set(projectId, name)
        return name
    }
}

// An exclusion is not a fix (SENTINEL-172): a row whose every installation lives under a path the current exclusions
// cover went because nobody looks there any more, and says nothing about the package. A row written before 3.8 names
// no manifest, so it is judged by its whole project.
function resolvedByExclusion(candidate: ResolvedCandidate, excludes: readonly string[], projectHidden: (candidate: ResolvedCandidate) => boolean): boolean {
    const installations = candidate.finding.installations
    if (installations.length === 0) return projectHidden(candidate)
    return installations.every(function excluded(installation) {
        return isExcludedPath(candidate.rootPath, join(candidate.rootPath, candidate.relPath, installation.manifestPath), excludes)
    })
}

// Whether a closed row that names no manifest may have lived behind an exclusion. Read from the disk, once per project
// for one message: with no manifest on it that the exclusions cover, wherever the row lived was either read by the scan
// that closed it (a manifest that went unread keeps its rows open) or is gone, so the closing is true. A walk that
// cannot see the whole project proves nothing, and the row is left out.
function exclusionsHiding(excludes: readonly string[]): (candidate: ResolvedCandidate) => boolean {
    const hidden = new Map<string, boolean>()
    return function projectHidden({ finding: { projectId }, rootPath, relPath }) {
        const known = hidden.get(projectId)
        if (known !== undefined) return known
        const hides = excludes.length > 0 && hidesManifest(rootPath, relPath, excludes)
        hidden.set(projectId, hides)
        return hides
    }
}

function hidesManifest(rootPath: string, relPath: string, excludes: readonly string[]): boolean {
    const projectPath = join(rootPath, relPath)
    const { project, errors } = rediscoverProject({ rootPath, projectPath })
    if (project === null || errors.length > 0) return true
    return project.manifests.some(function excluded(manifest) { return isExcludedPath(rootPath, join(projectPath, manifest.path), excludes) })
}

function resolvedLines(candidates: readonly ResolvedCandidate[]): FleetResolvedLine[] {
    const lines = new Map<string, FleetResolvedLine & { identities: Set<string> }>()
    for (const { finding, projectName } of candidates) {
        const key = finding.projectId + '|' + finding.ecosystem + '|' + finding.packageName
        const line = lines.get(key) ?? { projectId: finding.projectId, projectName, packageName: finding.packageName, ecosystem: finding.ecosystem, advisories: 0, identities: new Set<string>() }
        line.identities.add(finding.advisoryKey ?? finding.source + ':' + finding.advisoryId)
        line.advisories = line.identities.size
        lines.set(key, line)
    }
    return sortFleetLines(Array.from(lines.values()).map(function plain({ identities: _identities, ...line }) { return line }))
}

export function unscannableLines(projects: readonly UnscannableProject[], locale: Locale): FleetUnscannableLine[] {
    return sortFleetLines(projects.map(function line(project): FleetUnscannableLine {
        return {
            projectId: project.projectId,
            projectName: project.projectName,
            state: project.state,
            reason: describeScanReasons(project.reasons, locale, true)
        }
    }))
}

async function dispatchForTarget(db: DrizzleDb, target: NotificationTarget, run: RunFinished): Promise<void> {
    const at = Date.now()
    const locale = (getConfigValue<string>(db, CONFIG_KEYS.notificationLocale) || 'en') as Locale
    const events = selectPendingEventsForTarget(db, target.id, at, run.projectIds)
    const findingEvents = events.filter(function isFinding(e) { return e.eventType === 'finding' })
    const failureEvents = events.filter(function isFailure(e) { return e.eventType === 'scan_failure' })
    const eventProjects = Array.from(new Set(findingEvents.map(function project(e) { return e.projectId })))
    // An event with no open finding is neither described nor consumed, as on the per-project path.
    const matched = matchEventsToFindings(db, findingEvents, new Map(), findingScanContexts(db, eventProjects))
    const told = listUnscannableTold(db, target.id)
    const newlyUnscannable = unscannableForTarget(db, target, at, run.projectIds).filter(function isNew(project) { return !told.has(project.projectId) })
    // Nothing new means no send. Resolved rows never trigger one: they ride along, and stay owed until a message goes.
    if (matched.length === 0 && newlyUnscannable.length === 0) return
    const excludes = getConfigValue<string[]>(db, CONFIG_KEYS.globalIgnore) || DEFAULT_GLOBAL_IGNORE
    const projectHidden = exclusionsHiding(excludes)
    const resolved = listOwedResolvedFindings(db, target.id, at, run.projectIds).filter(function notExcluded(candidate) { return !resolvedByExclusion(candidate, excludes, projectHidden) })
    const { counts, listed } = summarizeFleetFindings(matched.map(function row(m) { return m.finding }), projectNames(db))
    const message = renderFleetSummary({
        kind: 'run_summary',
        targetKind: target.kind,
        counts,
        listed,
        resolved: resolvedLines(resolved),
        unscannable: unscannableLines(newlyUnscannable, locale),
        portalBaseUrl: getConfigValue<string>(db, CONFIG_KEYS.portalBaseUrl) || null,
        locale
    })
    if (getConfigValue<boolean>(db, CONFIG_KEYS.dryRunNotify)) {
        console.log('[run-summary] DRY-RUN ' + redactTarget(target) + ' would receive: ' + message.title)
        return
    }
    // A scan failure the message's unscannable rows carry goes with it: told, and not repeated per project later.
    const covered = [...matched.map(function event(m) { return m.event }), ...failureEvents]
    // Recorded before the send: an attempt with no outcome is unknown, and retried.
    for (const event of covered) recordAttempt(db, event.id, target.id, at)
    const result = await (run.send ?? sendByKind)(target, message)
    if (result.ok) {
        recordRunSummaryDelivered(db, {
            targetId: target.id,
            events: covered,
            resolvedFindingIds: resolved.map(function id(candidate) { return candidate.finding.id }),
            unscannableProjectIds: newlyUnscannable.map(function id(project) { return project.projectId }),
            at: Date.now()
        })
        console.log('[run-summary] sent to ' + redactTarget(target) + ' (' + covered.length + ' events)')
        return
    }
    // Everything stays owed, and the next finishing run retries what falls in its scope.
    const errorText = redactErrorText(result.errorText)
    const failureAt = Date.now()
    for (const event of covered) recordFailure(db, event.id, target.id, failureAt, errorText)
    console.error('[run-summary] send to ' + redactTarget(target) + ' failed: ' + errorText)
}
