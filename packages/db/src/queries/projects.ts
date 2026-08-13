import { eq, inArray } from 'drizzle-orm'
import { getEcosystem, type EcosystemId, type Project } from '@sentinello/core'
import type { DrizzleDb } from '../client'
import { isProjectMuted } from './mutes'
import {
    findings,
    mutes,
    notificationDeliveries,
    notificationEvents,
    notificationTargetProjects,
    projects,
    scanRequests,
    scans
} from '../schema'

type ProjectRow = typeof projects.$inferSelect
type ProjectInsert = typeof projects.$inferInsert

export function listProjects(db: DrizzleDb): Project[] {
    const rows = db.select().from(projects).all()
    return rows.map(rowToProject)
}

export function listProjectsByRoot(db: DrizzleDb, rootId: string): Project[] {
    const rows = db.select().from(projects).where(eq(projects.rootId, rootId)).all()
    return rows.map(rowToProject)
}

// `muted` is resolved from the mutes table rather than the legacy projects.muted column, matching what
// listProjectCatalog already does for the dashboard. Nothing writes the column any more, so reading it
// reported a wholesale-muted project as muted:false — which is what MCP get_project was handing agents.
// listProjects deliberately keeps reading the column: discovery round-trips that value on every sweep.
export function getProjectById(db: DrizzleDb, id: string, at: number = Date.now()): Project | null {
    const row = db.select().from(projects).where(eq(projects.id, id)).get()
    if (!row) return null
    return { ...rowToProject(row), muted: isProjectMuted(db, id, at) }
}

export function upsertProject(db: DrizzleDb, project: Project): void {
    const insertRow = projectToInsert(project)
    db.insert(projects)
        .values(insertRow)
        .onConflictDoUpdate({
            target: projects.id,
            set: {
                rootId: insertRow.rootId,
                relPath: insertRow.relPath,
                name: insertRow.name,
                packageManager: insertRow.packageManager,
                nvmrcVersion: insertRow.nvmrcVersion,
                gitBranch: insertRow.gitBranch,
                tagsJson: insertRow.tagsJson,
                ecosystemsJson: insertRow.ecosystemsJson,
                updatedAt: insertRow.updatedAt
            }
        })
        .run()
}

// Hard-delete a batch of projects and everything that hangs off them. Sentinello keeps only
// projects it currently sees on disk: when discovery finds a project gone (under a root it
// actually walked — an unmounted root is skipped, never reconciled), it deletes the project
// rather than tombstoning it. SQLite FKs here are advertised but not CASCADE-enforced, so we
// cascade explicitly, child rows before parents. notification_deliveries hangs off events (not
// the project) so it must go before the events it references.
//
// Operates on the provided tx — callers wrap (or batch with sibling deletes) inside a single
// transaction. No-op when projectIds is empty so callers can pass results of a lookup without
// gating.
export function cascadeDeleteProjects(tx: DrizzleDb, projectIds: string[]): void {
    if (projectIds.length === 0) return
    const eventRows = tx
        .select({ id: notificationEvents.id })
        .from(notificationEvents)
        .where(inArray(notificationEvents.projectId, projectIds))
        .all()
    const eventIds = eventRows.map(function pickId(r) { return r.id })
    if (eventIds.length > 0) {
        tx.delete(notificationDeliveries).where(inArray(notificationDeliveries.eventId, eventIds)).run()
    }
    tx.delete(notificationEvents).where(inArray(notificationEvents.projectId, projectIds)).run()
    tx.delete(notificationTargetProjects).where(inArray(notificationTargetProjects.projectId, projectIds)).run()
    // findings reference scans via scan_id / resolved_scan_id, so delete findings before scans.
    tx.delete(findings).where(inArray(findings.projectId, projectIds)).run()
    tx.delete(scans).where(inArray(scans.projectId, projectIds)).run()
    tx.delete(scanRequests).where(inArray(scanRequests.projectId, projectIds)).run()
    // Only project-scoped mutes; global finding mutes (project_id IS NULL) are unrelated.
    tx.delete(mutes).where(inArray(mutes.projectId, projectIds)).run()
    tx.delete(projects).where(inArray(projects.id, projectIds)).run()
}

export function deleteProject(db: DrizzleDb, id: string): void {
    db.transaction(function txn(tx) {
        cascadeDeleteProjects(tx, [id])
    })
}

export function setProjectTags(db: DrizzleDb, id: string, tags: string[], at: number): void {
    db.update(projects)
        .set({ tagsJson: JSON.stringify(tags), updatedAt: at })
        .where(eq(projects.id, id))
        .run()
}

export function setProjectAlias(db: DrizzleDb, id: string, alias: string | null, at: number): void {
    db.update(projects).set({ alias, updatedAt: at }).where(eq(projects.id, id)).run()
}

// Written by the worker at scan start so the recorded branch matches the code the findings came
// from, not whatever was checked out during the last discovery sweep.
export function setProjectGitBranch(db: DrizzleDb, id: string, gitBranch: string | null, at: number): void {
    db.update(projects).set({ gitBranch, updatedAt: at }).where(eq(projects.id, id)).run()
}

function rowToProject(row: ProjectRow): Project {
    return {
        id: row.id,
        rootId: row.rootId,
        relPath: row.relPath,
        name: row.name,
        alias: row.alias,
        packageManager: row.packageManager,
        nvmrcVersion: row.nvmrcVersion,
        gitBranch: row.gitBranch,
        ecosystems: parseEcosystems(row.ecosystemsJson),
        muted: row.muted,
        tags: parseTags(row.tagsJson),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt
    }
}

function parseTags(json: string): string[] {
    const parsed = JSON.parse(json) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(function isString(value): value is string {
        return typeof value === 'string'
    })
}

// Parse the persisted ecosystems_json, keeping only values that are still known to the central registry
// (so a renamed/removed ecosystem id can't reach the rest of the app as a phantom EcosystemId).
function parseEcosystems(json: string): EcosystemId[] {
    const parsed = JSON.parse(json) as unknown
    if (!Array.isArray(parsed)) return []
    const out: EcosystemId[] = []
    for (const value of parsed) {
        if (typeof value !== 'string') continue
        const def = getEcosystem(value)
        if (def) out.push(def.id)
    }
    return out
}

function projectToInsert(project: Project): ProjectInsert {
    return {
        id: project.id,
        rootId: project.rootId,
        relPath: project.relPath,
        name: project.name,
        alias: project.alias,
        packageManager: project.packageManager,
        nvmrcVersion: project.nvmrcVersion,
        gitBranch: project.gitBranch,
        muted: project.muted,
        tagsJson: JSON.stringify(project.tags),
        ecosystemsJson: JSON.stringify(project.ecosystems),
        createdAt: project.createdAt,
        updatedAt: project.updatedAt
    }
}
