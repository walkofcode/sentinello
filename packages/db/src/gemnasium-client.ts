import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { resolveDbPath } from './client'
import * as gemnasiumSchema from './gemnasium-schema'

// The gemnasium advisory cache lives in its own SQLite file (gemnasium.db) next to the primary
// sentinello.sqlite, mirroring resolveOsvDbPath(). Kept separate from the main client so the portal's
// read-only file-trace never pulls the gemnasium migration/seed code into its bundle.

export type GemnasiumDrizzleDb = BetterSQLite3Database<typeof gemnasiumSchema>

export type OpenGemnasiumDbResult = {
    db: GemnasiumDrizzleDb
    sqlite: Database.Database
    dbPath: string
}

export function resolveGemnasiumDbPath(): string {
    const fromEnv = process.env.SENTINELLO_GEMNASIUM_DB_PATH
    if (fromEnv && fromEnv.trim().length > 0) {
        return resolve(/*turbopackIgnore: true*/ process.cwd(), fromEnv.trim())
    }
    // Sibling of the primary DB: data/sentinello.sqlite → data/gemnasium.db.
    const mainPath = resolveDbPath()
    return resolve(/*turbopackIgnore: true*/ dirname(mainPath), 'gemnasium.db')
}

export function openGemnasiumDb(dbPath?: string): OpenGemnasiumDbResult {
    const path = dbPath || resolveGemnasiumDbPath()
    const parentDir = dirname(/*turbopackIgnore: true*/ path)
    if (existsSync(/*turbopackIgnore: true*/ parentDir) === false) {
        mkdirSync(/*turbopackIgnore: true*/ parentDir, { recursive: true })
    }
    const sqlite = new Database(/*turbopackIgnore: true*/ path)
    sqlite.pragma('journal_mode = WAL')
    sqlite.pragma('synchronous = NORMAL')
    sqlite.pragma('busy_timeout = 5000')
    const db = drizzle(sqlite, { schema: gemnasiumSchema })
    return { db, sqlite, dbPath: path }
}

export function runGemnasiumMigrations(db: GemnasiumDrizzleDb): void {
    const here = fileURLToPath(import.meta.url)
    const folder = resolve(dirname(here), '..', 'drizzle-gemnasium')
    migrate(db, { migrationsFolder: folder, migrationsTable: '__drizzle_migrations_gemnasium' })
}
