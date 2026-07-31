import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    enqueueScanRequest,
    enqueueWorkerSignal,
    listRecentScanRequests,
    projectId as makeProjectId,
    setConfigValue,
    upsertRoot
} from '@sentinello/db'
import { CONFIG_KEYS } from './config-loader'
import {
    PKG_JSON,
    T0,
    closeWorkerTestDb,
    makeTree,
    openWorkerTestDb,
    type WorkerTestDb
} from './worker-test-db.fixture'
import { createWorkerRuntime, type WorkerRuntime } from './runtime'

// The scan-request poller is the worker's inbound door: everything the portal and the MCP tools ask for
// arrives as a row in scan_requests or worker_signals, never as a direct call. Three properties of that
// door are load-bearing and none are visible from the outside:
//
//   - signals drain BEFORE a scan request is claimed. A schedule change saved while a long scan is
//     running must take effect within one poll interval, not whenever the scan happens to finish.
//   - every claimed request reaches a terminal status. A request that throws and stays 'running' is
//     indistinguishable from one still in flight, so the portal shows a spinner forever and the next
//     boot's orphan reset is the only thing that clears it.
//   - an unknown signal kind is skipped, not fatal. A newer portal enqueueing a kind this worker version
//     does not know about must not take the poller down.
//
// ./runner is stubbed because runBatch would otherwise shell out to `npm audit` for every project —
// selectScanners hands it the real npmAuditPlugin. Everything else, including the claim/heartbeat/
// terminal-status queries and discovery, is real.

const runBatch = vi.hoisted(function makeRunBatch() {
    return vi.fn(async function runBatch(_input: unknown) { return [] as unknown[] })
})

vi.mock('./runner', function mockRunner() {
    return { runBatch }
})

const { pollOnce, startScanRequestPoller } = await import('./scan-request-poller')

let handle: WorkerTestDb
let runtime: WorkerRuntime
let rootPath: string
let scheduler: { reload: ReturnType<typeof vi.fn<() => void>>; stop: ReturnType<typeof vi.fn<() => void>> }

function controller() {
    return {
        getScanner: vi.fn(function getScanner() { return null }),
        reload: vi.fn(),
        refresh: vi.fn(async function refresh() {}),
        stop: vi.fn()
    }
}

let osvController: ReturnType<typeof controller>
let gemnasiumController: ReturnType<typeof controller>

function input(overrides: Record<string, unknown> = {}) {
    return {
        db: handle.db,
        sqlite: handle.sqlite,
        runtime,
        scheduler,
        osvController,
        gemnasiumController,
        ...overrides
    }
}

// A drizzle handle that rejects every call with a bare string rather than an Error. better-sqlite3
// only ever throws Errors, so this is the only way to reach the String(err) arm of the message
// extraction that every log line in this module goes through.
function throwingDb() {
    return new Proxy({}, {
        get() {
            throw 'database exploded'
        }
    }) as unknown as WorkerTestDb['db']
}

function lastBatch() {
    return runBatch.mock.calls[runBatch.mock.calls.length - 1]?.[0] as {
        projects: { id: string; relPath: string }[]
        parallelism: number
        abortSignal?: AbortSignal
    }
}

function statusOf(id: string): string | undefined {
    return listRecentScanRequests(handle.db).find(function match(r) { return r.id === id })?.status
}

function errorLines(): string[] {
    return vi.mocked(console.error).mock.calls.map(function first(c) { return String(c[0]) })
}

function logLines(): string[] {
    return vi.mocked(console.log).mock.calls.map(function first(c) { return String(c[0]) })
}

beforeEach(async function setup() {
    runBatch.mockClear()
    handle = await openWorkerTestDb('worker-poller')
    runtime = createWorkerRuntime()
    scheduler = { reload: vi.fn<() => void>(), stop: vi.fn<() => void>() }
    osvController = controller()
    gemnasiumController = controller()
    rootPath = await makeTree(handle.dir, 'code', { 'web/package.json': PKG_JSON })
    upsertRoot(handle.db, { id: 'root-1', path: rootPath, label: null, createdAt: T0 })
    vi.spyOn(console, 'log').mockImplementation(function silence() {})
    vi.spyOn(console, 'warn').mockImplementation(function silence() {})
    vi.spyOn(console, 'error').mockImplementation(function silence() {})
})

afterEach(async function teardown() {
    vi.restoreAllMocks()
    await closeWorkerTestDb(handle)
})

describe('pollOnce — claiming', function () {
    it('does nothing when the queue is empty', async function () {
        await pollOnce(input())
        expect(runBatch).not.toHaveBeenCalled()
    })

    it('claims the oldest pending request first', async function () {
        const first = enqueueScanRequest(handle.db, {}, T0)
        enqueueScanRequest(handle.db, {}, T0 + 1000)
        await pollOnce(input())
        expect(statusOf(first.id)).toBe('done')
    })

    it('handles one request per tick', async function () {
        enqueueScanRequest(handle.db, {}, T0)
        const second = enqueueScanRequest(handle.db, {}, T0 + 1000)
        await pollOnce(input())
        expect(statusOf(second.id)).toBe('pending')
        await pollOnce(input())
        expect(statusOf(second.id)).toBe('done')
    })
})

describe('pollOnce — full sweep', function () {
    it('discovers and scans every project under every root', async function () {
        const request = enqueueScanRequest(handle.db, {}, T0)
        await pollOnce(input())
        expect(lastBatch().projects.map(function rel(p) { return p.relPath })).toEqual(['web'])
        expect(statusOf(request.id)).toBe('done')
    })

    it('marks the request done without a batch when there is nothing to scan', async function () {
        const empty = await openWorkerTestDb('worker-poller-empty')
        const request = enqueueScanRequest(empty.db, {}, T0)
        await pollOnce(input({ db: empty.db, sqlite: empty.sqlite }))
        expect(runBatch).not.toHaveBeenCalled()
        expect(listRecentScanRequests(empty.db).find(function m(r) { return r.id === request.id })?.status).toBe('done')
        await closeWorkerTestDb(empty)
    })

    it('uses the configured parallelism', async function () {
        setConfigValue(handle.db, CONFIG_KEYS.parallelism, 2)
        enqueueScanRequest(handle.db, {}, T0)
        await pollOnce(input())
        expect(lastBatch().parallelism).toBe(2)
    })

    it('threads the abort signal so shutdown can cut the scan short', async function () {
        enqueueScanRequest(handle.db, {}, T0)
        await pollOnce(input())
        expect(lastBatch().abortSignal).toBe(runtime.abortController.signal)
    })
})

describe('pollOnce — single project', function () {
    it('scans only the requested project', async function () {
        await makeTree(rootPath, 'api', { 'package.json': PKG_JSON })
        enqueueScanRequest(handle.db, {}, T0)
        await pollOnce(input())
        runBatch.mockClear()

        const id = makeProjectId('root-1', 'api')
        const request = enqueueScanRequest(handle.db, { projectId: id }, T0 + 1000)
        await pollOnce(input())

        expect(lastBatch().projects.map(function pid(p) { return p.id })).toEqual([id])
        expect(statusOf(request.id)).toBe('done')
    })

    // Defensive, and genuinely hard to reach: scan_requests.project_id is a foreign key and
    // cascadeDeleteProjects removes a project's pending requests along with it, so within one process
    // this branch is unreachable. It exists for the cross-process race — the portal deleting the target
    // between the worker's claim and its lookup — which is why the harness relaxes the FK pragma to get
    // at it. What matters is that the request still reaches a terminal status: a row left 'running' is
    // indistinguishable from a live scan and spins in the portal until the next boot resets it.
    it('marks the request failed when the project no longer exists', async function () {
        const loose = await openWorkerTestDb('worker-poller-ghost', { relaxForeignKeys: true })
        const request = enqueueScanRequest(loose.db, { projectId: 'ghost' }, T0)
        await pollOnce(input({ db: loose.db, sqlite: loose.sqlite }))
        expect(listRecentScanRequests(loose.db).find(function m(r) { return r.id === request.id })?.status).toBe('failed')
        expect(errorLines().some(function m(l) { return l.includes('project not found: ghost') })).toBe(true)
        expect(runBatch).not.toHaveBeenCalled()
        await closeWorkerTestDb(loose)
    })

    it('does not run discovery for a single-project request', async function () {
        enqueueScanRequest(handle.db, {}, T0)
        await pollOnce(input())
        await makeTree(rootPath, 'api', { 'package.json': PKG_JSON })

        const id = makeProjectId('root-1', 'web')
        enqueueScanRequest(handle.db, { projectId: id }, T0 + 1000)
        await pollOnce(input())

        expect(lastBatch().projects.map(function pid(p) { return p.id })).toEqual([id])
    })
})

describe('pollOnce — root sweep', function () {
    it('discovers and scans only the requested root', async function () {
        const other = await makeTree(handle.dir, 'other', { 'tool/package.json': PKG_JSON })
        upsertRoot(handle.db, { id: 'root-2', path: other, label: null, createdAt: T0 })
        const request = enqueueScanRequest(handle.db, { rootId: 'root-2' }, T0)

        await pollOnce(input())

        expect(lastBatch().projects.map(function rel(p) { return p.relPath })).toEqual(['tool'])
        expect(statusOf(request.id)).toBe('done')
    })

    // Same shape as the missing-project case, and reachable the same way — see the note there.
    it('marks the request failed when the root no longer exists', async function () {
        const loose = await openWorkerTestDb('worker-poller-ghost-root', { relaxForeignKeys: true })
        const request = enqueueScanRequest(loose.db, { rootId: 'ghost' }, T0)
        await pollOnce(input({ db: loose.db, sqlite: loose.sqlite }))
        expect(listRecentScanRequests(loose.db).find(function m(r) { return r.id === request.id })?.status).toBe('failed')
        expect(errorLines().some(function m(l) { return l.includes('root not found: ghost') })).toBe(true)
        await closeWorkerTestDb(loose)
    })

    it('marks the request done without a batch when the root holds no projects', async function () {
        const bare = await makeTree(handle.dir, 'bare', { 'notes.md': 'nothing here' })
        upsertRoot(handle.db, { id: 'root-3', path: bare, label: null, createdAt: T0 })
        const request = enqueueScanRequest(handle.db, { rootId: 'root-3' }, T0)
        await pollOnce(input())
        expect(runBatch).not.toHaveBeenCalled()
        expect(statusOf(request.id)).toBe('done')
    })

    // This is the "Scan this root" button's log line — the likeliest thing an operator reads after
    // pressing it — and its project count is pluralised inline.
    it.each([
        ['a single project', { 'only/package.json': PKG_JSON }, '1 project,'],
        ['several projects', { 'a/package.json': PKG_JSON, 'b/package.json': PKG_JSON }, '2 projects,']
    ])('reports %s in the finished log', async function (_label, tree, expected) {
        const path = await makeTree(handle.dir, 'counted-' + String(expected).replace(/\W/g, ''), tree as Record<string, string>)
        upsertRoot(handle.db, { id: 'root-count', path, label: null, createdAt: T0 })
        enqueueScanRequest(handle.db, { rootId: 'root-count' }, T0)

        await pollOnce(input())

        expect(logLines().some(function m(l) {
            return l.includes('root sweep finished') && l.includes(expected as string)
        })).toBe(true)
    })
})

describe('pollOnce — failure handling', function () {
    it('marks a request failed when the batch throws, and logs the reason', async function () {
        runBatch.mockRejectedValueOnce(new Error('scanner exploded'))
        const request = enqueueScanRequest(handle.db, {}, T0)
        await pollOnce(input())
        expect(statusOf(request.id)).toBe('failed')
        expect(errorLines().some(function m(l) {
            return l.includes('request ' + request.id + ' failed: scanner exploded')
        })).toBe(true)
    })

    it('reports a non-Error rejection as a string', async function () {
        runBatch.mockRejectedValueOnce('plain failure')
        enqueueScanRequest(handle.db, {}, T0)
        await pollOnce(input())
        expect(errorLines().some(function m(l) { return l.includes('failed: plain failure') })).toBe(true)
    })

    // A failed request must not wedge the queue: the next tick has to make progress.
    it('leaves the queue drainable after a failure', async function () {
        runBatch.mockRejectedValueOnce(new Error('once'))
        enqueueScanRequest(handle.db, {}, T0)
        const second = enqueueScanRequest(handle.db, {}, T0 + 1000)
        await pollOnce(input())
        await pollOnce(input())
        expect(statusOf(second.id)).toBe('done')
    })
})

describe('pollOnce — the heartbeat', function () {
    // heartbeat_at is what lets the portal tell "still working" from "orphaned by a crash". Without a
    // ping mid-scan, a long scan looks stale and a future boot would reset a live row.
    it('pings the heartbeat while a scan is in flight', async function () {
        vi.useFakeTimers()
        let release = function release() {}
        runBatch.mockImplementationOnce(function slow() {
            return new Promise(function executor(resolve) {
                release = function () { resolve([]) }
            })
        })
        const request = enqueueScanRequest(handle.db, {}, T0)
        const work = pollOnce(input())
        await vi.advanceTimersByTimeAsync(5_000)
        const midFlight = listRecentScanRequests(handle.db).find(function m(r) { return r.id === request.id })
        expect(midFlight?.heartbeatAt).not.toBeNull()
        release()
        await work
        vi.useRealTimers()
    })

    it('stops pinging once the request is done', async function () {
        vi.useFakeTimers()
        const request = enqueueScanRequest(handle.db, {}, T0)
        await pollOnce(input())
        const settled = listRecentScanRequests(handle.db).find(function m(r) { return r.id === request.id })
        await vi.advanceTimersByTimeAsync(30_000)
        const later = listRecentScanRequests(handle.db).find(function m(r) { return r.id === request.id })
        expect(later?.heartbeatAt).toBe(settled?.heartbeatAt ?? null)
        vi.useRealTimers()
    })

    // The ping runs on its own interval, outside the try/catch that wraps the scan, so a throwing
    // ping is an unhandled exception inside a timer callback — which takes the process down and
    // loses the scan that was actually going fine. It has its own catch for exactly that reason.
    //
    // The fault is injected by closing the connection mid-scan, which is the real shape of the
    // failure: the ping keeps firing on its interval after a shutdown has already closed the
    // database, and better-sqlite3 throws rather than returning an error.
    it('survives a heartbeat ping that throws', async function () {
        vi.useFakeTimers()
        let release = function release() {}
        runBatch.mockImplementationOnce(function slow() {
            handle.sqlite.close()
            return new Promise(function executor(resolve) {
                release = function () { resolve([]) }
            })
        })
        enqueueScanRequest(handle.db, {}, T0)

        const work = pollOnce(input())
        await vi.advanceTimersByTimeAsync(5_000)

        // The ping failed and was logged, and the scan promise is still pending — that is the whole
        // property: a dead heartbeat does not interrupt the scan it was reporting on.
        expect(errorLines().some(function m(l) { return l.includes('heartbeat ping failed') })).toBe(true)

        // Once the batch finishes, the same closed connection defeats the terminal-status write too,
        // and pollOnce rejects — which is correct and is the caller's problem: startScanRequestPoller
        // catches it (covered below). Asserted rather than awaited bare so the cascade is stated
        // rather than showing up as an unhandled rejection in some later test.
        release()
        await expect(work).rejects.toThrow(/database connection is not open/)
        vi.useRealTimers()
    })
})

describe('pollOnce — when the database itself is unavailable', function () {
    // Everything above injects failure at the scanner. These two inject it at the database, which is
    // the shape a shutdown race actually takes: the connection closes while a tick is in flight.
    // Both paths have to degrade to a log rather than an unhandled rejection, because an unhandled
    // rejection inside setInterval takes the whole worker down over a transient.

    it('logs a failing signal claim and returns rather than throwing', async function () {
        enqueueWorkerSignal(handle.db, 'reload-schedule', T0)
        handle.sqlite.close()

        // drainWorkerSignals swallows its own failure and returns; what rejects is the request claim
        // immediately after it. So the assertion below is specifically about the drain arm having
        // logged and moved on, not about pollOnce surviving.
        await expect(pollOnce(input())).rejects.toThrow()

        expect(errorLines().some(function m(l) { return l.includes('signal claim failed') })).toBe(true)
        expect(scheduler.reload).not.toHaveBeenCalled()
    })

    it('renders a non-Error signal-claim failure as a string', async function () {
        await expect(pollOnce(input({ db: throwingDb() }))).rejects.toBe('database exploded')
        expect(errorLines().some(function m(l) { return l.includes('signal claim failed: database exploded') })).toBe(true)
    })

    it('catches a rejected tick inside the interval instead of crashing the worker', async function () {
        vi.useFakeTimers()
        const handles = startScanRequestPoller(input({ intervalMs: 100 }))
        handle.sqlite.close()

        await vi.advanceTimersByTimeAsync(100)

        expect(errorLines().some(function m(l) { return l.includes('tick failed') })).toBe(true)
        handles.stop()
        vi.useRealTimers()
    })

    // A non-Error rejection cannot come from the database layer — better-sqlite3 throws Errors — so
    // the String(err) arm of the tick's handler is reached with a db double that throws a bare
    // string. It is the same arm a `throw 'msg'` anywhere below pollOnce would take, and the cost of
    // getting it wrong is "[object Object]" in the only line that says the poller stopped working.
    it('renders a non-Error tick rejection as a string', async function () {
        vi.useFakeTimers()
        const handles = startScanRequestPoller(input({ db: throwingDb(), intervalMs: 100 }))

        await vi.advanceTimersByTimeAsync(100)

        expect(errorLines().some(function m(l) { return l.includes('tick failed: database exploded') })).toBe(true)
        handles.stop()
        vi.useRealTimers()
    })

    // Falls back to POLL_INTERVAL_MS when the caller passes none — which is how the worker starts it.
    // Every other test here passes an explicit interval to keep the fake clock short, so the real
    // production value had never been exercised.
    it('defaults to a five-second interval when none is given', async function () {
        vi.useFakeTimers()
        const handles = startScanRequestPoller(input())
        enqueueScanRequest(handle.db, {}, T0)

        await vi.advanceTimersByTimeAsync(4_999)
        expect(runBatch).not.toHaveBeenCalled()

        await vi.advanceTimersByTimeAsync(1)
        expect(runBatch).toHaveBeenCalledTimes(1)

        handles.stop()
        vi.useRealTimers()
    })
})

describe('worker signals', function () {
    it('drains signals even when no scan request is pending', async function () {
        enqueueWorkerSignal(handle.db, 'reload-schedule', T0)
        await pollOnce(input())
        expect(scheduler.reload).toHaveBeenCalledTimes(1)
    })

    // Drained before the claim, so a schedule saved during a long scan lands within one poll interval
    // rather than after the scan finishes.
    it('drains signals before claiming a scan request', async function () {
        enqueueWorkerSignal(handle.db, 'reload-schedule', T0)
        enqueueScanRequest(handle.db, {}, T0)
        runBatch.mockImplementationOnce(function assertOrder() {
            expect(scheduler.reload).toHaveBeenCalled()
            return Promise.resolve([])
        })
        await pollOnce(input())
        expect(runBatch).toHaveBeenCalled()
    })

    it('claims each signal exactly once', async function () {
        enqueueWorkerSignal(handle.db, 'reload-schedule', T0)
        await pollOnce(input())
        await pollOnce(input())
        expect(scheduler.reload).toHaveBeenCalledTimes(1)
    })

    it('reloads both source controllers on reload-sources', async function () {
        enqueueWorkerSignal(handle.db, 'reload-sources', T0)
        await pollOnce(input())
        expect(osvController.reload).toHaveBeenCalledTimes(1)
        expect(gemnasiumController.reload).toHaveBeenCalledTimes(1)
    })

    it('tolerates absent source controllers', async function () {
        enqueueWorkerSignal(handle.db, 'reload-sources', T0)
        await pollOnce(input({ osvController: null, gemnasiumController: null }))
        expect(errorLines()).toEqual([])
    })

    it('kicks an OSV refresh in the background and tracks it for shutdown', async function () {
        enqueueWorkerSignal(handle.db, 'refresh-osv', T0)
        await pollOnce(input())
        expect(osvController.refresh).toHaveBeenCalledTimes(1)
        expect(gemnasiumController.refresh).not.toHaveBeenCalled()
    })

    it('kicks a gemnasium refresh on its own signal', async function () {
        enqueueWorkerSignal(handle.db, 'refresh-gemnasium', T0)
        await pollOnce(input())
        expect(gemnasiumController.refresh).toHaveBeenCalledTimes(1)
        expect(osvController.refresh).not.toHaveBeenCalled()
    })

    it('catches a failing refresh instead of leaving an unhandled rejection', async function () {
        osvController.refresh.mockRejectedValueOnce(new Error('feed down'))
        enqueueWorkerSignal(handle.db, 'refresh-osv', T0)
        await pollOnce(input())
        await Promise.allSettled(Array.from(runtime.inFlight))
        expect(errorLines().some(function m(l) { return l.includes('OSV refresh failed: feed down') })).toBe(true)
    })

    it('catches a failing gemnasium refresh too', async function () {
        gemnasiumController.refresh.mockRejectedValueOnce(new Error('archive down'))
        enqueueWorkerSignal(handle.db, 'refresh-gemnasium', T0)
        await pollOnce(input())
        await Promise.allSettled(Array.from(runtime.inFlight))
        expect(errorLines().some(function m(l) { return l.includes('gemnasium refresh failed: archive down') })).toBe(true)
    })

    it('skips a refresh signal when the source has no controller', async function () {
        enqueueWorkerSignal(handle.db, 'refresh-osv', T0)
        enqueueWorkerSignal(handle.db, 'refresh-gemnasium', T0)
        await pollOnce(input({ osvController: null, gemnasiumController: null }))
        expect(errorLines()).toEqual([])
    })

    // Forward compatibility: a newer portal may enqueue kinds this worker has never heard of.
    it('warns about an unknown signal kind and keeps going', async function () {
        enqueueWorkerSignal(handle.db, 'teleport-the-database', T0)
        enqueueWorkerSignal(handle.db, 'reload-schedule', T0)
        await pollOnce(input())
        expect(vi.mocked(console.warn).mock.calls.map(function f(c) { return String(c[0]) }).some(function m(l) {
            return l.includes('unknown signal kind: teleport-the-database')
        })).toBe(true)
        expect(scheduler.reload).toHaveBeenCalledTimes(1)
    })

    // One signal's dispatch throwing must not swallow the rest of the batch.
    it('logs a failing dispatch and still dispatches the remaining signals', async function () {
        scheduler.reload.mockImplementationOnce(function boom() { throw new Error('reload blew up') })
        enqueueWorkerSignal(handle.db, 'reload-schedule', T0)
        enqueueWorkerSignal(handle.db, 'reload-sources', T0)
        await pollOnce(input())
        expect(errorLines().some(function m(l) { return l.includes('signal dispatch failed') && l.includes('reload-schedule') })).toBe(true)
        expect(osvController.reload).toHaveBeenCalledTimes(1)
    })

    // Every message in this module is built with `err instanceof Error && err.message || String(err)`.
    // The second arm is what a `throw 'string'` or a rejected non-Error takes, and getting it wrong
    // prints "[object Object]" in the one log line an operator has to diagnose from.
    it('renders a non-Error dispatch failure as a string', async function () {
        scheduler.reload.mockImplementationOnce(function boom() { throw 'reload blew up' })
        enqueueWorkerSignal(handle.db, 'reload-schedule', T0)
        await pollOnce(input())
        expect(errorLines().some(function m(l) { return l.includes('signal dispatch failed') && l.includes('reload blew up') })).toBe(true)
    })

    it.each([
        ['OSV', 'refresh-osv', 'OSV refresh failed: feed down'],
        ['gemnasium', 'refresh-gemnasium', 'gemnasium refresh failed: feed down']
    ])('renders a non-Error %s refresh rejection as a string', async function (_label, kind, expected) {
        const target = kind === 'refresh-osv' ? osvController : gemnasiumController
        target.refresh.mockRejectedValueOnce('feed down')
        enqueueWorkerSignal(handle.db, kind as string, T0)
        await pollOnce(input())
        await Promise.allSettled(Array.from(runtime.inFlight))
        expect(errorLines().some(function m(l) { return l.includes(expected as string) })).toBe(true)
    })
})

describe('startScanRequestPoller', function () {
    beforeEach(function useFake() {
        vi.useFakeTimers()
    })

    afterEach(function useReal() {
        vi.useRealTimers()
    })

    it('polls on the configured interval', async function () {
        const handles = startScanRequestPoller(input({ intervalMs: 100 }))
        enqueueScanRequest(handle.db, {}, T0)
        await vi.advanceTimersByTimeAsync(100)
        expect(runBatch).toHaveBeenCalledTimes(1)
        handles.stop()
    })

    it('does not poll before the first interval elapses', async function () {
        const handles = startScanRequestPoller(input({ intervalMs: 5_000 }))
        enqueueScanRequest(handle.db, {}, T0)
        await vi.advanceTimersByTimeAsync(4_999)
        expect(runBatch).not.toHaveBeenCalled()
        handles.stop()
    })

    // Tracked so waitForInFlight() can hold shutdown until the scan's DB writes land. Note the tick
    // tracks the promise AFTER pollOnce has already run synchronously as far as its first await — so
    // this has to be observed from outside, with the batch still pending, rather than from inside it.
    it('registers each tick with the runtime so shutdown can await it', async function () {
        let release = function release() {}
        runBatch.mockImplementationOnce(function slow() {
            return new Promise(function executor(resolve) {
                release = function () { resolve([]) }
            })
        })
        const handles = startScanRequestPoller(input({ intervalMs: 100 }))
        enqueueScanRequest(handle.db, {}, T0)
        await vi.advanceTimersByTimeAsync(100)
        expect(runtime.inFlight.size).toBe(1)
        release()
        await vi.advanceTimersByTimeAsync(0)
        expect(runtime.inFlight.size).toBe(0)
        handles.stop()
    })

    it('stops ticking after stop()', async function () {
        const handles = startScanRequestPoller(input({ intervalMs: 100 }))
        handles.stop()
        enqueueScanRequest(handle.db, {}, T0)
        await vi.advanceTimersByTimeAsync(1_000)
        expect(runBatch).not.toHaveBeenCalled()
    })

    // A rejected tick inside setInterval is an unhandled rejection, which takes the process down.
    it('catches a failing tick and logs it', async function () {
        runBatch.mockRejectedValueOnce(new Error('tick exploded'))
        const handles = startScanRequestPoller(input({ intervalMs: 100 }))
        enqueueScanRequest(handle.db, {}, T0)
        await vi.advanceTimersByTimeAsync(100)
        expect(errorLines().some(function m(l) { return l.includes('tick failed') || l.includes('exploded') })).toBe(true)
        handles.stop()
    })

    it('keeps polling after a failed tick', async function () {
        runBatch.mockRejectedValueOnce(new Error('once'))
        const handles = startScanRequestPoller(input({ intervalMs: 100 }))
        enqueueScanRequest(handle.db, {}, T0)
        await vi.advanceTimersByTimeAsync(100)
        const second = enqueueScanRequest(handle.db, {}, T0 + 1)
        await vi.advanceTimersByTimeAsync(100)
        expect(statusOf(second.id)).toBe('done')
        handles.stop()
    })

    it('logs the sweep it performed', async function () {
        const handles = startScanRequestPoller(input({ intervalMs: 100 }))
        enqueueScanRequest(handle.db, {}, T0)
        await vi.advanceTimersByTimeAsync(100)
        expect(logLines().some(function m(l) { return l.includes('full sweep started') })).toBe(true)
        handles.stop()
    })
})
