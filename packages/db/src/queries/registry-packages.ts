import { and, eq, inArray } from 'drizzle-orm'
import type { DrizzleDb } from '../client'
import { registryPackages } from '../schema'

export type RegistryPackageStatus = 'ok' | 'not_found'

// One cached registry answer. `summaryJson` is the reduced packument for 'ok' (parsed by the caller,
// which owns its shape) and null for 'not_found'.
export type RegistryPackageRow = {
    ecosystem: string
    name: string
    status: RegistryPackageStatus
    summaryJson: string | null
    weeklyDownloads: number | null
    downloadsCheckedAt: number | null
    checkedAt: number
}

// SQLite caps bound parameters per statement; a project's distinct package list stays far below this,
// but a fleet-wide caller must not trip it.
const CHUNK = 500

export function getRegistryPackages(db: DrizzleDb, ecosystem: string, names: readonly string[]): Map<string, RegistryPackageRow> {
    const out = new Map<string, RegistryPackageRow>()
    const unique = [...new Set(names)]
    for (let i = 0; i < unique.length; i += CHUNK) {
        const rows = db
            .select()
            .from(registryPackages)
            .where(and(eq(registryPackages.ecosystem, ecosystem), inArray(registryPackages.name, unique.slice(i, i + CHUNK))))
            .all()
        for (const row of rows) out.set(row.name, row)
    }
    return out
}

// Writes the registry's latest answer for a package. Only ever called with an answer ('ok' or
// 'not_found'): a failed fetch is not an answer and is never cached, so the last good row survives it.
// Download counts belong to a separate, rarer fetch and are left as they are.
export function upsertRegistryPackage(
    db: DrizzleDb,
    row: { ecosystem: string; name: string; status: RegistryPackageStatus; summaryJson: string | null; checkedAt: number }
): void {
    db.insert(registryPackages)
        .values({ ...row, weeklyDownloads: null, downloadsCheckedAt: null })
        .onConflictDoUpdate({
            target: [registryPackages.ecosystem, registryPackages.name],
            set: { status: row.status, summaryJson: row.summaryJson, checkedAt: row.checkedAt }
        })
        .run()
}

// Records a package's weekly download count beside its cached answer. Only a package that already has a
// cached answer is updated: counts are fetched for packages whose summary was just read, and a count
// with no answer to belong to is not worth a row.
export function setRegistryDownloads(db: DrizzleDb, ecosystem: string, name: string, weeklyDownloads: number, checkedAt: number): void {
    db.update(registryPackages)
        .set({ weeklyDownloads, downloadsCheckedAt: checkedAt })
        .where(and(eq(registryPackages.ecosystem, ecosystem), eq(registryPackages.name, name)))
        .run()
}
