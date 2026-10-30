import { CAPABILITIES, isCacheNotReadyReason, type Capability, type Locale } from '@sentinello/core'
import {
    baselineCountsForTarget,
    claimCompletedBaselines,
    closeFinishedBaselines,
    getConfigValue,
    getNotificationTargetById,
    listOpenSummaryDeliveries,
    pendingBaselineCapabilities,
    recordSummaryAttempt,
    recordSummaryDryRun,
    recordSummaryFailure,
    recordSummarySuccess,
    suppressSummary,
    targetPolicyFingerprint,
    type BaselineCounts,
    type DrizzleDb
} from '@sentinello/db'
import { redactErrorText, redactTarget, renderCapabilitySummary, type NotificationSender } from '@sentinello/notifications'
import { CONFIG_KEYS } from './config-loader'
import { gemnasiumFeedDisabled } from './gemnasium-sync'
import { osvFeedDisabled } from './osv-sync'
import type { ProjectScanOutcome } from './runner'
import { GEMNASIUM_CACHE, osvCache, type CacheRebuilds } from './runtime'
import { sendByKind } from './transport'

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
    // The notification locale the summary is written in; English when absent.
    locale?: Locale
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
        const message = renderCapabilitySummary({ capability, ...counts, portalBaseUrl: input.portalBaseUrl ?? null, locale: input.locale })
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

// The sweep's scans in the capability's ecosystems that are unauditable only because an advisory cache is
// not downloaded or is being rebuilt, split by whether that cache is still on its way. Each is a source the
// operator enabled (the runner runs only enabled cells) that has not answered yet.
//   - waiting: its cache is still being prepared — a download in flight, one not started yet, or one that
//     landed after the scan. A summary counted now would leave out whatever that source is about to find,
//     and every later finding would then be sent one by one; so the capability waits for the next sweep,
//     the one queued when the cache lands.
//   - failed: the last attempt to download its cache failed. Waiting for a retry to succeed would hold the
//     baseline, and with it every finding of the capability's languages from the sources that did answer,
//     for as long as the feed stays down. The scan keeps its unauditable verdict, as any failed cell does.
// A source whose feed is switched off is never downloading anything: its "not downloaded" verdict is final,
// and it is neither.
type CacheWait = { waiting: number; failed: number }

function scansWaitingOnACache(capability: Capability, outcomes: readonly ProjectScanOutcome[], rebuilds: Pick<CacheRebuilds, 'failed'>): CacheWait {
    const wait: CacheWait = { waiting: 0, failed: 0 }
    for (const { scan } of outcomes) {
        if (scan.status !== 'unauditable' || !isCacheNotReadyReason(scan.reasonCode)) continue
        if (!(capability.ecosystems as string[]).includes(scan.ecosystem)) continue
        // gemnasium's own cache, or the OSV cache of the ecosystem: OSV's scans and gemnasium's withdrawal
        // evidence both read it.
        const gemnasium = scan.reasonCode === 'gemnasium_db_not_seeded'
        if (gemnasium ? gemnasiumFeedDisabled() : osvFeedDisabled()) continue
        if (rebuilds.failed(gemnasium ? GEMNASIUM_CACHE : osvCache(scan.ecosystem))) wait.failed += 1
        else wait.waiting += 1
    }
    return wait
}

function scans(n: number): string {
    return n + ' scan' + (n === 1 ? '' : 's')
}

function sameCounts(a: BaselineCounts, b: BaselineCounts): boolean {
    return a.findings === b.findings && a.projects === b.projects && a.critical === b.critical && a.sourceDisabledProjects === b.sourceDisabledProjects
}

// What a COMPLETED sweep does for the baselines (decision SENTINEL-120, tightened in 3.8.1): claim every
// pending one the sweep answered for — a concurrent completion loses the claim — then dispatch whatever
// summary is still owed, including retries of earlier failures. Only a sweep that processed every project
// and was not aborted counts; an interrupted one leaves the baseline pending for the next. `outcomes` is
// every scan the sweep made; `rebuilds` says which advisory caches failed to download.
export async function onCompletedSweep(db: DrizzleDb, outcomes: readonly ProjectScanOutcome[], options: { rebuilds: Pick<CacheRebuilds, 'failed'>; send?: DispatchSummariesInput['send']; capabilities?: readonly Capability[] }): Promise<void> {
    const capabilities = options.capabilities ?? CAPABILITIES
    // Only a pending baseline has anything to wait for, or to say it waits for.
    const answered = pendingBaselineCapabilities(db, capabilities).filter(function sweptFor(capability) {
        const wait = scansWaitingOnACache(capability, outcomes, options.rebuilds)
        if (wait.waiting > 0) {
            console.log('[baseline] ' + capability.id + ' stays pending: ' + scans(wait.waiting) + ' of its languages could not answer while an advisory cache was not ready')
            return false
        }
        if (wait.failed > 0) console.log('[baseline] ' + capability.id + ' completes without ' + scans(wait.failed) + ' whose advisory cache failed to download; they stay unauditable until a download succeeds')
        return true
    })
    claimCompletedBaselines(db, answered, Date.now())
    await dispatchCapabilitySummaries({
        db,
        dryRun: getConfigValue<boolean>(db, CONFIG_KEYS.dryRunNotify) || false,
        portalBaseUrl: getConfigValue<string>(db, CONFIG_KEYS.portalBaseUrl) || null,
        locale: (getConfigValue<string>(db, CONFIG_KEYS.notificationLocale) || 'en') as Locale,
        send: options.send,
        capabilities
    })
}
