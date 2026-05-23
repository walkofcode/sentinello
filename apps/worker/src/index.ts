import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import lockfile from 'proper-lockfile'
import { backfillFindingsLifecycle, getConfigValue, getLastScanFinishedAt, listRoots, openDb, resetOrphanedRunningRequests, resolveDbPath, resolveLockPath, runMigrations } from '@sentinello/db'
import { CONFIG_KEYS, DEFAULT_SCHEDULE, discoverDockerRoots, loadConfigFile, seedFromConfig, type IntervalHours } from './config-loader'
import { startScheduler, sweepActiveProjects } from './scheduler'
import { startScanRequestPoller } from './scan-request-poller'
import { startLockfileWatcher, type WatcherHandle } from './watcher'
import { startMuteExpirySweep, type MuteExpiryHandle } from './mute-expiry'
import { createWorkerRuntime, waitForInFlight, type WorkerRuntime } from './runtime'

const GRACE_PERIOD_MS = 30_000

main().catch(function onMainError(err: unknown) {
    const message = err instanceof Error && err.message || String(err)
    console.error('[worker] fatal: ' + message)
    process.exit(1)
})

async function main(): Promise<void> {
    const dbPath = resolveDbPath()
    const lockPath = resolveLockPath(dbPath)
    ensureLockFileExists(lockPath)
    let release: () => Promise<void>
    try {
        const releaseFn = await lockfile.lock(lockPath, { realpath: false, stale: 30_000 })
        release = releaseFn
    } catch (err) {
        const message = err instanceof Error && err.message || String(err)
        console.error('[worker] could not acquire single-instance lock at ' + lockPath + ': ' + message)
        process.exit(1)
        return
    }
    console.log('[worker] acquired lock at ' + lockPath)
    console.log('[worker] DB at ' + dbPath)
    const { db, sqlite } = openDb()
    runMigrations(db)
    // Self-heal scan_requests left in 'running' by a previous process that did not exit cleanly.
    // Safe to run unconditionally: the single-instance lockfile guarantees no other worker is alive
    // right now, so any 'running' row is by definition orphaned.
    const orphanedRequests = resetOrphanedRunningRequests(db, Date.now())
    if (orphanedRequests > 0) {
        console.log('[worker] reset ' + orphanedRequests + ' orphaned scan_request' + (orphanedRequests === 1 ? '' : 's') + ' from previous crash')
    }
    // One-shot lifecycle backfill: seed first_detected_at / last_seen_at for rows written under
    // the pre-lifecycle snapshot model from their originating scan's finished_at. Idempotent —
    // the COALESCE clause skips any row that already has lifecycle timestamps set.
    const backfilled = backfillFindingsLifecycle(db)
    if (backfilled > 0) {
        console.log('[worker] backfilled lifecycle timestamps on ' + backfilled + ' finding row' + (backfilled === 1 ? '' : 's'))
    }
    const config = loadConfigFile(process.cwd())
    if (config) {
        seedFromConfig(db, config, Date.now())
        console.log('[worker] applied config file from ' + process.cwd())
    }
    const rootsBefore = listRoots(db).length
    discoverDockerRoots(db, Date.now())
    const rootsAfter = listRoots(db).length
    if (rootsAfter > rootsBefore) {
        console.log('[worker] auto-registered ' + (rootsAfter - rootsBefore) + ' root' + (rootsAfter - rootsBefore === 1 ? '' : 's') + ' from /roots')
    }
    const runtime = createWorkerRuntime()
    const scheduler = startScheduler({ db, sqlite, runtime })
    const poller = startScanRequestPoller({ db, sqlite, runtime })
    const muteExpiry = startMuteExpirySweep({ db, runtime })
    let watcher: WatcherHandle | null = null
    const watcherEnabled = getConfigValue<boolean>(db, CONFIG_KEYS.watcherEnabled) || false
    if (watcherEnabled) {
        // Per-root opt-in: the watcher only runs against the roots the operator
        // has explicitly opted in via Settings → Advanced. An empty selection means "watch nothing"
        // and is honored as such — we do NOT silently fall back to "watch every root".
        const watcherRoots = getConfigValue<string[]>(db, CONFIG_KEYS.watcherRoots) || []
        if (watcherRoots.length > 0) {
            watcher = startLockfileWatcher({ db, rootPaths: watcherRoots })
        } else {
            console.log('[worker] watcher enabled but no roots opted in; watcher inactive')
        }
    }
    console.log('[worker] scheduler + scan-request poller + mute-expiry running' + (watcher ? ' + lockfile watcher' : ''))
    // Register shutdown handlers BEFORE the initial sweep starts. sweepActiveProjects() runs synchronous
    // discovery before its first await; a SIGTERM during that window would otherwise hit a process with no
    // handlers and fall through to default-terminate, defeating the graceful-shutdown contract.
    const shutdown = makeShutdown({
        scheduler,
        poller,
        muteExpiry,
        watcher,
        sqlite,
        release,
        runtime
    })
    process.on('SIGTERM', function onSigterm() {
        shutdown('SIGTERM')
    })
    process.on('SIGINT', function onSigint() {
        shutdown('SIGINT')
    })
    // On boot, only run an initial sweep if enough time has elapsed since the last scan
    // (i.e. we're overdue per the configured schedule). Otherwise wait for the next cron tick.
    // First-boot (no prior scans) always runs.
    const schedule = getConfigValue<{ intervalHours: IntervalHours }>(db, CONFIG_KEYS.schedule) || DEFAULT_SCHEDULE
    const intervalMs = schedule.intervalHours * 60 * 60 * 1000
    const lastFinishedAt = getLastScanFinishedAt(db)
    const now = Date.now()
    const elapsedMs = lastFinishedAt === null ? null : now - lastFinishedAt
    const overdue = elapsedMs === null || elapsedMs >= intervalMs
    if (overdue) {
        const reason = lastFinishedAt === null ? 'no prior scans' : 'last scan ' + formatAgo(elapsedMs as number) + ' ago, interval is ' + schedule.intervalHours + 'h'
        console.log('[worker] initial active sweep starting (' + reason + ')')
        const initialSweep = sweepActiveProjects({ db, sqlite, runtime }).catch(function onInitialSweepError(err: unknown) {
            const message = err instanceof Error && err.message || String(err)
            console.error('[worker] initial sweep failed: ' + message)
        })
        runtime.track(initialSweep)
    } else {
        const nextDueIn = intervalMs - (elapsedMs as number)
        console.log('[worker] initial active sweep skipped (last scan ' + formatAgo(elapsedMs as number) + ' ago, interval is ' + schedule.intervalHours + 'h, next due in ' + formatAgo(nextDueIn) + ')')
    }
}

function formatAgo(ms: number): string {
    if (ms < 60_000) return Math.round(ms / 1000) + 's'
    if (ms < 3_600_000) return Math.round(ms / 60_000) + 'm'
    if (ms < 86_400_000) return (ms / 3_600_000).toFixed(1) + 'h'
    return (ms / 86_400_000).toFixed(1) + 'd'
}

function ensureLockFileExists(lockPath: string): void {
    const parent = dirname(lockPath)
    if (!existsSync(parent)) {
        mkdirSync(parent, { recursive: true })
    }
    if (!existsSync(lockPath)) {
        writeFileSync(lockPath, '')
    }
}

type ShutdownDeps = {
    scheduler: { stop(): void }
    poller: { stop(): void }
    muteExpiry: MuteExpiryHandle
    watcher: WatcherHandle | null
    sqlite: { close(): void }
    release: () => Promise<void>
    runtime: WorkerRuntime
}

function makeShutdown(deps: ShutdownDeps): (signal: string) => void {
    let shuttingDown = false
    return function shutdown(signal: string): void {
        if (shuttingDown) return
        shuttingDown = true
        console.log('[worker] received ' + signal + ', shutting down (grace ' + GRACE_PERIOD_MS + 'ms)...')
        // 1. Stop accepting new timer ticks so no more sweeps/polls schedule.
        deps.scheduler.stop()
        deps.poller.stop()
        deps.muteExpiry.stop()
        if (deps.watcher) {
            deps.watcher.stop().catch(function onWatcherStopError(err: unknown) {
                const message = err instanceof Error && err.message || String(err)
                console.error('[worker] watcher stop failed: ' + message)
            })
        }
        // 2. Signal in-flight scanner subprocesses to bail out early via AbortSignal.
        deps.runtime.abortController.abort()
        // 3. Hard-deadline timer that force-exits if the graceful path stalls (e.g. release() hangs).
        const forcedExit = setTimeout(function onForceExit() {
            console.error('[worker] forced exit: graceful shutdown did not complete in time')
            process.exit(1)
        }, GRACE_PERIOD_MS + 5_000)
        forcedExit.unref()
        // 4. Await in-flight work (bounded by grace), then release the lock and close SQLite.
        waitForInFlight(deps.runtime, GRACE_PERIOD_MS)
            .then(function onInFlightDrained() {
                return deps.release().catch(function onReleaseError(err: unknown) {
                    const message = err instanceof Error && err.message || String(err)
                    console.error('[worker] release failed: ' + message)
                })
            })
            .finally(function onAfterRelease() {
                try {
                    deps.sqlite.close()
                } catch (err) {
                    const message = err instanceof Error && err.message || String(err)
                    console.error('[worker] DB close failed: ' + message)
                }
                process.exit(0)
            })
    }
}
