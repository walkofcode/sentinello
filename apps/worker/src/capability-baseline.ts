import { CAPABILITIES, type Capability } from '@sentinello/core'
import {
    baselineCountsForTarget,
    claimCompletedBaselines,
    closeFinishedBaselines,
    getConfigValue,
    getNotificationTargetById,
    listOpenSummaryDeliveries,
    recordSummaryAttempt,
    recordSummaryDryRun,
    recordSummaryFailure,
    recordSummarySuccess,
    suppressSummary,
    targetPolicyFingerprint,
    type BaselineCounts,
    type DrizzleDb
} from '@sentinello/db'
import { redactErrorText, redactTarget, renderCapabilitySummary, senderFor, type NotificationSender } from '@sentinello/notifications'
import { CONFIG_KEYS } from './config-loader'

// The silent baseline's worker side (plan Phase 3 step 5, decisions SENTINEL-120/124/125). The notifier
// stamps a pending capability's new finding events so they are never dispatched one by one; when a sweep
// completes, the baseline is claimed and every enabled target is owed one summary; this module is the only
// path that sends one, for the first attempt and every retry.

// A summary that failed this many times is given up on for good (gave_up_at): the ledger then says it was
// never delivered, rather than retrying a dead channel forever.
export const MAX_SUMMARY_ATTEMPTS = 5

export type DispatchSummariesInput = {
    db: DrizzleDb
    // With dryRunNotify on, a summary is logged as "would receive" and closed, never sent — and so never
    // sent stale once dry-run is turned off.
    dryRun: boolean
    // The transport for each target. Defaults to the real sender of the target's kind; tests and the
    // live-copy verification pass a recording one.
    send?: NotificationSender
    capabilities: readonly Capability[]
    portalBaseUrl?: string | null
}

// The single-flight queue (SENTINEL-125). Every dispatch — after a completed sweep, from the boot sweep,
// from a portal-requested full sweep, overlapping or not — runs strictly after the one before it has
// recorded its outcome, so a second caller selects again and finds the row the first one just closed: two
// overlapping dispatches make one sender call per row. Process-local is enough: the worker holds the
// single-instance lock (worker.ts), and the portal never sends a summary. No database transaction is held
// across the network: the attempt and its outcome are two short writes. A crash drops the queue with the
// process, and the attempt it recorded without an outcome is retried on the next completed sweep.
let queue: Promise<void> = Promise.resolve()

export function dispatchCapabilitySummaries(input: DispatchSummariesInput): Promise<void> {
    const run = queue.then(function next() { return dispatchOpenSummaries(input) })
    // A failed dispatch fails its own caller, never the ones queued behind it.
    queue = run.catch(function keepServing() { return undefined })
    return run
}

// Runs inside the queue only: not exported, so nothing can reach the select → recheck → attempt → send →
// outcome path without it.
async function dispatchOpenSummaries(input: DispatchSummariesInput): Promise<void> {
    const send = input.send ?? sendByKind
    for (const row of listOpenSummaryDeliveries(input.db)) {
        // CAPABILITIES is append-only and the ledger only holds ids it seeded.
        const capability = input.capabilities.find(function byId(c) { return c.id === row.capabilityId }) as Capability
        // A row exists only while its target does (ON DELETE CASCADE), but the target may go between the
        // select and here.
        const target = getNotificationTargetById(input.db, row.targetId)
        if (!target) continue
        const at = Date.now()
        // Current policy first (SENTINEL-124). Each of these closes the row for good: a target re-enabled
        // weeks later, or a summary counted under a scope it no longer has, must not deliver a stale count.
        if (!target.enabled) {
            suppressSummary(input.db, row.capabilityId, row.targetId, 'target_disabled', at)
            continue
        }
        if (targetPolicyFingerprint(target) !== row.policyFingerprint) {
            suppressSummary(input.db, row.capabilityId, row.targetId, 'policy_changed', at)
            continue
        }
        // Aggregate counts cannot be re-filtered, so a summary that would now include something the target
        // excludes — a new mute on a counted finding, a project gone — is dropped, never sent. A change that
        // touches nothing it counted leaves the counts equal, and the summary goes out.
        const counts = baselineCountsForTarget(input.db, capability, target, at)
        if (!sameCounts(counts, row.counts)) {
            suppressSummary(input.db, row.capabilityId, row.targetId, 'eligibility_changed', at)
            continue
        }
        const message = renderCapabilitySummary({ capability, ...counts, portalBaseUrl: input.portalBaseUrl ?? null })
        if (input.dryRun) {
            console.log('[baseline] DRY-RUN ' + redactTarget(target) + ' would receive: ' + message.title)
            recordSummaryDryRun(input.db, row.capabilityId, row.targetId, at)
            continue
        }
        // Recorded before the send: an attempt with no outcome is unknown, and retried. A crash after the
        // channel accepted but before success is recorded can therefore repeat the summary, within the
        // attempt budget.
        recordSummaryAttempt(input.db, row.capabilityId, row.targetId, at)
        const result = await send(target, message)
        if (result.ok) {
            recordSummarySuccess(input.db, row.capabilityId, row.targetId, Date.now())
            console.log('[baseline] summary sent to ' + redactTarget(target))
            continue
        }
        const errorText = redactErrorText(result.errorText)
        const spent = row.attempts + 1 >= MAX_SUMMARY_ATTEMPTS
        recordSummaryFailure(input.db, row.capabilityId, row.targetId, errorText, spent ? Date.now() : null)
        console.error('[baseline] summary to ' + redactTarget(target) + ' failed' + (spent ? ', giving up' : ', retried after the next completed sweep') + ': ' + errorText)
    }
    closeFinishedBaselines(input.db, Date.now())
}

function sendByKind(target: Parameters<NotificationSender>[0], message: Parameters<NotificationSender>[1]): ReturnType<NotificationSender> {
    return senderFor(target)(target, message)
}

function sameCounts(a: BaselineCounts, b: BaselineCounts): boolean {
    return a.findings === b.findings && a.projects === b.projects && a.critical === b.critical && a.sourceDisabledProjects === b.sourceDisabledProjects
}

// What a COMPLETED sweep does for the baselines (decision SENTINEL-120): claim every pending one — a
// concurrent completion loses the claim — then dispatch whatever summary is still owed, including retries
// of earlier failures. Only a sweep that processed every project and was not aborted counts; an
// interrupted one leaves the baseline pending for the next.
export async function onCompletedSweep(db: DrizzleDb, options: { send?: DispatchSummariesInput['send']; capabilities?: readonly Capability[] } = {}): Promise<void> {
    const capabilities = options.capabilities ?? CAPABILITIES
    claimCompletedBaselines(db, capabilities, Date.now())
    await dispatchCapabilitySummaries({
        db,
        dryRun: getConfigValue<boolean>(db, CONFIG_KEYS.dryRunNotify) || false,
        portalBaseUrl: getConfigValue<string>(db, CONFIG_KEYS.portalBaseUrl) || null,
        send: options.send,
        capabilities
    })
}
