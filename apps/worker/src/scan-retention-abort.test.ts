import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Scan } from '@sentinello/core'

// The short-delete abort, which needs the DB layer intercepted and therefore cannot live in
// scan-retention.test.ts — that file drives a real @sentinello/db throughout, which is what makes its
// other assertions worth anything.
//
// The guard cannot fire against a real database, and that is the point rather than a reason to skip it.
// listPrunableScanIds excludes every referenced row via three NOT IN subqueries, and a referenced row
// would THROW `FOREIGN KEY constraint failed` rather than silently delete fewer than asked. So a short
// delete means the predicate and the schema have drifted apart — and the loop that would follow it
// re-selects the very same ids, forever, on a job that deletes user data unattended on a cron. Faking
// the short return is the only way to prove the sweep stops instead of spinning.

const actualDb = await vi.importActual<typeof import('@sentinello/db')>('@sentinello/db')

const dbDoubles = vi.hoisted(function makeDbDoubles() {
    return { deleteScansByIds: vi.fn(), listPrunableScanIds: vi.fn() }
})

vi.mock('@sentinello/db', async function mockDb(importOriginal) {
    const actual = await importOriginal<typeof import('@sentinello/db')>()
    return {
        ...actual,
        deleteScansByIds: dbDoubles.deleteScansByIds,
        listPrunableScanIds: dbDoubles.listPrunableScanIds
    }
})

const { insertScan, openDb, runMigrations, upsertProject, upsertRoot } = actualDb
const { sweepOldScans } = await import('./scan-retention')

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'db', 'drizzle')

const ROOT_ID = 'root-1'
const PROJECT_ID = 'project-1'
const T0 = Date.UTC(2026, 0, 1)
const DAY = 24 * 3600_000
const NOW = T0 + 10_000 * DAY

let db: import('@sentinello/db').DrizzleDb
let sqlite: import('@sentinello/db').SqliteDb
let dir: string

function scanAt(id: string, finishedAt: number): Scan {
    return {
        id,
        projectId: PROJECT_ID,
        startedAt: finishedAt - 1000,
        finishedAt,
        scanner: 'osv',
        source: 'osv',
        ecosystem: 'npm',
        status: 'ok',
        reasonCode: 'ok',
        durationMs: 1000,
        errorText: null,
        rawJson: ''
    } as Scan
}

beforeEach(async function setup() {
    dbDoubles.deleteScansByIds.mockImplementation(actualDb.deleteScansByIds)
    dbDoubles.listPrunableScanIds.mockImplementation(actualDb.listPrunableScanIds)
    dir = await mkdtemp(join(tmpdir(), 'sentinello-retention-abort-'))
    const opened = openDb({ dbPath: join(dir, 'test.sqlite') })
    db = opened.db
    sqlite = opened.sqlite
    runMigrations(db, { migrationsFolder: MIGRATIONS })
    upsertRoot(db, { id: ROOT_ID, path: '/repo', label: null, createdAt: T0 })
    upsertProject(db, {
        id: PROJECT_ID,
        rootId: ROOT_ID,
        relPath: 'app',
        name: 'app',
        alias: null,
        packageManager: 'npm',
        nvmrcVersion: null,
        gitBranch: null,
        ecosystems: ['npm'],
        muted: false,
        tags: [],
        createdAt: T0,
        updatedAt: T0
    })
    // 110 scans, so 10 sit past the 100-row per-project floor and are genuinely prunable.
    for (let i = 0; i < 110; i++) insertScan(db, scanAt('scan-' + i, T0 + i * DAY))
})

afterEach(async function teardown() {
    vi.restoreAllMocks()
    sqlite.close()
    await rm(dir, { recursive: true, force: true })
})

describe('sweepOldScans — the short-delete abort', function () {
    it('stops after one batch instead of re-selecting the same rows forever', async function () {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(function silence() {})
        // One row fewer than asked for, exactly once — a real delete would have removed all ten.
        dbDoubles.deleteScansByIds.mockImplementation(function short(_db: unknown, ids: string[]) {
            return ids.length - 1
        })

        const result = await sweepOldScans({ db, at: NOW })

        // The count reports what actually went, not what was selected.
        expect(result.deletedCount).toBe(9)
        // The load-bearing assertion: exactly ONE selection round. Without the abort the loop would ask
        // again, get the same ids back, delete nine again, and never reach its exit condition.
        expect(dbDoubles.listPrunableScanIds).toHaveBeenCalledTimes(1)
        expect(dbDoubles.deleteScansByIds).toHaveBeenCalledTimes(1)
        // And it says so loudly rather than reporting a clean sweep.
        expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('aborting: deleted 9 of 10'))
    })
})
