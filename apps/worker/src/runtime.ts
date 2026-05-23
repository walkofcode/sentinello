// Shared worker runtime. Owns the AbortController that propagates to scanner subprocesses on
// shutdown, and the in-flight Set so shutdown can await sweeps/polls already in progress.
//
// Why both live here:
//  - shutdown must call abort() (so scanner spawn calls bail out fast) AND await in-flight (so DB
//    writes for already-started scans complete before we close SQLite and release the lock)
//  - any module that schedules work that touches the DB or shells out must thread the runtime through
//    so dispatch records and lock release stay consistent

export type WorkerRuntime = {
    abortController: AbortController
    inFlight: Set<Promise<unknown>>
    track<T>(work: Promise<T>): Promise<T>
}

export function createWorkerRuntime(): WorkerRuntime {
    const abortController = new AbortController()
    const inFlight = new Set<Promise<unknown>>()
    function track<T>(work: Promise<T>): Promise<T> {
        inFlight.add(work)
        function removeTracked(): void {
            inFlight.delete(work)
        }
        work.then(removeTracked, removeTracked)
        return work
    }
    return { abortController, inFlight, track }
}

// Waits for every currently-tracked promise to settle, or for graceMs to elapse, whichever comes first.
// Resolves either way. Callers run shutdown steps that depend on in-flight state being quiesced
// (release lock, close SQLite) AFTER this resolves.
export function waitForInFlight(runtime: WorkerRuntime, graceMs: number): Promise<void> {
    return new Promise(function executor(resolve) {
        const tasks = Array.from(runtime.inFlight)
        if (tasks.length === 0) {
            resolve()
            return
        }
        let settled = false
        const graceTimer = setTimeout(function onGraceTimeout() {
            if (settled) return
            settled = true
            console.error('[worker] grace period exceeded; ' + runtime.inFlight.size + ' in-flight tasks did not settle')
            resolve()
        }, graceMs)
        graceTimer.unref()
        Promise.allSettled(tasks).then(function onAllSettled() {
            if (settled) return
            settled = true
            clearTimeout(graceTimer)
            resolve()
        })
    })
}
