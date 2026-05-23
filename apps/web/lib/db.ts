import { openDb, type DrizzleDb, type SqliteDb } from '@sentinello/db'

// Module-level singleton. Server components import `db` directly; do not re-open per request.
// Next.js will hot-reload modules in dev — we cache on globalThis to avoid leaking handles.
//
// The web app does NOT run migrations or backfills — the worker owns the DB lifecycle (single
// instance lockfile, WAL checkpoints, schema upgrades, lifecycle backfill). If the worker hasn't
// migrated yet, queries here will fail loudly with "no such column" / "no such table", which is
// the correct signal that the worker needs to be started first.

type GlobalWithDb = typeof globalThis & {
    __sentinelloDb?: { db: DrizzleDb; sqlite: SqliteDb }
}

function getOrInit(): { db: DrizzleDb; sqlite: SqliteDb } {
    const g = globalThis as GlobalWithDb
    if (g.__sentinelloDb) return g.__sentinelloDb
    const handle = openDb()
    g.__sentinelloDb = { db: handle.db, sqlite: handle.sqlite }
    return g.__sentinelloDb
}

export function getDb(): DrizzleDb {
    return getOrInit().db
}

export function getSqlite(): SqliteDb {
    return getOrInit().sqlite
}
