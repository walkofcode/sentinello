import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sourceEnabledKey, type EcosystemId, type NotificationTarget, type SourceId } from '@sentinello/core'
import {
    enqueueFullSweepUnlessPending,
    getBaselineState,
    getNotificationTargetById,
    insertNotificationTarget,
    listSummaryDeliveries,
    recordSourceCellDisabled,
    recordSourceCellEnabled,
    schema,
    setConfigValue,
    setNotificationTargetDelivery,
    upsertRoot
} from '@sentinello/db'
import type { NotificationSender, RenderedMessage } from '@sentinello/notifications'
import type { ScannerPlugin } from '@sentinello/scanners'
import { closeWorkerTestDb, makeTree, openWorkerTestDb, T0, type WorkerTestDb } from './worker-test-db.fixture'
import { createWorkerRuntime, type WorkerRuntime } from './runtime'
import { discoverProjects } from './discovery'
import { sweepProjects } from './scheduler'

// Switching a source on with scans on record: 126 findings went out in 7 messages. Replayed through the real
// discovery, runner, notifier and baseline dispatcher, with only the feed and the sender faked.

vi.mock('@sentinello/fixes', async function mockFixes(importOriginal) {
    const actual = await importOriginal<typeof import('@sentinello/fixes')>()
    return { ...actual, createRegistryClients: function noRegistry() { return {} } }
})

let handle: WorkerTestDb
let runtime: WorkerRuntime
let sent: { targetId: string; message: RenderedMessage }[]
let feedState: 'ok' | 'not_seeded'
let duringScan: (() => void) | null

const send: NotificationSender = async function recording(target, message) {
    sent.push({ targetId: target.id, message })
    return { ok: true }
}

const NPM_AUDIT: ScannerPlugin = {
    name: 'npm-audit',
    scan: async function clean() {
        hook()
        return { status: 'ok', reasonCode: 'ok', findings: [], rawJson: '{}', errorText: null, durationMs: 1 }
    }
} as ScannerPlugin

function hook(): void {
    if (!duringScan) return
    const once = duringScan
    duringScan = null
    once()
}

function reported(advisoryId: string) {
    return {
        advisoryId, advisoryTitle: 't', advisoryUrl: null, packageName: 'lodash', ecosystem: 'npm', installedVersion: '1.0.0', vulnerableRange: '<2.0.0', severity: 'critical' as const,
        fixAvailable: false, fixVersion: null, fixInputs: { source: 'osv', installed: ['1.0.0'], affected: { comparator: 'semver' as const, ranges: [], exact: [], complete: false }, patched: null, patchedSet: null, statedFix: null, fixViaParent: false },
        depPath: [], isProd: true, isDev: false, aliases: []
    }
}

function feed(name: SourceId): ScannerPlugin {
    return {
        name,
        scan: async function scan(path: string) {
            hook()
            if (feedState === 'not_seeded') return { status: 'unauditable', reasonCode: name === 'gemnasium' ? 'gemnasium_db_not_seeded' : 'osv_db_not_seeded', findings: [], rawJson: '', errorText: null, durationMs: 1 }
            return { status: 'ok', reasonCode: 'ok', findings: [reported(name + '-' + path.split('/').pop())], rawJson: '{}', errorText: null, durationMs: 1 }
        }
    } as ScannerPlugin
}

// What writeSourceCell does, in the portal: the flag and the baseline in one write.
function enable(source: SourceId, ecosystem: EcosystemId): void {
    setConfigValue(handle.db, sourceEnabledKey(source, ecosystem), true)
    recordSourceCellEnabled(handle.db, { source, ecosystem }, Date.now())
}

function sweep(scanners: ScannerPlugin[]): Promise<void> {
    return sweepProjects({ db: handle.db, sqlite: handle.sqlite, runtime, send }, async function list() { return scanners })
}

function target(id: string, delivery: NotificationTarget['delivery'] = 'per_project'): void {
    insertNotificationTarget(handle.db, {
        id, kind: 'webhook', config: { url: 'https://hooks.example.test/' + id }, severityFilter: ['critical'], envFilter: 'all', enabled: true,
        createdAt: T0, rootIds: [], projectIds: [], sourceScope: { mode: 'all', cells: [] }, delivery: 'per_project', weeklyDigest: true, digestEligibleSinceAt: null
    })
    if (delivery === 'run_summary') setNotificationTargetDelivery(handle.db, getNotificationTargetById(handle.db, id) as NotificationTarget, delivery, Date.now())
}

function baselines() {
    return handle.db.select().from(schema.capabilityBaselines).all().filter(function operators(row) { return row.cellsJson !== null })
}

function tick(): Promise<void> {
    return new Promise(function later(resolve) { setTimeout(resolve, 3) })
}

beforeEach(async function setup() {
    handle = await openWorkerTestDb('worker-source-enable')
    runtime = createWorkerRuntime()
    vi.spyOn(console, 'log').mockImplementation(function silence() {})
    vi.spyOn(console, 'error').mockImplementation(function silence() {})
    sent = []
    feedState = 'ok'
    duringScan = null
    const spec: Record<string, string> = {}
    for (const name of ['a', 'b', 'c']) {
        spec[name + '/package.json'] = JSON.stringify({ name, dependencies: { lodash: '1.0.0' } })
        spec[name + '/package-lock.json'] = JSON.stringify({ name, lockfileVersion: 3, packages: { '': { name, dependencies: { lodash: '1.0.0' } }, 'node_modules/lodash': { version: '1.0.0' } } })
    }
    const path = await makeTree(handle.dir, 'code', spec)
    const root = { id: 'code', path, label: null, createdAt: T0 }
    upsertRoot(handle.db, root)
    setConfigValue(handle.db, 'globalIgnore', [])
    discoverProjects({ db: handle.db, roots: [root], globalIgnore: [], at: T0 })
    // An install that has scanned before.
    await sweep([NPM_AUDIT])
    sent = []
    await tick()
})

afterEach(async function teardown() {
    vi.restoreAllMocks()
    await closeWorkerTestDb(handle)
})

describe('enabling a source after a sweep has run', function () {
    it('sends every target one summary instead of a message per project, per-project and run-summary targets alike', async function () {
        target('per-project')
        target('summary', 'run_summary')
        enable('osv', 'npm')
        await tick()
        await sweep([NPM_AUDIT, feed('osv')])
        expect(sent.map(function who(s) { return s.targetId }).sort()).toEqual(['per-project', 'summary'])
        const message = sent[0]?.message as RenderedMessage
        expect(message.title).toBe('Sentinello now checks Node.js with OSV')
        expect(message.text).toContain('3 findings across 3 projects, 3 critical')
        expect(message.webhook).toMatchObject({ event: 'capability_summary', capability: { since: null, cells: [{ source: 'osv', ecosystem: 'npm' }] } })
        expect(handle.db.select().from(schema.notificationEvents).all().map(function of(e) { return e.baselineOf })).toEqual(Array(3).fill(baselines()[0]?.capabilityId))
    })

    it('reads later findings normally once the baseline closed', async function () {
        target('per-project')
        enable('osv', 'npm')
        await tick()
        await sweep([NPM_AUDIT, feed('osv')])
        sent = []
        await sweep([NPM_AUDIT, feed('osv'), { ...feed('osv'), name: 'gemnasium' } as ScannerPlugin])
        expect(sent).toEqual([])
    })

    it('is one summary for several cells enabled at once', async function () {
        target('per-project')
        enable('osv', 'npm')
        enable('gemnasium', 'npm')
        await tick()
        await sweep([NPM_AUDIT, feed('osv'), feed('gemnasium')])
        expect(baselines()).toHaveLength(1)
        expect(sent).toHaveLength(1)
        expect(sent[0]?.message.title).toBe('Sentinello now checks Node.js with OSV/GitLab gemnasium')
    })

    it('waits while the cell\'s cache is still downloading, and a failed download stops holding it', async function () {
        target('per-project')
        enable('osv', 'npm')
        feedState = 'not_seeded'
        await tick()
        await sweep([NPM_AUDIT, feed('osv')])
        expect(sent).toEqual([])
        expect(baselines()[0]?.state).toBe('pending')
        vi.spyOn(runtime.rebuilds, 'failed').mockReturnValue(true)
        await sweep([NPM_AUDIT, feed('osv')])
        expect(sent).toHaveLength(1)
    })

    it('is not closed by a sweep already running when the operator clicked, which never scanned the cell', async function () {
        target('per-project')
        duringScan = function clickedMidSweep() { enable('osv', 'npm') }
        await sweep([NPM_AUDIT])
        expect(sent).toEqual([])
        expect(baselines()[0]?.state).toBe('pending')
        await tick()
        await sweep([NPM_AUDIT, feed('osv')])
        expect(sent).toHaveLength(1)
    })

    it('stays open when a second cell joins during a sweep that would have closed it', async function () {
        target('per-project')
        enable('osv', 'npm')
        await tick()
        duringScan = function clickedMidSweep() { enable('gemnasium', 'npm') }
        await sweep([NPM_AUDIT, feed('osv')])
        expect(sent).toEqual([])
        expect(baselines()).toHaveLength(1)
        expect(baselines()[0]?.state).toBe('pending')
        await tick()
        await sweep([NPM_AUDIT, feed('osv'), feed('gemnasium')])
        expect(sent).toHaveLength(1)
        expect(JSON.parse(baselines()[0]?.cellsJson as string)).toHaveLength(2)
        expect(getBaselineState(handle.db, baselines()[0]?.capabilityId as string)).toBe('done')
    })

    it('opens a new one for a cell enabled after the last one was claimed', async function () {
        target('per-project')
        enable('osv', 'npm')
        await tick()
        await sweep([NPM_AUDIT, feed('osv')])
        enable('gemnasium', 'npm')
        expect(baselines()).toHaveLength(2)
    })

    it('does not count a timestamp equal to the sweep\'s start as before it', async function () {
        target('per-project')
        const at = Date.now()
        vi.spyOn(Date, 'now').mockReturnValue(at)
        enable('osv', 'npm')
        await sweep([NPM_AUDIT, feed('osv')])
        expect(sent).toEqual([])
        expect(listSummaryDeliveries(handle.db, baselines()[0]?.capabilityId as string)).toEqual([])
        vi.spyOn(Date, 'now').mockRestore()
    })

    it('names a cell once however many times it is enabled', async function () {
        enable('osv', 'npm')
        enable('osv', 'npm')
        expect(JSON.parse(baselines()[0]?.cellsJson as string)).toEqual([{ source: 'osv', ecosystem: 'npm' }])
    })
})

describe('what opens no baseline, and what closes one early', function () {
    it('a cache rebuild alone opens none', async function () {
        target('per-project')
        expect(enqueueFullSweepUnlessPending(handle.db, Date.now())).toBe(true)
        await sweep([NPM_AUDIT])
        expect(baselines()).toEqual([])
    })

    it('a fresh install with no scan on record opens none', async function () {
        handle.db.delete(schema.scans).run()
        enable('osv', 'npm')
        expect(baselines()).toEqual([])
    })

    it('a cell switched off again leaves, and the last one leaving closes it with nothing to say', async function () {
        target('per-project')
        recordSourceCellDisabled(handle.db, { source: 'osv', ecosystem: 'npm' }, Date.now())
        enable('osv', 'npm')
        enable('gemnasium', 'npm')
        recordSourceCellDisabled(handle.db, { source: 'osv', ecosystem: 'npm' }, Date.now())
        expect(JSON.parse(baselines()[0]?.cellsJson as string)).toEqual([{ source: 'gemnasium', ecosystem: 'npm' }])
        recordSourceCellDisabled(handle.db, { source: 'gemnasium', ecosystem: 'npm' }, Date.now())
        expect(baselines()[0]?.state).toBe('done')
        await tick()
        await sweep([NPM_AUDIT])
        expect(sent).toEqual([])
    })
})
