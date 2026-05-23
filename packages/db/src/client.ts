import { existsSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema'

// The shared DB path is the single source of truth tying apps/web and apps/worker together.
// Resolution lives in exactly this one file; both apps call resolveDbPath() — neither computes its own.
// Migrations live in ./migrate.ts so the portal's NFT trace does not pull in fileURLToPath / dirname
// resolution paths it never executes (the portal opens the DB read-only; the worker runs migrations).

const DEFAULT_RELATIVE_PATH = 'data/sentinello.sqlite'

// Use the abstract drizzle type rather than `ReturnType<typeof drizzle>` so that the type
// is compatible with the `tx` handle drizzle passes to `db.transaction(cb)` — that handle
// is a SQLiteTransaction without the `$client` field the runtime type carries.
export type DrizzleDb = BetterSQLite3Database<typeof schema>

export type SqliteDb = Database.Database

export type OpenDbResult = {
    db: DrizzleDb
    sqlite: SqliteDb
    dbPath: string
}

export type OpenDbOptions = {
    // Override the resolved path; primarily for tests / scripts.
    dbPath?: string
    // Set to false to skip the WAL pragma block (e.g. for ad-hoc read-only tools). Default: true.
    applyPragmas?: boolean
}

// Walk up from `start` looking for the monorepo root marker (pnpm-workspace.yaml).
// Returns the directory that contains it, or null if not found. This is how we make the
// default DB path the same for apps/web and apps/worker even though they each run with their
// own process.cwd() — without it, each app lands on its own private data/sentinello.sqlite
// and the worker never sees the scan_requests the portal writes.
function findMonorepoRoot(start: string): string | null {
    let dir = start
    while (true) {
        if (existsSync(/*turbopackIgnore: true*/ resolve(dir, 'pnpm-workspace.yaml'))) return dir
        const parent = dirname(/*turbopackIgnore: true*/ dir)
        if (parent === dir) return null
        dir = parent
    }
}

export function resolveDbPath(): string {
    const fromEnv = process.env.SENTINELLO_DB_PATH
    if (fromEnv && fromEnv.trim().length > 0) {
        const trimmed = fromEnv.trim()
        return isAbsolute(trimmed) && trimmed || resolve(/*turbopackIgnore: true*/ process.cwd(), trimmed)
    }
    const repoRoot = findMonorepoRoot(process.cwd())
    if (repoRoot) return resolve(/*turbopackIgnore: true*/ repoRoot, DEFAULT_RELATIVE_PATH)
    return resolve(/*turbopackIgnore: true*/ process.cwd(), DEFAULT_RELATIVE_PATH)
}

export function resolveLockPath(dbPath?: string): string {
    const path = dbPath || resolveDbPath()
    return resolve(/*turbopackIgnore: true*/ dirname(path), 'sentinello.worker.lock')
}

export function openDb(options?: OpenDbOptions): OpenDbResult {
    const dbPath = options && options.dbPath || resolveDbPath()
    const parentDir = dirname(/*turbopackIgnore: true*/ dbPath)
    if (existsSync(/*turbopackIgnore: true*/ parentDir) === false) {
        mkdirSync(/*turbopackIgnore: true*/ parentDir, { recursive: true })
    }
    const sqlite = new Database(/*turbopackIgnore: true*/ dbPath)
    const applyPragmas = !options || options.applyPragmas !== false
    if (applyPragmas) {
        sqlite.pragma('journal_mode = WAL')
        sqlite.pragma('synchronous = NORMAL')
        sqlite.pragma('busy_timeout = 5000')
        sqlite.pragma('foreign_keys = ON')
    }
    const db = drizzle(sqlite, { schema })
    return { db, sqlite, dbPath }
}

export function walCheckpoint(sqlite: SqliteDb): void {
    sqlite.pragma('wal_checkpoint(TRUNCATE)')
}
