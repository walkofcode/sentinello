import { desc, eq, sql } from 'drizzle-orm'
import type { Scan } from '@sentinello/core'
import type { DrizzleDb } from '../client'
import { scans } from '../schema'

type ScanRow = typeof scans.$inferSelect

export function insertScan(db: DrizzleDb, scan: Scan): void {
    db.insert(scans)
        .values({
            id: scan.id,
            projectId: scan.projectId,
            startedAt: scan.startedAt,
            finishedAt: scan.finishedAt,
            scanner: scan.scanner,
            status: scan.status,
            reasonCode: scan.reasonCode,
            durationMs: scan.durationMs,
            errorText: scan.errorText,
            rawJson: scan.rawJson
        })
        .run()
}

export function getLatestScanForProject(db: DrizzleDb, projectId: string): Scan | null {
    const row = db
        .select()
        .from(scans)
        .where(eq(scans.projectId, projectId))
        .orderBy(desc(scans.finishedAt))
        .limit(1)
        .get()
    if (!row) return null
    return rowToScan(row)
}

export function getLastScanFinishedAt(db: DrizzleDb): number | null {
    const row = db
        .select({ finishedAt: scans.finishedAt })
        .from(scans)
        .orderBy(desc(scans.finishedAt))
        .limit(1)
        .get()
    return row?.finishedAt ?? null
}

export function listScansForProject(db: DrizzleDb, projectId: string, limit = 50, offset = 0): Scan[] {
    const rows = db
        .select()
        .from(scans)
        .where(eq(scans.projectId, projectId))
        .orderBy(desc(scans.finishedAt))
        .limit(limit)
        .offset(offset)
        .all()
    return rows.map(rowToScan)
}

export function countScansForProject(db: DrizzleDb, projectId: string): number {
    const row = db
        .select({ count: sql<number>`count(*)` })
        .from(scans)
        .where(eq(scans.projectId, projectId))
        .get()
    return row?.count ?? 0
}

function rowToScan(row: ScanRow): Scan {
    return {
        id: row.id,
        projectId: row.projectId,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        scanner: row.scanner,
        status: row.status,
        reasonCode: row.reasonCode,
        durationMs: row.durationMs,
        errorText: row.errorText,
        rawJson: row.rawJson
    }
}
