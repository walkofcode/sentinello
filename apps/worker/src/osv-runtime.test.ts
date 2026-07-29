import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    OSV_NORMALIZER_VERSION,
    getConfigValue,
    openOsvDb,
    osvMetaKeyFor,
    runOsvMigrations,
    setConfigValue,
    setOsvMeta,
    upsertOsvAdvisories,
    type OsvDrizzleDb
} from '@sentinello/db'
import { OSV_META_KEYS } from '@sentinello/db'
import { sourceEnabledKey, sourceStatusKey } from '@sentinello/core'
import type { SqliteDb } from '@sentinello/db'
import { closeWorkerTestDb, openWorkerTestDb, type WorkerTestDb } from './worker-test-db.fixture'
import { createWorkerRuntime, type WorkerRuntime } from './runtime'

// The OSV runtime is the piece that decides whether an operator's estate is auditable against OSV at all,
// and every one of its decisions fails quietly:
//
//   - the cache is opened LAZILY. A worker with the source off must never create osv.db or touch the
//     network — that is the difference between an opt-in source and a 100 MB surprise on first boot.
//   - isSeeded() gates on the seed flag AND the per-ecosystem normalizer stamp. Skipping the second
//     check would let a cache mid-rebuild answer scans with rows that lack the new fields, which reads
//     as "no vulnerabilities" rather than as an error.
//   - selectScanners is evaluated per batch. If it were captured once at boot, toggling a source in
//     Settings would do nothing until the worker restarted.
//
// ./osv-sync is stubbed — it is the module that downloads ~100 MB of advisories — and node-cron, because
// a real daily schedule never fires inside a test run. The cache itself is a real migrated osv.db under a
// temp dir, reached through SENTINELLO_OSV_DB_PATH, so the meta reads and status mirroring are real.

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
        seedOsv: vi.fn(async function seedOsv(_db: unknown, _ecosystem: string, _signal?: AbortSignal) {
            return { status: 'ok', upserted: 0, recordCount: 0, message: null }
        }),
        incrementalSyncOsv: vi.fn(async function incrementalSyncOsv(_db: unknown, _ecosystem: string, _signal?: AbortSignal) {
            return { status: 'ok', upserted: 0, recordCount: 0, message: null }
        }),
        checkOsvFreeSpace: vi.fn(async function checkOsvFreeSpace() {
            return { freeBytes: 42_000_000, sufficient: true }
        })
    }
})

vi.mock('./osv-sync', function mockOsvSync() {
    return {
        seedOsv: sync.seedOsv,
        incrementalSyncOsv: sync.incrementalSyncOsv,
        checkOsvFreeSpace: sync.checkOsvFreeSpace,
        osvFeedDisabled: function osvFeedDisabled() { return sync.feedDisabled }
    }
})

const {
    createOsvController,
    enabledOsvEcosystems,
    extraSourceCells,
    npmAuditSourceEnabled,
    osvSourceEnabled,
    runSync,
    selectScanners,
    startOsvRuntime
} = await import('./osv-runtime')

let handle: WorkerTestDb
let runtime: WorkerRuntime
let osvPath: string
let priorEnv: string | undefined

function enable(ecosystem: string, on = true): void {
    setConfigValue(handle.db, sourceEnabledKey('osv' as never, ecosystem as never), on)
}

function fakeScanner(name: string) {
    return { name, supports: function supports() { return true }, scan: async function scan() { return null } } as never
}

function logLines(): string[] {
    return vi.mocked(console.log).mock.calls.map(function first(c) { return String(c[0]) })
}

function errorLines(): string[] {
    return vi.mocked(console.error).mock.calls.map(function first(c) { return String(c[0]) })
}

// Opens the same cache file the runtime under test will open, so a test can pre-stamp its meta rows.
function openCache(): { db: OsvDrizzleDb; sqlite: SqliteDb } {
    const opened = openOsvDb(osvPath)
    runOsvMigrations(opened.db)
    return { db: opened.db, sqlite: opened.sqlite }
}

beforeEach(async function setup() {
    cron.reset()
    sync.feedDisabled = false
    sync.seedOsv.mockClear()
    sync.incrementalSyncOsv.mockClear()
    handle = await openWorkerTestDb('worker-osv-runtime')
    runtime = createWorkerRuntime()
    osvPath = join(handle.dir, 'osv.db')
    priorEnv = process.env.SENTINELLO_OSV_DB_PATH
    process.env.SENTINELLO_OSV_DB_PATH = osvPath
    vi.spyOn(console, 'log').mockImplementation(function silence() {})
    vi.spyOn(console, 'error').mockImplementation(function silence() {})
})

afterEach(async function teardown() {
    if (priorEnv === undefined) delete process.env.SENTINELLO_OSV_DB_PATH
    else process.env.SENTINELLO_OSV_DB_PATH = priorEnv
    vi.restoreAllMocks()
    await closeWorkerTestDb(handle)
})

describe('reading the source matrix', function () {
    it('reports no enabled OSV ecosystems out of the box', function () {
        expect(enabledOsvEcosystems(handle.db)).toEqual([])
        expect(osvSourceEnabled(handle.db)).toBe(false)
    })

    // The source is a family of per-ecosystem cells, so enabling the first language is what starts it.
    it('treats any single enabled cell as the source being on', function () {
        enable('PyPI')
        expect(osvSourceEnabled(handle.db)).toBe(true)
        expect(enabledOsvEcosystems(handle.db)).toEqual(['PyPI'])
    })

    it('lists enabled cells in registry order rather than enablement order', function () {
        enable('crates.io')
        enable('npm')
        expect(enabledOsvEcosystems(handle.db)).toEqual(['npm', 'crates.io'])
    })

    it('drops a cell that was turned back off', function () {
        enable('npm')
        enable('npm', false)
        expect(osvSourceEnabled(handle.db)).toBe(false)
    })

    it('has npm-audit on by default and off when its cell is disabled', function () {
        expect(npmAuditSourceEnabled(handle.db)).toBe(true)
        setConfigValue(handle.db, sourceEnabledKey('npm-audit' as never, 'npm' as never), false)
        expect(npmAuditSourceEnabled(handle.db)).toBe(false)
    })
})

describe('selectScanners', function () {
    const npmAudit = fakeScanner('npm-audit')

    it('offers npm-audit alone when no extra source is on', function () {
        expect(selectScanners(handle.db, npmAudit, [])).toEqual([npmAudit])
    })

    // Order IS the dedup priority: the authoritative source goes first, and later scanners are
    // suppressed for advisories it already reported.
    it('appends enabled extras after npm-audit, in the order given', function () {
        enable('npm')
        const osv = fakeScanner('osv')
        const gem = fakeScanner('gemnasium')
        const result = selectScanners(handle.db, npmAudit, [
            { scanner: osv, isEnabled: function on() { return true } },
            { scanner: gem, isEnabled: function on() { return true } }
        ])
        expect(result).toEqual([npmAudit, osv, gem])
    })

    // Both gates matter: a runtime that has not produced a scanner yet, and a cell the operator turned off.
    it('skips an extra whose runtime produced no scanner', function () {
        expect(selectScanners(handle.db, npmAudit, [
            { scanner: null, isEnabled: function on() { return true } }
        ])).toEqual([npmAudit])
    })

    it('skips an extra whose source is disabled even though its runtime is alive', function () {
        expect(selectScanners(handle.db, npmAudit, [
            { scanner: fakeScanner('osv'), isEnabled: function off() { return false } }
        ])).toEqual([npmAudit])
    })

    it('drops npm-audit when its own cell is disabled', function () {
        setConfigValue(handle.db, sourceEnabledKey('npm-audit' as never, 'npm' as never), false)
        const osv = fakeScanner('osv')
        expect(selectScanners(handle.db, npmAudit, [
            { scanner: osv, isEnabled: function on() { return true } }
        ])).toEqual([osv])
    })

    it('can produce an empty batch when every source is off', function () {
        setConfigValue(handle.db, sourceEnabledKey('npm-audit' as never, 'npm' as never), false)
        expect(selectScanners(handle.db, npmAudit, [])).toEqual([])
    })
})

describe('extraSourceCells', function () {
    it('offers OSV before gemnasium', function () {
        const cells = extraSourceCells({
            osvController: { getScanner: function get() { return fakeScanner('osv') } } as never,
            gemnasiumController: { getScanner: function get() { return fakeScanner('gemnasium') } } as never
        })
        expect(cells.map(function name(c) { return (c.scanner as { name: string } | null)?.name })).toEqual([
            'osv',
            'gemnasium'
        ])
    })

    it('yields null scanners when no controllers were passed', function () {
        const cells = extraSourceCells({})
        expect(cells.map(function s(c) { return c.scanner })).toEqual([null, null])
    })

    it('still offers both cells so the predicates stay in the batch', function () {
        expect(extraSourceCells({ osvController: null, gemnasiumController: null })).toHaveLength(2)
    })
})

describe('createOsvController — lazy lifecycle', function () {
    // The whole point of an opt-in source: a worker that never enables it must never create osv.db.
    it('opens nothing while the source is off', function () {
        const controller = createOsvController(handle.db, runtime)
        expect(controller.getScanner()).toBeNull()
        expect(existsSync(osvPath)).toBe(false)
    })

    it('starts the runtime immediately when the source is already on', function () {
        enable('npm')
        const controller = createOsvController(handle.db, runtime)
        expect(controller.getScanner()).not.toBeNull()
        expect(existsSync(osvPath)).toBe(true)
    })

    // The 'reload-sources' signal path: a toggle in Settings must take effect without a restart.
    it('starts the runtime on reload after the source is enabled', function () {
        const controller = createOsvController(handle.db, runtime)
        expect(controller.getScanner()).toBeNull()
        enable('npm')
        controller.reload()
        expect(controller.getScanner()).not.toBeNull()
    })

    it('stops the runtime on reload after the source is disabled', function () {
        enable('npm')
        const controller = createOsvController(handle.db, runtime)
        enable('npm', false)
        controller.reload()
        expect(controller.getScanner()).toBeNull()
        expect(logLines()).toContain('[osv] source disabled; runtime stopped')
    })

    it('is idempotent — reloading with no change leaves the same scanner in place', function () {
        enable('npm')
        const controller = createOsvController(handle.db, runtime)
        const first = controller.getScanner()
        controller.reload()
        expect(controller.getScanner()).toBe(first)
    })

    it('stops the cron task when the source is disabled', function () {
        enable('npm')
        const controller = createOsvController(handle.db, runtime)
        enable('npm', false)
        controller.reload()
        expect(cron.tasks[0]?.stopped).toBe(true)
    })

    it('stops cleanly on stop() and reports no scanner afterwards', function () {
        enable('npm')
        const controller = createOsvController(handle.db, runtime)
        controller.stop()
        expect(controller.getScanner()).toBeNull()
        expect(cron.tasks[0]?.stopped).toBe(true)
    })

    it('tolerates stop() when the runtime was never started', function () {
        const controller = createOsvController(handle.db, runtime)
        expect(function stopTwice() {
            controller.stop()
            controller.stop()
        }).not.toThrow()
    })

    // A cache that cannot be opened (unwritable volume, corrupt file) must not take the worker down —
    // the rest of the estate is still scannable by npm-audit.
    it('logs and stays disabled when the runtime fails to start', function () {
        enable('npm')
        // A path that IS a directory. openOsvDb mkdir -p's the parent, so a merely-absent path
        // would succeed; SQLite cannot open a directory as a database file, which is the closest
        // stand-in for the real causes (unwritable volume, corrupt file).
        process.env.SENTINELLO_OSV_DB_PATH = handle.dir
        const controller = createOsvController(handle.db, runtime)
        expect(controller.getScanner()).toBeNull()
        expect(errorLines().some(function m(l) { return l.startsWith('[osv] runtime failed to start: ') })).toBe(true)
    })
})

describe('createOsvController — refresh', function () {
    it('runs a sync when the runtime is already up', async function () {
        enable('npm')
        const controller = createOsvController(handle.db, runtime)
        await Promise.allSettled(Array.from(runtime.inFlight))
        sync.seedOsv.mockClear()
        await controller.refresh()
        expect(sync.seedOsv).toHaveBeenCalledTimes(1)
    })

    // "Refresh now" on a source that is enabled but not yet running should start it — starting triggers
    // its own initial sync, so kicking a second one would download everything twice.
    it('reconciles to config instead of syncing when the runtime is down', async function () {
        enable('npm')
        const controller = createOsvController(handle.db, runtime)
        controller.stop()
        sync.seedOsv.mockClear()
        await controller.refresh()
        expect(controller.getScanner()).not.toBeNull()
    })

    it('does nothing when the source is off', async function () {
        const controller = createOsvController(handle.db, runtime)
        await controller.refresh()
        expect(controller.getScanner()).toBeNull()
        expect(sync.seedOsv).not.toHaveBeenCalled()
    })
})

describe('startOsvRuntime', function () {
    beforeEach(function enableNpm() {
        enable('npm')
    })

    it('schedules the daily sync off-hour and under a named task', function () {
        startOsvRuntime(handle.db, runtime)
        expect(cron.tasks[0]?.expr).toBe('17 3 * * *')
        expect(cron.tasks[0]?.options).toEqual({ name: 'sentinello-osv-sync' })
    })

    it('runs an initial sync and tracks it for shutdown', async function () {
        startOsvRuntime(handle.db, runtime)
        expect(runtime.inFlight.size).toBe(1)
        await Promise.allSettled(Array.from(runtime.inFlight))
        expect(sync.seedOsv).toHaveBeenCalledTimes(1)
    })

    // SENTINELLO_OSV_FEED_URL=off is the escape hatch for an air-gapped install; it must leave the
    // scanner present but unseeded rather than failing the boot.
    it('skips the initial sync when the feed is disabled', function () {
        sync.feedDisabled = true
        const rt = startOsvRuntime(handle.db, runtime)
        expect(sync.seedOsv).not.toHaveBeenCalled()
        expect(rt.scanner).not.toBeNull()
        expect(logLines().some(function m(l) { return l.includes('feed disabled') })).toBe(true)
    })

    // Without this the Settings panel shows nothing at all the moment a source is enabled, which reads
    // as "broken" rather than "not seeded yet".
    it('mirrors a status snapshot before the first sync completes', function () {
        startOsvRuntime(handle.db, runtime)
        expect(getConfigValue(handle.db, sourceStatusKey('osv' as never, 'npm' as never))).toMatchObject({
            seedComplete: false,
            recordCount: 0,
            refreshedAt: null,
            lastError: null,
            freeBytes: null
        })
    })

    it('mirrors an initial snapshot for every enabled cell', function () {
        enable('PyPI')
        startOsvRuntime(handle.db, runtime)
        expect(getConfigValue(handle.db, sourceStatusKey('osv' as never, 'PyPI' as never))).not.toBeNull()
    })

    it('runs a sync on the scheduled tick and tracks it', async function () {
        startOsvRuntime(handle.db, runtime)
        await Promise.allSettled(Array.from(runtime.inFlight))
        sync.seedOsv.mockClear()
        await cron.tasks[0]?.fn()
        expect(sync.seedOsv).toHaveBeenCalledTimes(1)
    })

    it('catches a failing scheduled sync rather than rejecting inside the cron callback', async function () {
        startOsvRuntime(handle.db, runtime)
        await Promise.allSettled(Array.from(runtime.inFlight))
        sync.seedOsv.mockRejectedValueOnce(new Error('feed down'))
        await cron.tasks[0]?.fn()
        await Promise.allSettled(Array.from(runtime.inFlight))
        expect(errorLines().some(function m(l) { return l.includes('scheduled sync failed: feed down') })).toBe(true)
    })

    it('catches a failing initial sync', async function () {
        sync.seedOsv.mockRejectedValueOnce(new Error('no disk'))
        startOsvRuntime(handle.db, runtime)
        await Promise.allSettled(Array.from(runtime.inFlight))
        expect(errorLines().some(function m(l) { return l.includes('initial sync failed: no disk') })).toBe(true)
    })

    // Not every rejection is an Error. An abort, a thrown string from a fetch polyfill, or a
    // rejected non-Error from a transitive dependency all reach the same handler, and the log line
    // has to name the cause rather than reading "[osv] scheduled sync failed: undefined".
    it.each([
        ['a string', 'socket hang up', 'socket hang up'],
        ['a number', 500, '500'],
        ['null', null, 'null']
    ] as Array<[string, unknown, string]>)('reports %s rejection from the scheduled sync', async function (_label, thrown, expected) {
        startOsvRuntime(handle.db, runtime)
        await Promise.allSettled(Array.from(runtime.inFlight))
        sync.seedOsv.mockRejectedValueOnce(thrown)
        await cron.tasks[0]?.fn()
        await Promise.allSettled(Array.from(runtime.inFlight))
        expect(errorLines().some(function m(l) { return l === '[osv] scheduled sync failed: ' + expected })).toBe(true)
    })

    it('reports a non-Error rejection from the initial sync', async function () {
        sync.seedOsv.mockRejectedValueOnce('socket hang up')
        startOsvRuntime(handle.db, runtime)
        await Promise.allSettled(Array.from(runtime.inFlight))
        expect(errorLines()).toContain('[osv] initial sync failed: socket hang up')
    })

    it('exposes runSyncNow for the refresh path', async function () {
        const rt = startOsvRuntime(handle.db, runtime)
        await Promise.allSettled(Array.from(runtime.inFlight))
        sync.seedOsv.mockClear()
        await rt.runSyncNow()
        expect(sync.seedOsv).toHaveBeenCalledTimes(1)
    })
})

describe('runSync — seed or catch up', function () {
    let cache: { db: OsvDrizzleDb; sqlite: SqliteDb }

    beforeEach(function openTheCache() {
        cache = openCache()
    })

    afterEach(function closeTheCache() {
        cache.sqlite.close()
    })

    function markSeeded(ecosystem: string, normalizerVersion: number = OSV_NORMALIZER_VERSION): void {
        setOsvMeta(cache.db, osvMetaKeyFor(OSV_META_KEYS.seedComplete, ecosystem), true)
        setOsvMeta(cache.db, osvMetaKeyFor(OSV_META_KEYS.normalizerVersion, ecosystem), normalizerVersion)
    }

    it('does nothing when no ecosystem is enabled', async function () {
        await runSync(handle.db, cache.db, runtime)
        expect(sync.seedOsv).not.toHaveBeenCalled()
        expect(sync.incrementalSyncOsv).not.toHaveBeenCalled()
    })

    it('seeds an ecosystem that has never been downloaded', async function () {
        enable('npm')
        await runSync(handle.db, cache.db, runtime)
        expect(sync.seedOsv).toHaveBeenCalledWith(cache.db, 'npm', runtime.abortController.signal)
        expect(sync.incrementalSyncOsv).not.toHaveBeenCalled()
    })

    it('takes the cheap incremental path once an ecosystem is seeded and current', async function () {
        enable('npm')
        markSeeded('npm')
        await runSync(handle.db, cache.db, runtime)
        expect(sync.incrementalSyncOsv).toHaveBeenCalledTimes(1)
        expect(sync.seedOsv).not.toHaveBeenCalled()
    })

    // A normalizer bump means the stored rows lack fields the matcher now reads. Re-seeding is the only
    // safe response — an incremental pass would leave old-shape rows in place indefinitely.
    it('forces a full re-seed when the normalizer version moved', async function () {
        enable('npm')
        markSeeded('npm', OSV_NORMALIZER_VERSION - 1)
        await runSync(handle.db, cache.db, runtime)
        expect(sync.seedOsv).toHaveBeenCalledTimes(1)
        expect(logLines().some(function m(l) { return l.includes('normalizer changed — rebuilding cache') })).toBe(true)
    })

    it('describes a first run as seeding rather than rebuilding', async function () {
        enable('npm')
        await runSync(handle.db, cache.db, runtime)
        expect(logLines().some(function m(l) { return l.includes('seeding cache (first run)') })).toBe(true)
    })

    // Each OSV ecosystem is its own download, so one being mid-rebuild must not drag a current sibling
    // onto the expensive path.
    it('decides the path per ecosystem rather than for the source as a whole', async function () {
        enable('npm')
        enable('PyPI')
        markSeeded('npm')
        await runSync(handle.db, cache.db, runtime)
        expect(sync.incrementalSyncOsv).toHaveBeenCalledTimes(1)
        expect(sync.seedOsv).toHaveBeenCalledTimes(1)
        expect(sync.seedOsv.mock.calls[0]?.[1]).toBe('PyPI')
    })

    it('stops before the first ecosystem when already aborted', async function () {
        enable('npm')
        runtime.abortController.abort()
        await runSync(handle.db, cache.db, runtime)
        expect(sync.seedOsv).not.toHaveBeenCalled()
    })

    it('abandons the remaining ecosystems once aborted mid-run', async function () {
        enable('npm')
        enable('PyPI')
        sync.seedOsv.mockImplementationOnce(async function abortAfterFirst() {
            runtime.abortController.abort()
            return { status: 'ok', upserted: 0, recordCount: 0, message: null }
        })
        await runSync(handle.db, cache.db, runtime)
        expect(sync.seedOsv).toHaveBeenCalledTimes(1)
    })

    it('mirrors each cell status with the free-space reading after syncing it', async function () {
        enable('npm')
        setOsvMeta(cache.db, osvMetaKeyFor(OSV_META_KEYS.recordCount, 'npm'), 1234)
        setOsvMeta(cache.db, osvMetaKeyFor(OSV_META_KEYS.seedComplete, 'npm'), true)
        await runSync(handle.db, cache.db, runtime)
        expect(getConfigValue(handle.db, sourceStatusKey('osv' as never, 'npm' as never))).toMatchObject({
            seedComplete: true,
            recordCount: 1234,
            freeBytes: 42_000_000
        })
    })

    // The mirror lives in a finally block precisely so a failed sync still surfaces its error in the
    // portal instead of leaving the panel showing the last successful state.
    it('mirrors the status even when the sync throws', async function () {
        enable('npm')
        sync.seedOsv.mockImplementationOnce(async function fail() {
            setOsvMeta(cache.db, osvMetaKeyFor(OSV_META_KEYS.lastError, 'npm'), 'seed exploded')
            throw new Error('seed exploded')
        })
        await expect(runSync(handle.db, cache.db, runtime)).rejects.toThrow('seed exploded')
        expect(getConfigValue(handle.db, sourceStatusKey('osv' as never, 'npm' as never))).toMatchObject({
            lastError: 'seed exploded'
        })
    })

    it('reports a never-refreshed cell as null rather than zero', async function () {
        enable('npm')
        await runSync(handle.db, cache.db, runtime)
        expect(getConfigValue(handle.db, sourceStatusKey('osv' as never, 'npm' as never))).toMatchObject({
            refreshedAt: null
        })
    })
})

// The scanner the runtime hands to each batch. Its three closures are where the operator's live
// configuration actually meets a scan, and each one fails silently in a different direction: a cell that
// should be off still matching, a cache mid-rebuild answering with old-shape rows, or a lookup asking the
// cache for an ecosystem name it does not store. None of this is observable from the runtime's own state —
// it only shows up when a scan runs.
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

    function scanWith(scanner: { scan: (p: string, ctx: never) => Promise<{ reasonCode: string }> }, packages: { ecosystem: string; name: string; version: string }[]) {
        return scanner.scan('/tmp/project', { timeoutMs: 1000, resolvedGraph: graph(packages) } as never)
    }

    let cache: { db: OsvDrizzleDb; sqlite: SqliteDb }

    beforeEach(function openTheCache() {
        enable('npm')
        cache = openCache()
    })

    afterEach(function closeTheCache() {
        cache.sqlite.close()
    })

    function markSeeded(ecosystem: string, normalizerVersion: number = OSV_NORMALIZER_VERSION): void {
        setOsvMeta(cache.db, osvMetaKeyFor(OSV_META_KEYS.seedComplete, ecosystem), true)
        setOsvMeta(cache.db, osvMetaKeyFor(OSV_META_KEYS.normalizerVersion, ecosystem), normalizerVersion)
    }

    it('reports the estate unauditable while the cache is unseeded', async function () {
        const rt = startOsvRuntime(handle.db, runtime)
        const result = await scanWith(rt.scanner as never, [{ ecosystem: 'npm', name: 'lodash', version: '4.17.11' }])
        expect(result.reasonCode).toBe('osv_db_not_seeded')
    })

    it('scans once the ecosystem is seeded at the current normalizer version', async function () {
        markSeeded('npm')
        const rt = startOsvRuntime(handle.db, runtime)
        const result = await scanWith(rt.scanner as never, [{ ecosystem: 'npm', name: 'lodash', version: '4.17.11' }])
        expect(result.reasonCode).toBe('ok')
    })

    // The rule the whole isSeeded closure exists for: a seeded cache whose rows predate a normalizer bump
    // lacks fields the matcher now reads, so it must read as "not downloaded" rather than "no findings".
    it('treats a cache seeded under an older normalizer as not downloaded', async function () {
        markSeeded('npm', OSV_NORMALIZER_VERSION - 1)
        const rt = startOsvRuntime(handle.db, runtime)
        const result = await scanWith(rt.scanner as never, [{ ecosystem: 'npm', name: 'lodash', version: '4.17.11' }])
        expect(result.reasonCode).toBe('osv_db_not_seeded')
    })

    // isEnabled is read per scan, so a cell disabled after it was seeded still has rows in osv.db and
    // still passes isSeeded — this gate is the only thing stopping the scanner matching it anyway.
    it('ignores an ecosystem whose cell was disabled after it was seeded', async function () {
        markSeeded('npm')
        const rt = startOsvRuntime(handle.db, runtime)
        enable('npm', false)
        const result = await scanWith(rt.scanner as never, [{ ecosystem: 'npm', name: 'lodash', version: '4.17.11' }])
        // No enabled ecosystem is left in the graph, so there is nothing to declare unauditable.
        expect(result.reasonCode).toBe('ok')
        expect((result as unknown as { findings: unknown[] }).findings).toEqual([])
    })

    it('fails open when the project has no resolvable lockfile', async function () {
        markSeeded('npm')
        const rt = startOsvRuntime(handle.db, runtime)
        const result = await (rt.scanner as never as { scan: (p: string, c: never) => Promise<{ reasonCode: string }> })
            .scan('/tmp/project', { timeoutMs: 1000, resolvedGraph: null } as never)
        expect(result.reasonCode).toBe('no_lockfile')
    })

    // The cache's `ecosystem` column holds the canonical OSV feed id, which is resolved through the
    // registry rather than assumed equal to the internal id.
    it('matches an advisory through the cache lookup', async function () {
        markSeeded('npm')
        upsertOsvAdvisories(cache.db, [{
            advisoryId: 'GHSA-aaaa',
            ecosystem: 'npm',
            packageName: 'lodash',
            aliases: ['CVE-2024-1'],
            ranges: [{ type: 'SEMVER', introduced: '0', fixed: '4.17.21', lastAffected: null }],
            versions: [],
            severity: 'high',
            summary: 'Prototype pollution',
            url: 'https://example.test/GHSA-aaaa',
            malicious: false,
            withdrawn: null
        } as never])

        const rt = startOsvRuntime(handle.db, runtime)
        const result = await scanWith(rt.scanner as never, [{ ecosystem: 'npm', name: 'lodash', version: '4.17.11' }])

        expect((result as unknown as { findings: { advisoryId: string }[] }).findings.map(function id(f) {
            return f.advisoryId
        })).toEqual(['GHSA-aaaa'])
    })

    it('reports no findings for a package the cache does not know', async function () {
        markSeeded('npm')
        const rt = startOsvRuntime(handle.db, runtime)
        const result = await scanWith(rt.scanner as never, [{ ecosystem: 'npm', name: 'left-pad', version: '1.0.0' }])
        expect((result as unknown as { findings: unknown[] }).findings).toEqual([])
    })
})
