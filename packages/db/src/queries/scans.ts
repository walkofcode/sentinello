import { desc, eq, inArray, sql } from 'drizzle-orm'
import { SOURCE_UNAVAILABLE_REASON_CODES, type Scan } from '@sentinello/core'
import type { DrizzleDb } from '../client'
import { scans } from '../schema'
import { sumCount } from './count'

type ScanRow = typeof scans.$inferSelect

// Hard ceiling on what any scanner can persist into scans.raw_json. This is the choke point every
// writer goes through, which is the point: npm-audit used to store the entire raw audit document
// here and reached 2.1 GB — 98.7% of a real instance's database — before anyone noticed, because no
// single writer looked unreasonable on its own. rawJson is a small structured summary by contract
// (see packages/scanners/src/types.ts), so anything approaching this size is already a bug; the cap
// bounds the blast radius rather than defining the format.
//
// Truncation is marked rather than silent so a truncated value is obviously not parseable JSON,
// instead of looking like a scanner that wrote something malformed. getProjectEcosystemCoverage
// already skips anything it cannot parse (see below).
export const RAW_JSON_MAX_BYTES = 32 * 1024
const RAW_JSON_TRUNCATION_MARKER = '…[truncated]'

export function capRawJson(rawJson: string): string {
    if (rawJson.length <= RAW_JSON_MAX_BYTES) return rawJson
    return rawJson.slice(0, RAW_JSON_MAX_BYTES - RAW_JSON_TRUNCATION_MARKER.length) + RAW_JSON_TRUNCATION_MARKER
}

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
            rawJson: capRawJson(scan.rawJson)
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

// Does any project's LATEST scan for this source still say the source's cache could not be consulted?
//
// The worker enqueues a re-scan when a cache TRANSITIONS to usable inside one sync, which covers the
// seed that just finished. It cannot cover a transition nobody was watching: a cache that became usable
// under a previous build, or while the worker was down, leaves every project holding an
// osv_db_not_seeded verdict with nothing left to trigger a re-scan — the cache is fine, the verdicts are
// stale, and they would sit there until the next scheduled sweep or until someone noticed and clicked.
// This is the boot-time reconciliation for exactly that: ask whether the two disagree, rather than
// relying on having observed the moment they stopped agreeing.
//
// Latest scan PER PROJECT for the source, not the newest row overall: one project scanned since the
// cache came back does not speak for the rest.
export function hasStaleSourceUnavailableScans(db: DrizzleDb, source: string): boolean {
    // .all() + sumCount rather than .get() + `?? 0`: a COUNT(*) with no GROUP BY always returns exactly
    // one row, so the fallback would be a branch no database state can reach. See ./count.
    const rows = db.all<{ count: number }>(sql`
        WITH ranked AS (
            SELECT s.reason_code AS reason_code,
                   ROW_NUMBER() OVER (
                       PARTITION BY s.project_id
                       ORDER BY s.finished_at DESC, s.id DESC
                   ) AS rn
            FROM scans s
            WHERE COALESCE(s.source, s.scanner) = ${source}
        )
        SELECT COUNT(*) AS count
        FROM ranked
        WHERE rn = 1
          AND reason_code IN (${sql.join(SOURCE_UNAVAILABLE_REASON_CODES.map(function lit(c) { return sql`${c}` }), sql`, `)})
    `)
    return sumCount(rows) > 0
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
    return sumCount(
        db.select({ count: sql<number>`count(*)` }).from(scans).where(eq(scans.projectId, projectId)).all()
    )
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

// --- Retention ---

// Scan rows accumulate one per (project × source × ecosystem) per sweep and nothing has ever deleted
// them by age: cascadeDeleteProjects is scoped by projectId, for projects that vanish from disk. A
// real instance reached 60k rows / 2.2 GB in under three months.
//
// A row is prunable only when all three hold, and each condition earns its place:
//
//  1. It is older than the caller's cutoff.
//  2. It is not among the newest `keepPerProject` scans for its project. This protects
//     getProjectEcosystemCoverage below, which reads exactly the last 100 scans per project and is
//     what lets the UI say "this Python scan was partial" rather than reading a coverage gap as a
//     clean bill of health. It also keeps listVulnTrendForProject's sparkline and, for a
//     rarely-scanned project, the difference between "no findings" and "never successfully scanned".
//  3. Nothing references it. foreign_keys is ON (client.ts) and findings.scan_id,
//     findings.resolved_scan_id and notification_events.first_scan_id are all NO ACTION, so a
//     referenced row does not merely deserve keeping — deleting it THROWS.
//
// This is race-free against the writer: no code path ever re-points an OLD scan. findings records
// scan_id at first detection and resolved_scan_id at resolution, both the current scan, and
// notification_events writes first_scan_id on insert only. The referenced set grows at the head, so a
// row older than the cutoff can never acquire a new reference mid-sweep.
export function listPrunableScanIds(db: DrizzleDb, cutoffAt: number, keepPerProject: number, batchSize: number): string[] {
    const rows = db.all<{ id: string }>(sql`
        WITH ranked AS (
            SELECT id, project_id, finished_at,
                   ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY finished_at DESC) AS rn
            FROM scans
        )
        SELECT r.id AS id
        FROM ranked r
        WHERE r.rn > ${keepPerProject}
          AND r.finished_at < ${cutoffAt}
          -- NOT IN, deliberately, and NOT NOT EXISTS. There is no index on findings.resolved_scan_id
          -- or on notification_events.first_scan_id, so NOT EXISTS degenerates into a full scan per
          -- candidate: measured against a real 60k-row table, 47.4s versus 0.09s. NOT IN materialises
          -- each list once. This inverts the usual advice, which is why it is written down.
          --
          -- The IS NOT NULL guard on resolved_scan_id is LOAD-BEARING. NOT IN against a list
          -- containing NULL evaluates to NULL for every row, so dropping it does not raise an error —
          -- it silently makes this sweep return nothing, forever. scan_id and first_scan_id are
          -- NOT NULL in the schema and so need no guard; if that ever changes, they need one too.
          AND r.id NOT IN (SELECT scan_id FROM findings)
          AND r.id NOT IN (SELECT resolved_scan_id FROM findings WHERE resolved_scan_id IS NOT NULL)
          AND r.id NOT IN (SELECT first_scan_id FROM notification_events)
        LIMIT ${batchSize}
    `)
    return rows.map(function pickId(row) { return row.id })
}

export function deleteScansByIds(db: DrizzleDb, ids: string[]): number {
    if (ids.length === 0) return 0
    const result = db.delete(scans).where(inArray(scans.id, ids)).run()
    return result.changes
}

function rowToScan(row: ScanRow): Scan {
    return {
        id: row.id,
        projectId: row.projectId,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        scanner: row.scanner,
        source: row.source ?? row.scanner,
        // No `?? 'npm'`: scans.ecosystem is NOT NULL DEFAULT 'npm' (schema.ts:67). Only source is nullable.
        ecosystem: row.ecosystem,
        status: row.status,
        reasonCode: row.reasonCode,
        durationMs: row.durationMs,
        errorText: row.errorText,
        rawJson: row.rawJson
    }
}
