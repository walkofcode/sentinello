import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CAPABILITIES, sourceEnabledKey, type EcosystemId } from '@sentinello/core'
import {
    GEMNASIUM_META_KEYS,
    GEMNASIUM_NORMALIZER_VERSION,
    OSV_META_KEYS,
    getBaselineState,
    getProjectScanState,
    insertNotificationTarget,
    insertScan,
    listCurrentFindingsForProject,
    listEventsForProject,
    listProjects,
    listRecentScanRequests,
    listScansForProject,
    listSummaryDeliveries,
    openGemnasiumDb,
    openOsvDb,
    osvMetaKeyFor,
    osvNormalizerVersion,
    projectId,
    runGemnasiumMigrations,
    runOsvMigrations,
    seedCapabilityBaselines,
    setConfigValue,
    setGemnasiumMeta,
    setOsvMeta,
    upsertGemnasiumAdvisories,
    upsertRoot,
    type GemnasiumDrizzleDb,
    type OsvDrizzleDb,
    type SqliteDb
} from '@sentinello/db'
import type { RenderedMessage } from '@sentinello/notifications'
import { closeWorkerTestDb, makeTree, openWorkerTestDb, T0, type WorkerTestDb } from './worker-test-db.fixture'
import { createWorkerRuntime, type WorkerRuntime } from './runtime'
import { discoverProjects } from './discovery'

// The 3.7.7 → 3.8.0 upgrade of the live instance, replayed through the worker as worker.ts wires it (SENTINEL-158,
// SENTINEL-159). Both normalizers had changed, so at boot the OSV runtime re-seeded npm and PyPI while gemnasium
// rebuilt its cache. gemnasium landed first and queued a full re-scan; the poller ran it while OSV was still
// seeding, every scan said "not downloaded yet" (gemnasium too: its withdrawal evidence is the OSV cache), 318
// scan-failure events paged the operator, and the silent baseline closed on a summary of zero findings.
//
// What is real: both runtimes, their scanners against real migrated caches, the poller, the scheduler's sweep,
// the runner, the notifier and the baseline dispatcher. What is stubbed: the two feed downloads (each lands
// when the test says so) and the transport, which records every message instead of sending it.

const cron = vi.hoisted(function makeCronDouble() {
    return { schedule: function schedule() { return { stop: function stop() {}, start: function start() {} } } }
})

vi.mock('node-cron', function mockNodeCron() {
    return { default: cron }
})

// One download per cache, each held until the test lets it land; landing stamps the current normalizer.
const feeds = vi.hoisted(function makeFeeds() {
    type Gate = { promise: Promise<void>; open: () => void }
    function gate(): Gate {
        let open!: () => void
        const promise = new Promise<void>(function executor(resolve) { open = resolve })
        return { promise, open }
    }
    return {
        gate,
        osv: new Map<string, Gate>(),
        gemnasium: gate(),
        stampOsv: null as ((ecosystem: string) => void) | null,
        stampGemnasium: null as (() => void) | null
    }
})

vi.mock('./osv-sync', function mockOsvSync() {
    const ok = { status: 'ok', upserted: 0, recordCount: 0, message: null }
    return {
        seedOsv: async function seedOsv(_db: unknown, ecosystem: string) {
            await feeds.osv.get(ecosystem)!.promise
            feeds.stampOsv!(ecosystem)
            return ok
        },
        incrementalSyncOsv: async function incrementalSyncOsv() { return ok },
        osvFeedDisabled: function osvFeedDisabled() { return false }
    }
})

vi.mock('./gemnasium-sync', function mockGemnasiumSync() {
    return {
        syncGemnasium: async function syncGemnasium() {
            await feeds.gemnasium.promise
            feeds.stampGemnasium!()
            return { status: 'ok', upserted: 0, recordCount: 0, message: null }
        },
        gemnasiumFeedDisabled: function gemnasiumFeedDisabled() { return false }
    }
})

const transport = vi.hoisted(function makeTransport() {
    return { sent: [] as RenderedMessage[] }
})

vi.mock('./transport', function mockTransport() {
    return {
        sendByKind: async function sendByKind(_target: unknown, message: RenderedMessage) {
            transport.sent.push(message)
            return { ok: true }
        }
    }
})

const { createOsvController } = await import('./osv-runtime')
const { createGemnasiumController } = await import('./gemnasium-runtime')
const { pollOnce } = await import('./scan-request-poller')
const { sweepActiveProjects } = await import('./scheduler')

const LANGUAGES: EcosystemId[] = ['npm', 'PyPI']

let handle: WorkerTestDb
let runtime: WorkerRuntime
let osv: { db: OsvDrizzleDb; sqlite: SqliteDb }
let gemnasium: { db: GemnasiumDrizzleDb; sqlite: SqliteDb }
let controllers: { osvController: ReturnType<typeof createOsvController>; gemnasiumController: ReturnType<typeof createGemnasiumController> }

function stampOsv(ecosystem: string, version: number): void {
    setOsvMeta(osv.db, osvMetaKeyFor(OSV_META_KEYS.seedComplete, ecosystem), true)
    setOsvMeta(osv.db, osvMetaKeyFor(OSV_META_KEYS.normalizerVersion, ecosystem), version)
}

function stampGemnasium(version: number): void {
    setGemnasiumMeta(gemnasium.db, GEMNASIUM_META_KEYS.seedComplete, true)
    setGemnasiumMeta(gemnasium.db, GEMNASIUM_META_KEYS.normalizerVersion, version)
}

// Lets every promise chain the last step started run to its end.
async function flush(): Promise<void> {
    for (let i = 0; i < 20; i++) await new Promise(function tick(resolve) { setImmediate(resolve) })
}

function boot(): void {
    const osvController = createOsvController(handle.db, runtime)
    const gemnasiumController = createGemnasiumController(handle.db, runtime, osvController.evidence)
    controllers = { osvController, gemnasiumController }
}

function poll(): Promise<void> {
    return pollOnce({ db: handle.db, sqlite: handle.sqlite, runtime, scheduler: { reload: function reload() {}, stop: function stop() {} }, ...controllers })
}

// The scheduled sweep (or the boot sweep): it does not go through the queue, so it can run mid-rebuild.
function scheduledSweep(): Promise<void> {
    return sweepActiveProjects({ db: handle.db, sqlite: handle.sqlite, runtime, ...controllers })
}

function fullSweeps(status: string) {
    return listRecentScanRequests(handle.db).filter(function full(r) { return r.projectId === null && r.rootId === null && r.status === status })
}

// Every (source, ecosystem) cell's latest verdict, across the estate.
function latestVerdicts(): string[] {
    const out: string[] = []
    for (const project of listProjects(handle.db)) {
        const seen = new Set<string>()
        for (const scan of listScansForProject(handle.db, project.id)) {
            const cell = scan.scanner + '/' + scan.ecosystem
            if (seen.has(cell)) continue
            seen.add(cell)
            out.push(project.relPath + ' ' + cell + ' ' + scan.status + (scan.status === 'ok' ? '' : ':' + scan.reasonCode))
        }
    }
    return out.sort()
}

function scanFailureEvents(): number {
    return listProjects(handle.db).flatMap(function events(p) { return listEventsForProject(handle.db, p.id) }).filter(function failure(e) { return e.eventType === 'scan_failure' }).length
}

function sentKinds(): string[] {
    return transport.sent.map(function kind(m) { return (m.webhook as { event: string }).event })
}

beforeEach(async function upgradedInstall() {
    transport.sent = []
    feeds.osv = new Map(LANGUAGES.map(function gateFor(e) { return [e, feeds.gate()] }))
    feeds.gemnasium = feeds.gate()
    feeds.stampOsv = function current(ecosystem) { stampOsv(ecosystem, osvNormalizerVersion(ecosystem)) }
    feeds.stampGemnasium = function current() { stampGemnasium(GEMNASIUM_NORMALIZER_VERSION) }
    handle = await openWorkerTestDb('worker-upgrade-rebuild')
    runtime = createWorkerRuntime()
    vi.stubEnv('SENTINELLO_OSV_DB_PATH', join(handle.dir, 'osv.db'))
    vi.stubEnv('SENTINELLO_GEMNASIUM_DB_PATH', join(handle.dir, 'gemnasium.db'))
    vi.spyOn(console, 'log').mockImplementation(function silence() {})
    vi.spyOn(console, 'error').mockImplementation(function silence() {})

    const rootPath = await makeTree(handle.dir, 'code', {
        'web/package.json': JSON.stringify({ name: 'web', version: '1.0.0', dependencies: { braces: '^3.0.0' } }),
        'web/package-lock.json': JSON.stringify({
            name: 'web',
            lockfileVersion: 3,
            packages: {
                '': { name: 'web', version: '1.0.0', dependencies: { braces: '^3.0.0' } },
                'node_modules/braces': { version: '3.0.3' }
            }
        }),
        'api/requirements.txt': 'django==3.2.0\n'
    })
    upsertRoot(handle.db, { id: 'code', path: rootPath, label: null, createdAt: T0 })
    discoverProjects({ db: handle.db, roots: [{ id: 'code', path: rootPath, label: null, createdAt: T0 }], globalIgnore: [], at: T0 })
    // OSV and gemnasium on for Node.js and Python; npm audit, which shells out, off.
    setConfigValue(handle.db, sourceEnabledKey('npm-audit', 'npm'), false)
    for (const ecosystem of LANGUAGES) {
        setConfigValue(handle.db, sourceEnabledKey('osv', ecosystem), true)
        setConfigValue(handle.db, sourceEnabledKey('gemnasium', ecosystem), true)
    }

    // Both caches as 3.7.7 left them: complete, under the previous normalizer.
    const openedOsv = openOsvDb(join(handle.dir, 'osv.db'))
    runOsvMigrations(openedOsv.db)
    osv = { db: openedOsv.db, sqlite: openedOsv.sqlite }
    for (const ecosystem of LANGUAGES) stampOsv(ecosystem, osvNormalizerVersion(ecosystem) - 1)
    const openedGemnasium = openGemnasiumDb(join(handle.dir, 'gemnasium.db'))
    runGemnasiumMigrations(openedGemnasium.db)
    gemnasium = { db: openedGemnasium.db, sqlite: openedGemnasium.sqlite }
    upsertGemnasiumAdvisories(gemnasium.db, [
        {
            advisoryId: 'CVE-2026-0001', ecosystem: 'npm', packageName: 'braces', aliases: [], versions: [],
            ranges: [{ introduced: '0', fixed: '3.0.4', lastAffected: null }],
            severity: 'high', summary: 'Resource consumption in braces', url: 'https://advisories.example.test/1', malicious: false, withdrawn: null
        },
        {
            advisoryId: 'CVE-2026-0002', ecosystem: 'PyPI', packageName: 'django', aliases: [], versions: [],
            ranges: [{ introduced: '0', fixed: '3.2.5', lastAffected: null }],
            severity: 'high', summary: 'SQL injection in django', url: 'https://advisories.example.test/2', malicious: false, withdrawn: null
        }
    ])
    stampGemnasium(GEMNASIUM_NORMALIZER_VERSION - 1)
})

afterEach(async function teardown() {
    // Lets every held download land, so nothing is left running into the next test.
    feeds.gemnasium.open()
    for (const g of feeds.osv.values()) g.open()
    await flush()
    osv.sqlite.close()
    gemnasium.sqlite.close()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    await closeWorkerTestDb(handle)
})

describe('an upgrade that rebuilds both advisory caches', function () {
    // A target that takes only critical findings: the estate has none, and a scan failure passes every
    // severity filter, so any message at all is a false alert.
    beforeEach(function criticalOnlyTarget() {
        // A fresh install's baseline is done at once: nothing is held, nothing is summarized.
        seedCapabilityBaselines(handle.db, CAPABILITIES, T0)
        insertNotificationTarget(handle.db, {
            id: 'ops', kind: 'webhook', config: { url: 'https://hooks.example.test/ops' }, severityFilter: ['critical'],
            envFilter: 'all', enabled: true, createdAt: T0, rootIds: [], projectIds: [], sourceScope: { mode: 'all', cells: [] }
        })
    })

    it('sweeps once, after the last cache lands, and never alerts', async function () {
        boot()
        expect(runtime.rebuilds.active()).toBe(true)

        // gemnasium lands first and queues its re-scan; OSV is still seeding npm.
        feeds.gemnasium.open()
        await flush()
        expect(fullSweeps('pending')).toHaveLength(1)
        await poll()
        expect(fullSweeps('pending')).toHaveLength(1)
        expect(latestVerdicts()).toEqual([])

        // The scheduled sweep comes due mid-rebuild: what it records waits on the cache, and says so to nobody.
        await scheduledSweep()
        expect(latestVerdicts()).toEqual([
            'api gemnasium/PyPI unauditable:osv_db_not_seeded',
            'api osv/PyPI unauditable:osv_db_not_seeded',
            'web gemnasium/npm unauditable:osv_db_not_seeded',
            'web osv/npm unauditable:osv_db_not_seeded'
        ])
        expect(scanFailureEvents()).toBe(0)

        // npm lands; PyPI is still seeding, so the sweep still waits.
        feeds.osv.get('npm')!.open()
        await flush()
        await poll()
        expect(fullSweeps('pending')).toHaveLength(1)

        feeds.osv.get('PyPI')!.open()
        await flush()
        expect(runtime.rebuilds.active()).toBe(false)
        // OSV landing found gemnasium's sweep still waiting: one sweep for the whole upgrade.
        expect(fullSweeps('pending')).toHaveLength(1)
        await poll()
        await poll()
        expect(fullSweeps('done')).toHaveLength(1)
        expect(fullSweeps('pending')).toHaveLength(0)

        expect(latestVerdicts()).toEqual([
            'api gemnasium/PyPI ok',
            'api osv/PyPI ok',
            'web gemnasium/npm ok',
            'web osv/npm ok'
        ])
        for (const project of listProjects(handle.db)) expect(getProjectScanState(handle.db, project.id).state).toBe('scanned')
        expect(scanFailureEvents()).toBe(0)
        expect(transport.sent).toEqual([])
    })
})

// SENTINEL-159: the baseline must not close on the sweep that ran during the rebuild.
describe('the silent baseline across that upgrade', function () {
    beforeEach(function upgradedFrom37() {
        // An install that has scanned before (npm audit, under 3.7.7): 3.8's languages start a silent baseline.
        insertScan(handle.db, { id: 'old-scan', projectId: projectId('code', 'web'), startedAt: T0, finishedAt: T0, scanner: 'npm-audit', source: 'npm-audit', ecosystem: 'npm', status: 'ok', reasonCode: 'ok', durationMs: 1, errorText: null, rawJson: '{}' })
        seedCapabilityBaselines(handle.db, CAPABILITIES, T0)
        insertNotificationTarget(handle.db, {
            id: 'ops', kind: 'webhook', config: { url: 'https://hooks.example.test/ops' }, severityFilter: ['critical', 'high'],
            envFilter: 'all', enabled: true, createdAt: T0, rootIds: [], projectIds: [], sourceScope: { mode: 'all', cells: [] }
        })
    })

    it('stays pending through the sweep that ran mid-rebuild and closes on the first one that answered', async function () {
        boot()
        feeds.gemnasium.open()
        await flush()
        await scheduledSweep()
        // Python could not be checked: closing now would summarize zero findings.
        expect(getBaselineState(handle.db, 'languages-3.8')).toBe('pending')
        expect(listSummaryDeliveries(handle.db, 'languages-3.8')).toEqual([])
        expect(transport.sent).toEqual([])

        feeds.osv.get('npm')!.open()
        feeds.osv.get('PyPI')!.open()
        await flush()
        await poll()

        const api = listProjects(handle.db).find(function byPath(p) { return p.relPath === 'api' })!
        expect(listCurrentFindingsForProject(handle.db, api.id, Date.now()).map(function id(f) { return f.advisoryId })).toEqual(['CVE-2026-0002'])
        expect(getBaselineState(handle.db, 'languages-3.8')).toBe('done')
        expect(listSummaryDeliveries(handle.db, 'languages-3.8')[0]?.counts).toEqual({ findings: 1, projects: 1, critical: 0, sourceDisabledProjects: 0 })
        // The npm finding by itself (npm is never held), the one summary, and no scan failure at all.
        expect(sentKinds().sort()).toEqual(['capability_summary', 'findings'])
        expect(scanFailureEvents()).toBe(0)
    })
})
