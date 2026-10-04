import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb, type DrizzleDb, type SqliteDb } from '../client'
import { runMigrations } from '../migrate'
import { registryPackages } from '../schema'
import { getRegistryPackages, upsertRegistryPackage } from './registry-packages'

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle')

let db: DrizzleDb
let sqlite: SqliteDb
let dir: string

beforeEach(async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-registry-db-'))
    const opened = openDb({ dbPath: join(dir, 'test.sqlite') })
    db = opened.db
    sqlite = opened.sqlite
    runMigrations(db, { migrationsFolder: MIGRATIONS })
})

afterEach(async function teardown() {
    sqlite.close()
    await rm(dir, { recursive: true, force: true })
})

describe('registry_packages', function () {
    it('upserts an answer and reads it back by ecosystem and name', function () {
        upsertRegistryPackage(db, { ecosystem: 'npm', name: 'braces', status: 'ok', summaryJson: '{"v":1}', checkedAt: 1 })
        upsertRegistryPackage(db, { ecosystem: 'npm', name: 'gone', status: 'not_found', summaryJson: null, checkedAt: 2 })
        const rows = getRegistryPackages(db, 'npm', ['braces', 'gone', 'braces', 'never'])
        expect(rows.size).toBe(2)
        expect(rows.get('braces')).toEqual({ ecosystem: 'npm', name: 'braces', status: 'ok', summaryJson: '{"v":1}', weeklyDownloads: null, downloadsCheckedAt: null, checkedAt: 1 })
        expect(rows.get('gone')).toMatchObject({ status: 'not_found', summaryJson: null })
        expect(getRegistryPackages(db, 'PyPI', ['braces']).size).toBe(0)
    })

    // Download counts come from a separate, rarer fetch: a packument refresh must not wipe them.
    it('replaces the answer on refetch and keeps the download counts', function () {
        upsertRegistryPackage(db, { ecosystem: 'npm', name: 'braces', status: 'ok', summaryJson: '{"v":1}', checkedAt: 1 })
        db.update(registryPackages).set({ weeklyDownloads: 42, downloadsCheckedAt: 1 }).run()
        upsertRegistryPackage(db, { ecosystem: 'npm', name: 'braces', status: 'not_found', summaryJson: null, checkedAt: 5 })
        expect(getRegistryPackages(db, 'npm', ['braces']).get('braces')).toMatchObject({ status: 'not_found', summaryJson: null, checkedAt: 5, weeklyDownloads: 42, downloadsCheckedAt: 1 })
    })

    it('looks up more names than one statement may bind', function () {
        const names = Array.from({ length: 1200 }, function n(_v, i) { return 'p' + i })
        for (const name of names) upsertRegistryPackage(db, { ecosystem: 'npm', name, status: 'not_found', summaryJson: null, checkedAt: 1 })
        expect(getRegistryPackages(db, 'npm', names).size).toBe(1200)
        expect(getRegistryPackages(db, 'npm', []).size).toBe(0)
    })
})
