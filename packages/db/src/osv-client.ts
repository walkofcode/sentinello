import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { resolveDbPath } from './client'
import * as osvSchema from './osv-schema'

// The OSV advisory cache lives in its own SQLite file (osv.db) next to the primary
// sentinello.sqlite, so the resolution mirrors resolveDbPath() — same directory, fixed filename.
// Kept separate from the main client so the portal's read-only file-trace never pulls the OSV
// migration/seed code into its bundle.

export type OsvDrizzleDb = BetterSQLite3Database<typeof osvSchema>

export type OpenOsvDbResult = {
    db: OsvDrizzleDb
    sqlite: Database.Database
    dbPath: string
}

export function resolveOsvDbPath(): string {
    const fromEnv = process.env.SENTINELLO_OSV_DB_PATH
    if (fromEnv && fromEnv.trim().length > 0) {
        return resolve(/*turbopackIgnore: true*/ process.cwd(), fromEnv.trim())
    }
    // Sibling of the primary DB: data/sentinello.sqlite → data/osv.db.
    const mainPath = resolveDbPath()
    return resolve(/*turbopackIgnore: true*/ dirname(mainPath), 'osv.db')
}

export function openOsvDb(dbPath?: string): OpenOsvDbResult {
    const path = dbPath || resolveOsvDbPath()
    const parentDir = dirname(/*turbopackIgnore: true*/ path)
    if (existsSync(/*turbopackIgnore: true*/ parentDir) === false) {
        mkdirSync(/*turbopackIgnore: true*/ parentDir, { recursive: true })
    }
    const sqlite = new Database(/*turbopackIgnore: true*/ path)
    sqlite.pragma('journal_mode = WAL')
    sqlite.pragma('synchronous = NORMAL')
    sqlite.pragma('busy_timeout = 5000')
    const db = drizzle(sqlite, { schema: osvSchema })
    return { db, sqlite, dbPath: path }
}

export function runOsvMigrations(db: OsvDrizzleDb): void {
    const here = fileURLToPath(import.meta.url)
    const folder = resolve(dirname(here), '..', 'drizzle-osv')
    migrate(db, { migrationsFolder: folder, migrationsTable: '__drizzle_migrations_osv' })
}
