import { join } from 'node:path'
import { describeScanReasons, type FindingInstallation, type Locale, type NotificationTarget, type ScanRequestOrigin } from '@sentinello/core'
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
import { isExcludedPath } from '@sentinello/scanners'
import { inSummaryQueue } from './capability-baseline'
import { CONFIG_KEYS, DEFAULT_GLOBAL_IGNORE } from './config-loader'
import { matchEventsToFindings } from './notifier'
import { hidesCopy, excludedCopyPresent, readProjectSight, type ProjectSight } from './project-sight'
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

// Leaving the scan's view is not a fix. A row went for nothing but that when every installation lives under a path the
// current exclusions cover (SENTINEL-172), or when any installation is still on the disk where a scan does not look or
// an exclusion says not to (SENTINEL-198, SENTINEL-201): one copy unread proves nothing, whatever a checked copy beside it
// says. A row written before 3.8 names no manifest, so it is judged by its whole project.
function closedOutOfSight(candidate: ResolvedCandidate, excludes: readonly string[], sightOf: (candidate: ResolvedCandidate) => ProjectSight): boolean {
    const { finding: { installations, ecosystem }, rootPath, relPath } = candidate
    if (installations.length === 0) return hidesAnyManifest(sightOf(candidate), rootPath, relPath, excludes)
    function excluded(installation: FindingInstallation): boolean {
        return isExcludedPath(rootPath, join(rootPath, relPath, installation.manifestPath), excludes)
    }
    if (installations.every(excluded)) return true
    const sight = sightOf(candidate)
    return installations.some(function unproved(installation) {
        const stillThere = excluded(installation) ? excludedCopyPresent : hidesCopy
        return stillThere(sight, rootPath, relPath, installation, ecosystem)
    })
}

// Read from the disk, once per project for one message.
function projectSights(excludes: readonly string[]): (candidate: ResolvedCandidate) => ProjectSight {
    const sights = new Map<string, ProjectSight>()
    return function sightOf({ finding: { projectId }, rootPath, relPath }) {
        const known = sights.get(projectId)
        if (known !== undefined) return known
        const sight = readProjectSight(rootPath, relPath, excludes)
        sights.set(projectId, sight)
        return sight
    }
}

// Whether a closed row that names no manifest may have lived where a scan does not look. A manifest the scan's walk
// misses, or one the exclusions cover, is hidden: nothing read it, so the closing says nothing and the row stays owed
// until the manifest is removed or a scan reads it. With none hidden, wherever the row lived was either read by the scan
// that closed it (a manifest that went unread keeps its rows open) or is gone, so the closing is true. An ignored
// directory holding no manifest hides nothing. A directory either walk cannot read proves nothing, ignored or not, and
// the row is left out.
function hidesAnyManifest(sight: ProjectSight, rootPath: string, relPath: string, excludes: readonly string[]): boolean {
    if (!sight.found || sight.unreadable.length > 0 || sight.hidden.length > 0) return true
    return sight.manifests.some(function excluded(manifest) { return isExcludedPath(rootPath, join(rootPath, relPath, manifest.path), excludes) })
}

// What this message may call fixed. A row held for what the scan cannot see holds every owed row of its advisory: an
// episode that came and went elsewhere names only what was read, and the claim is about the advisory (SENTINEL-203).
function tellableResolved(owed: readonly ResolvedCandidate[], excludes: readonly string[]): ResolvedCandidate[] {
    const sightOf = projectSights(excludes)
    const held = new Set(owed.filter(function unproved(candidate) { return closedOutOfSight(candidate, excludes, sightOf) }).map(function identity(candidate) { return candidate.identity }))
    return owed.filter(function tellable(candidate) { return !held.has(candidate.identity) })
}

function resolvedLines(candidates: readonly ResolvedCandidate[]): FleetResolvedLine[] {
    const lines = new Map<string, FleetResolvedLine & { identities: Set<string> }>()
    for (const { finding, identity, projectName } of candidates) {
        const key = finding.projectId + '|' + finding.ecosystem + '|' + finding.packageName
        const line = lines.get(key) ?? { projectId: finding.projectId, projectName, packageName: finding.packageName, ecosystem: finding.ecosystem, advisories: 0, identities: new Set<string>() }
        line.identities.add(identity)
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
    const resolved = tellableResolved(listOwedResolvedFindings(db, target.id, at, run.projectIds), excludes)
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
