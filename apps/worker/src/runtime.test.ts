import { describe, expect, it, vi } from 'vitest'
import { createWorkerRuntime, waitForInFlight } from './runtime'

// Shutdown correctness depends on this pair. abort() tells scanner subprocesses to bail out fast,
// and waitForInFlight holds the shutdown until DB writes for already-started scans have landed —
// only after that is it safe to release the instance lock and close SQLite.
//
// The grace period is the interesting part: it must resolve either way. A promise that never
// settles (a wedged scanner subprocess) must not be able to hang the shutdown forever, but neither
// should the common case be delayed by waiting out the full grace.

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
    let resolve!: () => void
    let reject!: (e: Error) => void
    const promise = new Promise<void>(function executor(res, rej) {
        resolve = res
        reject = rej
    })
    return { promise, resolve, reject }
}

describe('createWorkerRuntime', function () {
    it('starts with an unaborted controller and nothing in flight', function () {
        const runtime = createWorkerRuntime()
        expect(runtime.abortController.signal.aborted).toBe(false)
        expect(runtime.inFlight.size).toBe(0)
    })

    it('gives each runtime its own controller', function () {
        const a = createWorkerRuntime()
        const b = createWorkerRuntime()
        a.abortController.abort()
        expect(b.abortController.signal.aborted).toBe(false)
    })
})

describe('track', function () {
    it('returns the same promise it was given', function () {
        const runtime = createWorkerRuntime()
        const work = Promise.resolve('value')
        expect(runtime.track(work)).toBe(work)
    })

    it('holds the work while it is pending', function () {
        const runtime = createWorkerRuntime()
        runtime.track(deferred().promise)
        expect(runtime.inFlight.size).toBe(1)
    })

    it('releases the work once it resolves', async function () {
        const runtime = createWorkerRuntime()
        const d = deferred()
        runtime.track(d.promise)
        d.resolve()
        await d.promise
        expect(runtime.inFlight.size).toBe(0)
    })

    // A failed scan must not leave a permanent entry, or every later shutdown would wait out the
    // full grace period for work that finished long ago.
    it('releases the work when it rejects', async function () {
        const runtime = createWorkerRuntime()
        const d = deferred()
        const tracked = runtime.track(d.promise).catch(function swallow() { return undefined })
        d.reject(new Error('scan failed'))
        await tracked
        expect(runtime.inFlight.size).toBe(0)
    })

    it('tracks several pieces of work at once', function () {
        const runtime = createWorkerRuntime()
        runtime.track(deferred().promise)
        runtime.track(deferred().promise)
        expect(runtime.inFlight.size).toBe(2)
    })

    it('preserves the resolved value', async function () {
        const runtime = createWorkerRuntime()
        expect(await runtime.track(Promise.resolve(42))).toBe(42)
    })
})

describe('waitForInFlight', function () {
    it('resolves immediately when nothing is in flight', async function () {
        const runtime = createWorkerRuntime()
        await expect(waitForInFlight(runtime, 50)).resolves.toBeUndefined()
    })

    it('waits for tracked work to settle', async function () {
        const runtime = createWorkerRuntime()
        const d = deferred()
        runtime.track(d.promise)

        let settled = false
        const waiting = waitForInFlight(runtime, 5000).then(function mark() { settled = true })
        await Promise.resolve()
        expect(settled).toBe(false)

        d.resolve()
        await waiting
        expect(settled).toBe(true)
    })

    it('resolves once every tracked promise has settled', async function () {
        const runtime = createWorkerRuntime()
        const a = deferred()
        const b = deferred()
        runtime.track(a.promise)
        runtime.track(b.promise)

        let settled = false
        const waiting = waitForInFlight(runtime, 5000).then(function mark() { settled = true })
        a.resolve()
        await Promise.resolve()
        expect(settled).toBe(false)

        b.resolve()
        await waiting
        expect(settled).toBe(true)
    })

    // A rejected scan still counts as settled — shutdown waits for work to finish, not to succeed.
    it('treats rejected work as settled', async function () {
        const runtime = createWorkerRuntime()
        const d = deferred()
        runtime.track(d.promise).catch(function swallow() { return undefined })
        d.reject(new Error('scan failed'))
        await expect(waitForInFlight(runtime, 5000)).resolves.toBeUndefined()
    })

    // The backstop: a scanner that never returns must not wedge the shutdown.
    it('gives up after the grace period and resolves anyway', async function () {
        vi.useFakeTimers()
        const warn = vi.spyOn(console, 'error').mockImplementation(function silence() {})
        try {
            const runtime = createWorkerRuntime()
            runtime.track(deferred().promise)

            let settled = false
            const waiting = waitForInFlight(runtime, 1000).then(function mark() { settled = true })
            await vi.advanceTimersByTimeAsync(999)
            expect(settled).toBe(false)

            await vi.advanceTimersByTimeAsync(2)
            await waiting
            expect(settled).toBe(true)
            expect(warn).toHaveBeenCalled()
        } finally {
            warn.mockRestore()
            vi.useRealTimers()
        }
    })

    it('reports how many tasks were still outstanding when the grace expired', async function () {
        vi.useFakeTimers()
        const warn = vi.spyOn(console, 'error').mockImplementation(function silence() {})
        try {
            const runtime = createWorkerRuntime()
            runtime.track(deferred().promise)
            runtime.track(deferred().promise)

            const waiting = waitForInFlight(runtime, 1000)
            await vi.advanceTimersByTimeAsync(1001)
            await waiting
            expect(String(warn.mock.calls[0]?.[0])).toContain('2 in-flight')
        } finally {
            warn.mockRestore()
            vi.useRealTimers()
        }
    })

    // Work that finishes before the grace expires must not be delayed by it, and the expiry warning
    // must not fire afterwards.
    it('does not warn when the work settles inside the grace period', async function () {
        vi.useFakeTimers()
        const warn = vi.spyOn(console, 'error').mockImplementation(function silence() {})
        try {
            const runtime = createWorkerRuntime()
            const d = deferred()
            runtime.track(d.promise)

            const waiting = waitForInFlight(runtime, 10_000)
            d.resolve()
            await waiting
            await vi.advanceTimersByTimeAsync(20_000)
            expect(warn).not.toHaveBeenCalled()
        } finally {
            warn.mockRestore()
            vi.useRealTimers()
        }
    })

    // Snapshotted at call time: work started after shutdown began is not waited on, which is what
    // stops a self-rescheduling loop from deferring shutdown indefinitely.
    it('ignores work tracked after the wait began', async function () {
        const runtime = createWorkerRuntime()
        const first = deferred()
        runtime.track(first.promise)

        const waiting = waitForInFlight(runtime, 5000)
        runtime.track(deferred().promise)
        first.resolve()

        await expect(waiting).resolves.toBeUndefined()
    })
})

describe('waitForInFlight — the settled race', function () {
    // The one ordering the guards exist for: the grace expires, shutdown proceeds, and THEN the
    // abandoned scan finishes anyway. Without the flag, its allSettled handler would resolve an
    // already-resolved promise — harmless in itself — but the guard is also what stops a second
    // "grace period exceeded" line being attributed to work that did eventually complete.
    //
    // This is a real sequence, not a theoretical one: the grace period is bounded precisely because
    // a scanner subprocess can outlive it, and abort() only asks it to stop.
    it('ignores work that settles after the grace period already expired', async function () {
        vi.useFakeTimers()
        const warn = vi.spyOn(console, 'error').mockImplementation(function silence() {})
        try {
            const runtime = createWorkerRuntime()
            const late = deferred()
            runtime.track(late.promise)

            const waiting = waitForInFlight(runtime, 1000)
            await vi.advanceTimersByTimeAsync(1001)
            await waiting
            expect(warn).toHaveBeenCalledTimes(1)

            // The straggler lands after shutdown has already moved on.
            late.resolve()
            await vi.advanceTimersByTimeAsync(0)

            expect(warn).toHaveBeenCalledTimes(1)
            expect(runtime.inFlight.size).toBe(0)
        } finally {
            warn.mockRestore()
            vi.useRealTimers()
        }
    })
})
