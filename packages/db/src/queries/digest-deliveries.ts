import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm'
import type { DrizzleDb } from '../client'
import { digestDeliveries } from '../schema'

// The weekly digest's ledger (schema.ts digest_deliveries): one row per target per calendar week, and the same
// attempt, success, failure and give-up shape as the baseline summary's (capability-baselines.ts). The worker's tick
// (apps/worker/src/weekly-digest.ts) is the only thing that sends one.

export type DigestSuppressedReason = 'target_disabled' | 'digest_off' | 'not_eligible_at_due' | 'superseded'

export type DigestDelivery = typeof digestDeliveries.$inferSelect

// Only these close delivery, the same set listOpenSummaryDeliveries treats as closed. Any other row stays retryable,
// across any schedule edit.
export function digestDeliveryClosed(row: DigestDelivery): boolean {
    return row.firstSucceededAt !== null || row.dryRunAt !== null || row.gaveUpAt !== null || row.suppressedAt !== null
}

export function listDigestDeliveries(db: DrizzleDb, targetId: string): DigestDelivery[] {
    return db.select().from(digestDeliveries).where(eq(digestDeliveries.targetId, targetId)).orderBy(desc(digestDeliveries.dueAt)).all()
}

// The row that reserves a calendar week for this target against a second insertion, whatever its state: the row of
// that week's key, or the target's latest row if it reads as this week or later under the current timezone. A
// timezone edit can move a due instant across a week boundary, so the latest row's stored key is not enough: `keyOf`
// re-keys its due_at. Its own row is what a retry then attempts, so one week stays one message.
export function reservingDigestDelivery(db: DrizzleDb, targetId: string, weekKey: string, keyOf: (dueAt: number) => string): DigestDelivery | null {
    const own = db.select().from(digestDeliveries)
        .where(and(eq(digestDeliveries.targetId, targetId), eq(digestDeliveries.weekKey, weekKey)))
        .get()
    if (own) return own
    const latest = db.select().from(digestDeliveries)
        .where(eq(digestDeliveries.targetId, targetId))
        .orderBy(desc(digestDeliveries.dueAt))
        .limit(1)
        .get()
    if (latest && keyOf(latest.dueAt) >= weekKey) return latest
    return null
}

export function insertDigestDelivery(db: DrizzleDb, targetId: string, weekKey: string, dueAt: number): DigestDelivery {
    return db.insert(digestDeliveries).values({ targetId, weekKey, dueAt }).returning().get()
}

function deliveryKey(row: Pick<DigestDelivery, 'targetId' | 'weekKey'>) {
    return and(eq(digestDeliveries.targetId, row.targetId), eq(digestDeliveries.weekKey, row.weekKey))
}

// Only the latest due week is ever considered, so a row still open from an earlier week will never be attempted
// again. The ledger says so instead of leaving it looking owed.
export function supersedeOlderDigestDeliveries(db: DrizzleDb, targetId: string, dueAt: number, at: number): void {
    const stale = db.select().from(digestDeliveries)
        .where(and(eq(digestDeliveries.targetId, targetId), lt(digestDeliveries.dueAt, dueAt), isNull(digestDeliveries.suppressedAt)))
        .all()
        .filter(function open(row) { return !digestDeliveryClosed(row) })
    if (stale.length === 0) return
    db.update(digestDeliveries)
        .set({ suppressedAt: at, suppressedReason: 'superseded' })
        .where(and(eq(digestDeliveries.targetId, targetId), inArray(digestDeliveries.weekKey, stale.map(function key(row) { return row.weekKey }))))
        .run()
}

// Recorded BEFORE the send, so an attempt with no recorded outcome reads as unknown and is retried.
export function recordDigestAttempt(db: DrizzleDb, row: DigestDelivery, at: number): void {
    db.update(digestDeliveries)
        .set({
            attempts: sql`${digestDeliveries.attempts} + 1`,
            firstAttemptedAt: sql`COALESCE(${digestDeliveries.firstAttemptedAt}, ${at})`,
            lastAttemptedAt: at
        })
        .where(deliveryKey(row))
        .run()
}

export function recordDigestSuccess(db: DrizzleDb, row: DigestDelivery, at: number): void {
    db.update(digestDeliveries).set({ firstSucceededAt: at, lastErrorText: null }).where(deliveryKey(row)).run()
}

// `gaveUpAt` closes the row for good once its attempt budget is spent.
export function recordDigestFailure(db: DrizzleDb, row: DigestDelivery, errorText: string, gaveUpAt: number | null): void {
    db.update(digestDeliveries).set({ lastErrorText: errorText, gaveUpAt }).where(deliveryKey(row)).run()
}

export function recordDigestGaveUp(db: DrizzleDb, row: DigestDelivery, at: number): void {
    db.update(digestDeliveries).set({ gaveUpAt: at }).where(deliveryKey(row)).run()
}

export function recordDigestDryRun(db: DrizzleDb, row: DigestDelivery, at: number): void {
    db.update(digestDeliveries).set({ dryRunAt: at }).where(deliveryKey(row)).run()
}

export function suppressDigestDelivery(db: DrizzleDb, row: DigestDelivery, reason: DigestSuppressedReason, at: number): void {
    db.update(digestDeliveries).set({ suppressedAt: at, suppressedReason: reason }).where(deliveryKey(row)).run()
}
