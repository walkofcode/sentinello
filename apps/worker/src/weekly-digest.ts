import { digestWeekKey, latestDigestDue, type Locale, type NotificationTarget } from '@sentinello/core'
import {
    digestDeliveryClosed,
    getConfigValue,
    getProjectById,
    getWeeklyDigestSchedule,
    insertDigestDelivery,
    listNotificationTargets,
    outstandingForTarget,
    recordDigestAttempt,
    recordDigestDryRun,
    recordDigestFailure,
    recordDigestGaveUp,
    recordDigestSuccess,
    reservingDigestDelivery,
    supersedeOlderDigestDeliveries,
    suppressDigestDelivery,
    unscannableForTarget,
    type DigestDelivery,
    type DigestSuppressedReason,
    type DrizzleDb
} from '@sentinello/db'
import { redactErrorText, redactTarget, renderFleetSummary, summarizeFleetFindings, type NotificationSender } from '@sentinello/notifications'
import { MAX_SUMMARY_ATTEMPTS, inSummaryQueue } from './capability-baseline'
import { CONFIG_KEYS, type Schedule } from './config-loader'
import { unscannableLines } from './run-summary'
import { sendByKind } from './transport'

// One message per enabled target per calendar week, also with nothing outstanding: the proof the system is alive
// (notifications-design.md, Weekly digest). Called from one cron inside the scheduler and once at boot; both reach
// here through the shared queue, and most ticks stop at finding this week's rows closed.

const RETRY_INTERVAL_MS = 60 * 60 * 1000

export type DigestTickInput = {
    db: DrizzleDb
    send?: NotificationSender
    // The clock; tests fix it.
    now?: number
}

export function runDigestTick(input: DigestTickInput): Promise<void> {
    return inSummaryQueue(function tick() { return tickDigests(input) })
}

// Why a target with no row this week is owed nothing for it, or null when it is owed. Judged against the due instant,
// not now: a target that was off at the due instant is not owed that week, whenever it came back on.
function notOwedReason(target: NotificationTarget, dueAt: number): DigestSuppressedReason | null {
    if (!target.enabled) return 'target_disabled'
    if (!target.weeklyDigest) return 'digest_off'
    if ((target.digestEligibleSinceAt ?? target.createdAt) > dueAt) return 'not_eligible_at_due'
    return null
}

async function tickDigests(input: DigestTickInput): Promise<void> {
    const now = input.now ?? Date.now()
    const timezone = getConfigValue<Schedule>(input.db, CONFIG_KEYS.schedule)?.timezone
    const { dueAt, weekKey } = latestDigestDue(getWeeklyDigestSchedule(input.db), timezone, now)
    function keyOf(instant: number): string { return digestWeekKey(instant, timezone) }
    for (const target of listNotificationTargets(input.db)) {
        const reserving = reservingDigestDelivery(input.db, target.id, weekKey, keyOf)
        if (reserving === null) {
            // Only the latest due week is ever considered, so a worker down for three weeks sends one.
            supersedeOlderDigestDeliveries(input.db, target.id, dueAt, now)
            const row = insertDigestDelivery(input.db, target.id, weekKey, dueAt)
            const reason = notOwedReason(target, dueAt)
            if (reason !== null) suppressDigestDelivery(input.db, row, reason, now)
            else await attemptDigest(input, target, row, now)
            continue
        }
        if (digestDeliveryClosed(reserving)) continue
        if (!target.enabled) {
            suppressDigestDelivery(input.db, reserving, 'target_disabled', now)
            continue
        }
        if (!target.weeklyDigest) {
            suppressDigestDelivery(input.db, reserving, 'digest_off', now)
            continue
        }
        // Spent by attempts whose outcome a crash lost: failures close the row themselves.
        if (reserving.attempts >= MAX_SUMMARY_ATTEMPTS) {
            recordDigestGaveUp(input.db, reserving, now)
            continue
        }
        if (reserving.lastAttemptedAt !== null && now - reserving.lastAttemptedAt < RETRY_INTERVAL_MS) continue
        await attemptDigest(input, target, reserving, now)
    }
}

// A digest is counted fresh at each attempt, so a retry cannot go stale. An empty one still sends.
async function attemptDigest(input: DigestTickInput, target: NotificationTarget, row: DigestDelivery, now: number): Promise<void> {
    const db = input.db
    const locale = (getConfigValue<string>(db, CONFIG_KEYS.notificationLocale) || 'en') as Locale
    const { counts, severe } = outstandingForTarget(db, target, now)
    const { listed } = summarizeFleetFindings(severe, function projectName(projectId) {
        const project = getProjectById(db, projectId)
        return project?.alias ?? project?.name ?? projectId
    })
    const message = renderFleetSummary({
        kind: 'weekly_digest',
        targetKind: target.kind,
        counts,
        listed,
        resolved: [],
        unscannable: unscannableLines(unscannableForTarget(db, target, now), locale),
        portalBaseUrl: getConfigValue<string>(db, CONFIG_KEYS.portalBaseUrl) || null,
        locale
    })
    if (getConfigValue<boolean>(db, CONFIG_KEYS.dryRunNotify)) {
        console.log('[digest] DRY-RUN ' + redactTarget(target) + ' would receive: ' + message.title)
        recordDigestDryRun(db, row, now)
        return
    }
    // Recorded before the send: an attempt with no outcome is unknown, and retried within the budget.
    recordDigestAttempt(db, row, now)
    const result = await (input.send ?? sendByKind)(target, message)
    if (result.ok) {
        recordDigestSuccess(db, row, now)
        console.log('[digest] sent to ' + redactTarget(target))
        return
    }
    const errorText = redactErrorText(result.errorText)
    const spent = row.attempts + 1 >= MAX_SUMMARY_ATTEMPTS
    recordDigestFailure(db, row, errorText, spent ? now : null)
    console.error('[digest] send to ' + redactTarget(target) + ' failed' + (spent ? ', giving up' : ', retried in an hour') + ': ' + errorText)
}
