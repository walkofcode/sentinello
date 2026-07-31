import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listRoots, openDb, runMigrations } from '@sentinello/db'
import type { DrizzleDb, SqliteDb } from '@sentinello/db'
import { getDb, getSqlite } from './db'

// The portal's DB handle. Server components import it directly and Next.js hot-reloads modules in
// dev, so the handle is cached on globalThis rather than in a module-level variable — a module-local
// cache would re-open the database on every reload and leak a native handle per edit.
//
// Every other apps/web suite pre-seeds globalThis.__sentinelloDb (that is the seam the action and MCP
// tests drive), which is exactly why the open path here had never run.

// Same resolution as portal-test-db.fixture.ts: the portal never migrates, so a test that needs
// tables has to do what the worker does at boot.
const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'db', 'drizzle')

type GlobalWithDb = typeof globalThis & {
    __sentinelloDb?: { db: DrizzleDb; sqlite: SqliteDb }
}

const g = globalThis as GlobalWithDb

let dir: string

beforeEach(async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-web-db-'))
    delete g.__sentinelloDb
})

afterEach(async function teardown() {
    g.__sentinelloDb?.sqlite.close()
    delete g.__sentinelloDb
    vi.unstubAllEnvs()
    await rm(dir, { recursive: true, force: true })
})

describe('lazy open', function () {
    it('opens the database on first access and publishes it on globalThis', function () {
        vi.stubEnv('SENTINELLO_DB_PATH', join(dir, 'portal.sqlite'))
        expect(g.__sentinelloDb).toBeUndefined()

        const db = getDb()

        expect(db).toBeDefined()
        expect(g.__sentinelloDb).toBeDefined()
        expect(g.__sentinelloDb?.db).toBe(db)
    })

    // The property that matters: one handle per process, not one per import or per request. A second
    // open of the same file would work — SQLite allows it — so a regression here is invisible except
    // as a slow handle leak under dev hot-reload.
    it('returns the same handle across repeated calls', function () {
        vi.stubEnv('SENTINELLO_DB_PATH', join(dir, 'portal.sqlite'))
        expect(getDb()).toBe(getDb())
        expect(getSqlite()).toBe(getSqlite())
    })

    // Server components take getDb() while a few raw-SQL read paths take getSqlite(); both have to be
    // the same connection or a write made through one is invisible to the other within a request.
    // DrizzleDb deliberately does not expose $client, so this writes through the raw handle and reads
    // back through a real query rather than comparing references.
    it('backs getDb and getSqlite with the same connection', function () {
        vi.stubEnv('SENTINELLO_DB_PATH', join(dir, 'portal.sqlite'))
        const db = getDb()
        const sqlite = getSqlite()
        runMigrations(db, { migrationsFolder: MIGRATIONS })

        sqlite
            .prepare('INSERT INTO roots (id, path, label, created_at) VALUES (?, ?, ?, ?)')
            .run('root-1', '/repo', null, 0)

        expect(listRoots(db).map(function path(root) { return root.path })).toEqual(['/repo'])
        // Only one open happened, so both getters populated the cache rather than racing it.
        expect(g.__sentinelloDb?.sqlite).toBe(sqlite)
    })

    it('opens through getSqlite first just as well as getDb', function () {
        vi.stubEnv('SENTINELLO_DB_PATH', join(dir, 'portal.sqlite'))
        const sqlite = getSqlite()
        expect(sqlite).toBeDefined()
        expect(g.__sentinelloDb?.sqlite).toBe(sqlite)
        expect(getDb()).toBe(g.__sentinelloDb?.db)
    })

    it('honours SENTINELLO_DB_PATH rather than resolving its own default', function () {
        const path = join(dir, 'nested', 'portal.sqlite')
        vi.stubEnv('SENTINELLO_DB_PATH', path)
        expect(getSqlite().name).toBe(path)
    })
})

describe('the globalThis cache', function () {
    // This is the seam the rest of the apps/web suites drive: seeding the global replaces the portal's
    // database wholesale without any module mocking. If getOrInit stopped honouring a pre-seeded value
    // those suites would silently start testing against a real on-disk database instead.
    it('adopts a pre-seeded handle without opening anything', function () {
        // Seeded with a real handle pointed somewhere else, so "did it open the env path" is
        // answerable from the filesystem rather than from a marker object.
        const decoy = join(dir, 'never-opened.sqlite')
        vi.stubEnv('SENTINELLO_DB_PATH', decoy)
        const seeded = openDb({ dbPath: join(dir, 'seeded.sqlite') })
        g.__sentinelloDb = { db: seeded.db, sqlite: seeded.sqlite }

        expect(getDb()).toBe(seeded.db)
        expect(getSqlite()).toBe(seeded.sqlite)
        expect(existsSync(decoy)).toBe(false)
    })

    it('re-opens after the cache is cleared', function () {
        vi.stubEnv('SENTINELLO_DB_PATH', join(dir, 'portal.sqlite'))
        const first = getSqlite()
        first.close()
        delete g.__sentinelloDb

        const second = getSqlite()
        expect(second).not.toBe(first)
        expect(second.open).toBe(true)
    })

    // The portal never runs migrations — the worker owns the DB lifecycle. A freshly opened database
    // with no worker behind it therefore has no tables, and the correct behaviour is to fail loudly
    // on the first query rather than to paper over it. That "no such table" is the signal an operator
    // needs: start the worker first.
    it('opens an unmigrated database rather than migrating it', function () {
        vi.stubEnv('SENTINELLO_DB_PATH', join(dir, 'portal.sqlite'))
        const sqlite = getSqlite()
        const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
        expect(tables).toEqual([])
        expect(function query() {
            sqlite.prepare('SELECT * FROM projects').all()
        }).toThrow(/no such table/)
    })
})
