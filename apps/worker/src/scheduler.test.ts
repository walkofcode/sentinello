import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONFIG_KEYS } from './config-loader'
import { setConfigValue, upsertRoot } from '@sentinello/db'
import {
    PKG_JSON,
    T0,
    closeWorkerTestDb,
    makeTree,
    openWorkerTestDb,
    type WorkerTestDb
} from './worker-test-db.fixture'
import { createWorkerRuntime, type WorkerRuntime } from './runtime'

// The scheduler is a thin shell around a cron task, and both of its halves own a rule that only breaks
// silently:
//
//   - reload() must be a no-op when the expression and timezone are unchanged. It is invoked from the
//     worker-signal mailbox, so a reload that always rebuilt would cancel and re-arm the task on every
//     unrelated Settings save — and a task re-armed at, say, 13:59 loses the 14:00 tick it was about to
//     fire. The equality check is the whole reason the sweep is not silently skippable.
//   - sweepActiveProjects must run discovery BEFORE listing projects, or a project added since the last
//     sweep waits a full interval to be scanned for the first time.
//
// Two things are stubbed, both because they own a resource a test cannot: node-cron (a real schedule
// never fires inside a test run) and ./runner (runBatch would otherwise shell out to `npm audit` for
// every project, since selectScanners hands it the real npmAuditPlugin). runner.ts is covered directly
// by runner.test.ts, so what matters here is only WHAT the scheduler hands it.

// The cron double records every schedule() call so a test can fire the callback by hand and assert on
// the expression the scheduler chose. Hoisted because vi.mock factories are lifted above imports.
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

const runBatch = vi.hoisted(function makeRunBatch() {
    return vi.fn(async function runBatch(_input: unknown) { return [] as unknown[] })
})

vi.mock('./runner', function mockRunner() {
    return { runBatch }
})

const { startScheduler, sweepActiveProjects } = await import('./scheduler')

let handle: WorkerTestDb
let runtime: WorkerRuntime
let rootPath: string

function input() {
    return { db: handle.db, sqlite: handle.sqlite, runtime }
}

function lastBatch() {
    return runBatch.mock.calls[runBatch.mock.calls.length - 1]?.[0] as {
        projects: { relPath: string }[]
        parallelism: number
        scanners: { name: string }[]
        abortSignal?: AbortSignal
    }
}

function logLines(): string[] {
    return vi.mocked(console.log).mock.calls.map(function first(c) { return String(c[0]) })
}

beforeEach(async function setup() {
    cron.reset()
    runBatch.mockClear()
    handle = await openWorkerTestDb('worker-scheduler')
    runtime = createWorkerRuntime()
    rootPath = await makeTree(handle.dir, 'code', { 'web/package.json': PKG_JSON })
    upsertRoot(handle.db, { id: 'root-1', path: rootPath, label: null, createdAt: T0 })
    vi.spyOn(console, 'log').mockImplementation(function silence() {})
    vi.spyOn(console, 'error').mockImplementation(function silence() {})
})

afterEach(async function teardown() {
    vi.restoreAllMocks()
    await closeWorkerTestDb(handle)
})

describe('startScheduler — arming the task', function () {
    it('schedules the default daily expression when no schedule is configured', function () {
        startScheduler(input())
        expect(cron.tasks).toHaveLength(1)
        expect(cron.tasks[0]?.expr).toBe('0 0 * * *')
    })

    it('translates the configured interval and start hour into the cron expression', function () {
        setConfigValue(handle.db, CONFIG_KEYS.schedule, { intervalHours: 6, startHour: 2 })
        startScheduler(input())
        expect(cron.tasks[0]?.expr).toBe('0 2,8,14,20 * * *')
    })

    it('passes the configured timezone through to node-cron', function () {
        setConfigValue(handle.db, CONFIG_KEYS.schedule, {
            intervalHours: 24,
            startHour: 9,
            timezone: 'America/Argentina/Buenos_Aires'
        })
        startScheduler(input())
        expect(cron.tasks[0]?.options).toEqual({ timezone: 'America/Argentina/Buenos_Aires' })
    })

    // node-cron reads an absent options object as "system timezone", which is the documented fallback.
    // Passing `{ timezone: undefined }` instead would be a different code path in node-cron.
    it('omits the options object entirely when no timezone is set', function () {
        startScheduler(input())
        expect(cron.tasks[0]?.options).toBeUndefined()
    })

    it('stops the active task on stop()', function () {
        const handles = startScheduler(input())
        handles.stop()
        expect(cron.tasks[0]?.stopped).toBe(true)
    })
})

describe('startScheduler — reload', function () {
    it('does nothing when the schedule is unchanged', function () {
        const handles = startScheduler(input())
        handles.reload()
        expect(cron.tasks).toHaveLength(1)
        expect(cron.tasks[0]?.stopped).toBe(false)
    })

    it('stops the old task and arms a new one when the interval changes', function () {
        const handles = startScheduler(input())
        setConfigValue(handle.db, CONFIG_KEYS.schedule, { intervalHours: 1 })
        handles.reload()
        expect(cron.tasks).toHaveLength(2)
        expect(cron.tasks[0]?.stopped).toBe(true)
        expect(cron.tasks[1]?.expr).toBe('0 * * * *')
    })

    // A timezone change leaves the expression identical, so an expression-only comparison would treat
    // this as a no-op and the operator's new timezone would not take effect until the next restart.
    it('re-arms when only the timezone changed', function () {
        setConfigValue(handle.db, CONFIG_KEYS.schedule, { intervalHours: 24, startHour: 3 })
        const handles = startScheduler(input())
        setConfigValue(handle.db, CONFIG_KEYS.schedule, { intervalHours: 24, startHour: 3, timezone: 'UTC' })
        handles.reload()
        expect(cron.tasks).toHaveLength(2)
        expect(cron.tasks[1]?.options).toEqual({ timezone: 'UTC' })
    })

    it('logs the before and after when it re-arms', function () {
        const handles = startScheduler(input())
        setConfigValue(handle.db, CONFIG_KEYS.schedule, { intervalHours: 12, startHour: 1 })
        handles.reload()
        expect(logLines().some(function match(l) {
            return l.startsWith('[scheduler] schedule reloaded:') && l.includes('0 0 * * *') && l.includes('0 1,13 * * *')
        })).toBe(true)
    })

    it('names the system timezone rather than printing undefined', function () {
        const handles = startScheduler(input())
        setConfigValue(handle.db, CONFIG_KEYS.schedule, { intervalHours: 1 })
        handles.reload()
        expect(logLines().some(function match(l) { return l.includes('@ system') })).toBe(true)
    })

    it('stops only the newest task after a reload', function () {
        const handles = startScheduler(input())
        setConfigValue(handle.db, CONFIG_KEYS.schedule, { intervalHours: 1 })
        handles.reload()
        handles.stop()
        expect(cron.tasks[1]?.stopped).toBe(true)
    })
})

describe('the scheduled tick', function () {
    it('runs a sweep and registers it with the runtime so shutdown can await it', async function () {
        const handles = startScheduler(input())
        const work = cron.tasks[0]?.fn() as Promise<unknown>
        expect(runtime.inFlight.size).toBe(1)
        await work
        expect(runBatch).toHaveBeenCalledTimes(1)
        handles.stop()
    })

    // An unhandled rejection inside a cron callback takes the worker process down. The sweep is the one
    // thing on that path that touches the filesystem and subprocesses, so it is the one most likely to throw.
    it('catches a failing sweep and logs it instead of rejecting', async function () {
        runBatch.mockRejectedValueOnce(new Error('scanner exploded'))
        startScheduler(input())
        await (cron.tasks[0]?.fn() as Promise<unknown>)
        expect(vi.mocked(console.error).mock.calls.map(function first(c) { return String(c[0]) })).toContain(
            '[scheduler] active sweep failed: scanner exploded'
        )
    })

    it('reports a non-Error rejection as a string rather than [object Object]', async function () {
        runBatch.mockRejectedValueOnce('plain string failure')
        startScheduler(input())
        await (cron.tasks[0]?.fn() as Promise<unknown>)
        expect(vi.mocked(console.error).mock.calls.map(function first(c) { return String(c[0]) })).toContain(
            '[scheduler] active sweep failed: plain string failure'
        )
    })
})

describe('sweepActiveProjects', function () {
    it('discovers projects before scanning, so a new one is picked up on the same sweep', async function () {
        await sweepActiveProjects(input())
        expect(lastBatch().projects.map(function rel(p) { return p.relPath })).toEqual(['web'])
    })

    it('picks up a project added since the previous sweep', async function () {
        await sweepActiveProjects(input())
        await makeTree(rootPath, 'api', { 'package.json': PKG_JSON })
        await sweepActiveProjects(input())
        expect(lastBatch().projects.map(function rel(p) { return p.relPath }).sort()).toEqual(['api', 'web'])
    })

    it('skips the batch entirely when discovery found nothing', async function () {
        const empty = await openWorkerTestDb('worker-scheduler-empty')
        await sweepActiveProjects({ db: empty.db, sqlite: empty.sqlite, runtime })
        expect(runBatch).not.toHaveBeenCalled()
        expect(logLines().some(function match(l) { return l.includes('active sweep finished (0 projects') })).toBe(true)
        await closeWorkerTestDb(empty)
    })

    it('uses the default parallelism when none is configured', async function () {
        await sweepActiveProjects(input())
        expect(lastBatch().parallelism).toBe(4)
    })

    it('uses the configured parallelism', async function () {
        setConfigValue(handle.db, CONFIG_KEYS.parallelism, 8)
        await sweepActiveProjects(input())
        expect(lastBatch().parallelism).toBe(8)
    })

    // The abort signal is what lets a SIGTERM cut scanner subprocesses short instead of waiting out the
    // full grace period. If the sweep did not thread it through, shutdown would stall on every scan.
    it('threads the runtime abort signal into the batch', async function () {
        await sweepActiveProjects(input())
        expect(lastBatch().abortSignal).toBe(runtime.abortController.signal)
    })

    it('offers npm-audit as the batch scanner by default', async function () {
        await sweepActiveProjects(input())
        expect(lastBatch().scanners.map(function name(s) { return s.name })).toEqual(['npm-audit'])
    })

    // The "always a source on" invariant is enforced at the toggle, not here — the scheduler simply
    // reflects the live config, so a disabled npm-audit cell produces an empty scanner list.
    it('drops npm-audit from the batch when its cell is disabled', async function () {
        setConfigValue(handle.db, 'sources.npm-audit.npm.enabled', false)
        await sweepActiveProjects(input())
        expect(lastBatch().scanners).toEqual([])
    })

    it('honours the configured global ignore list during discovery', async function () {
        setConfigValue(handle.db, CONFIG_KEYS.globalIgnore, ['web'])
        await sweepActiveProjects(input())
        expect(runBatch).not.toHaveBeenCalled()
    })

    it('logs the project count with correct pluralization', async function () {
        await sweepActiveProjects(input())
        expect(logLines().some(function match(l) { return l === '[scheduler] active sweep started (1 project)' })).toBe(true)
        await makeTree(rootPath, 'api', { 'package.json': PKG_JSON })
        await sweepActiveProjects(input())
        expect(logLines().some(function match(l) { return l === '[scheduler] active sweep started (2 projects)' })).toBe(true)
    })

    it('reports a sub-second sweep in milliseconds', async function () {
        await sweepActiveProjects(input())
        expect(logLines().some(function match(l) {
            return l.includes('active sweep finished') && /\d+ms\)/.test(l)
        })).toBe(true)
    })
})
