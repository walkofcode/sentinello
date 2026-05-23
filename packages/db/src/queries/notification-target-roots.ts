import { eq, inArray } from 'drizzle-orm'
import type { DrizzleDb } from '../client'
import { notificationTargetRoots } from '../schema'

// Per-target root scope helpers. Zero rows for a target = "all roots" (no filter applied by
// the dispatch query). One or more rows = explicit allow-list. The dispatch SQL in
// selectDispatchablePairs / backfillForNewTarget is the load-bearing reader of these rows;
// these helpers are the only writers.

export function listTargetRootIds(db: DrizzleDb, targetId: string): string[] {
    const rows = db
        .select({ rootId: notificationTargetRoots.rootId })
        .from(notificationTargetRoots)
        .where(eq(notificationTargetRoots.targetId, targetId))
        .all()
    return rows.map(function toId(r) { return r.rootId })
}

// Batched lookup keyed by targetId. Returns a Map so callers can hand out empty arrays for
// targets that have zero rows (which is the "all roots" sentinel — callers must NOT confuse a
// missing key with a key whose value is an empty array; both mean the same thing, but always
// hand back an empty array for ergonomics).
export function listRootIdsForTargets(db: DrizzleDb, targetIds: string[]): Map<string, string[]> {
    const out = new Map<string, string[]>()
    for (const id of targetIds) out.set(id, [])
    if (targetIds.length === 0) return out
    const rows = db
        .select({
            targetId: notificationTargetRoots.targetId,
            rootId: notificationTargetRoots.rootId
        })
        .from(notificationTargetRoots)
        .where(inArray(notificationTargetRoots.targetId, targetIds))
        .all()
    for (const row of rows) {
        const list = out.get(row.targetId) || []
        list.push(row.rootId)
        out.set(row.targetId, list)
    }
    return out
}

// Replace-all: wipe existing rows for the target, then insert the new set. Wrapped in a write
// transaction so dispatch never observes a half-applied scope (e.g. zero rows mid-update would
// momentarily mean "all roots").
export function setTargetRoots(db: DrizzleDb, targetId: string, rootIds: string[]): void {
    db.transaction(function txn(tx) {
        tx.delete(notificationTargetRoots).where(eq(notificationTargetRoots.targetId, targetId)).run()
        if (rootIds.length === 0) return
        const values = rootIds.map(function toRow(rootId) { return { targetId, rootId } })
        tx.insert(notificationTargetRoots).values(values).run()
    })
}

// Cascades. Called from deleteNotificationTarget / deleteRoot in the sibling query modules so
// scope rows can never outlive their referents (SQLite FKs are advertised but not enforced as
// CASCADE here — we own the cleanup explicitly).

export function deleteTargetRootsForTarget(db: DrizzleDb, targetId: string): void {
    db.delete(notificationTargetRoots).where(eq(notificationTargetRoots.targetId, targetId)).run()
}

export function deleteTargetRootsForRoot(db: DrizzleDb, rootId: string): void {
    db.delete(notificationTargetRoots).where(eq(notificationTargetRoots.rootId, rootId)).run()
}
