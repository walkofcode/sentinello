import { readFileSync, writeFileSync } from 'node:fs'
import { openDb } from '../../../packages/db/src/client'
import { E2E_BASELINE_PATH, E2E_DB_PATH } from './paths'
import type { Database as SqliteDb } from 'better-sqlite3'

// Database operations the mutating specs need, run in a tsx child process (see admin.ts for why).
//
// better-sqlite3 is reached through packages/db/src/client rather than imported directly: it is
// installed under packages/db and does not resolve from anywhere else in the repo.

type Counts = Record<string, number>

export type AdminState = {
    counts: Counts
    fixture: { version: number; rootPath: string; seededAt: number } | null
    inFlight: number
}

// Read from sqlite_master rather than a hand-maintained list, so a migration that adds a table cannot
// silently leave it out of the reset. __drizzle_migrations is excluded — the migration ledger must
// survive, or the next openDb would try to re-run every migration.
function userTables(sqlite: SqliteDb): string[] {
    const rows = sqlite
        .prepare(
            "select name from sqlite_master where type='table' " +
            "and name not like 'sqlite_%' and name not like '__drizzle%' order by name"
        )
        .all() as { name: string }[]
    return rows.map(function pick(r) { return r.name })
}

function open() {
    // Never a fresh path, never an unlink: the portal caches its handle on globalThis.__sentinelloDb
    // and the worker holds its own, so the file must stay the same inode for the whole run. Every
    // operation here opens the EXISTING file and mutates rows in place.
    return openDb({ dbPath: E2E_DB_PATH })
}

function countsFor(sqlite: SqliteDb): Counts {
    const out: Counts = {}
    for (const t of userTables(sqlite)) {
        const row = sqlite.prepare('select count(*) as n from "' + t + '"').get() as { n: number }
        out[t] = row.n
    }
    return out
}

export function state(): AdminState {
    const { sqlite } = open()
    try {
        const fixtureRow = sqlite
            .prepare("select value_json from app_config where key = 'e2e.fixture'")
            .get() as { value_json: string } | undefined
        const inFlightRow = sqlite
            .prepare("select count(*) as n from scan_requests where status in ('pending','running')")
            .get() as { n: number }
        return {
            counts: countsFor(sqlite),
            fixture: fixtureRow ? JSON.parse(fixtureRow.value_json) : null,
            inFlight: inFlightRow.n
        }
    } finally {
        sqlite.close()
    }
}

async function poll(timeoutMs: number, label: string, ready: (sqlite: SqliteDb) => boolean): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
        const { sqlite } = open()
        let done = false
        let snapshot = ''
        try {
            done = ready(sqlite)
            if (!done) snapshot = JSON.stringify(countsFor(sqlite))
        } finally {
            sqlite.close()
        }
        if (done) return
        if (Date.now() > deadline) {
            throw new Error('[e2e] timed out after ' + timeoutMs + 'ms waiting for ' + label + '; counts=' + snapshot)
        }
        await new Promise(function wait(r) { setTimeout(r, 250) })
    }
}

// The scan queue must be idle before a reset. Otherwise the reset deletes `projects` out from under an
// in-flight scan and the worker's insertScan fails a foreign key — a confusing crash whose cause is
// nowhere near where it surfaces. This is the one ordering rule between the reset and the live worker.
export async function awaitQueueIdle(timeoutMs: number): Promise<void> {
    await poll(timeoutMs, 'the scan queue to drain', function ready(sqlite) {
        const row = sqlite
            .prepare("select count(*) as n from scan_requests where status in ('pending','running')")
            .get() as { n: number }
        return row.n === 0
    })
}

// Waits for the worker's boot sweep, then snapshots what it produced.
//
// The baseline IS worker output, captured once per run. Nothing here is hand-written, so nothing can
// drift from what the scanner would really emit — and restoring it costs a few milliseconds rather
// than a re-scan.
export async function awaitBaseline(timeoutMs: number, expected: Counts): Promise<Counts> {
    await poll(timeoutMs, 'the worker boot sweep', function ready(sqlite) {
        const counts = countsFor(sqlite)
        const idle = (sqlite
            .prepare("select count(*) as n from scan_requests where status in ('pending','running')")
            .get() as { n: number }).n === 0
        return idle && Object.keys(expected).every(function match(k) { return counts[k] === expected[k] })
    })

    const { sqlite } = open()
    try {
        const snapshot: Record<string, unknown[]> = {}
        for (const t of userTables(sqlite)) {
            snapshot[t] = sqlite.prepare('select * from "' + t + '"').all()
        }
        writeFileSync(E2E_BASELINE_PATH, JSON.stringify(snapshot), 'utf8')
        return countsFor(sqlite)
    } finally {
        sqlite.close()
    }
}

export async function reset(): Promise<Counts> {
    await awaitQueueIdle(30_000)

    const snapshot = JSON.parse(readFileSync(E2E_BASELINE_PATH, 'utf8')) as Record<string, Record<string, unknown>[]>
    const { sqlite } = open()
    try {
        // Per-connection, so neither the portal's handle nor the worker's is affected. Needed because
        // the delete order below is alphabetical rather than dependency-ordered.
        sqlite.pragma('foreign_keys = OFF')

        // ONE transaction, and that is not tidiness. selectScanners reads the source-enabled flags
        // per batch: a two-step delete-then-restore would expose a window in which app_config is
        // empty, and a scan starting inside it would resolve to ZERO scanners and report every
        // project clean. Other connections block on the write lock instead of observing that state.
        const restore = sqlite.transaction(function apply() {
            for (const t of userTables(sqlite)) {
                sqlite.prepare('delete from "' + t + '"').run()
            }
            for (const [table, rows] of Object.entries(snapshot)) {
                for (const row of rows) {
                    const cols = Object.keys(row)
                    if (cols.length === 0) continue
                    const sql = 'insert into "' + table + '" (' + cols.map(function quote(c) { return '"' + c + '"' }).join(', ') +
                        ') values (' + cols.map(function ph() { return '?' }).join(', ') + ')'
                    sqlite.prepare(sql).run(cols.map(function value(c) { return row[c] }))
                }
            }
        })
        restore()

        sqlite.pragma('wal_checkpoint(TRUNCATE)')
        sqlite.pragma('foreign_keys = ON')
        return countsFor(sqlite)
    } finally {
        sqlite.close()
    }
}

// Writes a scan request that is ALREADY running, with a fresh heartbeat.
//
// This is how the in-flight UI gets tested deterministically. Clicking Scan and asserting the
// transient state does not work: the claim window is up to POLL_INTERVAL_MS (5s) but an OSV scan of
// these fixtures takes milliseconds, and the page only samples every 5s, so "Scanning…" is usually
// never observable. A row inserted at 'running' is never touched by the poller — claimNextPendingRequest
// only ever claims 'pending' — and SCAN_HEARTBEAT_STALE_MS keeps it in flight for a full minute.
export function insertRunningRequest(projectIdValue: string): string {
    const { sqlite } = open()
    try {
        const row = sqlite
            .prepare('select root_id from projects where id = ?')
            .get(projectIdValue) as { root_id: string } | undefined
        if (!row) throw new Error('[e2e] no such project: ' + projectIdValue)
        const id = 'e2e-inflight-' + Date.now()
        const now = Date.now()
        sqlite
            .prepare(
                'insert into scan_requests (id, project_id, root_id, requested_at, picked_up_at, ' +
                'finished_at, heartbeat_at, status) values (?, ?, ?, ?, ?, null, ?, ?)'
            )
            .run(id, projectIdValue, row.root_id, now, now, now, 'running')
        return id
    } finally {
        sqlite.close()
    }
}

export function deleteRequest(id: string): void {
    const { sqlite } = open()
    try {
        sqlite.prepare('delete from scan_requests where id = ?').run(id)
    } finally {
        sqlite.close()
    }
}
