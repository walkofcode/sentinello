import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sourceEnabledKey, type NotificationTarget, type Severity } from '@sentinello/core'
import {
    enqueueScanRequest,
    getNotificationTargetById,
    insertMute,
    insertNotificationTarget,
    listProjects,
    projectId,
    schema,
    setConfigValue,
    setNotificationTargetDelivery,
    upsertRoot,
    type Root
} from '@sentinello/db'
import type { NotificationSender, RenderedMessage, SendResult } from '@sentinello/notifications'
import type { ScannerPlugin } from '@sentinello/scanners'
import { closeWorkerTestDb, makeTree, openWorkerTestDb, T0, type WorkerTestDb } from './worker-test-db.fixture'
import { createWorkerRuntime, type WorkerRuntime } from './runtime'
import { discoverProjects } from './discovery'
import { onRunFinished } from './run-summary'
import { pollOnce } from './scan-request-poller'
import { sweepProjects } from './scheduler'

// Replays of the run summary through the real discovery, runner, notifier, ledger and poller. Only the edges are
// fakes: the audit each project answers with, the package registries, and the sender.

vi.mock('@sentinello/fixes', async function mockFixes(importOriginal) {
    const actual = await importOriginal<typeof import('@sentinello/fixes')>()
    return { ...actual, createRegistryClients: function noRegistry() { return {} } }
})

const batchScanners = vi.hoisted(function holder() { return { current: [] as ScannerPlugin[] } })

vi.mock('./osv-runtime', async function mockOsvRuntime(importOriginal) {
    const actual = await importOriginal<typeof import('./osv-runtime')>()
    return { ...actual, scannersForBatch: async function scannersForBatch() { return batchScanners.current } }
})

type Reported = { advisoryId: string; packageName: string; severity: Severity }

let handle: WorkerTestDb
let runtime: WorkerRuntime
let root: Root
let rootPath: string
// What each project's audit answers: its findings, or 'fail'.
let audit: Map<string, Reported[] | 'fail'>
let sent: { targetId: string; message: RenderedMessage }[]
let answers: SendResult[]
let onSend: (() => void) | null

const send: NotificationSender = async function recording(target, message) {
    sent.push({ targetId: target.id, message })
    if (onSend) {
        const once = onSend
        onSend = null
        once()
    }
    return answers.shift() ?? { ok: true }
}

function rawFinding(r: Reported) {
    return {
        advisoryId: r.advisoryId, advisoryTitle: r.advisoryId + ' title', advisoryUrl: null, packageName: r.packageName, ecosystem: 'npm', installedVersion: '1.0.0',
        vulnerableRange: '<2.0.0', severity: r.severity, fixAvailable: false, fixVersion: null,
        fixInputs: { source: 'npm-audit', installed: ['1.0.0'], affected: { comparator: 'semver' as const, ranges: [], exact: [], complete: false }, patched: null, patchedSet: null, statedFix: null, fixViaParent: false },
        depPath: [], isProd: true, isDev: false, aliases: []
    }
}

const fakeAudit: ScannerPlugin = {
    name: 'npm-audit',
    scan: async function scan(path) {
        const report = audit.get(path.split('/').pop() as string) ?? []
        if (report === 'fail') return { status: 'error', reasonCode: 'audit_spawn_error', findings: [], rawJson: '', errorText: 'npm is gone', durationMs: 1 }
        return { status: 'ok', reasonCode: 'ok', findings: report.map(rawFinding), rawJson: '{}', errorText: null, durationMs: 1 }
    }
} as ScannerPlugin

// A feed source that answers ok and reports nothing, for a project on Bun, where npm audit is not attempted.
const quietFeed: ScannerPlugin = {
    name: 'osv',
    scan: async function scan() { return { status: 'ok', reasonCode: 'ok', findings: [], rawJson: '{}', errorText: null, durationMs: 1 } }
} as ScannerPlugin

function lockFor(name: string): Record<string, string> {
    return {
        [name + '/package.json']: JSON.stringify({ name, dependencies: { lodash: '1.0.0' } }),
        [name + '/package-lock.json']: JSON.stringify({ name, lockfileVersion: 3, packages: { '': { name, dependencies: { lodash: '1.0.0' } }, 'node_modules/lodash': { version: '1.0.0' } } })
    }
}

function target(id: string, delivery: NotificationTarget['delivery'], overrides: Partial<NotificationTarget> = {}): void {
    insertNotificationTarget(handle.db, {
        id, kind: 'webhook', config: { url: 'https://hooks.example.test/' + id }, severityFilter: ['critical', 'high', 'moderate', 'low', 'info'], envFilter: 'all', enabled: true,
        createdAt: T0, rootIds: [], projectIds: [], sourceScope: { mode: 'all', cells: [] }, delivery: 'per_project', weeklyDigest: true, digestEligibleSinceAt: null, ...overrides
    })
    if (delivery === 'run_summary') optIn(id)
}

function optIn(id: string): void {
    setNotificationTargetDelivery(handle.db, getNotificationTargetById(handle.db, id) as NotificationTarget, 'run_summary', Date.now())
}

function sweep(scanners: ScannerPlugin[] = [fakeAudit]): Promise<void> {
    return sweepProjects({ db: handle.db, sqlite: handle.sqlite, runtime, send }, async function list() { return scanners })
}

// A request as the poller claims it, with the scanners the batch reads.
async function request(origin: 'manual' | 'automatic', scope: { projectId?: string; rootId?: string } = {}, scanners: ScannerPlugin[] = [fakeAudit]): Promise<void> {
    batchScanners.current = scanners
    enqueueScanRequest(handle.db, scope, Date.now(), origin)
    await pollOnce({ db: handle.db, sqlite: handle.sqlite, runtime, scheduler: { reload: vi.fn(), stop: vi.fn() }, send })
}

function id(name: string): string {
    return projectId('code', name)
}

function to(targetId: string): RenderedMessage[] {
    return sent.filter(function mine(s) { return s.targetId === targetId }).map(function message(s) { return s.message })
}

function high(advisoryId: string, packageName = 'lodash'): Reported {
    return { advisoryId, packageName, severity: 'high' }
}

beforeEach(async function setup() {
    handle = await openWorkerTestDb('worker-run-summary')
    runtime = createWorkerRuntime()
    vi.spyOn(console, 'log').mockImplementation(function silence() {})
    vi.spyOn(console, 'error').mockImplementation(function silence() {})
    audit = new Map()
    sent = []
    answers = []
    onSend = null
    rootPath = await makeTree(handle.dir, 'code', { ...lockFor('a'), ...lockFor('b'), ...lockFor('c') })
    root = { id: 'code', path: rootPath, label: null, createdAt: T0 }
    upsertRoot(handle.db, root)
    discoverProjects({ db: handle.db, roots: [root], globalIgnore: [], at: T0 })
    setConfigValue(handle.db, 'globalIgnore', [])
})

afterEach(async function teardown() {
    vi.restoreAllMocks()
    await closeWorkerTestDb(handle)
})

describe('a sweep over many projects', function () {
    it('sends a run-summary target one message, and a per-project target its messages, then the second sweep is silent', async function () {
        target('summary', 'run_summary')
        target('per-project', 'per_project')
        audit.set('a', [high('GHSA-a')])
        audit.set('b', [{ advisoryId: 'GHSA-b', packageName: 'axios', severity: 'critical' }, { advisoryId: 'GHSA-m', packageName: 'ms', severity: 'moderate' }])
        audit.set('c', [{ advisoryId: 'GHSA-u', packageName: 'qs', severity: 'unrated' }])
        await sweep()
        expect(to('summary')).toHaveLength(1)
        const message = to('summary')[0] as RenderedMessage
        expect(message.title).toBe('Sentinello run summary: 1 critical, 1 high, 1 moderate, 1 unrated, 0 low, 0 info')
        expect(message.markdown).toContain('*CRITICAL*\n• b › axios (Node.js): 1 advisory, no fix released')
        expect(message.markdown).toContain('*HIGH*\n• a › lodash (Node.js): 1 advisory, no fix released')
        expect(message.markdown).not.toContain('ms')
        expect(to('per-project').map(function title(m) { return m.title }).sort()).toEqual([
            'Sentinello found vulnerabilities in a:',
            'Sentinello found vulnerabilities in b:',
            'Sentinello found vulnerabilities in c:'
        ])
        sent = []
        await sweep()
        expect(sent).toEqual([])
    })

    it('pins what a per-project target is sent', async function () {
        target('per-project', 'per_project')
        audit.set('a', [high('GHSA-a')])
        await sweep()
        expect(to('per-project')[0]?.markdown).toBe([
            'Sentinello found vulnerabilities in *a*:',
            '• [HIGH] lodash@1.0.0 (Node.js, GHSA-a) — no fix stated by the advisory · not checked against the registry',
            '    In: package-lock.json 1.0.0',
            '    Path: chain unknown (the lockfile records no dependency graph)'
        ].join('\n'))
    })

    it('never gives a run-summary target a per-project finding or scan-failure message, from any kind of scan', async function () {
        target('summary', 'run_summary')
        audit.set('a', [high('GHSA-a')])
        audit.set('b', 'fail')
        await request('automatic', { projectId: id('a') })
        await request('automatic', { projectId: id('b') })
        await request('automatic')
        expect(sent).toEqual([])
    })

    it('tells nothing of a sweep that was aborted, and everything stays owed', async function () {
        target('summary', 'run_summary')
        audit.set('a', [high('GHSA-a')])
        await onRunFinished(handle.db, { kind: 'scheduled', projectIds: null, completed: false, send })
        expect(sent).toEqual([])
        await sweep()
        expect(to('summary')).toHaveLength(1)
    })

    it('skips a target that is switched off, and a target it cannot reach fails alone', async function () {
        target('off', 'run_summary', { enabled: false })
        target('broken', 'run_summary')
        target('fine', 'run_summary')
        audit.set('a', [high('GHSA-a')])
        const throwing: NotificationSender = async function sender(t, message) {
            if (t.id === 'broken') throw new Error('no route')
            return send(t, message)
        }
        await sweepProjects({ db: handle.db, sqlite: handle.sqlite, runtime, send: throwing }, async function list() { return [fakeAudit] })
        expect(sent.map(function who(s) { return s.targetId })).toEqual(['fine'])
    })

    it('in dry run logs and records nothing, so turning it off sends what was owed', async function () {
        target('summary', 'run_summary')
        setConfigValue(handle.db, 'dryRunNotify', true)
        audit.set('a', [high('GHSA-a')])
        await sweep()
        expect(sent).toEqual([])
        setConfigValue(handle.db, 'dryRunNotify', false)
        await sweep()
        expect(to('summary')).toHaveLength(1)
    })
})

describe('what is scoped to which run', function () {
    it('holds a watcher scan for the next scheduled sweep', async function () {
        target('summary', 'run_summary')
        audit.set('a', [high('GHSA-a')])
        await request('automatic', { projectId: id('a') })
        expect(sent).toEqual([])
        await sweep()
        expect(to('summary')).toHaveLength(1)
        expect(to('summary')[0]?.markdown).toContain('a › lodash')
    })

    it('holds a cache-landed sweep too', async function () {
        target('summary', 'run_summary')
        audit.set('a', [high('GHSA-a')])
        await request('automatic')
        expect(sent).toEqual([])
    })

    it('tells a manual scan of a project about that project alone, including what a watcher left there', async function () {
        target('summary', 'run_summary')
        audit.set('a', [high('GHSA-a')])
        audit.set('b', [high('GHSA-b')])
        await request('automatic', { projectId: id('a') })
        await request('automatic', { projectId: id('b') })
        await request('manual', { projectId: id('a') })
        expect(to('summary')).toHaveLength(1)
        expect(to('summary')[0]?.markdown).toContain('a › lodash')
        expect(to('summary')[0]?.markdown).not.toContain('b › lodash')
        sent = []
        await sweep()
        expect(to('summary')[0]?.markdown).toContain('b › lodash')
        expect(to('summary')[0]?.markdown).not.toContain('a › lodash')
    })

    it('tells a manual root sweep and a manual full sweep what they scanned', async function () {
        target('summary', 'run_summary')
        audit.set('a', [high('GHSA-a')])
        await request('manual', { rootId: 'code' })
        expect(to('summary')).toHaveLength(1)
        sent = []
        audit.set('b', [high('GHSA-b')])
        await request('manual')
        expect(to('summary')[0]?.markdown).toContain('b › lodash')
    })

    it('sends nothing when a manual scan finds nothing new', async function () {
        target('summary', 'run_summary')
        await request('manual', { projectId: id('a') })
        expect(sent).toEqual([])
    })
})

describe('a dead channel', function () {
    it('retries on the next run, tells the same events once, and a run with nothing new of its own still retries', async function () {
        target('summary', 'run_summary')
        audit.set('a', [high('GHSA-a')])
        answers = [{ ok: false, errorText: 'down' }, { ok: false, errorText: 'still down' }]
        await sweep()
        await sweep()
        expect(to('summary')).toHaveLength(2)
        sent = []
        await sweep()
        expect(to('summary')).toHaveLength(1)
        expect(to('summary')[0]?.title).toContain('1 high')
        sent = []
        await sweep()
        expect(sent).toEqual([])
    })

    it('leaves another project\'s debt for a run that covers it', async function () {
        target('summary', 'run_summary')
        audit.set('a', [high('GHSA-a')])
        answers = [{ ok: false, errorText: 'down' }]
        await sweep()
        sent = []
        await request('manual', { projectId: id('b') })
        expect(sent).toEqual([])
    })
})

describe('resolved rows', function () {
    async function toldThenFixed(name: string): Promise<void> {
        audit.set(name, [high('GHSA-' + name)])
        await sweep()
        audit.set(name, [])
        sent = []
    }

    it('send nothing alone, and are told with the next message that goes out', async function () {
        target('summary', 'run_summary')
        await toldThenFixed('a')
        await sweep()
        expect(sent).toEqual([])
        audit.set('b', [high('GHSA-b')])
        await sweep()
        expect(to('summary')).toHaveLength(1)
        expect(to('summary')[0]?.markdown).toContain('*Resolved*\n• a › lodash (Node.js): 1 advisory')
        sent = []
        audit.set('c', [high('GHSA-c')])
        await sweep()
        expect(to('summary')[0]?.markdown).not.toContain('Resolved')
    })

    it('a manual scan of one project leaves another\'s resolution owed', async function () {
        target('summary', 'run_summary')
        await toldThenFixed('b')
        await request('automatic', { projectId: id('b') })
        audit.set('a', [high('GHSA-a')])
        await request('manual', { projectId: id('a') })
        expect(to('summary')).toHaveLength(1)
        expect(to('summary')[0]?.markdown).not.toContain('Resolved')
        sent = []
        audit.set('c', [high('GHSA-c')])
        await sweep()
        expect(to('summary')[0]?.markdown).toContain('*Resolved*\n• b › lodash')
    })

    it('a resolution that arrives while the send is pending stays owed', async function () {
        target('summary', 'run_summary')
        audit.set('a', [high('GHSA-a')])
        audit.set('b', [high('GHSA-b')])
        await sweep()
        sent = []
        audit.set('c', [high('GHSA-c')])
        onSend = function aResolves() {
            handle.sqlite.prepare('UPDATE findings SET resolved_at = ? WHERE project_id = ?').run(Date.now(), id('a'))
        }
        await sweep()
        expect(to('summary')[0]?.markdown).not.toContain('Resolved')
        sent = []
        audit.set('a', [])
        audit.set('b', [high('GHSA-b'), high('GHSA-b2', 'axios')])
        await sweep()
        expect(to('summary')[0]?.markdown).toContain('*Resolved*\n• a › lodash')
    })

    it('stay owed through a failed send', async function () {
        target('summary', 'run_summary')
        await toldThenFixed('a')
        await sweep()
        audit.set('b', [high('GHSA-b')])
        answers = [{ ok: false, errorText: 'down' }]
        await sweep()
        expect(to('summary')[0]?.markdown).toContain('Resolved')
        sent = []
        await sweep()
        expect(to('summary')[0]?.markdown).toContain('Resolved')
        sent = []
        audit.set('c', [high('GHSA-c')])
        await sweep()
        expect(to('summary')[0]?.markdown).not.toContain('Resolved')
    })

    it('leave out rows from before the opt-in, notices, and what an exclusion took away', async function () {
        target('summary', 'per_project')
        audit.set('a', [high('GHSA-before')])
        await sweep()
        audit.set('a', [])
        await sweep()
        optIn('summary')
        const at = Date.now()
        handle.sqlite.prepare("UPDATE notification_targets SET run_summary_since_at = ? WHERE id = 'summary'").run(at + 1)
        audit.set('b', [high('GHSA-b')])
        sent = []
        await sweep()
        expect(to('summary')[0]?.markdown).not.toContain('Resolved')
        handle.sqlite.prepare("UPDATE notification_targets SET run_summary_since_at = 0 WHERE id = 'summary'").run()
        handle.sqlite.prepare("UPDATE findings SET notice_kind = 'unmaintained' WHERE project_id = ?").run(id('a'))
        sent = []
        audit.set('c', [high('GHSA-c')])
        await sweep()
        expect(to('summary')[0]?.markdown).not.toContain('Resolved')
        handle.sqlite.prepare('UPDATE findings SET notice_kind = NULL, installations_json = ? WHERE project_id = ?').run(JSON.stringify([{ manifestPath: 'package-lock.json', version: '1.0.0' }]), id('a'))
        setConfigValue(handle.db, 'globalIgnore', ['a/package-lock.json'])
        sent = []
        audit.set('b', [high('GHSA-b'), high('GHSA-b3', 'qs')])
        await sweep()
        expect(to('summary')[0]?.markdown).not.toContain('Resolved')
    })
})

// A project that moves to Bun loses its npm audit rows through closeUninstalled: no scan writes the close, and
// resolved_scan_id stays null. Selecting through a scan or an outcome would miss them.
describe('a row a move to Bun closed, with no scan behind it', function () {
    const BUN_LOCK = '{ "lockfileVersion": 1, "workspaces": { "": { "dependencies": { "lodash": "2" } } }, "packages": { "lodash": ["lodash@2.0.0", "", {}, "x"] } }'

    async function movedToBun(name: string): Promise<void> {
        audit.set(name, [high('GHSA-' + name)])
        await sweep()
        await rm(join(rootPath, name, 'package-lock.json'))
        await writeFile(join(rootPath, name, 'bun.lock'), BUN_LOCK)
        audit.delete(name)
        setConfigValue(handle.db, sourceEnabledKey('osv', 'npm'), true)
        sent = []
    }

    function closedWithoutAScan(name: string): void {
        const rows = handle.db.select().from(schema.findings).all().filter(function ofProject(row) { return row.projectId === id(name) })
        expect(rows).toHaveLength(1)
        expect(rows[0]?.resolvedAt).not.toBeNull()
        expect(rows[0]?.resolvedScanId).toBeNull()
    }

    it('is silent alone, and told with the next message', async function () {
        target('summary', 'run_summary')
        await movedToBun('a')
        await sweep([fakeAudit, quietFeed])
        closedWithoutAScan('a')
        expect(sent).toEqual([])
        audit.set('b', [high('GHSA-b')])
        await sweep([fakeAudit, quietFeed])
        expect(to('summary')).toHaveLength(1)
        expect(to('summary')[0]?.markdown).toContain('*Resolved*\n• a › lodash')
    })

    it('stays owed when a manual scan of another project sends', async function () {
        target('summary', 'run_summary')
        await movedToBun('a')
        await request('automatic', { projectId: id('a') }, [fakeAudit, quietFeed])
        closedWithoutAScan('a')
        audit.set('b', [high('GHSA-b')])
        await request('manual', { projectId: id('b') }, [fakeAudit, quietFeed])
        expect(to('summary')[0]?.markdown).not.toContain('Resolved')
        sent = []
        audit.set('c', [high('GHSA-c')])
        await request('manual', { projectId: id('a') }, [fakeAudit, quietFeed])
        expect(sent).toEqual([])
        await sweep([fakeAudit, quietFeed])
        expect(to('summary')[0]?.markdown).toContain('*Resolved*\n• a › lodash')
    })

    it('is retried after a failed send, and told once', async function () {
        target('summary', 'run_summary')
        await movedToBun('a')
        audit.set('b', [high('GHSA-b')])
        answers = [{ ok: false, errorText: 'down' }]
        await sweep([fakeAudit, quietFeed])
        closedWithoutAScan('a')
        expect(to('summary')[0]?.markdown).toContain('Resolved')
        sent = []
        await sweep([fakeAudit, quietFeed])
        expect(to('summary')[0]?.markdown).toContain('Resolved')
        sent = []
        audit.set('c', [high('GHSA-c')])
        await sweep([fakeAudit, quietFeed])
        expect(to('summary')[0]?.markdown).not.toContain('Resolved')
    })
})

describe('newly unscannable projects', function () {
    it('tells a failure, stays quiet while it lasts, and tells it again after a quiet recovery', async function () {
        target('summary', 'run_summary')
        audit.set('a', 'fail')
        await sweep()
        expect(to('summary')).toHaveLength(1)
        expect(to('summary')[0]?.markdown).toContain('*Newly unscannable*\n• a:')
        sent = []
        await sweep()
        expect(sent).toEqual([])
        audit.set('a', [])
        await sweep()
        expect(sent).toEqual([])
        audit.set('a', 'fail')
        await sweep()
        expect(to('summary')).toHaveLength(1)
    })

    it('observes a recovery on an automatic scan, which sends nothing', async function () {
        target('summary', 'run_summary')
        audit.set('a', 'fail')
        await sweep()
        audit.set('a', [])
        sent = []
        await request('automatic', { projectId: id('a') })
        expect(sent).toEqual([])
        audit.set('a', 'fail')
        await sweep()
        expect(to('summary')).toHaveLength(1)
    })

    it('retries a failed send while the project still fails, and drops it once it recovered', async function () {
        target('summary', 'run_summary')
        audit.set('a', 'fail')
        answers = [{ ok: false, errorText: 'down' }]
        await sweep()
        expect(to('summary')).toHaveLength(1)
        sent = []
        await sweep()
        expect(to('summary')).toHaveLength(1)
        sent = []
        audit.set('b', 'fail')
        answers = [{ ok: false, errorText: 'down' }]
        await sweep()
        expect(to('summary')[0]?.markdown).toContain('• b:')
        sent = []
        audit.set('b', [])
        await sweep()
        expect(sent).toEqual([])
    })

    it('has nothing to decide when opting in on a quiet run: what already fails is not new', async function () {
        target('summary', 'per_project')
        audit.set('a', 'fail')
        await sweep()
        optIn('summary')
        sent = []
        await sweep()
        expect(sent).toEqual([])
        audit.set('b', 'fail')
        await sweep()
        expect(to('summary')[0]?.markdown).toContain('• b:')
        expect(to('summary')[0]?.markdown).not.toContain('• a:')
    })

    it('leaves a muted project out, keeps what was told across the mute, and tells what it hid after the unmute', async function () {
        target('summary', 'run_summary')
        audit.set('a', 'fail')
        await sweep()
        sent = []
        const mute = { scope: 'project' as const, projectId: id('a'), reason: 'r', author: 'a', createdAt: T0, expiresAt: null }
        insertMute(handle.db, { id: 'told', ...mute })
        insertMute(handle.db, { id: 'hidden', ...mute, projectId: id('b') })
        audit.set('b', 'fail')
        await sweep()
        expect(sent).toEqual([])
        handle.sqlite.prepare('DELETE FROM mutes').run()
        await sweep()
        expect(to('summary')).toHaveLength(1)
        expect(to('summary')[0]?.markdown).toContain('• b:')
        expect(to('summary')[0]?.markdown).not.toContain('• a:')
    })

    it('deletes the told row of a project that recovers under a mute', async function () {
        target('summary', 'run_summary')
        audit.set('a', 'fail')
        await sweep()
        insertMute(handle.db, { id: 'm', scope: 'project', projectId: id('a'), reason: 'r', author: 'a', createdAt: T0, expiresAt: null })
        audit.set('a', [])
        await sweep()
        handle.sqlite.prepare('DELETE FROM mutes').run()
        sent = []
        audit.set('a', 'fail')
        await sweep()
        expect(to('summary')).toHaveLength(1)
    })

    it('stops being told per project once a run summary carries it, even after opting out', async function () {
        target('summary', 'run_summary')
        audit.set('a', 'fail')
        await sweep()
        setNotificationTargetDelivery(handle.db, getNotificationTargetById(handle.db, 'summary') as NotificationTarget, 'per_project', Date.now())
        sent = []
        await sweep()
        expect(sent).toEqual([])
        expect(handle.db.select().from(schema.runSummaryUnscannableTold).all()).toEqual([])
    })

    it('counts a project once whatever its sources say, and every run reads the scope it scanned', async function () {
        expect(listProjects(handle.db)).toHaveLength(3)
        target('summary', 'run_summary', { projectIds: [] })
        audit.set('a', 'fail')
        await request('manual', { projectId: id('b') })
        expect(sent).toEqual([])
        await request('manual', { projectId: id('a') })
        expect(to('summary')).toHaveLength(1)
    })
})
