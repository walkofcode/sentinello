import { eq, inArray } from 'drizzle-orm'
import type { DrizzleDb } from '../client'
import { notificationTargetProjects } from '../schema'

// Per-target project scope helpers, parallel to notification-target-roots. Zero rows for a target
// (in BOTH this table and notification_target_roots) = "everything". One or more rows here = the
// target also fires for events from these specific projects. The dispatch SQL in
// selectDispatchablePairs / backfillForNewTarget is the load-bearing reader; these are the writers.

export function listTargetProjectIds(db: DrizzleDb, targetId: string): string[] {
    const rows = db
        .select({ projectId: notificationTargetProjects.projectId })
        .from(notificationTargetProjects)
        .where(eq(notificationTargetProjects.targetId, targetId))
        .all()
    return rows.map(function toId(r) { return r.projectId })
}

// Batched lookup keyed by targetId. Always hands back an empty array for targets with zero rows so
// callers don't have to distinguish a missing key from an empty list (both mean "no project scope").
export function listProjectIdsForTargets(db: DrizzleDb, targetIds: string[]): Map<string, string[]> {
    const out = new Map<string, string[]>()
    for (const id of targetIds) out.set(id, [])
    if (targetIds.length === 0) return out
    const rows = db
        .select({
            targetId: notificationTargetProjects.targetId,
            projectId: notificationTargetProjects.projectId
        })
        .from(notificationTargetProjects)
        .where(inArray(notificationTargetProjects.targetId, targetIds))
        .all()
    for (const row of rows) {
        const list = out.get(row.targetId) || []
        list.push(row.projectId)
        out.set(row.targetId, list)
    }
    return out
}

// Replace-all in a write transaction so dispatch never observes a half-applied scope.
export function setTargetProjects(db: DrizzleDb, targetId: string, projectIds: string[]): void {
    db.transaction(function txn(tx) {
        tx.delete(notificationTargetProjects).where(eq(notificationTargetProjects.targetId, targetId)).run()
        if (projectIds.length === 0) return
        const values = projectIds.map(function toRow(projectId) { return { targetId, projectId } })
        tx.insert(notificationTargetProjects).values(values).run()
    })
}

// Cascades. Called from deleteNotificationTarget / deleteProject so scope rows never outlive their
// referents (SQLite FKs here are advertised but not CASCADE-enforced — we own the cleanup).

export function deleteTargetProjectsForTarget(db: DrizzleDb, targetId: string): void {
    db.delete(notificationTargetProjects).where(eq(notificationTargetProjects.targetId, targetId)).run()
}

export function deleteTargetProjectsForProject(db: DrizzleDb, projectId: string): void {
    db.delete(notificationTargetProjects).where(eq(notificationTargetProjects.projectId, projectId)).run()
}
