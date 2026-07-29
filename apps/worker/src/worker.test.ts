import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The worker's boot sequence and its graceful-shutdown machinery — the last uncovered file in the
// worker, and the reason apps/worker/src/index.ts is now a three-line bin.
//
// Every collaborator is stubbed, and each owns a resource a test process cannot: cron timers, an
// inotify watcher, and the advisory-feed runtimes. proper-lockfile is stubbed for the same reason —
// the real one writes a lock beside the database and the failure path is what needs testing, not the
// happy one. Everything below the stubs is real: a genuine migrated SQLite file on a temp path,
// reached through SENTINELLO_DB_PATH, so every backfill and config read is the production query.
//
// makeShutdown needed no stubbing at all. It already takes a complete ShutdownDeps struct — the split
// out of index.ts is the only thing that was standing between it and a test.

const collaborators = vi.hoisted(function makeDoubles() {
    function handle() {
        return { stop: vi.fn(), refresh: vi.fn() }
    }
    return {
        scheduler: handle(),
        poller: handle(),
        muteExpiry: handle(),
        osvController: { stop: vi.fn(), getScanner: vi.fn(), reload: vi.fn() },
        gemnasiumController: { stop: vi.fn(), getScanner: vi.fn(), reload: vi.fn() },
        watcher: { stop: vi.fn(async function stop() {}) },
        startScheduler: vi.fn(),
        startScanRequestPoller: vi.fn(),
        startMuteExpirySweep: vi.fn(),
        startLockfileWatcher: vi.fn(),
        createOsvController: vi.fn(),
        createGemnasiumController: vi.fn(),
        sweepActiveProjects: vi.fn(async function sweep() {}),
        lock: vi.fn(),
        release: vi.fn(async function release() {})
    }
})

vi.mock('./scheduler', function mockScheduler() {
    return {
        startScheduler: collaborators.startScheduler,
        sweepActiveProjects: collaborators.sweepActiveProjects
    }
})
vi.mock('./scan-request-poller', function mockPoller() {
    return { startScanRequestPoller: collaborators.startScanRequestPoller }
})
vi.mock('./mute-expiry', function mockMuteExpiry() {
    return { startMuteExpirySweep: collaborators.startMuteExpirySweep }
})
vi.mock('./watcher', function mockWatcher() {
    return { startLockfileWatcher: collaborators.startLockfileWatcher }
})
vi.mock('./osv-runtime', function mockOsvRuntime() {
    return { createOsvController: collaborators.createOsvController }
})
vi.mock('./gemnasium-runtime', function mockGemnasiumRuntime() {
    return { createGemnasiumController: collaborators.createGemnasiumController }
})
vi.mock('proper-lockfile', function mockLockfile() {
    return { default: { lock: collaborators.lock } }
})

const {
    assertDataDirWritable,
    dataDirNotWritableMessage,
    ensureLockFileExists,
    formatAgo,
    main,
    makeShutdown
} = await import('./worker')

const GRACE_PERIOD_MS = 30_000

let dir: string
let exitSpy: ReturnType<typeof vi.spyOn>

function logLines(): string[] {
    return vi.mocked(console.log).mock.calls.map(function first(c) {
        return String(c[0])
    })
}

function errorLines(): string[] {
    return vi.mocked(console.error).mock.calls.map(function first(c) {
        return String(c[0])
    })
}

beforeEach(async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-worker-boot-'))
    vi.stubEnv('SENTINELLO_DB_PATH', join(dir, 'data', 'sentinello.sqlite'))
    vi.spyOn(console, 'log').mockImplementation(function silence() {})
    vi.spyOn(console, 'error').mockImplementation(function silence() {})
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(function noExit() {
        return undefined as never
    })
    collaborators.lock.mockResolvedValue(collaborators.release)
    collaborators.startScheduler.mockReturnValue(collaborators.scheduler)
    collaborators.startScanRequestPoller.mockReturnValue(collaborators.poller)
    collaborators.startMuteExpirySweep.mockReturnValue(collaborators.muteExpiry)
    collaborators.startLockfileWatcher.mockReturnValue(collaborators.watcher)
    collaborators.createOsvController.mockReturnValue(collaborators.osvController)
    collaborators.createGemnasiumController.mockReturnValue(collaborators.gemnasiumController)
})

afterEach(async function teardown() {
    vi.restoreAllMocks()
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    vi.useRealTimers()
    process.removeAllListeners('SIGTERM')
    process.removeAllListeners('SIGINT')
    await rm(dir, { recursive: true, force: true })
})

describe('formatAgo', function () {
    it.each([
        [0, '0s'],
        [45_000, '45s'],
        [59_999, '60s'],
        [60_000, '1m'],
        [90_000, '2m'],
        [3_599_999, '60m'],
        [3_600_000, '1.0h'],
        [5_400_000, '1.5h'],
        [86_399_999, '24.0h'],
        [86_400_000, '1.0d'],
        [7 * 86_400_000, '7.0d']
    ])('renders %dms as %s', function (ms, expected) {
        expect(formatAgo(ms as number)).toBe(expected)
    })
})

describe('ensureLockFileExists', function () {
    it('creates the parent directory and the lock file', function () {
        const lockPath = join(dir, 'nested', 'deeper', 'sentinello.worker.lock')
        ensureLockFileExists(lockPath)
        expect(existsSync(lockPath)).toBe(true)
    })

    // Truncating an existing lock would discard another process's ownership record.
    it('leaves an existing lock file untouched', function () {
        const lockPath = join(dir, 'sentinello.worker.lock')
        writeFileSync(lockPath, 'existing-content')
        ensureLockFileExists(lockPath)
        expect(existsSync(lockPath)).toBe(true)
    })

    it('is safe to call twice', function () {
        const lockPath = join(dir, 'a', 'sentinello.worker.lock')
        ensureLockFileExists(lockPath)
        expect(function again() {
            ensureLockFileExists(lockPath)
        }).not.toThrow()
    })
})

describe('assertDataDirWritable', function () {
    it('creates a missing data directory', function () {
        const dbPath = join(dir, 'fresh', 'sentinello.sqlite')
        assertDataDirWritable(dbPath)
        expect(existsSync(join(dir, 'fresh'))).toBe(true)
    })

    it('accepts a writable directory and leaves no probe file behind', async function () {
        const dbPath = join(dir, 'sentinello.sqlite')
        assertDataDirWritable(dbPath)
        const { readdir } = await import('node:fs/promises')
        expect(await readdir(dir)).toEqual([])
    })

    // The one case that actually lands here: an upgrade from a root-era image whose named volume is
    // still owned by root. Without this, the first write throws a bare EACCES that reads like a bug
    // rather than a permissions problem the operator can fix.
    it('throws an actionable error when the directory is not writable', function () {
        const readOnly = join(dir, 'readonly')
        mkdirSync(readOnly, { mode: 0o500 })
        expect(function probe() {
            assertDataDirWritable(join(readOnly, 'sentinello.sqlite'))
        }).toThrow(/not writable by uid/)
    })

    it('preserves the original error as the cause', function () {
        const readOnly = join(dir, 'readonly2')
        mkdirSync(readOnly, { mode: 0o500 })
        try {
            assertDataDirWritable(join(readOnly, 'sentinello.sqlite'))
            expect.unreachable('should have thrown')
        } catch (err) {
            expect((err as Error).cause).toBeInstanceOf(Error)
        }
    })
})

describe('dataDirNotWritableMessage', function () {
    it('names the directory, the uid and the chown fix', function () {
        const message = dataDirNotWritableMessage('/app/data', 'EACCES: permission denied')
        expect(message).toContain('/app/data')
        expect(message).toContain('10001:10001')
        expect(message).toContain('EACCES: permission denied')
    })
})

describe('makeShutdown', function () {
    function deps(overrides: Record<string, unknown> = {}) {
        return {
            scheduler: { stop: vi.fn() },
            poller: { stop: vi.fn() },
            osvController: { stop: vi.fn() },
            gemnasiumController: { stop: vi.fn() },
            muteExpiry: { stop: vi.fn() },
            watcher: null,
            sqlite: { close: vi.fn() },
            release: vi.fn(async function release() {}),
            runtime: { abortController: new AbortController(), inFlight: new Set(), track: vi.fn() },
            ...overrides
        } as unknown as Parameters<typeof makeShutdown>[0]
    }

    // Every timer source stops first, so no new sweep can start while the process is draining.
    it('stops every timer source', function () {
        const d = deps()
        makeShutdown(d)('SIGTERM')
        expect(d.scheduler.stop).toHaveBeenCalled()
        expect(d.poller.stop).toHaveBeenCalled()
        expect(d.muteExpiry.stop).toHaveBeenCalled()
        expect(d.osvController.stop).toHaveBeenCalled()
        expect(d.gemnasiumController.stop).toHaveBeenCalled()
    })

    // In-flight scanner subprocesses get told to bail out rather than being waited out in full.
    it('aborts in-flight work', function () {
        const d = deps()
        makeShutdown(d)('SIGTERM')
        expect(d.runtime.abortController.signal.aborted).toBe(true)
    })

    it('names the signal and the grace period in the log', function () {
        makeShutdown(deps())('SIGINT')
        expect(logLines().join('\n')).toContain('received SIGINT, shutting down (grace ' + GRACE_PERIOD_MS + 'ms)')
    })

    // A second signal during a slow drain must not restart the sequence — double-stopping the
    // scheduler and double-releasing the lock is exactly how a shutdown turns into a crash.
    it('ignores a repeat signal', function () {
        const d = deps()
        const shutdown = makeShutdown(d)
        shutdown('SIGTERM')
        shutdown('SIGTERM')
        shutdown('SIGINT')
        expect(d.scheduler.stop).toHaveBeenCalledTimes(1)
    })

    it('stops the watcher when one is running', function () {
        const watcher = { stop: vi.fn(async function stop() {}) }
        makeShutdown(deps({ watcher }))('SIGTERM')
        expect(watcher.stop).toHaveBeenCalled()
    })

    it('tolerates having no watcher', function () {
        expect(function shutdown() {
            makeShutdown(deps({ watcher: null }))('SIGTERM')
        }).not.toThrow()
    })

    it('reports a watcher that fails to stop without derailing the shutdown', async function () {
        const watcher = { stop: vi.fn(async function stop() { throw new Error('chokidar stuck') }) }
        const d = deps({ watcher })
        makeShutdown(d)('SIGTERM')
        await vi.waitFor(function drained() {
            expect(errorLines().join('\n')).toContain('watcher stop failed: chokidar stuck')
        })
    })

    it('releases the lock and closes the database, then exits zero', async function () {
        const d = deps()
        makeShutdown(d)('SIGTERM')
        await vi.waitFor(function drained() {
            expect(exitSpy).toHaveBeenCalledWith(0)
        })
        expect(d.release).toHaveBeenCalled()
        expect(d.sqlite.close).toHaveBeenCalled()
    })

    // The lock is released on a best-effort basis: failing to release it must still let the process
    // close the database and exit, or the next boot restart-loops until the lock ages out.
    it('still closes and exits when releasing the lock fails', async function () {
        const d = deps({ release: vi.fn(async function release() { throw new Error('release failed') }) })
        makeShutdown(d)('SIGTERM')
        await vi.waitFor(function drained() {
            expect(exitSpy).toHaveBeenCalledWith(0)
        })
        expect(d.sqlite.close).toHaveBeenCalled()
        expect(errorLines().join('\n')).toContain('release failed')
    })

    it('still exits zero when closing the database throws', async function () {
        const d = deps({ sqlite: { close: vi.fn(function close() { throw new Error('db busy') }) } })
        makeShutdown(d)('SIGTERM')
        await vi.waitFor(function drained() {
            expect(exitSpy).toHaveBeenCalledWith(0)
        })
        expect(errorLines().join('\n')).toContain('DB close failed: db busy')
    })
})

describe('main — boot sequence', function () {
    it('acquires the lock, opens the database and starts every component', async function () {
        await main()
        expect(collaborators.lock).toHaveBeenCalled()
        expect(collaborators.startScheduler).toHaveBeenCalled()
        expect(collaborators.startScanRequestPoller).toHaveBeenCalled()
        expect(collaborators.startMuteExpirySweep).toHaveBeenCalled()
        expect(logLines().join('\n')).toContain('scheduler + scan-request poller + mute-expiry running')
    })

    it('creates the data directory under the configured DB path', async function () {
        await main()
        expect(existsSync(join(dir, 'data'))).toBe(true)
    })

    // A second worker against the same database would double-scan and corrupt the lifecycle merge, so
    // failing to take the lock is fatal rather than a warning.
    it('exits when the single-instance lock is already held', async function () {
        collaborators.lock.mockRejectedValue(new Error('Lock file is already being held'))
        await main()
        expect(exitSpy).toHaveBeenCalledWith(1)
        expect(errorLines().join('\n')).toContain('could not acquire single-instance lock')
        expect(collaborators.startScheduler).not.toHaveBeenCalled()
    })

    it('registers SIGTERM and SIGINT handlers', async function () {
        const before = process.listenerCount('SIGTERM')
        await main()
        expect(process.listenerCount('SIGTERM')).toBe(before + 1)
        expect(process.listenerCount('SIGINT')).toBeGreaterThan(0)
    })

    // The handlers go on BEFORE the initial sweep, because sweepActiveProjects runs synchronous
    // discovery before its first await — a SIGTERM in that window would otherwise hit a process with
    // no handlers and default-terminate, defeating the graceful-shutdown contract entirely.
    it('registers the handlers before the initial sweep starts', async function () {
        let listenersWhenSwept = 0
        collaborators.sweepActiveProjects.mockImplementation(async function sweep() {
            listenersWhenSwept = process.listenerCount('SIGTERM')
        })
        await main()
        expect(listenersWhenSwept).toBeGreaterThan(0)
    })
})

describe('main — the initial sweep decision', function () {
    it('sweeps on first boot, when there are no prior scans', async function () {
        await main()
        expect(collaborators.sweepActiveProjects).toHaveBeenCalled()
        expect(logLines().join('\n')).toContain('initial active sweep starting (no prior scans)')
    })

    it('reports a failed initial sweep without taking the worker down', async function () {
        collaborators.sweepActiveProjects.mockRejectedValue(new Error('scanner exploded'))
        await main()
        await vi.waitFor(function settled() {
            expect(errorLines().join('\n')).toContain('initial sweep failed: scanner exploded')
        })
    })
})

describe('main — the lockfile watcher', function () {
    it('does not start the watcher by default', async function () {
        await main()
        expect(collaborators.startLockfileWatcher).not.toHaveBeenCalled()
        expect(logLines().join('\n')).not.toContain('lockfile watcher')
    })

    it('starts the watcher for the roots the operator opted in', async function () {
        const { openDb, runMigrations, setConfigValue } = await import('@sentinello/db')
        const { CONFIG_KEYS: KEYS } = await import('./config-loader')
        const dbPath = join(dir, 'data', 'sentinello.sqlite')
        mkdirSync(join(dir, 'data'), { recursive: true })
        const opened = openDb({ dbPath })
        runMigrations(opened.db)
        setConfigValue(opened.db, KEYS.watcherEnabled, true)
        setConfigValue(opened.db, KEYS.watcherRoots, ['/srv/code'])
        opened.sqlite.close()

        await main()

        expect(collaborators.startLockfileWatcher).toHaveBeenCalledWith(
            expect.objectContaining({ rootPaths: ['/srv/code'] })
        )
        expect(logLines().join('\n')).toContain('lockfile watcher')
    })

    // An empty selection means "watch nothing" and is honoured as such — falling back to "watch every
    // root" would put an inotify watch on trees the operator deliberately left out.
    it('honours an empty root selection as watch-nothing rather than watch-everything', async function () {
        const { openDb, runMigrations, setConfigValue } = await import('@sentinello/db')
        const { CONFIG_KEYS: KEYS } = await import('./config-loader')
        const dbPath = join(dir, 'data', 'sentinello.sqlite')
        mkdirSync(join(dir, 'data'), { recursive: true })
        const opened = openDb({ dbPath })
        runMigrations(opened.db)
        setConfigValue(opened.db, KEYS.watcherEnabled, true)
        setConfigValue(opened.db, KEYS.watcherRoots, [])
        opened.sqlite.close()

        await main()

        expect(collaborators.startLockfileWatcher).not.toHaveBeenCalled()
        expect(logLines().join('\n')).toContain('watcher enabled but no roots opted in')
    })
})
