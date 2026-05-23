import { eq } from 'drizzle-orm'
import type { DrizzleDb } from '../client'
import { appConfig, roots } from '../schema'
import { deleteTargetRootsForRoot } from './notification-target-roots'

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

export function deleteRoot(db: DrizzleDb, id: string): void {
    // Wipe notification-target scope rows referencing this root first; otherwise a target with
    // an explicit allow-list could end up pointing at a deleted root and the dispatch query would
    // silently include 0 matching projects without surfacing the broken reference.
    deleteTargetRootsForRoot(db, id)
    db.delete(roots).where(eq(roots.id, id)).run()
}
