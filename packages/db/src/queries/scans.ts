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
            source: scan.source,
            ecosystem: scan.ecosystem,
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

// Per-ecosystem resolver coverage for a project, reconstructed from the most recent scans. Phase 4's
// feed scanners (OSV, gemnasium) serialize an EcosystemCoverage[] into each scan's rawJson; this walks the
// recent scans newest-first and keeps the first coverage entry seen per ecosystem (i.e. the latest). It is
// how the UI/API surface "this Python scan was partial/unauditable" instead of reading a coverage gap as a
// clean bill of health.
export type EcosystemCoverageRow = {
    ecosystem: string
    status: 'ok' | 'partial' | 'unauditable'
    reasonCode: string | null
    details: string[]
}

export function getProjectEcosystemCoverage(db: DrizzleDb, projectId: string): EcosystemCoverageRow[] {
    const rows = db
        .select({ rawJson: scans.rawJson })
        .from(scans)
        .where(eq(scans.projectId, projectId))
        .orderBy(desc(scans.finishedAt))
        .limit(100)
        .all()
    const seen = new Map<string, EcosystemCoverageRow>()
    for (const row of rows) {
        if (!row.rawJson) continue
        let parsed: unknown
        try {
            parsed = JSON.parse(row.rawJson)
        } catch {
            continue
        }
        const coverage = (parsed as { coverage?: unknown }).coverage
        if (!Array.isArray(coverage)) continue
        for (const entry of coverage) {
            if (!entry || typeof entry.ecosystem !== 'string') continue
            if (seen.has(entry.ecosystem)) continue
            const status = entry.status === 'partial' || entry.status === 'unauditable' ? entry.status : 'ok'
            seen.set(entry.ecosystem, {
                ecosystem: entry.ecosystem,
                status,
                reasonCode: typeof entry.reasonCode === 'string' ? entry.reasonCode : null,
                details: Array.isArray(entry.details) ? entry.details.filter(function isStr(d: unknown): d is string { return typeof d === 'string' }) : []
            })
        }
    }
    return Array.from(seen.values())
}

function rowToScan(row: ScanRow): Scan {
    return {
        id: row.id,
        projectId: row.projectId,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        scanner: row.scanner,
        source: row.source ?? row.scanner,
        ecosystem: row.ecosystem ?? 'npm',
        status: row.status,
        reasonCode: row.reasonCode,
        durationMs: row.durationMs,
        errorText: row.errorText,
        rawJson: row.rawJson
    }
}
