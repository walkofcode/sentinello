import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    insertMute,
    listActiveMutes,
    listExpiredMutes,
    openDb,
    runMigrations,
    upsertProject,
    upsertRoot,
    type DrizzleDb,
    type SqliteDb
} from '@sentinello/db'
import type { Mute } from '@sentinello/core'
import { sweepExpiredMutes } from './mute-expiry'

// An expired mute has to actually disappear, not merely stop matching. The mute row is deleted and a
// mute_lifts journal entry takes its place, which is what lets the next dispatch tick re-notify
// through the ordinary path — selectDispatchablePairs finds the prior event with no successful
// delivery and sends it. No special "re-emerge" query exists, so if the sweep silently skipped a
// mute the finding would stay hidden forever.

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'db', 'drizzle')

const ROOT_ID = 'root-1'
const PROJECT_ID = 'project-1'
const T0 = Date.UTC(2026, 0, 1)
const HOUR = 3600_000

let db: DrizzleDb
let sqlite: SqliteDb
let dir: string

function mute(overrides: Partial<Mute> = {}): Mute {
    return {
        id: 'mute-1',
        scope: 'finding',
        projectId: PROJECT_ID,
        scanner: 'osv',
        ecosystem: 'npm',
        advisoryId: 'CVE-2024-1',
        packageName: 'lodash',
        reason: 'accepted risk',
        author: 'betty',
        createdAt: T0,
        expiresAt: null,
        ...overrides
    } as Mute
}

beforeEach(async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-mute-expiry-'))
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
    vi.spyOn(console, 'log').mockImplementation(function silence() {})
})

afterEach(async function teardown() {
    vi.restoreAllMocks()
    sqlite.close()
    await rm(dir, { recursive: true, force: true })
})

describe('sweepExpiredMutes', function () {
    it('reports nothing on an empty database', async function () {
        expect(await sweepExpiredMutes({ db, at: T0 })).toEqual({ liftedCount: 0 })
    })

    it('lifts a mute whose expiry has passed', async function () {
        insertMute(db, mute({ expiresAt: T0 + HOUR }))
        expect(await sweepExpiredMutes({ db, at: T0 + 2 * HOUR })).toEqual({ liftedCount: 1 })
        expect(listActiveMutes(db, T0 + 2 * HOUR)).toEqual([])
        expect(listExpiredMutes(db, T0 + 2 * HOUR)).toEqual([])
    })

    it('leaves a mute that has not expired yet', async function () {
        insertMute(db, mute({ expiresAt: T0 + 10 * HOUR }))
        expect(await sweepExpiredMutes({ db, at: T0 + 2 * HOUR })).toEqual({ liftedCount: 0 })
        expect(listActiveMutes(db, T0 + 2 * HOUR)).toHaveLength(1)
    })

    // A mute with no expiry is a permanent operator decision and must never be swept.
    it('never lifts a mute with no expiry', async function () {
        insertMute(db, mute({ expiresAt: null }))
        expect(await sweepExpiredMutes({ db, at: T0 + 1000 * HOUR })).toEqual({ liftedCount: 0 })
        expect(listActiveMutes(db, T0 + 1000 * HOUR)).toHaveLength(1)
    })

    it('lifts several expired mutes in one pass', async function () {
        insertMute(db, mute({ id: 'm1', expiresAt: T0 + HOUR, advisoryId: 'CVE-1' }))
        insertMute(db, mute({ id: 'm2', expiresAt: T0 + HOUR, advisoryId: 'CVE-2' }))
        insertMute(db, mute({ id: 'm3', expiresAt: T0 + 100 * HOUR, advisoryId: 'CVE-3' }))
        expect(await sweepExpiredMutes({ db, at: T0 + 2 * HOUR })).toEqual({ liftedCount: 2 })
        expect(listActiveMutes(db, T0 + 2 * HOUR)).toHaveLength(1)
    })

    it('lifts a project-scope mute as readily as a finding-scope one', async function () {
        insertMute(db, mute({
            scope: 'project',
            scanner: null,
            ecosystem: null,
            advisoryId: null,
            packageName: null,
            expiresAt: T0 + HOUR
        }))
        expect(await sweepExpiredMutes({ db, at: T0 + 2 * HOUR })).toEqual({ liftedCount: 1 })
        expect(listActiveMutes(db, T0 + 2 * HOUR)).toEqual([])
    })

    it('is idempotent — a second pass finds nothing left', async function () {
        insertMute(db, mute({ expiresAt: T0 + HOUR }))
        await sweepExpiredMutes({ db, at: T0 + 2 * HOUR })
        expect(await sweepExpiredMutes({ db, at: T0 + 2 * HOUR })).toEqual({ liftedCount: 0 })
    })

    // Boundary: listExpiredMutes treats a mute as active while expires_at > at, so exactly-at-expiry
    // is the first instant it can be swept.
    it('lifts a mute exactly at its expiry instant', async function () {
        insertMute(db, mute({ expiresAt: T0 + HOUR }))
        expect(await sweepExpiredMutes({ db, at: T0 + HOUR })).toEqual({ liftedCount: 1 })
    })
})
