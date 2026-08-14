import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    GEMNASIUM_META_KEYS,
    GEMNASIUM_NORMALIZER_VERSION,
    getConfigValue,
    openGemnasiumDb,
    runGemnasiumMigrations,
    setConfigValue,
    setGemnasiumMeta,
    upsertGemnasiumAdvisories,
    type GemnasiumDrizzleDb,
    type SqliteDb
} from '@sentinello/db'
import { sourceEnabledKey, sourceStatusKey } from '@sentinello/core'
import { closeWorkerTestDb, openWorkerTestDb, type WorkerTestDb } from './worker-test-db.fixture'
import { createWorkerRuntime, type WorkerRuntime } from './runtime'

// gemnasium is OSV's near-twin, and the differences are exactly what this suite is for. gemnasium-db has
// no per-advisory delta feed and no per-ecosystem download: the cache is ONE multi-ecosystem archive with
// a single seed flag, so there is one global status rather than one per enabled cell. Per-cell enablement
// therefore gates MATCHING only — the whole archive is fetched regardless, and each enabled cell reads its
// slice. Getting that backwards would either download nothing for a non-npm cell or mirror a per-cell
// status that does not exist.
//
// ./gemnasium-sync is stubbed (it downloads ~80 MB) and node-cron with it. The cache is a real migrated
// gemnasium.db under a temp dir, reached through SENTINELLO_GEMNASIUM_DB_PATH.

const cron = vi.hoisted(function makeCronDouble() {
    type Task = { expr: string; options: unknown; fn: () => unknown; stopped: boolean }
    const tasks: Task[] = []
    return {
        tasks,
        reset: function reset() { tasks.length = 0 },
        schedule: function schedule(expr: string, fn: () => unknown, options: unknown) {
            const task: Task = { expr, options, fn, stopped: false }
            tasks.push(task)
            return { stop: function stop() { task.stopped = true }, start: function start() {} }
        }
    }
})

vi.mock('node-cron', function mockNodeCron() {
    return { default: { schedule: cron.schedule } }
})

const sync = vi.hoisted(function makeSyncDouble() {
    return {
        feedDisabled: false,
        // The parameters are declared even though the double ignores them: without them the mock's call
        // tuple is empty and assertions about the third argument (the range-recovery deps) cannot type.
        syncGemnasium: vi.fn(async function syncGemnasium(
            _db: unknown,
            _abortSignal?: unknown,
            _resolveDeps?: { osvRanges?: (ecosystem: string, packageName: string, ids: string[]) => unknown }
        ) {
            return { status: 'ok', upserted: 0, recordCount: 0, message: null }
        }),
        checkGemnasiumFreeSpace: vi.fn(async function checkGemnasiumFreeSpace() {
            return { freeBytes: 99_000_000, sufficient: true }
        })
    }
})

vi.mock('./gemnasium-sync', function mockGemnasiumSync() {
    return {
        syncGemnasium: sync.syncGemnasium,
        checkGemnasiumFreeSpace: sync.checkGemnasiumFreeSpace,
        gemnasiumFeedDisabled: function gemnasiumFeedDisabled() { return sync.feedDisabled }
    }
})

const {
    createGemnasiumController,
    enabledGemnasiumEcosystems,
    gemnasiumSourceEnabled,
    runSync,
    startGemnasiumRuntime
} = await import('./gemnasium-runtime')

let handle: WorkerTestDb
let runtime: WorkerRuntime
let cachePath: string
let priorEnv: string | undefined

function enable(ecosystem: string, on = true): void {
    setConfigValue(handle.db, sourceEnabledKey('gemnasium' as never, ecosystem as never), on)
}

function enableOsv(ecosystem: string, on = true): void {
    setConfigValue(handle.db, sourceEnabledKey('osv' as never, ecosystem as never), on)
}

function status(): unknown {
    return getConfigValue(handle.db, sourceStatusKey('gemnasium' as never, 'npm' as never))
}

function logLines(): string[] {
    return vi.mocked(console.log).mock.calls.map(function first(c) { return String(c[0]) })
}

function errorLines(): string[] {
    return vi.mocked(console.error).mock.calls.map(function first(c) { return String(c[0]) })
}

function openCache(): { db: GemnasiumDrizzleDb; sqlite: SqliteDb } {
    const opened = openGemnasiumDb(cachePath)
    runGemnasiumMigrations(opened.db)
    return { db: opened.db, sqlite: opened.sqlite }
}

beforeEach(async function setup() {
    cron.reset()
    sync.feedDisabled = false
    sync.syncGemnasium.mockClear()
    handle = await openWorkerTestDb('worker-gemnasium-runtime')
    runtime = createWorkerRuntime()
    cachePath = join(handle.dir, 'gemnasium.db')
    priorEnv = process.env.SENTINELLO_GEMNASIUM_DB_PATH
    process.env.SENTINELLO_GEMNASIUM_DB_PATH = cachePath
    vi.spyOn(console, 'log').mockImplementation(function silence() {})
    vi.spyOn(console, 'error').mockImplementation(function silence() {})
})

afterEach(async function teardown() {
    if (priorEnv === undefined) delete process.env.SENTINELLO_GEMNASIUM_DB_PATH
    else process.env.SENTINELLO_GEMNASIUM_DB_PATH = priorEnv
    vi.restoreAllMocks()
    await closeWorkerTestDb(handle)
})

describe('reading the source matrix', function () {
    it('is off out of the box', function () {
        expect(gemnasiumSourceEnabled(handle.db)).toBe(false)
        expect(enabledGemnasiumEcosystems(handle.db)).toEqual([])
    })

    // This was previously npm-only, which silently ignored every non-npm cell an operator enabled.
    it('counts a non-npm cell as the source being on', function () {
        enable('PyPI')
        expect(gemnasiumSourceEnabled(handle.db)).toBe(true)
        expect(enabledGemnasiumEcosystems(handle.db)).toEqual(['PyPI'])
    })

    it('lists enabled cells in registry order', function () {
        enable('Go')
        enable('npm')
        expect(enabledGemnasiumEcosystems(handle.db)).toEqual(['npm', 'Go'])
    })

    it('goes off again when the last cell is disabled', function () {
        enable('npm')
        enable('npm', false)
        expect(gemnasiumSourceEnabled(handle.db)).toBe(false)
    })
})

describe('createGemnasiumController — lazy lifecycle', function () {
    it('opens nothing while the source is off', function () {
        const controller = createGemnasiumController(handle.db, runtime)
        expect(controller.getScanner()).toBeNull()
        expect(existsSync(cachePath)).toBe(false)
    })

    it('starts the runtime when the source is already on', function () {
        enable('npm')
        const controller = createGemnasiumController(handle.db, runtime)
        expect(controller.getScanner()).not.toBeNull()
        expect(existsSync(cachePath)).toBe(true)
    })

    // The archive is one download covering every ecosystem, so enabling PyPI alone still starts it.
    it('starts on a non-npm cell alone', function () {
        enable('PyPI')
        const controller = createGemnasiumController(handle.db, runtime)
        expect(controller.getScanner()).not.toBeNull()
    })

    it('starts on reload once the source is enabled', function () {
        const controller = createGemnasiumController(handle.db, runtime)
        enable('npm')
        controller.reload()
        expect(controller.getScanner()).not.toBeNull()
    })

    it('stops on reload once the source is disabled', function () {
        enable('npm')
        const controller = createGemnasiumController(handle.db, runtime)
        enable('npm', false)
        controller.reload()
        expect(controller.getScanner()).toBeNull()
        expect(logLines()).toContain('[gemnasium] source disabled; runtime stopped')
    })

    it('leaves the same scanner in place when reloading with no change', function () {
        enable('npm')
        const controller = createGemnasiumController(handle.db, runtime)
        const first = controller.getScanner()
        controller.reload()
        expect(controller.getScanner()).toBe(first)
    })

    it('stops the cron task on stop()', function () {
        enable('npm')
        const controller = createGemnasiumController(handle.db, runtime)
        controller.stop()
        expect(controller.getScanner()).toBeNull()
        expect(cron.tasks[0]?.stopped).toBe(true)
    })

    it('tolerates stop() when nothing was ever started', function () {
        const controller = createGemnasiumController(handle.db, runtime)
        expect(function stopTwice() {
            controller.stop()
            controller.stop()
        }).not.toThrow()
    })

    it('logs and stays disabled when the cache cannot be opened', function () {
        enable('npm')
        // A directory path: openGemnasiumDb creates a missing parent, so only an unopenable target fails.
        process.env.SENTINELLO_GEMNASIUM_DB_PATH = handle.dir
        const controller = createGemnasiumController(handle.db, runtime)
        expect(controller.getScanner()).toBeNull()
        expect(errorLines().some(function m(l) {
            return l.startsWith('[gemnasium] runtime failed to start: ')
        })).toBe(true)
    })
})

describe('createGemnasiumController — refresh', function () {
    it('runs a sync when the runtime is up', async function () {
        enable('npm')
        const controller = createGemnasiumController(handle.db, runtime)
        await Promise.allSettled(Array.from(runtime.inFlight))
        sync.syncGemnasium.mockClear()
        await controller.refresh()
        expect(sync.syncGemnasium).toHaveBeenCalledTimes(1)
    })

    it('reconciles to config instead of double-syncing when the runtime is down', async function () {
        enable('npm')
        const controller = createGemnasiumController(handle.db, runtime)
        controller.stop()
        await controller.refresh()
        expect(controller.getScanner()).not.toBeNull()
    })

    it('does nothing when the source is off', async function () {
        const controller = createGemnasiumController(handle.db, runtime)
        await controller.refresh()
        expect(sync.syncGemnasium).not.toHaveBeenCalled()
    })
})

describe('startGemnasiumRuntime', function () {
    beforeEach(function enableNpm() {
        enable('npm')
    })

    // Deliberately offset from the OSV sync (03:17) and the on-the-hour scan schedule, so the three
    // never contend for disk and network at once.
    it('schedules its daily sync clear of the other jobs', function () {
        startGemnasiumRuntime(handle.db, runtime)
        expect(cron.tasks[0]?.expr).toBe('42 3 * * *')
        expect(cron.tasks[0]?.options).toEqual({ name: 'sentinello-gemnasium-sync' })
    })

    it('runs an initial sync and tracks it for shutdown', async function () {
        startGemnasiumRuntime(handle.db, runtime)
        expect(runtime.inFlight.size).toBe(1)
        await Promise.allSettled(Array.from(runtime.inFlight))
        expect(sync.syncGemnasium).toHaveBeenCalledTimes(1)
    })

    it('skips the initial sync when the feed is disabled', function () {
        sync.feedDisabled = true
        const rt = startGemnasiumRuntime(handle.db, runtime)
        expect(sync.syncGemnasium).not.toHaveBeenCalled()
        expect(rt.scanner).not.toBeNull()
        expect(logLines().some(function m(l) { return l.includes('feed disabled') })).toBe(true)
    })

    it('mirrors a not-seeded-yet snapshot before the first sync', function () {
        startGemnasiumRuntime(handle.db, runtime)
        expect(status()).toMatchObject({
            seedComplete: false,
            recordCount: 0,
            refreshedAt: null,
            lastError: null,
            freeBytes: null
        })
    })

    // The single most important asymmetry with OSV: gemnasium's archive has ONE seed, so there is no
    // per-cell status to write. It is stored under the npm cell's key as the source's status slot, and
    // every enabled cell reads that one row. A per-cell mirror here would be writing rows that mean nothing.
    it('writes one status under the npm cell even when only a non-npm cell is enabled', function () {
        enable('npm', false)
        enable('PyPI')
        startGemnasiumRuntime(handle.db, runtime)
        expect(status()).not.toBeNull()
        expect(getConfigValue(handle.db, sourceStatusKey('gemnasium' as never, 'PyPI' as never))).toBeNull()
    })

    it('runs a sync on the scheduled tick', async function () {
        startGemnasiumRuntime(handle.db, runtime)
        await Promise.allSettled(Array.from(runtime.inFlight))
        sync.syncGemnasium.mockClear()
        await cron.tasks[0]?.fn()
        expect(sync.syncGemnasium).toHaveBeenCalledTimes(1)
    })

    it('catches a failing scheduled sync', async function () {
        startGemnasiumRuntime(handle.db, runtime)
        await Promise.allSettled(Array.from(runtime.inFlight))
        sync.syncGemnasium.mockRejectedValueOnce(new Error('archive down'))
        await cron.tasks[0]?.fn()
        await Promise.allSettled(Array.from(runtime.inFlight))
        expect(errorLines().some(function m(l) {
            return l.includes('scheduled sync failed: archive down')
        })).toBe(true)
    })

    it('catches a failing initial sync', async function () {
        sync.syncGemnasium.mockRejectedValueOnce(new Error('no disk'))
        startGemnasiumRuntime(handle.db, runtime)
        await Promise.allSettled(Array.from(runtime.inFlight))
        expect(errorLines().some(function m(l) { return l.includes('initial sync failed: no disk') })).toBe(true)
    })

    // The archive sync reaches the network through unzipper and undici, neither of which promises to
    // reject with an Error. The log line has to name the cause rather than reading "undefined".
    it('reports a non-Error rejection from the scheduled sync', async function () {
        startGemnasiumRuntime(handle.db, runtime)
        await Promise.allSettled(Array.from(runtime.inFlight))
        sync.syncGemnasium.mockRejectedValueOnce('socket hang up')
        await cron.tasks[0]?.fn()
        await Promise.allSettled(Array.from(runtime.inFlight))
        expect(errorLines()).toContain('[gemnasium] scheduled sync failed: socket hang up')
    })

    it('reports a non-Error rejection from the initial sync', async function () {
        sync.syncGemnasium.mockRejectedValueOnce(null)
        startGemnasiumRuntime(handle.db, runtime)
        await Promise.allSettled(Array.from(runtime.inFlight))
        expect(errorLines()).toContain('[gemnasium] initial sync failed: null')
    })

    it('exposes runSyncNow for the refresh path', async function () {
        const rt = startGemnasiumRuntime(handle.db, runtime)
        await Promise.allSettled(Array.from(runtime.inFlight))
        sync.syncGemnasium.mockClear()
        await rt.runSyncNow()
        expect(sync.syncGemnasium).toHaveBeenCalledTimes(1)
    })
})

describe('runSync', function () {
    let cache: { db: GemnasiumDrizzleDb; sqlite: SqliteDb }

    beforeEach(function openTheCache() {
        cache = openCache()
    })

    afterEach(function closeTheCache() {
        cache.sqlite.close()
    })

    // No delta feed exists, so the seed/incremental decision OSV makes has no counterpart here — the
    // sync module owns the whole choice and the runtime simply calls it.
    it('always delegates to the sync module, seeded or not', async function () {
        setGemnasiumMeta(cache.db, GEMNASIUM_META_KEYS.seedComplete, true)
        await runSync(handle.db, cache.db, runtime)
        expect(sync.syncGemnasium).toHaveBeenCalledWith(cache.db, runtime.abortController.signal, expect.any(Object))
    })

    // The OSV cache is the last tier of gemnasium's range recovery and it is strictly optional. With no
    // (osv, ecosystem) cell enabled the tier must not be wired up at all — no OSV lookup is handed to the
    // sync, so a record no sibling or prose could resolve is dropped rather than guessed at.
    it('passes no OSV lookup when the OSV source is disabled', async function () {
        await runSync(handle.db, cache.db, runtime)
        const deps = sync.syncGemnasium.mock.calls[0]?.[2]
        expect(deps?.osvRanges).toBeUndefined()
    })

    it('wires the OSV lookup in once any OSV cell is enabled', async function () {
        enableOsv('npm')
        await runSync(handle.db, cache.db, runtime)
        const deps = sync.syncGemnasium.mock.calls[0]?.[2]
        expect(typeof deps?.osvRanges).toBe('function')
    })

    // Per-cell, not per-source: an operator with OSV on for npm and off for PyPI must not have a PyPI
    // gemnasium record resolved out of the PyPI OSV cache.
    it('refuses the OSV tier for an ecosystem whose OSV cell is off', async function () {
        enableOsv('npm')
        await runSync(handle.db, cache.db, runtime)
        const deps = sync.syncGemnasium.mock.calls[0]?.[2]
        expect(deps?.osvRanges?.('PyPI', 'django', ['CVE-1'])).toBeNull()
    })

    it('mirrors the resulting status with the free-space reading', async function () {
        setGemnasiumMeta(cache.db, GEMNASIUM_META_KEYS.seedComplete, true)
        setGemnasiumMeta(cache.db, GEMNASIUM_META_KEYS.recordCount, 4321)
        await runSync(handle.db, cache.db, runtime)
        expect(status()).toMatchObject({ seedComplete: true, recordCount: 4321, freeBytes: 99_000_000 })
    })

    // The mirror is in a finally block so a failed sync surfaces its error rather than leaving the
    // Settings panel showing the last good state.
    it('mirrors the status even when the sync throws', async function () {
        setGemnasiumMeta(cache.db, GEMNASIUM_META_KEYS.lastError, 'archive exploded')
        sync.syncGemnasium.mockRejectedValueOnce(new Error('archive exploded'))
        await expect(runSync(handle.db, cache.db, runtime)).rejects.toThrow('archive exploded')
        expect(status()).toMatchObject({ lastError: 'archive exploded' })
    })

    it('reports a never-refreshed cache as null rather than zero', async function () {
        await runSync(handle.db, cache.db, runtime)
        expect(status()).toMatchObject({ refreshedAt: null, recordCount: 0 })
    })
})

// The scanner the runtime hands to each batch. Same three closures as OSV's, with one structural
// difference that matters: isSeeded() takes no ecosystem, because the archive is a single download with a
// single seed flag. Per-cell enablement therefore gates MATCHING only — the seed check is global and runs
// first, so a cache mid-rebuild reports the whole source unauditable rather than silently returning zero.
describe('the scanner the runtime produces', function () {
    function graph(packages: { ecosystem: string; name: string; version: string }[]) {
        const full = packages.map(function complete(p) {
            return { ...p, scope: 'prod' as const, depPaths: [p.name] }
        })
        return {
            packages: full,
            classify: function classify() { return 'prod' as const },
            byName: function byName(name: string) {
                return full.filter(function match(p) { return p.name === name })
            }
        }
    }

    function scanWith(
        scanner: { scan: (p: string, ctx: never) => Promise<{ reasonCode: string }> },
        packages: { ecosystem: string; name: string; version: string }[]
    ) {
        return scanner.scan('/tmp/project', { timeoutMs: 1000, resolvedGraph: graph(packages) } as never)
    }

    let cache: { db: GemnasiumDrizzleDb; sqlite: SqliteDb }

    beforeEach(function openTheCache() {
        enable('npm')
        cache = openCache()
    })

    afterEach(function closeTheCache() {
        cache.sqlite.close()
    })

    function markSeeded(normalizerVersion?: number): void {
        setGemnasiumMeta(cache.db, GEMNASIUM_META_KEYS.seedComplete, true)
        setGemnasiumMeta(
            cache.db,
            GEMNASIUM_META_KEYS.normalizerVersion,
            normalizerVersion ?? GEMNASIUM_NORMALIZER_VERSION
        )
    }

    it('reports the estate unauditable while the cache is unseeded', async function () {
        const rt = startGemnasiumRuntime(handle.db, runtime)
        const result = await scanWith(rt.scanner as never, [{ ecosystem: 'npm', name: 'lodash', version: '4.17.11' }])
        expect(result.reasonCode).toBe('gemnasium_db_not_seeded')
    })

    it('scans once the cache is seeded at the current normalizer version', async function () {
        markSeeded()
        const rt = startGemnasiumRuntime(handle.db, runtime)
        const result = await scanWith(rt.scanner as never, [{ ecosystem: 'npm', name: 'lodash', version: '4.17.11' }])
        expect(result.reasonCode).toBe('ok')
    })

    // A rebuild in progress leaves rows that lack the fields the matcher now reads. Reporting them as
    // "no findings" would be worse than reporting the source as not ready.
    it('treats a cache seeded under an older normalizer as not downloaded', async function () {
        markSeeded(GEMNASIUM_NORMALIZER_VERSION - 1)
        const rt = startGemnasiumRuntime(handle.db, runtime)
        const result = await scanWith(rt.scanner as never, [{ ecosystem: 'npm', name: 'lodash', version: '4.17.11' }])
        expect(result.reasonCode).toBe('gemnasium_db_not_seeded')
    })

    it('fails open when the project has no resolvable lockfile', async function () {
        markSeeded()
        const rt = startGemnasiumRuntime(handle.db, runtime)
        const result = await (rt.scanner as never as { scan: (p: string, c: never) => Promise<{ reasonCode: string }> })
            .scan('/tmp/project', { timeoutMs: 1000, resolvedGraph: null } as never)
        expect(result.reasonCode).toBe('no_lockfile')
    })

    it('matches an advisory through the cache lookup', async function () {
        markSeeded()
        upsertGemnasiumAdvisories(cache.db, [{
            advisoryId: 'CVE-2024-1',
            ecosystem: 'npm',
            packageName: 'lodash',
            aliases: ['GHSA-aaaa'],
            ranges: [{ introduced: '0', fixed: '4.17.21' }],
            versions: [],
            severity: 'high',
            summary: 'Prototype pollution',
            url: 'https://example.test/CVE-2024-1'
        } as never])

        const rt = startGemnasiumRuntime(handle.db, runtime)
        const result = await scanWith(rt.scanner as never, [{ ecosystem: 'npm', name: 'lodash', version: '4.17.11' }])

        expect((result as unknown as { findings: { advisoryId: string }[] }).findings.map(function id(f) {
            return f.advisoryId
        })).toEqual(['CVE-2024-1'])
    })

    // The single archive is seeded for every ecosystem, so without the per-cell gate a disabled cell would
    // still match. This is what makes (source, ecosystem) the real configuration unit at scan time.
    it('ignores an ecosystem whose cell is disabled even though the cache holds its rows', async function () {
        markSeeded()
        upsertGemnasiumAdvisories(cache.db, [{
            advisoryId: 'CVE-2024-1',
            ecosystem: 'npm',
            packageName: 'lodash',
            aliases: [],
            ranges: [{ introduced: '0', fixed: '4.17.21' }],
            versions: [],
            severity: 'high',
            summary: 'Prototype pollution',
            url: 'https://example.test/CVE-2024-1'
        } as never])

        // Started while npm was on, then the operator turned the cell off; isEnabled is read per scan.
        const rt = startGemnasiumRuntime(handle.db, runtime)
        enable('npm', false)
        const result = await scanWith(rt.scanner as never, [{ ecosystem: 'npm', name: 'lodash', version: '4.17.11' }])

        expect((result as unknown as { findings: unknown[] }).findings).toEqual([])
    })

    it('reports no findings for a package the cache does not know', async function () {
        markSeeded()
        const rt = startGemnasiumRuntime(handle.db, runtime)
        const result = await scanWith(rt.scanner as never, [{ ecosystem: 'npm', name: 'left-pad', version: '1.0.0' }])
        expect((result as unknown as { findings: unknown[] }).findings).toEqual([])
    })
})
