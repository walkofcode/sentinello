import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SqliteDb } from '@sentinello/db'

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
        release: vi.fn(async function release() {}),
        // The only two collaborators that cannot be driven from a test process for a reason other
        // than "it owns a timer": both are hardcoded to the absolute path /roots, which a test cannot
        // create. Their own behaviour is covered in config-loader.test.ts; what is stubbed here is
        // only the count they report back, which is what worker.ts branches on.
        discoverDockerRoots: vi.fn(),
        pruneDockerRoots: vi.fn()
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
// Partial: loadConfigFile, seedFromConfig, CONFIG_KEYS and DEFAULT_SCHEDULE all stay real, so the
// config-file arm below runs the production parse and seed against the real database.
vi.mock('./config-loader', async function mockConfigLoader(importOriginal) {
    const actual = await importOriginal<typeof import('./config-loader')>()
    return {
        ...actual,
        discoverDockerRoots: collaborators.discoverDockerRoots,
        pruneDockerRoots: collaborators.pruneDockerRoots
    }
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

// Opens the database main() will open, migrates it, hands it to `seed`, and closes. The point of
// almost every boot-log arm below is that it only fires when the database ALREADY holds a particular
// shape of row, which no test can arrange after the fact — main() reads it once, on the way up.
async function seedDb(seed: (db: SqliteDb) => void): Promise<void> {
    const { openDb, runMigrations } = await import('@sentinello/db')
    mkdirSync(join(dir, 'data'), { recursive: true })
    const opened = openDb({ dbPath: join(dir, 'data', 'sentinello.sqlite') })
    runMigrations(opened.db)
    seed(opened.sqlite)
    opened.sqlite.close()
}

// A root, a project and one finished scan — the minimum every legacy-row seed needs, because
// findings.scan_id and projects.root_id are real foreign keys.
function seedProjectAndScan(sqlite: SqliteDb, scanFinishedAt: number): void {
    sqlite.prepare('INSERT INTO roots (id, path, label, created_at) VALUES (?, ?, ?, ?)').run('root-1', '/repo', null, 0)
    sqlite
        .prepare(
            'INSERT INTO projects (id, root_id, rel_path, name, package_manager, muted, tags_json, ecosystems_json, created_at, updated_at)' +
                " VALUES (?, ?, ?, ?, 'npm', 0, '[]', '[]', ?, ?)"
        )
        .run('project-1', 'root-1', 'app', 'app', 0, 0)
    sqlite
        .prepare(
            'INSERT INTO scans (id, project_id, started_at, finished_at, scanner, source, ecosystem, status, duration_ms, raw_json)' +
                " VALUES (?, ?, ?, ?, 'npm-audit', NULL, 'npm', 'ok', 1, '{}')"
        )
        .run('scan-1', 'project-1', scanFinishedAt - 1000, scanFinishedAt)
}

// A finding written under the pre-lifecycle snapshot model: no first_detected_at / last_seen_at, and
// no persisted `source`. It is what both boot backfills exist to repair.
function seedLegacyFinding(sqlite: SqliteDb, id: string): void {
    sqlite
        .prepare(
            'INSERT INTO findings (id, scan_id, project_id, scanner, source, ecosystem, advisory_id, package_name,' +
                ' installed_version, vulnerable_range, severity, fix_available, fix_version, dep_path_json, is_prod, is_dev,' +
                ' first_detected_at, last_seen_at)' +
                " VALUES (?, 'scan-1', 'project-1', 'npm-audit', NULL, 'npm', ?, 'lodash', '4.17.11', '<4.17.21', 'high', 1, '4.17.21', '[]', 1, 0, NULL, NULL)"
        )
        .run(id, 'GHSA-' + id)
}

beforeEach(async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-worker-boot-'))
    vi.stubEnv('SENTINELLO_DB_PATH', join(dir, 'data', 'sentinello.sqlite'))
    collaborators.discoverDockerRoots.mockImplementation(function noRoots() {})
    collaborators.pruneDockerRoots.mockReturnValue({ removed: 0 })
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

    it('reports the running uid, since the whole message is about ownership', function () {
        vi.spyOn(process, 'getuid').mockReturnValue(4242)
        expect(dataDirNotWritableMessage('/app/data', 'EACCES')).toContain('uid 4242')
    })

    // process.getuid does not exist on Windows. The message is Docker-specific advice, but it must
    // still render rather than throwing "process.getuid is not a function" on top of the real error.
    it('falls back to -1 where process.getuid does not exist', function () {
        const original = process.getuid
        // Typed optional (process.getuid?: () => number), so deleting it needs no suppression.
        delete process.getuid
        try {
            expect(dataDirNotWritableMessage('/app/data', 'EACCES')).toContain('uid -1')
        } finally {
            process.getuid = original
        }
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

    // Every failure message in the shutdown path is built with `err instanceof Error && err.message
    // || String(err)`. A rejection that is not an Error takes the other arm, and getting it wrong
    // logs "[object Object]" at exactly the moment the log is the only diagnostic left.
    it.each([
        ['a watcher that rejects with a string', { watcher: { stop: vi.fn(async function stop() { throw 'chokidar stuck' }) } }, 'watcher stop failed: chokidar stuck'],
        ['a release that rejects with a string', { release: vi.fn(async function release() { throw 'release failed' }) }, 'release failed: release failed'],
        ['a close that throws a string', { sqlite: { close: vi.fn(function close() { throw 'db busy' }) } }, 'DB close failed: db busy']
    ])('reports %s', async function (_label, overrides, expected) {
        makeShutdown(deps(overrides as Record<string, unknown>))('SIGTERM')
        await vi.waitFor(function settled() {
            expect(errorLines().join('\n')).toContain(expected as string)
        })
    })

    // The hard deadline. It exists for the case the graceful path stalls outright — a release() that
    // never settles would otherwise leave the process alive holding the lock, and pm2 would restart
    // into a worker that cannot take it. unref'd so it never keeps an otherwise-idle process up.
    it('force-exits when the graceful path never completes', async function () {
        vi.useFakeTimers()
        const d = deps({ release: vi.fn(function release() { return new Promise(function never() {}) }) })
        makeShutdown(d)('SIGTERM')

        await vi.advanceTimersByTimeAsync(GRACE_PERIOD_MS + 5_000)

        expect(errorLines().join('\n')).toContain('forced exit: graceful shutdown did not complete in time')
        expect(exitSpy).toHaveBeenCalledWith(1)
    })

    // Asserted at t=0 rather than after advancing past the deadline, and deliberately so: the timer
    // is never cleared, because the graceful path ends in a real process.exit(0) and the timer is
    // unref'd. Only a test that stubs process.exit keeps the process alive long enough to see it
    // fire. So the property worth asserting is that the graceful exit happens immediately — the
    // deadline is a backstop for a stalled path, not a step the normal path waits out.
    it('exits gracefully without waiting out the force-exit deadline', async function () {
        vi.useFakeTimers()
        makeShutdown(deps())('SIGTERM')

        // Drains the microtask queue without moving the clock: with nothing in flight the whole
        // graceful path is promises, so it completes at t=0.
        await vi.advanceTimersByTimeAsync(0)

        expect(exitSpy).toHaveBeenCalledWith(0)
        expect(errorLines().join('\n')).not.toContain('forced exit')
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

    it('reports a non-Error lock rejection rather than [object Object]', async function () {
        collaborators.lock.mockRejectedValue('ELOCKED')
        await main()
        expect(errorLines().join('\n')).toContain('could not acquire single-instance lock')
        expect(errorLines().join('\n')).toContain('ELOCKED')
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

describe('main — self-healing state left by a previous process', function () {
    // The lockfile guarantees no other worker is alive, so any row still marked 'running' belongs to
    // a process that died mid-scan. Left alone it stays 'running' forever: the portal shows a scan in
    // flight that nothing is working on, and the poller will not claim it.
    it('resets a scan_request orphaned in running and says how many', async function () {
        await seedDb(function seed(sqlite) {
            seedProjectAndScan(sqlite, Date.now())
            sqlite
                .prepare("INSERT INTO scan_requests (id, project_id, requested_at, picked_up_at, status) VALUES (?, 'project-1', ?, ?, 'running')")
                .run('req-1', 0, 0)
        })

        await main()

        expect(logLines().join('\n')).toContain('reset 1 orphaned scan_request from previous crash')
    })

    // Plural, singular and zero are three separate arms of the same log line, and the zero arm is the
    // one that has to stay silent — a clean boot should not report work it did not do.
    it('pluralises the orphan count', async function () {
        await seedDb(function seed(sqlite) {
            seedProjectAndScan(sqlite, Date.now())
            for (const id of ['req-1', 'req-2', 'req-3']) {
                sqlite
                    .prepare("INSERT INTO scan_requests (id, project_id, requested_at, picked_up_at, status) VALUES (?, 'project-1', ?, ?, 'running')")
                    .run(id, 0, 0)
            }
        })

        await main()

        expect(logLines().join('\n')).toContain('reset 3 orphaned scan_requests from previous crash')
    })

    it('says nothing about orphans on a clean boot', async function () {
        await main()
        expect(logLines().join('\n')).not.toContain('orphaned scan_request')
    })

    // Pre-lifecycle rows have no first_detected_at, so the UI would show every finding's age as
    // unknown until its next scan. The backfill seeds them from the originating scan's finished_at.
    it('backfills lifecycle timestamps on legacy finding rows', async function () {
        const finishedAt = Date.UTC(2026, 0, 1)
        await seedDb(function seed(sqlite) {
            seedProjectAndScan(sqlite, finishedAt)
            seedLegacyFinding(sqlite, 'f1')
        })

        await main()

        expect(logLines().join('\n')).toContain('backfilled lifecycle timestamps on 1 finding row')
    })

    it('pluralises the lifecycle backfill count', async function () {
        await seedDb(function seed(sqlite) {
            seedProjectAndScan(sqlite, Date.UTC(2026, 0, 1))
            seedLegacyFinding(sqlite, 'f1')
            seedLegacyFinding(sqlite, 'f2')
        })

        await main()

        expect(logLines().join('\n')).toContain('backfilled lifecycle timestamps on 2 finding rows')
    })

    // The polyglot backfill copies scanner -> source so the finding identity tuple is keyed on the
    // persisted source rather than the plugin name. Both the findings row and the scans row seeded
    // above have source NULL, so this reports two.
    it('runs the polyglot source/identity backfill and says how many rows moved', async function () {
        await seedDb(function seed(sqlite) {
            seedProjectAndScan(sqlite, Date.UTC(2026, 0, 1))
            seedLegacyFinding(sqlite, 'f1')
        })

        await main()

        expect(logLines().join('\n')).toContain('polyglot backfill updated 2 rows (source/identity)')
    })

    // Both backfills are idempotent — they run on every boot, not once — so a second boot over the
    // same database has to report nothing rather than re-counting the same rows.
    it('stays silent on a second boot over the same database', async function () {
        await seedDb(function seed(sqlite) {
            seedProjectAndScan(sqlite, Date.UTC(2026, 0, 1))
            seedLegacyFinding(sqlite, 'f1')
        })

        await main()
        vi.mocked(console.log).mockClear()
        await main()

        const second = logLines().join('\n')
        expect(second).not.toContain('backfilled lifecycle timestamps')
        expect(second).not.toContain('polyglot backfill updated')
    })
})

describe('main — the config file', function () {
    // Read from process.cwd(), so the whole arm hinges on where the worker was launched.
    it('applies a config file found in the working directory', async function () {
        writeFileSync(
            join(dir, 'sentinello.config.json'),
            JSON.stringify({ roots: [{ path: '/srv/code', label: 'code' }], parallelism: 3 }),
            'utf8'
        )
        vi.spyOn(process, 'cwd').mockReturnValue(dir)

        await main()

        expect(logLines().join('\n')).toContain('applied config file from ' + dir)
        const { openDb, listRoots } = await import('@sentinello/db')
        const opened = openDb({ dbPath: join(dir, 'data', 'sentinello.sqlite') })
        expect(listRoots(opened.db).map(function path(r) { return r.path })).toEqual(['/srv/code'])
        opened.sqlite.close()
    })

    it('says nothing when there is no config file', async function () {
        vi.spyOn(process, 'cwd').mockReturnValue(dir)
        await main()
        expect(logLines().join('\n')).not.toContain('applied config file')
    })
})

describe('main — the /roots mount', function () {
    // Discovery runs BEFORE the prune, so a root mounted since the last boot is registered rather
    // than immediately pruned as stale. The count is derived from listRoots before/after rather than
    // returned, which is why it needs a double that actually writes.
    it('reports roots auto-registered from /roots', async function () {
        const { upsertRoot } = await import('@sentinello/db')
        collaborators.discoverDockerRoots.mockImplementation(function discover(db: never) {
            upsertRoot(db, { id: 'root-a', path: '/roots/a', label: 'a', createdAt: 0 })
        })

        await main()

        expect(logLines().join('\n')).toContain('auto-registered 1 root from /roots')
    })

    it('pluralises the auto-registered count', async function () {
        const { upsertRoot } = await import('@sentinello/db')
        collaborators.discoverDockerRoots.mockImplementation(function discover(db: never) {
            upsertRoot(db, { id: 'root-a', path: '/roots/a', label: 'a', createdAt: 0 })
            upsertRoot(db, { id: 'root-b', path: '/roots/b', label: 'b', createdAt: 0 })
        })

        await main()

        expect(logLines().join('\n')).toContain('auto-registered 2 roots from /roots')
    })

    it('says nothing when /roots adds nothing', async function () {
        await main()
        expect(logLines().join('\n')).not.toContain('auto-registered')
    })

    // Pruning hard-deletes the root and everything under it, so the count is the one number an
    // operator has to be able to see in the log after a mount disappears.
    it('reports pruned stale roots, singular and plural', async function () {
        collaborators.pruneDockerRoots.mockReturnValue({ removed: 1 })
        await main()
        expect(logLines().join('\n')).toContain('pruned 1 stale root from /roots')

        vi.mocked(console.log).mockClear()
        collaborators.pruneDockerRoots.mockReturnValue({ removed: 4 })
        await main()
        expect(logLines().join('\n')).toContain('pruned 4 stale roots from /roots')
    })

    it('says nothing when nothing was pruned', async function () {
        await main()
        expect(logLines().join('\n')).not.toContain('pruned')
    })
})

describe('main — the initial sweep decision', function () {
    async function withSchedule(intervalHours: number, lastScanFinishedAt: number | null): Promise<void> {
        const { setConfigValue, openDb, runMigrations } = await import('@sentinello/db')
        mkdirSync(join(dir, 'data'), { recursive: true })
        const opened = openDb({ dbPath: join(dir, 'data', 'sentinello.sqlite') })
        runMigrations(opened.db)
        setConfigValue(opened.db, 'schedule', { intervalHours, startHour: 0 })
        if (lastScanFinishedAt !== null) seedProjectAndScan(opened.sqlite, lastScanFinishedAt)
        opened.sqlite.close()
    }

    it('sweeps on first boot, when there are no prior scans', async function () {
        await main()
        expect(collaborators.sweepActiveProjects).toHaveBeenCalled()
        expect(logLines().join('\n')).toContain('initial active sweep starting (no prior scans)')
    })

    // Overdue with a prior scan takes a different arm of the same log than first boot: it has an
    // elapsed time to report, and reporting it is how an operator tells "we were behind" from
    // "this is a fresh install".
    it('sweeps when the last scan is older than the interval, and says how much older', async function () {
        await withSchedule(6, Date.now() - 7 * 3_600_000)
        await main()
        expect(collaborators.sweepActiveProjects).toHaveBeenCalled()
        expect(logLines().join('\n')).toMatch(/initial active sweep starting \(last scan 7\.0h ago, interval is 6h\)/)
    })

    // The whole reason the check exists: restarting the container must not re-scan every project.
    // Without it, a crash loop or a routine redeploy turns into a full sweep per restart.
    it('skips the sweep when the last scan is inside the interval', async function () {
        await withSchedule(24, Date.now() - 2 * 3_600_000)
        await main()
        expect(collaborators.sweepActiveProjects).not.toHaveBeenCalled()
        expect(logLines().join('\n')).toMatch(/initial active sweep skipped \(last scan 2\.0h ago, interval is 24h, next due in 22\.0h\)/)
    })

    // Exactly at the boundary counts as overdue (>=), not as inside the window.
    it('treats a scan exactly one interval old as overdue', async function () {
        await withSchedule(1, Date.now() - 3_600_000)
        await main()
        expect(collaborators.sweepActiveProjects).toHaveBeenCalled()
    })

    it('reports a failed initial sweep without taking the worker down', async function () {
        collaborators.sweepActiveProjects.mockRejectedValue(new Error('scanner exploded'))
        await main()
        await vi.waitFor(function settled() {
            expect(errorLines().join('\n')).toContain('initial sweep failed: scanner exploded')
        })
    })

    it('reports a non-Error initial sweep rejection', async function () {
        collaborators.sweepActiveProjects.mockRejectedValue('scanner exploded')
        await main()
        await vi.waitFor(function settled() {
            expect(errorLines().join('\n')).toContain('initial sweep failed: scanner exploded')
        })
    })
})

describe('main — the signal handlers', function () {
    // The handlers are registered inside main() and were never invoked by a test: every shutdown
    // assertion above drives makeShutdown directly. This checks the wiring between the two.
    it.each([['SIGTERM'], ['SIGINT']])('runs the shutdown sequence on %s', async function (signal) {
        await main()
        process.emit(signal as 'SIGTERM')

        expect(logLines().join('\n')).toContain('received ' + signal + ', shutting down')
        expect(collaborators.scheduler.stop).toHaveBeenCalled()
        await vi.waitFor(function drained() {
            expect(exitSpy).toHaveBeenCalledWith(0)
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

    // Distinct from the empty-array case above: here the key was never written at all, which is the
    // state after enabling the watcher in Settings without picking any root. The `|| []` fallback has
    // to land on watch-nothing too, not on undefined.length.
    it('treats a missing watcherRoots key the same as an empty one', async function () {
        const { openDb, runMigrations, setConfigValue } = await import('@sentinello/db')
        const { CONFIG_KEYS: KEYS } = await import('./config-loader')
        mkdirSync(join(dir, 'data'), { recursive: true })
        const opened = openDb({ dbPath: join(dir, 'data', 'sentinello.sqlite') })
        runMigrations(opened.db)
        setConfigValue(opened.db, KEYS.watcherEnabled, true)
        opened.sqlite.close()

        await main()

        expect(collaborators.startLockfileWatcher).not.toHaveBeenCalled()
        expect(logLines().join('\n')).toContain('watcher enabled but no roots opted in')
    })
})
