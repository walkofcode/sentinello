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
    rebuilds: CacheRebuilds
}

// The advisory-cache syncs in flight, across every source, so one source's runtime can see that another's
// cache is still being rebuilt. A full sweep run while any cache is rebuilding records "not downloaded yet"
// for every project that source covers (gemnasium too, while the OSV cache its withdrawal evidence comes
// from is incomplete), so the scan-request poller holds full sweeps until none is.
//
// It also remembers, per cache, whether the last attempt to prepare it failed. The silent baseline waits
// for a cache that is still on its way, never for one whose download failed: a failed feed would otherwise
// hold the baseline, and with it every finding of the capability's languages, until a retry succeeds.
export type CacheRebuilds = {
    // Registers a sync of one cache until it settles. It counts as a rebuild only while `unusable` answers
    // true, read at each check: a first seed or a normalizer rebuild from the start, an OSV incremental only
    // once it has discarded the cache to re-seed, and a gemnasium refresh of a usable cache never. When it
    // settles, rejected or not, the cache it leaves behind decides whether the attempt failed.
    track(cache: string, sync: Promise<unknown>, unusable: () => boolean): void
    active(): boolean
    // True from the moment a sync of the cache settles with the cache still unusable until one settles with
    // it usable. A retry in flight does not clear it, so retrying cannot extend a wait forever. Process-local:
    // a restarted worker starts a fresh attempt at boot, and that attempt's outcome is the one asked about.
    failed(cache: string): boolean
}

// The cache identities the sources track their syncs under. OSV downloads one cache per ecosystem;
// gemnasium's is one multi-ecosystem download.
export const GEMNASIUM_CACHE = 'gemnasium'

export function osvCache(ecosystem: string): string {
    return 'osv/' + ecosystem
}

export function createCacheRebuilds(): CacheRebuilds {
    const syncs = new Map<Promise<unknown>, () => boolean>()
    const failures = new Set<string>()
    return {
        track: function track(cache, sync, unusable) {
            syncs.set(sync, unusable)
            function settle(): void {
                syncs.delete(sync)
                if (unusable()) failures.add(cache)
                else failures.delete(cache)
            }
            sync.then(settle, settle)
        },
        active: function active() {
            for (const unusable of syncs.values()) {
                if (unusable()) return true
            }
            return false
        },
        failed: function failed(cache) {
            return failures.has(cache)
        }
    }
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
    return { abortController, inFlight, track, rebuilds: createCacheRebuilds() }
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
        // No `settled` flag guarding either side of this race. A promise's resolve is idempotent, so
        // whichever arm arrives second is already a no-op, and clearing the timer here is what stops
        // the grace-exceeded line being logged after a clean settle. The flag those two guards read
        // could never be true when they ran — it was set and the timer cleared in the same synchronous
        // block — so both were unreachable rather than defensive.
        const graceTimer = setTimeout(function onGraceTimeout() {
            console.error('[worker] grace period exceeded; ' + runtime.inFlight.size + ' in-flight tasks did not settle')
            resolve()
        }, graceMs)
        graceTimer.unref()
        Promise.allSettled(tasks).then(function onAllSettled() {
            clearTimeout(graceTimer)
            resolve()
        })
    })
}
