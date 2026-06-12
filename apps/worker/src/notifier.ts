import {
    buildAdvisoryMarkdown,
    resolveExportPrompt,
    type ExportFinding,
    type Finding,
    type Locale,
    type NotificationEvent,
    type NotificationTarget,
    type ReasonCode,
    type Root
} from '@sentinello/core'
import {
    selectDispatchablePairs,
    recordAttempt,
    recordSuccess,
    recordFailure,
    setFirstNotifiedAt,
    upsertFindingEvent,
    upsertScanFailureEvent,
    getProjectById,
    getRootById,
    getConfigValue,
    type DispatchablePair,
    type DrizzleDb
} from '@sentinello/db'
import {
    redactErrorText,
    redactTarget,
    renderBatchedFindings,
    renderScanFailure,
    senderFor,
    type RenderedMessage,
    type WebhookPayloadContext
} from '@sentinello/notifications'
import { CONFIG_KEYS } from './config-loader'
import type { ProjectScanOutcome } from './runner'

// The notifier orchestrates the ledger UPSERT + per-(event, target) dispatch flow described by
// the notification_deliveries lifecycle rules. It does NOT decide WHAT to
// dispatch on — that lives in packages/db's selectDispatchablePairs(). This module's job is to
// ask "what pairs need dispatch right now?" and POST them via packages/notifications.

export type NotifyForCompletedScanInput = {
    db: DrizzleDb
    outcome: ProjectScanOutcome
    dryRun: boolean
}

export async function notifyForCompletedScan(input: NotifyForCompletedScanInput): Promise<void> {
    const at = Date.now()
    const project = getProjectById(input.db, input.outcome.project.id)
    if (!project) return
    // Step 1: UPSERT discovery rows for current findings + (if not ok) a scan-failure row.
    for (const finding of input.outcome.findings) {
        upsertFindingEvent(input.db, {
            projectId: finding.projectId,
            source: finding.source,
            ecosystem: finding.ecosystem,
            advisoryId: finding.advisoryId,
            packageName: finding.packageName,
            severity: finding.severity,
            firstScanId: input.outcome.scan.id,
            at
        })
    }
    if (input.outcome.scan.status !== 'ok') {
        const signature = normalizeFailureSignature(
            input.outcome.scan.status,
            input.outcome.scan.reasonCode,
            input.outcome.scan.errorText
        )
        upsertScanFailureEvent(input.db, {
            projectId: input.outcome.project.id,
            scanner: input.outcome.scan.scanner,
            status: input.outcome.scan.status,
            failureSignature: signature,
            firstScanId: input.outcome.scan.id,
            at
        })
    }
    // Step 2: select dispatchable pairs (event × target) for this project.
    const pairs = selectDispatchablePairs(input.db, input.outcome.project.id, at)
    if (pairs.length === 0) return
    // Group pairs by target so each target receives one batched message per scan, not one per finding.
    const portalBaseUrl = getConfigValue<string>(input.db, CONFIG_KEYS.portalBaseUrl) || null
    const notificationLocale = (getConfigValue<string>(input.db, CONFIG_KEYS.notificationLocale) || 'en') as Locale
    // Resolved once and only used to enrich webhook payloads (root context + the advisory export the
    // 'text' flavor sends). Slack/Telegram ignore them.
    const root = getRootById(input.db, project.rootId)
    const exportPrompt = resolveExportPrompt(getConfigValue<string>(input.db, 'markdownExportPrompt'))
    const grouped = groupByTarget(pairs)
    for (const group of grouped) {
        await dispatchGroup({
            db: input.db,
            group,
            project,
            root,
            exportPrompt,
            findingsByEventId: indexFindingsByEventId(input.outcome.findings, input.outcome.project.id),
            portalBaseUrl,
            notificationLocale,
            scanErrorText: input.outcome.scan.errorText,
            dryRun: input.dryRun,
            at
        })
    }
}

type GroupedPairs = {
    target: NotificationTarget
    events: NotificationEvent[]
}

type DispatchGroupInput = {
    db: DrizzleDb
    group: GroupedPairs
    project: ReturnType<typeof getProjectById>
    root: Root | null
    exportPrompt: string
    findingsByEventId: Map<string, Finding>
    portalBaseUrl: string | null
    notificationLocale: Locale
    scanErrorText: string | null
    dryRun: boolean
    at: number
}

async function dispatchGroup(input: DispatchGroupInput): Promise<void> {
    const project = input.project
    if (!project) return
    const findingEvents: NotificationEvent[] = input.group.events.filter(function isFinding(e): boolean {
        return e.eventType === 'finding'
    })
    const failureEvents: NotificationEvent[] = input.group.events.filter(function isFailure(e): boolean {
        return e.eventType === 'scan_failure'
    })
    if (findingEvents.length > 0) {
        const matchedFindings = mapEventsToFindings(findingEvents, input.findingsByEventId)
        const isBaseline = matchedFindings.every(function noPriorNotify(_, idx): boolean {
            const event = findingEvents[idx]
            return event !== undefined && event.firstNotifiedAt === null
        })
        const message: RenderedMessage = renderBatchedFindings({
            projectName: project.name,
            projectId: project.id,
            findings: matchedFindings,
            isBaseline,
            portalBaseUrl: input.portalBaseUrl
        })
        if (input.group.target.kind === 'webhook') {
            message.webhook = {
                event: 'findings',
                isBaseline,
                root: webhookRoot(input.root),
                project: webhookProject(project),
                findings: matchedFindings,
                failureSignature: null,
                advisoryText: buildAdvisoryMarkdown({
                    scope: { kind: 'project', projectName: project.name, projectPath: project.relPath, depType: 'all' },
                    prompt: input.exportPrompt,
                    findings: matchedFindings.map(toExportFinding),
                    generatedAt: input.at
                })
            }
        }
        await postAndRecord({
            db: input.db,
            target: input.group.target,
            events: findingEvents,
            message,
            dryRun: input.dryRun,
            at: input.at
        })
    }
    for (const failureEvent of failureEvents) {
        const message: RenderedMessage = renderScanFailure({
            projectName: project.name,
            projectId: project.id,
            event: failureEvent,
            errorText: input.scanErrorText,
            portalBaseUrl: input.portalBaseUrl,
            locale: input.notificationLocale
        })
        if (input.group.target.kind === 'webhook') {
            message.webhook = {
                event: 'scan_failure',
                isBaseline: false,
                root: webhookRoot(input.root),
                project: webhookProject(project),
                findings: [],
                failureSignature: failureEvent.failureSignature,
                advisoryText: message.text
            }
        }
        await postAndRecord({
            db: input.db,
            target: input.group.target,
            events: [failureEvent],
            message,
            dryRun: input.dryRun,
            at: input.at
        })
    }
}

type PostAndRecordInput = {
    db: DrizzleDb
    target: NotificationTarget
    events: NotificationEvent[]
    message: ReturnType<typeof renderBatchedFindings>
    dryRun: boolean
    at: number
}

async function postAndRecord(input: PostAndRecordInput): Promise<void> {
    if (input.dryRun) {
        console.log('[notifier] DRY-RUN ' + redactTarget(input.target) + ' would receive: ' + input.message.title + ' (' + input.events.length + ' events)')
        return
    }
    // Record attempt(s) BEFORE the POST so a crash between POST and the success-record yields at most
    // one duplicate per target per the notification_deliveries lifecycle rule (record attempt before send).
    for (const event of input.events) {
        recordAttempt(input.db, event.id, input.target.id, input.at)
    }
    const sender = senderFor(input.target)
    const result = await sender(input.target, input.message)
    if (result.ok) {
        const successAt = Date.now()
        for (const event of input.events) {
            recordSuccess(input.db, event.id, input.target.id, successAt)
            setFirstNotifiedAt(input.db, event.id, successAt)
        }
        console.log('[notifier] dispatched to ' + redactTarget(input.target) + ' (' + input.events.length + ' events)')
        return
    }
    const errorText = redactErrorText(result.errorText)
    const failureAt = Date.now()
    for (const event of input.events) {
        recordFailure(input.db, event.id, input.target.id, failureAt, errorText)
    }
    console.error('[notifier] dispatch failed for ' + redactTarget(input.target) + ': ' + errorText)
}

function groupByTarget(pairs: DispatchablePair[]): GroupedPairs[] {
    const byTargetId = new Map<string, GroupedPairs>()
    for (const pair of pairs) {
        const existing = byTargetId.get(pair.target.id)
        if (existing) {
            existing.events.push(pair.event)
            continue
        }
        byTargetId.set(pair.target.id, { target: pair.target, events: [pair.event] })
    }
    return Array.from(byTargetId.values())
}

function indexFindingsByEventId(findings: Finding[], _projectId: string): Map<string, Finding> {
    // We index by the natural identity tuple stringified — the event row holds the same identity so
    // we can match without recomputing the ledger's identity_key. The source axis is the persisted
    // source identity (finding.source / event.scanner-as-source), never the scanner plugin name.
    const byKey = new Map<string, Finding>()
    for (const finding of findings) {
        const key = identityTupleKey(finding.projectId, finding.source, finding.ecosystem, finding.advisoryId, finding.packageName)
        byKey.set(key, finding)
    }
    return byKey
}

function mapEventsToFindings(events: NotificationEvent[], findingsByKey: Map<string, Finding>): Finding[] {
    const out: Finding[] = []
    for (const event of events) {
        if (event.advisoryId === null || event.packageName === null) continue
        // event.scanner carries the persisted source identity for finding events (matches finding.source).
        const key = identityTupleKey(event.projectId, event.scanner, event.ecosystem ?? '', event.advisoryId, event.packageName)
        const match = findingsByKey.get(key)
        if (match) out.push(match)
    }
    return out
}

function identityTupleKey(projectId: string, source: string, ecosystem: string, advisoryId: string, packageName: string): string {
    return projectId + '|' + source + '|' + ecosystem + '|' + advisoryId + '|' + packageName
}

function webhookRoot(root: Root | null): WebhookPayloadContext['root'] {
    if (!root) return null
    return { id: root.id, label: root.label, path: root.path }
}

function webhookProject(project: NonNullable<ReturnType<typeof getProjectById>>): WebhookPayloadContext['project'] {
    return {
        id: project.id,
        name: project.name,
        relPath: project.relPath,
        packageManager: project.packageManager
    }
}

function toExportFinding(f: Finding): ExportFinding {
    return {
        packageName: f.packageName,
        installedVersion: f.installedVersion,
        fixAvailable: f.fixAvailable,
        fixVersion: f.fixVersion,
        severity: f.severity,
        advisoryId: f.advisoryId,
        advisoryTitle: f.advisoryTitle,
        advisoryUrl: f.advisoryUrl,
        vulnerableRange: f.vulnerableRange,
        isProd: f.isProd,
        isDev: f.isDev,
        depPath: f.depPath
    }
}

// Normalises a scan failure into a stable identity string so repeated failures of the same kind
// reuse the same notification-event row. Prefers the structured reasonCode (e.g. "error:no_lockfile")
// so wording changes in errorText don't fork the event. Falls back to a scrubbed errorText for legacy
// rows that pre-date the reason_code column. Strips timestamps, PIDs, durations, and paths.
export function normalizeFailureSignature(
    status: string,
    reasonCode: ReasonCode | null,
    errorText: string | null
): string {
    if (reasonCode && reasonCode !== 'ok') {
        return status + ':' + reasonCode
    }
    if (!errorText) return status
    let sig = errorText
    sig = sig.replace(/\b\d{10,}\b/g, '<ts>')
    sig = sig.replace(/pid[ =]\d+/gi, 'pid=<n>')
    sig = sig.replace(/after\s+\d+\s*ms/i, 'after Nms')
    sig = sig.replace(/\/[^\s'"]+/g, '<path>')
    sig = sig.trim().slice(0, 200)
    return status + ': ' + sig
}
