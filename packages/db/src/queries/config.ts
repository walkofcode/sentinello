import { eq } from 'drizzle-orm'
import type { DrizzleDb } from '../client'
import { appConfig, notificationTargetRoots, projects, roots, scanRequests } from '../schema'
import { cascadeDeleteProjects } from './projects'

export type Root = typeof roots.$inferSelect

export function getConfigValue<T = unknown>(db: DrizzleDb, key: string): T | null {
    const row = db.select().from(appConfig).where(eq(appConfig.key, key)).get()
    if (!row) return null
    return JSON.parse(row.valueJson) as T
}

export function setConfigValue(db: DrizzleDb, key: string, value: unknown): void {
    const valueJson = JSON.stringify(value)
    db.insert(appConfig)
        .values({ key, valueJson })
        .onConflictDoUpdate({ target: appConfig.key, set: { valueJson } })
        .run()
}

export function listConfig(db: DrizzleDb): Record<string, unknown> {
    const rows = db.select().from(appConfig).all()
    const out: Record<string, unknown> = {}
    for (const row of rows) {
        out[row.key] = JSON.parse(row.valueJson)
    }
    return out
}

export function listRoots(db: DrizzleDb): Root[] {
    return db.select().from(roots).all()
}

export function getRootById(db: DrizzleDb, id: string): Root | null {
    const row = db.select().from(roots).where(eq(roots.id, id)).get()
    return row || null
}

export function getRootByPath(db: DrizzleDb, path: string): Root | null {
    const row = db.select().from(roots).where(eq(roots.path, path)).get()
    return row || null
}

export function upsertRoot(db: DrizzleDb, root: Root): void {
    db.insert(roots)
        .values(root)
        .onConflictDoUpdate({
            target: roots.id,
            set: { path: root.path, label: root.label }
        })
        .run()
}

// Label-only update used by the inline rename UI. Path is intentionally NOT writable here —
// the root id is sha256(path), and renaming would orphan every project/scan/finding under it.
export function updateRootLabel(db: DrizzleDb, id: string, label: string | null): void {
    db.update(roots).set({ label }).where(eq(roots.id, id)).run()
}

// Hard-delete a root and everything underneath it in one transaction. Three tables reference
// roots.id with ON DELETE no action (foreign_keys = ON is set in client.ts), so a bare DELETE
// fails with FOREIGN KEY constraint failed once any child rows exist: projects.root_id,
// scan_requests.root_id (root-level requests with project_id null), and
// notification_target_roots.root_id. We cascade explicitly child-first; project cascade is
// reused from cascadeDeleteProjects so this stays in lockstep with deleteProject.
export function deleteRoot(db: DrizzleDb, id: string): void {
    db.transaction(function txn(tx) {
        const projectRows = tx.select({ id: projects.id }).from(projects).where(eq(projects.rootId, id)).all()
        const projectIds = projectRows.map(function pickId(r) { return r.id })
        cascadeDeleteProjects(tx, projectIds)
        // Root-scoped scan requests (rootId set, projectId null) — not covered by the per-project cascade.
        tx.delete(scanRequests).where(eq(scanRequests.rootId, id)).run()
        // Notification-target scope rows referencing this root. A target with an explicit allow-list
        // pointing at a deleted root would otherwise silently match 0 projects without surfacing the
        // broken reference.
        tx.delete(notificationTargetRoots).where(eq(notificationTargetRoots.rootId, id)).run()
        tx.delete(roots).where(eq(roots.id, id)).run()
    })
}
