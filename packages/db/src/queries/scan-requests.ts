import { and, asc, eq, gte, isNull, or, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import { SCAN_HEARTBEAT_STALE_MS, type ScanRequest } from '@sentinello/core'
import type { DrizzleDb } from '../client'
import { scanRequests } from '../schema'

type ScanRequestRow = typeof scanRequests.$inferSelect

// projectId and rootId are mutually exclusive. Callers should pass at most one; the worker treats
// (projectId set) as single-project, (rootId set) as walk-one-root, (both null) as full sweep.
export function enqueueScanRequest(
    db: DrizzleDb,
    target: { projectId?: string | null; rootId?: string | null },
    at: number
): ScanRequest {
    const id = ulid()
    const projectId = target.projectId || null
    const rootId = target.rootId || null
    db.insert(scanRequests)
        .values({
            id,
            projectId,
            rootId,
            requestedAt: at,
            pickedUpAt: null,
            finishedAt: null,
            heartbeatAt: null,
            status: 'pending'
        })
        .run()
    return {
        id,
        projectId,
        rootId,
        requestedAt: at,
        pickedUpAt: null,
        finishedAt: null,
        heartbeatAt: null,
        status: 'pending'
    }
}

// Pick the oldest pending request and mark it running atomically.
// Returns null if no pending request.
export function claimNextPendingRequest(db: DrizzleDb, at: number): ScanRequest | null {
    const next = db
        .select()
        .from(scanRequests)
        .where(eq(scanRequests.status, 'pending'))
        .orderBy(asc(scanRequests.requestedAt))
        .limit(1)
        .get()
    if (!next) return null
    db.update(scanRequests)
        .set({ status: 'running', pickedUpAt: at, heartbeatAt: at })
        .where(eq(scanRequests.id, next.id))
        .run()
    return {
        id: next.id,
        projectId: next.projectId,
        rootId: next.rootId,
        requestedAt: next.requestedAt,
        pickedUpAt: at,
        finishedAt: next.finishedAt,
        heartbeatAt: at,
        status: 'running'
    }
}

// Refresh the liveness signal mid-scan. Guarded by status='running' so a late ping after
// markScanRequestDone/Failed is a no-op rather than resurrecting a finished row.
export function pingScanRequestHeartbeat(db: DrizzleDb, id: string, at: number): void {
    db.update(scanRequests)
        .set({ heartbeatAt: at })
        .where(and(eq(scanRequests.id, id), eq(scanRequests.status, 'running')))
        .run()
}

// Called once at worker boot. The single-instance lockfile means any 'running' row at startup
// belongs to a previous process that did not exit cleanly — mark them all failed so the queue
// is self-healing across crashes. Returns the count for logging.
export function resetOrphanedRunningRequests(db: DrizzleDb, at: number): number {
    const result = db.update(scanRequests)
        .set({ status: 'failed', finishedAt: at })
        .where(eq(scanRequests.status, 'running'))
        .run()
    return Number(result.changes) || 0
}

export function markScanRequestDone(db: DrizzleDb, id: string, at: number): void {
    db.update(scanRequests).set({ status: 'done', finishedAt: at }).where(eq(scanRequests.id, id)).run()
}

export function markScanRequestFailed(db: DrizzleDb, id: string, at: number): void {
    db.update(scanRequests).set({ status: 'failed', finishedAt: at }).where(eq(scanRequests.id, id)).run()
}

export function listRecentScanRequests(db: DrizzleDb, limit = 50): ScanRequest[] {
    const rows = db
        .select()
        .from(scanRequests)
        .orderBy(asc(scanRequests.requestedAt))
        .limit(limit)
        .all()
    return rows.map(rowToScanRequest)
}

// Read-side primitive used by the UI to drive "Scanning…" button state. Returns all rows that
// are either pending or actively running (fresh heartbeat). Stale 'running' rows are excluded
// so a crashed worker does not pin the UI to "Scanning…" forever.
export function selectInFlightScanRequests(db: DrizzleDb, now: number): ScanRequest[] {
    const freshAfter = now - SCAN_HEARTBEAT_STALE_MS
    const rows = db
        .select()
        .from(scanRequests)
        .where(
            or(
                eq(scanRequests.status, 'pending'),
                and(eq(scanRequests.status, 'running'), gte(scanRequests.heartbeatAt, freshAfter))
            )
        )
        .all()
    return rows.map(rowToScanRequest)
}

export function isAnyScanInFlight(db: DrizzleDb, now: number): boolean {
    const freshAfter = now - SCAN_HEARTBEAT_STALE_MS
    const row = db
        .select({ one: sql<number>`1` })
        .from(scanRequests)
        .where(
            or(
                eq(scanRequests.status, 'pending'),
                and(eq(scanRequests.status, 'running'), gte(scanRequests.heartbeatAt, freshAfter))
            )
        )
        .limit(1)
        .get()
    return Boolean(row)
}

// True if a pending/fresh-running request covers this project — either targets it directly,
// targets its root (so the root sweep will scan it), or is a full sweep (both nullable cols null).
export function isScanInFlightForProject(
    db: DrizzleDb,
    projectId: string,
    rootId: string,
    now: number
): boolean {
    const freshAfter = now - SCAN_HEARTBEAT_STALE_MS
    const row = db
        .select({ one: sql<number>`1` })
        .from(scanRequests)
        .where(
            and(
                or(
                    eq(scanRequests.status, 'pending'),
                    and(eq(scanRequests.status, 'running'), gte(scanRequests.heartbeatAt, freshAfter))
                ),
                or(
                    eq(scanRequests.projectId, projectId),
                    eq(scanRequests.rootId, rootId),
                    and(isNull(scanRequests.projectId), isNull(scanRequests.rootId))
                )
            )
        )
        .limit(1)
        .get()
    return Boolean(row)
}

// True if a pending/fresh-running request covers this root — either targets it directly,
// or is a full sweep. Per-project requests that happen to be inside this root are NOT counted:
// the per-root "Scan now" button is a coarser action and the user picked the strict cascade.
export function isScanInFlightForRoot(db: DrizzleDb, rootId: string, now: number): boolean {
    const freshAfter = now - SCAN_HEARTBEAT_STALE_MS
    const row = db
        .select({ one: sql<number>`1` })
        .from(scanRequests)
        .where(
            and(
                or(
                    eq(scanRequests.status, 'pending'),
                    and(eq(scanRequests.status, 'running'), gte(scanRequests.heartbeatAt, freshAfter))
                ),
                or(
                    eq(scanRequests.rootId, rootId),
                    and(isNull(scanRequests.projectId), isNull(scanRequests.rootId))
                )
            )
        )
        .limit(1)
        .get()
    return Boolean(row)
}

function rowToScanRequest(row: ScanRequestRow): ScanRequest {
    return {
        id: row.id,
        projectId: row.projectId,
        rootId: row.rootId,
        requestedAt: row.requestedAt,
        pickedUpAt: row.pickedUpAt,
        finishedAt: row.finishedAt,
        heartbeatAt: row.heartbeatAt,
        status: row.status
    }
}
