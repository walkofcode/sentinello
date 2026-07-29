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
