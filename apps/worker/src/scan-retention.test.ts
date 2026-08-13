import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    countScansForProject,
    insertScan,
    openDb,
    runMigrations,
    setConfigValue,
    upsertProject,
    upsertRoot,
    type DrizzleDb,
    type SqliteDb
} from '@sentinello/db'
import type { Scan } from '@sentinello/core'
import { createWorkerRuntime } from './runtime'

// Same cron double as mute-expiry.test.ts: records every schedule() call so a tick can be fired by
// hand, since a real schedule would never fire inside a test run.
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

const { startScanRetentionSweep, sweepOldScans, DEFAULT_RETENTION_DAYS, KEEP_PER_PROJECT } = await import(
    './scan-retention'
)

// Deleting scan history is irreversible and runs unattended, so the interesting cases here are all
// about the sweep declining to act: an unset window, a window that would reach into the protected
// per-project floor, and a delete that came up short (which means the predicate is wrong and retrying
// would spin forever).

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'db', 'drizzle')

const ROOT_ID = 'root-1'
const PROJECT_ID = 'project-1'
const T0 = Date.UTC(2026, 0, 1)
const DAY = 24 * 3600_000

let db: DrizzleDb
let sqlite: SqliteDb
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

// `count` scans, each a day apart, oldest first, all far enough back to be outside any window used here.
function seedOldScans(count: number): void {
    for (let i = 0; i < count; i++) {
        insertScan(db, scanAt('scan-' + i, T0 + i * DAY))
    }
}

const NOW = T0 + 10_000 * DAY

beforeEach(async function setup() {
    cron.reset()
    dir = await mkdtemp(join(tmpdir(), 'sentinello-retention-'))
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
})

afterEach(async function teardown() {
    sqlite.close()
    await rm(dir, { recursive: true, force: true })
})

describe('sweepOldScans', function () {
    it('deletes everything past the window beyond the per-project floor', async function () {
        seedOldScans(KEEP_PER_PROJECT + 5)
        setConfigValue(db, 'scanRetentionDays', 30)

        const result = await sweepOldScans({ db, at: NOW })

        expect(result.deletedCount).toBe(5)
        expect(countScansForProject(db, PROJECT_ID)).toBe(KEEP_PER_PROJECT)
    })

    // The floor wins over the window, always. Below it getProjectEcosystemCoverage stops being able to
    // reconstruct per-ecosystem coverage and a partially-audited project starts reading as a clean one.
    it('keeps the per-project floor however far back the window reaches', async function () {
        seedOldScans(KEEP_PER_PROJECT)
        setConfigValue(db, 'scanRetentionDays', 1)

        expect((await sweepOldScans({ db, at: NOW })).deletedCount).toBe(0)
        expect(countScansForProject(db, PROJECT_ID)).toBe(KEEP_PER_PROJECT)
    })

    it('does nothing when every scan is inside the window', async function () {
        insertScan(db, scanAt('recent', NOW - DAY))
        setConfigValue(db, 'scanRetentionDays', 30)

        expect((await sweepOldScans({ db, at: NOW })).deletedCount).toBe(0)
    })

    // An operator who sets 0 is asking for history to be kept, not for everything to be deleted.
    it('treats a non-positive window as retention disabled', async function () {
        seedOldScans(KEEP_PER_PROJECT + 5)
        setConfigValue(db, 'scanRetentionDays', 0)

        expect((await sweepOldScans({ db, at: NOW })).deletedCount).toBe(0)
        expect(countScansForProject(db, PROJECT_ID)).toBe(KEEP_PER_PROJECT + 5)
    })

    // 90 days is chosen so that an instance upgrading into this feature deletes nothing on its first
    // tick — trimming becomes something the operator opts into, not something an upgrade does to them.
    it('falls back to the default window when unconfigured', async function () {
        seedOldScans(KEEP_PER_PROJECT + 3)

        const result = await sweepOldScans({ db, at: NOW })

        expect(DEFAULT_RETENTION_DAYS).toBe(90)
        expect(result.deletedCount).toBe(3)
    })

    it('deletes across several batches until drained', async function () {
        seedOldScans(KEEP_PER_PROJECT + 600)
        setConfigValue(db, 'scanRetentionDays', 30)

        expect((await sweepOldScans({ db, at: NOW })).deletedCount).toBe(600)
        expect(countScansForProject(db, PROJECT_ID)).toBe(KEEP_PER_PROJECT)
    })

    it('reports nothing deleted on an empty database', async function () {
        setConfigValue(db, 'scanRetentionDays', 30)
        expect((await sweepOldScans({ db, at: NOW })).deletedCount).toBe(0)
    })
})

describe('startScanRetentionSweep', function () {
    let runtime: ReturnType<typeof createWorkerRuntime>

    beforeEach(function makeRuntime() {
        runtime = createWorkerRuntime()
    })

    it('schedules on the default cadence, offset from the mute-expiry sweep', function () {
        startScanRetentionSweep({ db, runtime })

        expect(cron.tasks).toHaveLength(1)
        expect(cron.tasks[0]?.expr).toBe('7 * * * *')
    })

    it('accepts an explicit cron expression', function () {
        startScanRetentionSweep({ db, runtime, cronExpression: '*/5 * * * *' })
        expect(cron.tasks[0]?.expr).toBe('*/5 * * * *')
    })

    // node-cron keys its task registry by name; an unnamed task cannot be told apart from the OSV,
    // gemnasium, mute-expiry and scan sweeps when inspecting a running worker.
    it('names the task so it is identifiable among the other schedules', function () {
        startScanRetentionSweep({ db, runtime })
        expect(cron.tasks[0]?.options).toEqual({ name: 'sentinello-scan-retention' })
    })

    it('deletes on a tick', async function () {
        seedOldScans(KEEP_PER_PROJECT + 2)
        setConfigValue(db, 'scanRetentionDays', 30)
        startScanRetentionSweep({ db, runtime })

        await cron.tasks[0]?.fn()
        await Promise.allSettled(Array.from(runtime.inFlight))

        expect(countScansForProject(db, PROJECT_ID)).toBe(KEEP_PER_PROJECT)
    })

    it('registers the sweep with the runtime so shutdown can await it', function () {
        startScanRetentionSweep({ db, runtime })
        cron.tasks[0]?.fn()
        expect(runtime.inFlight.size).toBe(1)
    })

    // An unhandled rejection inside a cron callback takes the worker process down. Losing one sweep is
    // recoverable; losing the worker is not.
    it('catches a failing sweep and logs it rather than rejecting', async function () {
        startScanRetentionSweep({ db, runtime })
        sqlite.close()

        expect(function tick() { cron.tasks[0]?.fn() }).not.toThrow()
        await Promise.allSettled(Array.from(runtime.inFlight))
    })

    it('stops ticking once stopped', function () {
        const handle = startScanRetentionSweep({ db, runtime })
        handle.stop()
        expect(cron.tasks[0]?.stopped).toBe(true)
    })
})
