import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    osvNormalizerVersion,
    enqueueScanRequest,
    getConfigValue,
    openOsvDb,
    osvMetaKeyFor,
    runOsvMigrations,
    setConfigValue,
    setOsvMeta,
    upsertOsvAdvisories,
    type OsvDrizzleDb
} from '@sentinello/db'
import {
    GEMNASIUM_META_KEYS,
    GEMNASIUM_NORMALIZER_VERSION,
    OSV_META_KEYS,
    countOsvAdvisories,
    getDashboardSummary,
    getOsvMeta,
    insertScan,
    listCurrentFindingsForProject,
    listFindingsForProject,
    listProjects,
    listRecentScanRequests,
    listScansForProject,
    openGemnasiumDb,
    runGemnasiumMigrations,
    setGemnasiumMeta,
    upsertGemnasiumAdvisories,
    upsertProject,
    upsertRoot,
    type GemnasiumDrizzleDb
} from '@sentinello/db'
import { sourceEnabledKey, sourceStatusKey } from '@sentinello/core'
import { normalizeOsvRecord } from '@sentinello/feeds'
import type { SqliteDb } from '@sentinello/db'
import { closeWorkerTestDb, makeTree, openWorkerTestDb, type WorkerTestDb } from './worker-test-db.fixture'
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
    // The 4th parameter is the cache-discard announcement. Carried on the double even though the default
    // implementation ignores it, so a test can drive the mid-rebuild mirror.
    async function stubSync(_db: unknown, _ecosystem: string, _signal?: AbortSignal, _onCacheDiscarded?: () => void) {
        return { status: 'ok', upserted: 0, recordCount: 0, message: null }
    }
    return {
        feedDisabled: false,
        stubSync,
        // The real module, captured by the mock factory, for the end-to-end batches below: they drive the
        // real seed and incremental sync against a faked feed rather than this double.
        real: null as typeof import('./osv-sync') | null,
        seedOsv: vi.fn(stubSync),
        incrementalSyncOsv: vi.fn(stubSync)
    }
})

vi.mock('./osv-sync', async function mockOsvSync(importOriginal) {
    sync.real = await importOriginal<typeof import('./osv-sync')>()
    return {
        seedOsv: sync.seedOsv,
        incrementalSyncOsv: sync.incrementalSyncOsv,
        osvFeedDisabled: function osvFeedDisabled() { return sync.feedDisabled }
    }
})

// The OSV feed itself, for the end-to-end batches: the real osv-sync reads it through these three, the way
// osv-sync.test.ts fakes it. Everything else in @sentinello/feeds is real.
const feed = vi.hoisted(function makeFeedDouble() {
    return {
        fetchOsvChangedIds: vi.fn(),
        fetchOsvAdvisoryRows: vi.fn(),
        streamOsvSeed: vi.fn()
    }
})

vi.mock('@sentinello/feeds', async function mockFeeds(importOriginal) {
    return { ...(await importOriginal<typeof import('@sentinello/feeds')>()), ...feed }
})

// The npm registry the batch settles fixes against: answers nothing, so no test reaches the network.
vi.mock('@sentinello/fixes', async function mockFixes(importOriginal) {
    const actual = await importOriginal<typeof import('@sentinello/fixes')>()
    return {
        ...actual,
        createNpmRegistryClient: function createNpmRegistryClient() {
            return {
                lookup: async function lookup() { return new Map() },
                weeklyDownloads: async function weeklyDownloads() { return new Map() }
            }
        }
    }
})

const {
    createOsvController,
    enabledOsvEcosystems,
    extraSourceCells,
    npmAuditSourceEnabled,
    osvCacheNeeded,
    osvSourceEnabled,
    runSync,
    selectScanners,
    startOsvRuntime,
    syncedOsvEcosystems,
    withdrawalEvidenceFrom
} = await import('./osv-runtime')
const { createGemnasiumController } = await import('./gemnasium-runtime')
const { sweepActiveProjects } = await import('./scheduler')

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
    // mockReset, not mockClear: an end-to-end test swaps in the real implementation, and vi.restoreAllMocks
    // does not undo an implementation set on a vi.fn.
    sync.seedOsv.mockReset().mockImplementation(sync.stubSync)
    sync.incrementalSyncOsv.mockReset().mockImplementation(sync.stubSync)
    feed.fetchOsvChangedIds.mockReset()
    feed.fetchOsvAdvisoryRows.mockReset()
    feed.streamOsvSeed.mockReset()
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
        enable('npm')
        expect(osvSourceEnabled(handle.db)).toBe(true)
        expect(enabledOsvEcosystems(handle.db)).toEqual(['npm'])
    })

    // A preview ecosystem is never an enabled cell. It cannot start the source on its own, and it cannot
    // add itself to a list that a stable cell has already started — which is what keeps its 200 MB export
    // from being downloaded for an ecosystem nothing will be scanned against.
    // Since 3.8 every language is offered: a Rust cell alone turns the source on.
    it('lists every enabled cell, a Rust one alone included', function () {
        enable('crates.io')
        expect(osvSourceEnabled(handle.db)).toBe(true)
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
        expect(logLines()).toContain('[osv] no OSV or gemnasium cell enabled; runtime stopped')
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
    it('logs and stays disabled when the runtime fails to start', async function () {
        enable('npm')
        // A path that IS a directory. openOsvDb mkdir -p's the parent, so a merely-absent path
        // would succeed; SQLite cannot open a directory as a database file, which is the closest
        // stand-in for the real causes (unwritable volume, corrupt file).
        process.env.SENTINELLO_OSV_DB_PATH = handle.dir
        const controller = createOsvController(handle.db, runtime)
        expect(controller.getScanner()).toBeNull()
        expect(errorLines().some(function m(l) { return l.startsWith('[osv] runtime failed to start: ') })).toBe(true)
        // Nothing downloads the cache while the runtime is down: a baseline must not wait on it (SENTINEL-159).
        await Promise.resolve()
        expect(runtime.rebuilds.failed('osv/npm')).toBe(true)
        expect(runtime.rebuilds.active()).toBe(false)
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
            normalizerVersion: null,
            recordCount: 0,
            refreshedAt: null,
            // Already stamped: the initial sync starts synchronously, and saying so is the point — the
            // panel can now distinguish "downloading" from "nothing is happening about this".
            syncStartedAt: expect.any(Number),
            lastError: null
        })
    })

    // The transition check in runSync only fires for a transition it WATCHES. A cache seeded under a
    // previous build, or while the worker was down, leaves projects holding osv_db_not_seeded with
    // nothing left to clear it — which is exactly the state a real instance was found in.
    function seedStaleProject(): void {
        upsertRoot(handle.db, { id: 'root-x', path: '/repo', label: null, createdAt: 1 })
        upsertProject(handle.db, {
            id: 'proj-x', rootId: 'root-x', relPath: 'app', name: 'app', alias: null,
            packageManager: 'npm', nvmrcVersion: null, gitBranch: null, ecosystems: ['npm'], manifests: [],
            muted: false, tags: [], createdAt: 1, updatedAt: 1
        })
        insertScan(handle.db, {
            id: 'scan-x', projectId: 'proj-x', startedAt: 1, finishedAt: 2, scanner: 'osv', source: 'osv',
            ecosystem: 'npm', status: 'unauditable', reasonCode: 'osv_db_not_seeded', durationMs: 1,
            errorText: null, rawJson: ''
        })
    }

    it('re-scans at boot when the cache is matchable but projects still say it was not', function () {
        const cache = openCache()
        setOsvMeta(cache.db, osvMetaKeyFor(OSV_META_KEYS.seedComplete, 'npm'), true)
        setOsvMeta(cache.db, osvMetaKeyFor(OSV_META_KEYS.normalizerVersion, 'npm'), osvNormalizerVersion('npm'))
        cache.sqlite.close()
        seedStaleProject()
        startOsvRuntime(handle.db, runtime)
        const requests = listRecentScanRequests(handle.db)
        expect(requests).toHaveLength(1)
        expect(requests[0]).toMatchObject({ projectId: null, rootId: null })
    })

    it('queues no second boot re-scan while one is already waiting', function () {
        const cache = openCache()
        setOsvMeta(cache.db, osvMetaKeyFor(OSV_META_KEYS.seedComplete, 'npm'), true)
        setOsvMeta(cache.db, osvMetaKeyFor(OSV_META_KEYS.normalizerVersion, 'npm'), osvNormalizerVersion('npm'))
        cache.sqlite.close()
        seedStaleProject()
        enqueueScanRequest(handle.db, {}, Date.now())
        startOsvRuntime(handle.db, runtime)
        expect(listRecentScanRequests(handle.db)).toHaveLength(1)
        expect(logLines()).not.toContain('[osv] cache is matchable but projects still hold unauditable verdicts — enqueued a full re-scan')
    })

    it('does not re-scan at boot when the cache is still unusable', function () {
        seedStaleProject()
        startOsvRuntime(handle.db, runtime)
        // Nothing to reconcile: the verdict is still accurate. Recovery here is runSync's job, and its
        // own transition check is what enqueues once the seed lands — the boot check must not double it.
        expect(listRecentScanRequests(handle.db)).toHaveLength(0)
    })

    it('does not re-scan at boot when no project is holding a stale verdict', function () {
        const cache = openCache()
        setOsvMeta(cache.db, osvMetaKeyFor(OSV_META_KEYS.seedComplete, 'npm'), true)
        setOsvMeta(cache.db, osvMetaKeyFor(OSV_META_KEYS.normalizerVersion, 'npm'), osvNormalizerVersion('npm'))
        cache.sqlite.close()
        startOsvRuntime(handle.db, runtime)
        expect(listRecentScanRequests(handle.db)).toHaveLength(0)
    })

    it('mirrors an initial snapshot for every enabled cell', function () {
        enable('npm')
        startOsvRuntime(handle.db, runtime)
        expect(getConfigValue(handle.db, sourceStatusKey('osv' as never, 'npm' as never))).not.toBeNull()
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

    function markSeeded(ecosystem: string, normalizerVersion: number = osvNormalizerVersion(ecosystem)): void {
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
        expect(sync.seedOsv).toHaveBeenCalledWith(cache.db, 'npm', runtime.abortController.signal, expect.any(Function))
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
        markSeeded('npm', osvNormalizerVersion('npm') - 1)
        await runSync(handle.db, cache.db, runtime)
        expect(sync.seedOsv).toHaveBeenCalledTimes(1)
        expect(logLines().some(function m(l) { return l.includes('normalizer changed — rebuilding cache') })).toBe(true)
    })

    it('describes a first run as seeding rather than rebuilding', async function () {
        enable('npm')
        await runSync(handle.db, cache.db, runtime)
        expect(logLines().some(function m(l) { return l.includes('seeding cache (first run)') })).toBe(true)
    })

    // Each OSV ecosystem is its own download and runSync decides seed-vs-incremental per ecosystem. The
    // two-ecosystem form of this assertion — one mid-rebuild must not drag a current sibling onto the
    // expensive path — cannot be written while npm is the only ecosystem offered; restore it from git
    // history when a second one is promoted out of preview in the registry.
    //
    // What is testable now, and matters more today: a preview cell is not synced at all, so enabling one
    // cannot trigger its export download.
    it('catches up a seeded ecosystem and seeds a newly enabled one', async function () {
        enable('npm')
        enable('crates.io')
        markSeeded('npm')
        await runSync(handle.db, cache.db, runtime)
        expect(sync.incrementalSyncOsv).toHaveBeenCalledTimes(1)
        expect(sync.incrementalSyncOsv.mock.calls[0]?.[1]).toBe('npm')
        expect(sync.seedOsv).toHaveBeenCalledTimes(1)
        expect(sync.seedOsv.mock.calls[0]?.[1]).toBe('crates.io')
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

    it('mirrors each cell status after syncing it, with the sync stamp cleared', async function () {
        enable('npm')
        setOsvMeta(cache.db, osvMetaKeyFor(OSV_META_KEYS.recordCount, 'npm'), 1234)
        markSeeded('npm')
        await runSync(handle.db, cache.db, runtime)
        expect(getConfigValue(handle.db, sourceStatusKey('osv' as never, 'npm' as never))).toMatchObject({
            seedComplete: true,
            normalizerVersion: osvNormalizerVersion('npm'),
            recordCount: 1234,
            syncStartedAt: null
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
        // syncStartedAt must clear on the throw too, or the panel reads "Rebuilding…" forever.
        expect(getConfigValue(handle.db, sourceStatusKey('osv' as never, 'npm' as never))).toMatchObject({
            lastError: 'seed exploded',
            syncStartedAt: null
        })
    })

    // Bug A, pinned. The discard is deferred to the first streamed batch, so a mirror written only at the
    // start and end of the sync leaves the panel claiming the pre-rebuild state for the whole rebuild —
    // which is exactly how Settings came to read "Up to date, 227,715 advisories" while every scan
    // returned unauditable/osv_db_not_seeded.
    it('re-mirrors the moment a seed discards the cache, keeping the prior count visible', async function () {
        enable('npm')
        setOsvMeta(cache.db, osvMetaKeyFor(OSV_META_KEYS.recordCount, 'npm'), 220)
        markSeeded('npm', osvNormalizerVersion('npm') - 1)
        let midRebuild: unknown = null
        sync.seedOsv.mockImplementationOnce(async function discardThenSeed(_db: unknown, eco: string, _signal?: AbortSignal, onCacheDiscarded?: () => void) {
            setOsvMeta(cache.db, osvMetaKeyFor(OSV_META_KEYS.seedComplete, eco), false)
            onCacheDiscarded?.()
            midRebuild = getConfigValue(handle.db, sourceStatusKey('osv' as never, 'npm' as never))
            markSeeded(eco)
            return { status: 'ok', upserted: 0, recordCount: 220, message: null }
        })
        await runSync(handle.db, cache.db, runtime)
        expect(midRebuild).toMatchObject({
            seedComplete: false,
            recordCount: 220,
            syncStartedAt: expect.any(Number)
        })
    })

    it('enqueues one full sweep when an ecosystem becomes matchable', async function () {
        enable('npm')
        sync.seedOsv.mockImplementationOnce(async function seed(_db: unknown, eco: string) {
            markSeeded(eco)
            return { status: 'ok', upserted: 1, recordCount: 1, message: null }
        })
        await runSync(handle.db, cache.db, runtime)
        const requests = listRecentScanRequests(handle.db)
        expect(requests).toHaveLength(1)
        expect(requests[0]).toMatchObject({ projectId: null, rootId: null, status: 'pending' })
    })

    it('does not enqueue a sweep for an incremental sync', async function () {
        enable('npm')
        markSeeded('npm')
        await runSync(handle.db, cache.db, runtime)
        expect(listRecentScanRequests(handle.db)).toHaveLength(0)
    })

    it('does not enqueue a sweep when the seed left the cache unusable', async function () {
        enable('npm')
        await runSync(handle.db, cache.db, runtime)
        expect(listRecentScanRequests(handle.db)).toHaveLength(0)
    })

    // The one rebuild that starts from a USABLE cache: a change set past OSV_INCREMENTAL_MAX_IDS re-seeds
    // from inside incrementalSyncOsv, so a plain before/after reading would see usable-to-usable and miss
    // that the scanner was refusing everything in between.
    it('enqueues a sweep when a rebuild discarded an already-matchable cache', async function () {
        enable('npm')
        markSeeded('npm')
        sync.incrementalSyncOsv.mockImplementationOnce(async function reseed(_db: unknown, eco: string, _signal?: AbortSignal, onCacheDiscarded?: () => void) {
            setOsvMeta(cache.db, osvMetaKeyFor(OSV_META_KEYS.seedComplete, eco), false)
            onCacheDiscarded?.()
            markSeeded(eco)
            return { status: 'ok', upserted: 1, recordCount: 1, message: null }
        })
        await runSync(handle.db, cache.db, runtime)
        expect(listRecentScanRequests(handle.db)).toHaveLength(1)
    })

    // The poller holds full sweeps while runtime.rebuilds is active: a seed counts from its first byte,
    // an incremental catch-up of a usable cache never does.
    it('counts a seed as a rebuild until the cache is matchable', async function () {
        enable('npm')
        const seeding = deferred<void>()
        sync.seedOsv.mockImplementationOnce(async function seed(_db: unknown, eco: string) {
            await seeding.promise
            markSeeded(eco)
            return { status: 'ok', upserted: 1, recordCount: 1, message: null }
        })
        const run = runSync(handle.db, cache.db, runtime)
        expect(runtime.rebuilds.active()).toBe(true)
        seeding.resolve()
        await run
        expect(runtime.rebuilds.active()).toBe(false)
    })

    it('does not count an incremental catch-up of a matchable cache as a rebuild', async function () {
        enable('npm')
        markSeeded('npm')
        const run = runSync(handle.db, cache.db, runtime)
        expect(runtime.rebuilds.active()).toBe(false)
        await run
    })

    // Two caches landing in turn queue one sweep, not two: the second finds the first's still waiting.
    it('queues no second sweep while one is still waiting', async function () {
        enable('npm')
        enqueueScanRequest(handle.db, {}, Date.now())
        sync.seedOsv.mockImplementationOnce(async function seed(_db: unknown, eco: string) {
            markSeeded(eco)
            return { status: 'ok', upserted: 1, recordCount: 1, message: null }
        })
        await runSync(handle.db, cache.db, runtime)
        expect(listRecentScanRequests(handle.db)).toHaveLength(1)
        expect(logLines()).toContain('[osv] cache is matchable again — a full re-scan is already queued')
    })

    it('reports a never-refreshed cell as null rather than zero', async function () {
        enable('npm')
        await runSync(handle.db, cache.db, runtime)
        expect(getConfigValue(handle.db, sourceStatusKey('osv' as never, 'npm' as never))).toMatchObject({
            refreshedAt: null,
            normalizerVersion: null
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

    function markSeeded(ecosystem: string, normalizerVersion: number = osvNormalizerVersion(ecosystem)): void {
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
        markSeeded('npm', osvNormalizerVersion('npm') - 1)
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

// --- The OSV cache as gemnasium's withdrawal evidence (SENTINEL-42, 45, 46) ---
//
// gemnasium-db records no withdrawal, so the OSV cache is synced for every gemnasium cell as well as every
// OSV cell, and the gemnasium scanner stamps withdrawals from it. OSV FINDINGS still come only from enabled
// OSV cells. Everything below is about the cache's second consumer.

function enableGemnasium(ecosystem: string, on = true): void {
    setConfigValue(handle.db, sourceEnabledKey('gemnasium' as never, ecosystem as never), on)
}

function markUsable(db: OsvDrizzleDb, ecosystem: string, normalizerVersion: number = osvNormalizerVersion('npm')): void {
    setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.seedComplete, ecosystem), true)
    setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.normalizerVersion, ecosystem), normalizerVersion)
}

// A promise the test resolves by hand, to hold a sync in flight while a second caller arrives.
function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (err: unknown) => void
    const promise = new Promise<T>(function executor(res, rej) {
        resolve = res
        reject = rej
    })
    return { promise, resolve, reject }
}

async function settle(): Promise<void> {
    await Promise.allSettled(Array.from(runtime.inFlight))
}

describe('the OSV cache follows the gemnasium cells too', function () {
    it('syncs the union of the OSV and gemnasium cells, each ecosystem once', function () {
        enableGemnasium('npm')
        expect(syncedOsvEcosystems(handle.db)).toEqual(['npm'])
        enable('npm')
        expect(syncedOsvEcosystems(handle.db)).toEqual(['npm'])
        enableGemnasium('npm', false)
        expect(syncedOsvEcosystems(handle.db)).toEqual(['npm'])
        enable('npm', false)
        expect(syncedOsvEcosystems(handle.db)).toEqual([])
    })

    it('is needed for a gemnasium cell alone, and not with every cell off', function () {
        expect(osvCacheNeeded(handle.db)).toBe(false)
        enableGemnasium('npm')
        expect(osvCacheNeeded(handle.db)).toBe(true)
        expect(osvSourceEnabled(handle.db)).toBe(false)
    })

    it('starts the runtime for a gemnasium cell but keeps the OSV scanner out of the batch', function () {
        enableGemnasium('npm')
        const controller = createOsvController(handle.db, runtime)
        expect(existsSync(osvPath)).toBe(true)
        expect(controller.getScanner()).not.toBeNull()
        const npmAudit = fakeScanner('npm-audit')
        expect(selectScanners(handle.db, npmAudit, extraSourceCells({ osvController: controller })).map(function n(s) { return s.name })).toEqual(['npm-audit'])
    })

    it('stops the runtime once the last gemnasium cell is turned off', function () {
        enableGemnasium('npm')
        const controller = createOsvController(handle.db, runtime)
        enableGemnasium('npm', false)
        controller.reload()
        expect(controller.getScanner()).toBeNull()
    })

    it('seeds and mirrors the status of an ecosystem only gemnasium needs', async function () {
        enableGemnasium('npm')
        startOsvRuntime(handle.db, runtime)
        await settle()
        expect(sync.seedOsv).toHaveBeenCalledWith(expect.anything(), 'npm', expect.anything(), expect.any(Function))
        expect(getConfigValue(handle.db, sourceStatusKey('osv', 'npm'))).toMatchObject({ seedComplete: false, syncStartedAt: null })
    })

    // gemnasium recorded osv_db_not_seeded while its evidence was missing; only this cache landing clears it.
    it('re-scans at boot when gemnasium still holds a verdict the usable cache has cleared', function () {
        enableGemnasium('npm')
        const cache = openCache()
        markUsable(cache.db, 'npm')
        cache.sqlite.close()
        upsertRoot(handle.db, { id: 'root-x', path: '/repo', label: null, createdAt: 1 })
        upsertProject(handle.db, {
            id: 'proj-x', rootId: 'root-x', relPath: 'app', name: 'app', alias: null,
            packageManager: 'npm', nvmrcVersion: null, gitBranch: null, ecosystems: ['npm'], manifests: [],
            muted: false, tags: [], createdAt: 1, updatedAt: 1
        })
        insertScan(handle.db, {
            id: 'scan-x', projectId: 'proj-x', startedAt: 1, finishedAt: 2, scanner: 'gemnasium',
            source: 'gemnasium', ecosystem: 'npm', status: 'unauditable',
            reasonCode: 'osv_db_not_seeded', durationMs: 1, errorText: null, rawJson: ''
        })
        sync.feedDisabled = true
        startOsvRuntime(handle.db, runtime)
        expect(listRecentScanRequests(handle.db)).toHaveLength(1)
    })
})

describe('the withdrawal evidence the controller exposes', function () {
    it('is not ready, and has nothing to stamp from, while no runtime runs', function () {
        const controller = createOsvController(handle.db, runtime)
        expect(controller.evidence.ready('npm')).toBe(false)
        expect(controller.evidence.links('npm', ['braces'])).toBeNull()
    })

    // The air-gapped opt-out: with the feed off nothing new is learnt, and gemnasium is not held hostage.
    it('is ready with the feed switched off, stamping nothing without a snapshot', function () {
        sync.feedDisabled = true
        const controller = createOsvController(handle.db, runtime)
        expect(controller.evidence.ready('npm')).toBe(true)
        expect(controller.evidence.links('npm', ['braces'])).toBeNull()
    })

    it('reads every row, withdrawn or not, from a complete snapshot', function () {
        enableGemnasium('npm')
        const cache = openCache()
        markUsable(cache.db, 'npm')
        upsertOsvAdvisories(cache.db, [
            { advisoryId: 'GHSA-a', ecosystem: 'npm', packageName: 'braces', aliases: ['CVE-1'], ranges: [], versions: [], severity: null, summary: null, url: null, malicious: false, withdrawn: 5 },
            { advisoryId: 'GHSA-b', ecosystem: 'npm', packageName: 'braces', aliases: ['CVE-1'], ranges: [], versions: ['1.0.0'], severity: null, summary: null, url: null, malicious: false, withdrawn: null }
        ])
        cache.sqlite.close()
        const controller = createOsvController(handle.db, runtime)
        expect(controller.evidence.ready('npm')).toBe(true)
        expect(controller.evidence.links('npm', ['braces'])?.get('braces')?.map(function id(l) { return l.advisoryId + ':' + l.withdrawn }).sort()).toEqual(['GHSA-a:5', 'GHSA-b:null'])
    })

    it.each([
        ['mid-rebuild', function midRebuild(db: OsvDrizzleDb) { markUsable(db, 'npm'); setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.seedComplete, 'npm'), false) }],
        ['stamped by an older normalizer', function old(db: OsvDrizzleDb) { markUsable(db, 'npm', osvNormalizerVersion('npm') - 1) }]
    ])('is neither ready nor read when the snapshot is %s', function (_label, state) {
        enableGemnasium('npm')
        const cache = openCache()
        state(cache.db)
        cache.sqlite.close()
        const controller = createOsvController(handle.db, runtime)
        expect(controller.evidence.ready('npm')).toBe(false)
        expect(controller.evidence.links('npm', ['braces'])).toBeNull()
    })

    it('is read through the scratch tools from any cache handle', function () {
        const cache = openCache()
        markUsable(cache.db, 'npm')
        const evidence = withdrawalEvidenceFrom(function scratch() { return cache.db })
        expect(evidence.ready('npm')).toBe(true)
        expect(evidence.links('npm', ['braces'])?.size).toBe(0)
        cache.sqlite.close()
    })
})

// The per-batch refresh (D9): awaited before every batch with no age gate, single-flight with every other
// sync of the ecosystem, never waiting on a seed.
describe('refreshEvidence', function () {
    function usableCache(): void {
        const cache = openCache()
        markUsable(cache.db, 'npm')
        cache.sqlite.close()
    }

    it('does nothing while no runtime runs', async function () {
        const controller = createOsvController(handle.db, runtime)
        await controller.refreshEvidence()
        expect(sync.incrementalSyncOsv).not.toHaveBeenCalled()
        expect(sync.seedOsv).not.toHaveBeenCalled()
    })

    it('does nothing with the feed switched off', async function () {
        enableGemnasium('npm')
        usableCache()
        sync.feedDisabled = true
        const controller = createOsvController(handle.db, runtime)
        await controller.refreshEvidence()
        expect(sync.incrementalSyncOsv).not.toHaveBeenCalled()
    })

    // OSV findings keep their daily sync; only gemnasium's evidence is re-checked per batch.
    it('refreshes nothing for an ecosystem only the OSV source uses', async function () {
        enable('npm')
        usableCache()
        const controller = createOsvController(handle.db, runtime)
        await settle()
        sync.incrementalSyncOsv.mockClear()
        await controller.refreshEvidence()
        expect(sync.incrementalSyncOsv).not.toHaveBeenCalled()
    })

    it('refreshes a usable gemnasium ecosystem incrementally and waits for it', async function () {
        enableGemnasium('npm')
        usableCache()
        const controller = createOsvController(handle.db, runtime)
        await settle()
        sync.incrementalSyncOsv.mockClear()
        sync.seedOsv.mockClear()
        await controller.refreshEvidence()
        expect(sync.incrementalSyncOsv.mock.calls.map(function eco(c) { return c[1] })).toEqual(['npm'])
        expect(sync.seedOsv).not.toHaveBeenCalled()
    })

    // No age gate: a refresh that just completed never exempts the next batch.
    it('refreshes again for every batch, however recent the last refresh', async function () {
        enableGemnasium('npm')
        usableCache()
        const controller = createOsvController(handle.db, runtime)
        await settle()
        sync.incrementalSyncOsv.mockClear()
        await controller.refreshEvidence()
        await controller.refreshEvidence()
        expect(sync.incrementalSyncOsv).toHaveBeenCalledTimes(2)
    })

    it('shares one in-flight refresh between two batches, and both wait for it', async function () {
        enableGemnasium('npm')
        usableCache()
        const controller = createOsvController(handle.db, runtime)
        await settle()
        sync.incrementalSyncOsv.mockClear()
        const gate = deferred<void>()
        sync.incrementalSyncOsv.mockImplementation(async function held() {
            await gate.promise
            return { status: 'ok', upserted: 0, recordCount: 0, message: null }
        })
        const done: string[] = []
        const first = controller.refreshEvidence().then(function a() { done.push('first') })
        const second = controller.refreshEvidence().then(function b() { done.push('second') })
        await new Promise(function tick(r) { setImmediate(r) })
        expect(done).toEqual([])
        gate.resolve()
        await Promise.all([first, second])
        expect(sync.incrementalSyncOsv).toHaveBeenCalledTimes(1)
        expect(done.sort()).toEqual(['first', 'second'])
    })

    it('joins the sync "Refresh now" already has in flight', async function () {
        enableGemnasium('npm')
        usableCache()
        const controller = createOsvController(handle.db, runtime)
        await settle()
        sync.incrementalSyncOsv.mockClear()
        const gate = deferred<void>()
        sync.incrementalSyncOsv.mockImplementation(async function held() {
            await gate.promise
            return { status: 'ok', upserted: 0, recordCount: 0, message: null }
        })
        const manual = controller.refresh()
        const batch = controller.refreshEvidence()
        gate.resolve()
        await Promise.all([manual, batch])
        expect(sync.incrementalSyncOsv).toHaveBeenCalledTimes(1)
    })

    it('starts a background seed for an unusable cache without waiting for it', async function () {
        enableGemnasium('npm')
        const controller = createOsvController(handle.db, runtime)
        await settle()
        sync.seedOsv.mockClear()
        const gate = deferred<void>()
        sync.seedOsv.mockImplementation(async function held(db: unknown, ecosystem: string) {
            await gate.promise
            markUsable(db as OsvDrizzleDb, ecosystem)
            return { status: 'ok', upserted: 0, recordCount: 0, message: null }
        })
        await controller.refreshEvidence()
        expect(sync.seedOsv).toHaveBeenCalledTimes(1)
        expect(listRecentScanRequests(handle.db)).toHaveLength(0)
        // A second batch while the seed is still running neither waits nor starts another.
        await controller.refreshEvidence()
        expect(sync.seedOsv).toHaveBeenCalledTimes(1)
        gate.resolve()
        await settle()
        // The seed landed: every verdict recorded meanwhile is stale, so the estate is re-scanned once.
        expect(listRecentScanRequests(handle.db)).toHaveLength(1)
        expect(controller.evidence.ready('npm')).toBe(true)
    })

    it('does not re-scan when the background seed left the cache unusable', async function () {
        enableGemnasium('npm')
        const controller = createOsvController(handle.db, runtime)
        await settle()
        await controller.refreshEvidence()
        await settle()
        expect(listRecentScanRequests(handle.db)).toHaveLength(0)
    })

    it('logs a background seed that throws', async function () {
        enableGemnasium('npm')
        const controller = createOsvController(handle.db, runtime)
        await settle()
        sync.seedOsv.mockRejectedValue(new Error('disk full'))
        await controller.refreshEvidence()
        await settle()
        expect(errorLines()).toContain('[osv] background seed failed for npm: disk full')
    })

    // The batch scans against the last complete snapshot rather than failing.
    it('logs a refresh that throws and lets the batch go on', async function () {
        enableGemnasium('npm')
        usableCache()
        const controller = createOsvController(handle.db, runtime)
        await settle()
        sync.incrementalSyncOsv.mockRejectedValue(new Error('database is locked'))
        await expect(controller.refreshEvidence()).resolves.toBeUndefined()
        expect(errorLines()).toContain('[osv] withdrawal evidence refresh failed for npm; scanning against the last complete snapshot: database is locked')
    })

    // A change set past OSV_INCREMENTAL_MAX_IDS re-seeds from inside the refresh: the cache was unusable
    // for that window, so the estate is re-scanned once it is back.
    it('re-scans when the refresh rebuilt the cache', async function () {
        enableGemnasium('npm')
        usableCache()
        const controller = createOsvController(handle.db, runtime)
        await settle()
        sync.incrementalSyncOsv.mockImplementation(async function rebuild(_db, _eco, _signal, onCacheDiscarded) {
            if (onCacheDiscarded) onCacheDiscarded()
            return { status: 'ok', upserted: 0, recordCount: 0, message: null }
        })
        await controller.refreshEvidence()
        expect(listRecentScanRequests(handle.db)).toHaveLength(1)
    })

    it('does nothing once the worker is shutting down', async function () {
        enableGemnasium('npm')
        usableCache()
        const controller = createOsvController(handle.db, runtime)
        await settle()
        sync.incrementalSyncOsv.mockClear()
        runtime.abortController.abort()
        await controller.refreshEvidence()
        expect(sync.incrementalSyncOsv).not.toHaveBeenCalled()
    })

    // runSync joining a sync a batch started reports nothing for it: the batch that started it re-scans.
    it('enqueues one re-scan when runSync joins a rebuild a batch started', async function () {
        enableGemnasium('npm')
        usableCache()
        const controller = createOsvController(handle.db, runtime)
        await settle()
        sync.incrementalSyncOsv.mockClear()
        const gate = deferred<void>()
        sync.incrementalSyncOsv.mockImplementation(async function rebuild(_db, _eco, _signal, onCacheDiscarded) {
            await gate.promise
            if (onCacheDiscarded) onCacheDiscarded()
            return { status: 'ok', upserted: 0, recordCount: 0, message: null }
        })
        const batch = controller.refreshEvidence()
        const manual = controller.refresh()
        gate.resolve()
        await Promise.all([batch, manual])
        expect(sync.incrementalSyncOsv).toHaveBeenCalledTimes(1)
        expect(listRecentScanRequests(handle.db)).toHaveLength(1)
    })
})

// End to end, through the real batch: the scheduler's sweep (the same scannersForBatch the poller's three
// entry points use), the real runBatch and finding merge, the real gemnasium runtime over a temp
// gemnasium.db, and the real seed and incremental sync over a temp osv.db. Only the OSV feed is faked, the
// way osv-sync.test.ts fakes it. "Resolved", "dashboard count" and "export" are read back from the main DB
// the batch wrote: the advisory export and the project view both read listCurrentFindingsForProject.
//
// The fixture is the shape of the live case: gemnasium's CVE-2026-93687 for braces <= 3.0.3, aliasing
// GHSA-vfj7-8cjw-p6xm, which GitHub withdrew on 2026-10-23.
describe('every batch re-checks withdrawals — end to end', function () {
    const GHSA = 'GHSA-vfj7-8cjw-p6xm'
    const DUPLICATE = 'GHSA-2222-3333-4444'
    const CVE = 'CVE-2026-93687'
    const WITHDRAWN_AT = '2026-10-23T12:53:02Z'

    let gemnasium: { db: GemnasiumDrizzleDb; sqlite: SqliteDb }
    let osv: { db: OsvDrizzleDb; sqlite: SqliteDb }

    function osvRows(id: string, withdrawn: string | null) {
        return normalizeOsvRecord({
            id,
            aliases: [CVE],
            ...(withdrawn ? { withdrawn } : {}),
            database_specific: { severity: 'HIGH' },
            affected: [{
                package: { name: 'braces', ecosystem: 'npm' },
                ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { last_affected: '3.0.3' }] }]
            }]
        }, 'npm')
    }

    // A complete npm snapshot at the current normalizer, with the ETag of the modified_id.csv it consumed.
    function completeSnapshot(rows: ReturnType<typeof osvRows>): void {
        upsertOsvAdvisories(osv.db, rows)
        markUsable(osv.db, 'npm')
        setOsvMeta(osv.db, osvMetaKeyFor(OSV_META_KEYS.lastModified, 'npm'), '2026-10-22T00:00:00Z')
        setOsvMeta(osv.db, osvMetaKeyFor(OSV_META_KEYS.modifiedIdsEtag, 'npm'), 'etag-1')
    }

    function republish(id: string, withdrawn: string | null): void {
        feed.fetchOsvChangedIds.mockResolvedValue({ status: 'ok', ids: [id], newestIso: WITHDRAWN_AT, etag: 'etag-2' })
        feed.fetchOsvAdvisoryRows.mockResolvedValue(osvRows(id, withdrawn))
    }

    beforeEach(async function estate() {
        // Cast: the double is typed by its stub, which takes any handle and ecosystem.
        sync.seedOsv.mockImplementation(sync.real!.seedOsv as never)
        sync.incrementalSyncOsv.mockImplementation(sync.real!.incrementalSyncOsv as never)
        feed.fetchOsvChangedIds.mockResolvedValue({ status: 'unchanged' })
        vi.stubEnv('SENTINELLO_GEMNASIUM_DB_PATH', join(handle.dir, 'gemnasium.db'))
        vi.stubEnv('SENTINELLO_GEMNASIUM_FEED_URL', 'off')
        // gemnasium npm only: every OSV cell stays off unless a test turns one on, and npm-audit, which
        // shells out, is off.
        setConfigValue(handle.db, sourceEnabledKey('npm-audit' as never, 'npm' as never), false)
        enableGemnasium('npm')
        const rootPath = await makeTree(handle.dir, 'code', {
            'app/package.json': JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { braces: '^3.0.0' } }),
            'app/package-lock.json': JSON.stringify({
                name: 'app',
                lockfileVersion: 3,
                packages: {
                    '': { name: 'app', version: '1.0.0', dependencies: { braces: '^3.0.0' } },
                    'node_modules/braces': { version: '3.0.3' }
                }
            })
        })
        upsertRoot(handle.db, { id: 'root-1', path: rootPath, label: null, createdAt: 1 })
        const opened = openGemnasiumDb(join(handle.dir, 'gemnasium.db'))
        runGemnasiumMigrations(opened.db)
        upsertGemnasiumAdvisories(opened.db, [{
            advisoryId: CVE,
            ecosystem: 'npm',
            packageName: 'braces',
            aliases: [GHSA],
            ranges: [{ introduced: '0', fixed: null, lastAffected: '3.0.3' }],
            versions: [],
            severity: 'high',
            summary: 'Uncontrolled resource consumption in braces',
            url: 'https://example.test/' + CVE,
            malicious: false,
            withdrawn: null
        }])
        setGemnasiumMeta(opened.db, GEMNASIUM_META_KEYS.seedComplete, true)
        setGemnasiumMeta(opened.db, GEMNASIUM_META_KEYS.normalizerVersion, GEMNASIUM_NORMALIZER_VERSION)
        gemnasium = { db: opened.db, sqlite: opened.sqlite }
        osv = openCache()
    })

    afterEach(function closeCaches() {
        gemnasium.sqlite.close()
        osv.sqlite.close()
        vi.unstubAllEnvs()
    })

    // The controllers as worker.ts wires them, settled past their initial sync so a test counts only the
    // feed calls its own batches make.
    async function controllers() {
        const osvController = createOsvController(handle.db, runtime)
        const gemnasiumController = createGemnasiumController(handle.db, runtime, osvController.evidence)
        await settle()
        feed.fetchOsvChangedIds.mockClear()
        feed.fetchOsvAdvisoryRows.mockClear()
        return { osvController, gemnasiumController }
    }

    function batch(c: Awaited<ReturnType<typeof controllers>>): Promise<void> {
        return sweepActiveProjects({ db: handle.db, sqlite: handle.sqlite, runtime, ...c })
    }

    function projectId(): string {
        return listProjects(handle.db)[0]!.id
    }

    function openFindings(): string[] {
        return listCurrentFindingsForProject(handle.db, projectId(), Date.now()).map(function id(f) { return f.advisoryId })
    }

    function highCount(): number {
        return getDashboardSummary(handle.db, Date.now()).severityCounts.high
    }

    function latestScan(scanner: string) {
        return listScansForProject(handle.db, projectId()).find(function by(s) { return s.scanner === scanner })
    }

    it('resolves the finding in the very next batch, minutes after the withdrawal', async function () {
        completeSnapshot(osvRows(GHSA, null))
        const c = await controllers()
        const startedAt = Date.now()
        await batch(c)
        expect(openFindings()).toEqual([CVE])
        expect(highCount()).toBe(1)

        republish(GHSA, WITHDRAWN_AT)
        await batch(c)

        expect(Date.now() - startedAt).toBeLessThan(10 * 60_000)
        // Each batch made its own conditional request, the first one answered 304.
        expect(feed.fetchOsvChangedIds).toHaveBeenCalledTimes(2)
        expect(openFindings()).toEqual([])
        expect(highCount()).toBe(0)
        const episode = listFindingsForProject(handle.db, projectId()).find(function by(f) { return f.advisoryId === CVE })
        expect(episode?.resolvedAt).not.toBeNull()
        expect(latestScan('gemnasium')).toMatchObject({ status: 'ok' })
        // OSV findings stayed off throughout: the cache was only evidence.
        expect(latestScan('osv')).toBeUndefined()
    })

    it('costs one body-less conditional request per batch while the feed is unchanged', async function () {
        completeSnapshot(osvRows(GHSA, null))
        const c = await controllers()
        await batch(c)
        await batch(c)
        expect(feed.fetchOsvChangedIds).toHaveBeenCalledTimes(2)
        for (const call of feed.fetchOsvChangedIds.mock.calls) {
            expect(call.slice(0, 3)).toEqual(['npm', Date.parse('2026-10-22T00:00:00Z'), 'etag-1'])
        }
        expect(feed.fetchOsvAdvisoryRows).not.toHaveBeenCalled()
        expect(countOsvAdvisories(osv.db, 'npm')).toBe(1)
        expect(getOsvMeta<string>(osv.db, osvMetaKeyFor(OSV_META_KEYS.modifiedIdsEtag, 'npm'))).toBe('etag-1')
        expect(openFindings()).toEqual([CVE])
    })

    it('shares one in-flight refresh between two batches, and both wait for it', async function () {
        completeSnapshot(osvRows(GHSA, null))
        const c = await controllers()
        const manifest = deferred<unknown>()
        feed.fetchOsvChangedIds.mockReturnValue(manifest.promise)
        feed.fetchOsvAdvisoryRows.mockResolvedValue(osvRows(GHSA, WITHDRAWN_AT))
        const first = batch(c)
        const second = batch(c)
        await new Promise(function tick(r) { setImmediate(r) })
        // Neither batch has scanned: both are waiting on the one refresh.
        expect(listScansForProject(handle.db, projectId())).toEqual([])
        expect(feed.fetchOsvChangedIds).toHaveBeenCalledTimes(1)
        manifest.resolve({ status: 'ok', ids: [GHSA], newestIso: WITHDRAWN_AT, etag: 'etag-2' })
        await Promise.all([first, second])
        expect(feed.fetchOsvChangedIds).toHaveBeenCalledTimes(1)
        // Both scanned against what that refresh fetched.
        expect(listScansForProject(handle.db, projectId()).filter(function g(s) { return s.scanner === 'gemnasium' })).toHaveLength(2)
        expect(openFindings()).toEqual([])
    })

    it('scans against the last complete snapshot when the refresh fails', async function () {
        completeSnapshot(osvRows(GHSA, null))
        const c = await controllers()
        await batch(c)
        feed.fetchOsvChangedIds.mockRejectedValue(new Error('ECONNRESET'))
        await batch(c)
        expect(latestScan('gemnasium')).toMatchObject({ status: 'ok' })
        expect(openFindings()).toEqual([CVE])
        expect(getOsvMeta<string>(osv.db, osvMetaKeyFor(OSV_META_KEYS.lastError, 'npm'))).toContain('ECONNRESET')
    })

    // SENTINEL-48: GitHub withdraws GHSA-A as a duplicate of a newly published GHSA-B, both aliasing CVE-X,
    // and B's fetch fails. Publishing A's withdrawal alone made every linked record look withdrawn, so the
    // batch resolved a live CVE-X. The batch must scan the last complete snapshot, and the retry that
    // lands B must keep CVE-X open.
    it('keeps a live duplicate open when its replacement failed to fetch, and after the retry lands it', async function () {
        completeSnapshot(osvRows(GHSA, null))
        const c = await controllers()
        await batch(c)
        expect(openFindings()).toEqual([CVE])

        feed.fetchOsvChangedIds.mockResolvedValue({ status: 'ok', ids: [GHSA, DUPLICATE], newestIso: WITHDRAWN_AT, etag: 'etag-2' })
        feed.fetchOsvAdvisoryRows.mockImplementation(async function partial(id: string) {
            if (id === DUPLICATE) throw new Error('503 Service Unavailable')
            return osvRows(GHSA, WITHDRAWN_AT)
        })
        await batch(c)

        expect(getOsvMeta<string>(osv.db, osvMetaKeyFor(OSV_META_KEYS.lastError, 'npm'))).toContain(DUPLICATE + ' could not be re-read')
        expect(c.osvController.evidence.ready('npm')).toBe(true)
        expect(latestScan('gemnasium')).toMatchObject({ status: 'ok' })
        expect(openFindings()).toEqual([CVE])
        expect(highCount()).toBe(1)

        // The retry: the cursor and ETag were held back, so the next batch re-reads the whole window.
        feed.fetchOsvAdvisoryRows.mockImplementation(async function complete(id: string) {
            return osvRows(id, id === GHSA ? WITHDRAWN_AT : null)
        })
        await batch(c)

        expect(feed.fetchOsvChangedIds.mock.calls.at(-1)?.slice(0, 3)).toEqual(['npm', Date.parse('2026-10-22T00:00:00Z'), null])
        expect(getOsvMeta<string>(osv.db, osvMetaKeyFor(OSV_META_KEYS.lastError, 'npm'))).toBeNull()
        expect(openFindings()).toEqual([CVE])
        expect(highCount()).toBe(1)
    })

    // A scan that reads the evidence while a multi-id pass is still fetching (a batch that started before
    // the cron's sync, say) sees the previous snapshot, never A's withdrawal without B.
    it('serves the previous snapshot as evidence while a multi-id refresh is in progress', async function () {
        completeSnapshot(osvRows(GHSA, null))
        const c = await controllers()
        const replacement = deferred<ReturnType<typeof osvRows>>()
        feed.fetchOsvChangedIds.mockResolvedValue({ status: 'ok', ids: [GHSA, DUPLICATE], newestIso: WITHDRAWN_AT, etag: 'etag-2' })
        feed.fetchOsvAdvisoryRows.mockImplementation(async function held(id: string) {
            if (id === DUPLICATE) return await replacement.promise
            return osvRows(GHSA, WITHDRAWN_AT)
        })
        const refresh = c.osvController.refresh()
        await vi.waitFor(function bothRequested() {
            expect(feed.fetchOsvAdvisoryRows).toHaveBeenCalledTimes(2)
        })

        expect(c.osvController.evidence.links('npm', ['braces'])?.get('braces')).toEqual([
            { advisoryId: GHSA, aliases: [CVE], withdrawn: null }
        ])

        replacement.resolve(osvRows(DUPLICATE, null))
        await refresh
        expect(c.osvController.evidence.links('npm', ['braces'])?.get('braces')).toHaveLength(2)
        await batch(c)
        expect(openFindings()).toEqual([CVE])
    })

    // SENTINEL-45: every OSV cell off. The cache is still opened, seeded and refreshed as evidence, and no
    // OSV scanner ever joins the batch.
    it('seeds and refreshes the evidence with OSV matching disabled', async function () {
        feed.streamOsvSeed.mockImplementation(async function* seed() {
            yield { rows: osvRows(GHSA, null), lastModified: '2026-10-22T00:00:00Z' }
        })
        const c = await controllers()
        expect(sync.seedOsv).toHaveBeenCalledTimes(1)
        expect(c.osvController.evidence.ready('npm')).toBe(true)
        expect(getConfigValue(handle.db, sourceStatusKey('osv', 'npm'))).toMatchObject({ seedComplete: true, normalizerVersion: osvNormalizerVersion('npm') })
        await batch(c)
        expect(feed.fetchOsvChangedIds).toHaveBeenCalledTimes(1)
        expect(openFindings()).toEqual([CVE])
        expect(latestScan('osv')).toBeUndefined()

        republish(GHSA, WITHDRAWN_AT)
        await batch(c)
        expect(openFindings()).toEqual([])
    })

    // SENTINEL-46: a snapshot mid-rebuild may hold the withdrawn duplicate GHSA-A and not yet the active
    // GHSA-B, both aliasing CVE-X. Stamping from it would suppress a live advisory, and reporting unstamped
    // would reopen every withdrawn finding; so gemnasium is unauditable until the snapshot completes.
    it.each([
        ['not complete', function incomplete() { setOsvMeta(osv.db, osvMetaKeyFor(OSV_META_KEYS.seedComplete, 'npm'), false) }],
        ['stamped by an older normalizer', function old() { setOsvMeta(osv.db, osvMetaKeyFor(OSV_META_KEYS.normalizerVersion, 'npm'), osvNormalizerVersion('npm') - 1) }]
    ])('waits out a snapshot that is %s, then stamps from the complete one', async function (_label, makeIncomplete) {
        completeSnapshot(osvRows(GHSA, null))
        const c = await controllers()
        await batch(c)
        expect(openFindings()).toEqual([CVE])

        // Mid-rebuild: only the withdrawn GHSA-A has streamed in. The rebuild completes when the gate opens.
        upsertOsvAdvisories(osv.db, osvRows(GHSA, WITHDRAWN_AT))
        makeIncomplete()
        const gate = deferred<void>()
        feed.streamOsvSeed.mockImplementation(async function* rebuild() {
            await gate.promise
            yield { rows: [...osvRows(GHSA, WITHDRAWN_AT), ...osvRows(DUPLICATE, null)], lastModified: '2026-10-24T00:00:00Z' }
        })
        await batch(c)
        expect(latestScan('gemnasium')).toMatchObject({ status: 'unauditable', reasonCode: 'osv_db_not_seeded' })
        expect(openFindings()).toEqual([CVE])

        gate.resolve()
        await settle()
        // The rebuild landed: every verdict recorded meanwhile is stale, so the estate is re-scanned.
        expect(listRecentScanRequests(handle.db)).toHaveLength(1)
        await batch(c)
        // GHSA-B is still active, so CVE-X is still real.
        expect(latestScan('gemnasium')).toMatchObject({ status: 'ok' })
        expect(openFindings()).toEqual([CVE])

        // Now GHSA-B is withdrawn too: the complete snapshot is all-withdrawn, and the finding resolves.
        republish(DUPLICATE, WITHDRAWN_AT)
        await batch(c)
        expect(openFindings()).toEqual([])
    })
})
