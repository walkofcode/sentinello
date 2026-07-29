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
import { createWorkerRuntime } from './runtime'

// The cron double records every schedule() call so the sweep's tick can be fired by hand — a real
// schedule would never fire inside a test run. Hoisted because vi.mock factories are lifted above imports.
const cron = vi.hoisted(function makeCronDouble() {
    type Task = { expr: string; options: unknown; fn: () => unknown; stopped: boolean }
    const tasks: Task[] = []
    return {
        tasks,
        reset: function reset() { tasks.length = 0 },
        schedule: function schedule(expr: string, fn: () => unknown, options: unknown) {
            const task: Task = { expr, options, fn, stopped: false }
            tasks.push(task)
            return {
                stop: function stop() { task.stopped = true },
                start: function start() {}
            }
        }
    }
})

vi.mock('node-cron', function mockNodeCron() {
    return { default: { schedule: cron.schedule } }
})

const { startMuteExpirySweep, sweepExpiredMutes } = await import('./mute-expiry')

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
    cron.reset()
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

// The scheduling half. sweepExpiredMutes above is the decision; this is the thing that makes it happen
// unattended, and its failure mode is total silence — a sweep that never fires leaves every expired mute
// in place forever, and the finding stays hidden with no error anywhere to explain why.
describe('startMuteExpirySweep', function () {
    let runtime: ReturnType<typeof createWorkerRuntime>

    beforeEach(function makeRuntime() {
        runtime = createWorkerRuntime()
        vi.spyOn(console, 'error').mockImplementation(function silence() {})
    })

    it('schedules on a quarter-hour cadence by default', function () {
        startMuteExpirySweep({ db, runtime })
        expect(cron.tasks).toHaveLength(1)
        expect(cron.tasks[0]?.expr).toBe('*/15 * * * *')
    })

    it('honours an explicit cron expression', function () {
        startMuteExpirySweep({ db, runtime, cronExpression: '0 * * * *' })
        expect(cron.tasks[0]?.expr).toBe('0 * * * *')
    })

    // node-cron keys its task registry by name; an unnamed task cannot be told apart from the OSV,
    // gemnasium and scan sweeps when inspecting a running worker.
    it('names the task so it is identifiable among the worker\'s other schedules', function () {
        startMuteExpirySweep({ db, runtime })
        expect(cron.tasks[0]?.options).toEqual({ name: 'sentinello-mute-expiry' })
    })

    it('announces the cadence it registered', function () {
        startMuteExpirySweep({ db, runtime, cronExpression: '*/5 * * * *' })
        expect(vi.mocked(console.log).mock.calls.map(function f(c) { return String(c[0]) })).toContain(
            '[mute-expiry] scheduled (*/5 * * * *)'
        )
    })

    it('lifts expired mutes when the tick fires', async function () {
        insertMute(db, mute({ expiresAt: T0 + HOUR }))
        startMuteExpirySweep({ db, runtime })
        await cron.tasks[0]?.fn()
        await Promise.allSettled(Array.from(runtime.inFlight))
        expect(listActiveMutes(db, Date.now())).toEqual([])
    })

    it('registers the sweep with the runtime so shutdown can await it', function () {
        startMuteExpirySweep({ db, runtime })
        cron.tasks[0]?.fn()
        expect(runtime.inFlight.size).toBe(1)
    })

    // An unhandled rejection inside a cron callback takes the worker process down. Losing one sweep is
    // recoverable; losing the worker is not.
    it('catches a failing sweep and logs it rather than rejecting', async function () {
        startMuteExpirySweep({ db, runtime })
        sqlite.close()
        await cron.tasks[0]?.fn()
        await Promise.allSettled(Array.from(runtime.inFlight))
        expect(vi.mocked(console.error).mock.calls.map(function f(c) { return String(c[0]) }).some(function m(l) {
            return l.startsWith('[mute-expiry] sweep failed: ')
        })).toBe(true)
        // Reopened so the shared teardown has something to close.
        const reopened = openDb({ dbPath: join(dir, 'test.sqlite') })
        sqlite = reopened.sqlite
    })

    it('stops the task on stop()', function () {
        const handle = startMuteExpirySweep({ db, runtime })
        handle.stop()
        expect(cron.tasks[0]?.stopped).toBe(true)
    })
})
