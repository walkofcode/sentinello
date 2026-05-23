import { eq } from 'drizzle-orm'
import type { NotificationTarget, NotificationTargetConfig } from '@sentinello/core'
import type { DrizzleDb } from '../client'
import { notificationTargets } from '../schema'
import {
    deleteTargetRootsForTarget,
    listRootIdsForTargets,
    listTargetRootIds
} from './notification-target-roots'
import {
    deleteTargetProjectsForTarget,
    listProjectIdsForTargets,
    listTargetProjectIds
} from './notification-target-projects'

type NotificationTargetRow = typeof notificationTargets.$inferSelect

export function listNotificationTargets(db: DrizzleDb): NotificationTarget[] {
    const rows = db.select().from(notificationTargets).all()
    return hydrateTargets(db, rows)
}

export function listEnabledNotificationTargets(db: DrizzleDb): NotificationTarget[] {
    const rows = db.select().from(notificationTargets).where(eq(notificationTargets.enabled, true)).all()
    return hydrateTargets(db, rows)
}

export function getNotificationTargetById(db: DrizzleDb, id: string): NotificationTarget | null {
    const row = db.select().from(notificationTargets).where(eq(notificationTargets.id, id)).get()
    if (!row) return null
    const rootIds = listTargetRootIds(db, row.id)
    const projectIds = listTargetProjectIds(db, row.id)
    return rowToTarget(row, rootIds, projectIds)
}

export function insertNotificationTarget(db: DrizzleDb, target: NotificationTarget): void {
    db.insert(notificationTargets)
        .values({
            id: target.id,
            kind: target.kind,
            configJson: JSON.stringify(target.config),
            severityFilterJson: JSON.stringify(target.severityFilter),
            enabled: target.enabled,
            createdAt: target.createdAt
        })
        .run()
}

export function setNotificationTargetEnabled(db: DrizzleDb, id: string, enabled: boolean): void {
    db.update(notificationTargets).set({ enabled }).where(eq(notificationTargets.id, id)).run()
}

export function deleteNotificationTarget(db: DrizzleDb, id: string): void {
    // Three FK children point at notification_targets.id and the client opens with
    // foreign_keys = ON, so all three must be addressed or the parent delete is rejected
    // with FOREIGN KEY constraint failed:
    //   - notification_target_roots / notification_target_projects: deleted child-first here
    //     because scope rows are meaningless without their parent target.
    //   - notification_deliveries: handled at the DB by ON DELETE SET NULL — the historical
    //     delivery row survives as an audit trail with target_id nulled out.
    // Wrapped in a transaction so a partial failure can't leave the scope rows orphaned.
    db.transaction(function cascade(tx) {
        deleteTargetRootsForTarget(tx, id)
        deleteTargetProjectsForTarget(tx, id)
        tx.delete(notificationTargets).where(eq(notificationTargets.id, id)).run()
    })
}

// Patch-style update: only the fields supplied are written. createdAt is never updated (it is the
// load-bearing anchor for backfill semantics). config is optional so the caller can update the
// severity filter / enabled flag without re-supplying the raw secret payload.
export type UpdateNotificationTargetInput = {
    id: string
    config?: NotificationTargetConfig
    severityFilter?: NotificationTarget['severityFilter']
    enabled?: boolean
}

export function updateNotificationTarget(db: DrizzleDb, input: UpdateNotificationTargetInput): void {
    const patch: Record<string, unknown> = {}
    if (input.config !== undefined) patch.configJson = JSON.stringify(input.config)
    if (input.severityFilter !== undefined) patch.severityFilterJson = JSON.stringify(input.severityFilter)
    if (input.enabled !== undefined) patch.enabled = input.enabled
    if (Object.keys(patch).length === 0) return
    db.update(notificationTargets).set(patch).where(eq(notificationTargets.id, input.id)).run()
}

function hydrateTargets(db: DrizzleDb, rows: NotificationTargetRow[]): NotificationTarget[] {
    if (rows.length === 0) return []
    const ids = rows.map(function pickId(r) { return r.id })
    const rootIdsByTarget = listRootIdsForTargets(db, ids)
    const projectIdsByTarget = listProjectIdsForTargets(db, ids)
    return rows.map(function toTarget(row) {
        return rowToTarget(row, rootIdsByTarget.get(row.id) || [], projectIdsByTarget.get(row.id) || [])
    })
}

function rowToTarget(row: NotificationTargetRow, rootIds: string[], projectIds: string[]): NotificationTarget {
    const config = JSON.parse(row.configJson) as NotificationTargetConfig
    const severityFilter = parseSeverityFilter(row.severityFilterJson)
    return {
        id: row.id,
        kind: row.kind,
        config,
        severityFilter,
        enabled: row.enabled,
        createdAt: row.createdAt,
        rootIds,
        projectIds
    }
}

function parseSeverityFilter(json: string): NotificationTarget['severityFilter'] {
    const parsed = JSON.parse(json) as unknown
    if (!Array.isArray(parsed)) return []
    const valid = new Set(['critical', 'high', 'moderate', 'low', 'info'])
    return parsed.filter(function isSev(value): value is NotificationTarget['severityFilter'][number] {
        return typeof value === 'string' && valid.has(value)
    })
}
