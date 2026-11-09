import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
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
    recordSourceCellEnabled,
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

type Reported = { advisoryId: string; packageName: string; severity: Severity; advisoryUrl?: string }

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
        advisoryId: r.advisoryId, advisoryTitle: r.advisoryId + ' title', advisoryUrl: r.advisoryUrl ?? null, packageName: r.packageName, ecosystem: 'npm', installedVersion: '1.0.0',
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

// Two sources disagree: npm audit stops reporting an advisory another source still reports. No ignore file and no edit,
// and the package is still vulnerable, so one message must not list it under HIGH and under Resolved.
describe('a row another source still has open', function () {
    const GHSA = 'GHSA-aaaa-bbbb-cccc'
    const NEWS = 'https://github.com/advisories/' + GHSA
    // What the second source answers for each project.
    let osv: Map<string, Reported[]>

    const npmFeed: ScannerPlugin = {
        name: 'osv',
        scan: async function scan(path, options) {
            const reported = options.ecosystem === 'npm' ? osv.get(path.split('/').pop() as string) ?? [] : []
            return { status: 'ok', reasonCode: 'ok', findings: reported.map(rawFinding), rawJson: '{}', errorText: null, durationMs: 1 }
        }
    } as ScannerPlugin

    function rowsOfA(): (typeof schema.findings.$inferSelect)[] {
        return handle.db.select().from(schema.findings).all().filter(function ofProject(row) { return row.projectId === id('a') })
    }

    function bothSources(): Promise<void> {
        return sweep([fakeAudit, npmFeed])
    }

    // One more finding on b, which is what carries a resolved row when a has no news of its own.
    async function sweepWithNews(): Promise<string> {
        const earlier = audit.get('b') as Reported[] | undefined ?? []
        const packageName = 'news-' + earlier.length
        audit.set('b', [...earlier, high('GHSA-' + packageName, packageName)])
        sent = []
        await bothSources()
        expect(to('summary')).toHaveLength(1)
        return to('summary')[0]?.markdown as string
    }

    function told(): number {
        return handle.db.select().from(schema.runSummaryResolvedTold).all().length
    }

    beforeEach(function enableSecondSource() {
        osv = new Map()
        setConfigValue(handle.db, sourceEnabledKey('osv', 'npm'), true)
        target('summary', 'run_summary')
    })

    it('is not told while that source reports the package under HIGH, and is told once when it closes too', async function () {
        audit.set('a', [high(GHSA)])
        osv.set('a', [high(GHSA)])
        await bothSources()
        audit.set('a', [])
        sent = []
        await bothSources()
        expect(rowsOfA().map(function open(row) { return [row.source, row.resolvedAt === null] }).sort()).toEqual([['npm-audit', false], ['osv', true]])
        expect(to('summary')).toHaveLength(1)
        expect(to('summary')[0]?.markdown).toContain('a › lodash')
        expect(to('summary')[0]?.markdown).not.toContain('Resolved')
        expect(told()).toBe(0)
        osv.delete('a')
        expect(await sweepWithNews()).toContain('*Resolved*\n• a › lodash (Node.js): 1 advisory')
        expect(told()).toBe(2)
        expect(await sweepWithNews()).not.toContain('Resolved')
    })

    // npm audit's numeric id, with only its url to say which advisory it is, on a row whose key nothing refreshes now.
    it('is held by the evidence of a numeric id whose key is gone, and reads as one advisory when both have closed', async function () {
        audit.set('a', [{ ...high('1234'), advisoryUrl: NEWS }])
        osv.set('a', [high(GHSA)])
        await bothSources()
        audit.set('a', [])
        await bothSources()
        handle.sqlite.prepare('UPDATE findings SET advisory_key = NULL WHERE resolved_at IS NOT NULL').run()
        expect(rowsOfA().filter(function closed(row) { return row.resolvedAt !== null }).map(function key(row) { return [row.advisoryId, row.advisoryKey] })).toEqual([['1234', null]])
        expect(await sweepWithNews()).not.toContain('Resolved')
        expect(told()).toBe(0)
        osv.delete('a')
        expect(await sweepWithNews()).toContain('*Resolved*\n• a › lodash (Node.js): 1 advisory')
        expect(told()).toBe(2)
        expect(await sweepWithNews()).not.toContain('Resolved')
    })

    it('is told when what stays open is another advisory of the package', async function () {
        audit.set('a', [high('GHSA-fixed')])
        osv.set('a', [high('GHSA-still-open')])
        await bothSources()
        audit.set('a', [])
        expect(await sweepWithNews()).toContain('*Resolved*\n• a › lodash (Node.js): 1 advisory')
        expect(told()).toBe(1)
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

const GEMFILE_LOCK = ['GEM', '  remote: https://rubygems.org/', '  specs:', '    rack (2.0.8)', '', 'PLATFORMS', '  ruby', '', 'DEPENDENCIES', '  rack', ''].join('\n')

// What the Ruby cell answers for each project; nothing for one not named.
let ruby: Map<string, string[]>

// Reports the version GEMFILE_LOCK installs, so the runner finds each copy in the real graph and names its manifest.
const rubyFeed: ScannerPlugin = {
    name: 'osv',
    scan: async function scan(path, options) {
        const advisories = options.ecosystem === 'RubyGems' ? ruby.get(path.split('/').pop() as string) ?? [] : []
        const findings = advisories.map(function row(advisoryId) { return { ...rawFinding({ advisoryId, packageName: 'rack', severity: 'high' }), ecosystem: 'RubyGems', installedVersion: '2.0.8' } })
        return { status: 'ok', reasonCode: 'ok', findings, rawJson: '{}', errorText: null, durationMs: 1 }
    }
} as ScannerPlugin

// An ignore file over a manifest takes it out of the scan as surely as an exclusion does, and nothing read it when the
// row closed. Named by where the rule sits, with the configured exclusions that say nothing about the manifest.
const IGNORE_ONLY = [
    ['.gitignore in the project', join('a', '.gitignore'), 'ios/'],
    ['.sentinelloignore in the project', join('a', '.sentinelloignore'), 'ios/'],
    ['.gitignore at the root', '.gitignore', 'a/ios/'],
    ['.sentinelloignore at the root', '.sentinelloignore', 'a/ios/']
] as const
const NO_RELEVANT_EXCLUSION: readonly (readonly [string, string[]])[] = [['no exclusions', []], ['an unrelated exclusion', ['elsewhere']]]
const IGNORE_ONLY_CASES = IGNORE_ONLY.flatMap(function perExclusion([where, ignoreFile, rule]) {
    return NO_RELEVANT_EXCLUSION.map(function combined([label, exclusions]) { return [where + ' with ' + label, ignoreFile, rule, exclusions] as const })
})

// A row written before 3.8 names no manifest. Exclude the sub-manifest that supplied it and the merge can close it as
// absent, with the parent project intact: nothing then says the package went, only that nobody looks there any more.
describe('a resolved row that names no manifest', function () {
    // Each named project holds ios/Gemfile.lock and a finding from it, made legacy as a pre-3.8 row reads.
    async function legacyRows(...names: string[]): Promise<void> {
        target('summary', 'run_summary')
        setConfigValue(handle.db, sourceEnabledKey('osv', 'RubyGems'), true)
        ruby = new Map()
        for (const name of names) {
            await mkdir(join(rootPath, name, 'ios'))
            await writeFile(join(rootPath, name, 'ios', 'Gemfile.lock'), GEMFILE_LOCK)
            ruby.set(name, ['GHSA-' + name, 'GHSA-' + name + '2'])
        }
        await sweep([fakeAudit, rubyFeed])
        handle.sqlite.prepare('UPDATE findings SET installations_json = ?').run('[]')
        sent = []
    }

    function closedNamingNoManifest(name: string): void {
        const rows = handle.db.select().from(schema.findings).all().filter(function ofProject(row) { return row.projectId === id(name) })
        expect(rows).toHaveLength(2)
        for (const row of rows) {
            expect(row.resolvedAt).not.toBeNull()
            expect(row.installationsJson).toBe('[]')
        }
    }

    it('is not told while an exclusion hides a manifest of its project, and a proven one still rides along', async function () {
        await legacyRows('a', 'c')
        setConfigValue(handle.db, 'globalIgnore', ['a/ios'])
        ruby = new Map()
        audit.set('b', [high('GHSA-b')])
        await sweep([fakeAudit, rubyFeed])
        closedNamingNoManifest('a')
        closedNamingNoManifest('c')
        expect(to('summary')).toHaveLength(1)
        expect(to('summary')[0]?.markdown).toContain('*Resolved*\n• c › rack')
        expect(to('summary')[0]?.markdown).not.toContain('a › rack')
        // Once the manifest itself is gone, nothing hides it: the row closed for a reason that holds.
        await rm(join(rootPath, 'a', 'ios'), { recursive: true })
        sent = []
        audit.set('b', [high('GHSA-b'), high('GHSA-b2', 'axios')])
        await sweep([fakeAudit, rubyFeed])
        expect(to('summary')[0]?.markdown).toContain('*Resolved*\n• a › rack')
    })

    // An ignore file over the same directory must not hide the excluded manifest from the check: the row still went
    // because nobody looks there. Named by where the rule sits: the project, or a directory above it.
    it.each([
        ['.gitignore in the project', join('a', '.gitignore'), 'ios/'],
        ['.sentinelloignore in the project', join('a', '.sentinelloignore'), 'ios/'],
        ['.gitignore at the root', '.gitignore', 'a/ios/'],
        ['.sentinelloignore at the root', '.sentinelloignore', 'a/ios/']
    ])('is not told when a %s also covers the excluded manifest', async function (_name, ignoreFile, rule) {
        await legacyRows('a', 'c')
        setConfigValue(handle.db, 'globalIgnore', ['a/ios'])
        await writeFile(join(rootPath, ignoreFile), rule)
        ruby = new Map()
        audit.set('b', [high('GHSA-b')])
        await sweep([fakeAudit, rubyFeed])
        closedNamingNoManifest('a')
        closedNamingNoManifest('c')
        expect(to('summary')[0]?.markdown).toContain('*Resolved*\n• c › rack')
        expect(to('summary')[0]?.markdown).not.toContain('a › rack')
    })

    // The row stays owed until the manifest is gone, whatever the configured exclusions say.
    it.each(IGNORE_ONLY_CASES)('is not told while a %s hides its manifest, and is told once the manifest is gone', async function (_name, ignoreFile, rule, exclusions) {
        await legacyRows('a')
        setConfigValue(handle.db, 'globalIgnore', exclusions)
        await writeFile(join(rootPath, ignoreFile), rule)
        ruby = new Map()
        audit.set('b', [high('GHSA-b')])
        await sweep([fakeAudit, rubyFeed])
        closedNamingNoManifest('a')
        expect(to('summary')[0]?.markdown).toContain('b › lodash')
        expect(to('summary')[0]?.markdown).not.toContain('Resolved')
        await rm(join(rootPath, 'a', 'ios'), { recursive: true })
        sent = []
        audit.set('b', [high('GHSA-b'), high('GHSA-b2', 'axios')])
        await sweep([fakeAudit, rubyFeed])
        expect(to('summary')[0]?.markdown).toContain('*Resolved*\n• a › rack')
    })

    it('is told once the rule is lifted and a scan reads the manifest it hid', async function () {
        await legacyRows('a')
        setConfigValue(handle.db, 'globalIgnore', [])
        await writeFile(join(rootPath, 'a', '.gitignore'), 'ios/')
        ruby = new Map()
        audit.set('b', [high('GHSA-b')])
        await sweep([fakeAudit, rubyFeed])
        expect(to('summary')[0]?.markdown).not.toContain('Resolved')
        await rm(join(rootPath, 'a', '.gitignore'))
        sent = []
        audit.set('b', [high('GHSA-b'), high('GHSA-b2', 'axios')])
        await sweep([fakeAudit, rubyFeed])
        expect(to('summary')[0]?.markdown).toContain('*Resolved*\n• a › rack')
    })

    // Ignoring something holds nothing back by itself, or almost every project's legacy rows would stay owed for good:
    // an ignored directory with no manifest hides none, and no scan ever searches a vendored one.
    it.each([
        ['with no manifest in it', 'tmp', 'notes.txt', 'scratch'],
        ['that holds only vendored dependencies', 'vendor', 'Gemfile.lock', GEMFILE_LOCK]
    ])('is told when an ignored directory %s is all its ignore file covers', async function (_name, directory, file, content) {
        await legacyRows('a')
        await rm(join(rootPath, 'a', 'ios'), { recursive: true })
        setConfigValue(handle.db, 'globalIgnore', [])
        await mkdir(join(rootPath, 'a', directory))
        await writeFile(join(rootPath, 'a', directory, file), content)
        await writeFile(join(rootPath, 'a', '.gitignore'), directory + '/')
        ruby = new Map()
        audit.set('b', [high('GHSA-b')])
        await sweep([fakeAudit, rubyFeed])
        closedNamingNoManifest('a')
        expect(to('summary')[0]?.markdown).toContain('*Resolved*\n• a › rack')
    })

    it('is told when no exclusion is set', async function () {
        await legacyRows('a')
        ruby = new Map()
        audit.set('b', [high('GHSA-b')])
        await sweep([fakeAudit, rubyFeed])
        closedNamingNoManifest('a')
        expect(to('summary')[0]?.markdown).toContain('*Resolved*\n• a › rack')
    })

    it('is not told while a directory of its project cannot be read', async function () {
        await legacyRows('a')
        setConfigValue(handle.db, 'globalIgnore', ['elsewhere'])
        ruby = new Map()
        await sweep([fakeAudit, rubyFeed])
        closedNamingNoManifest('a')
        await chmod(join(rootPath, 'a', 'ios'), 0o000)
        try {
            audit.set('b', [high('GHSA-b')])
            await sweep([fakeAudit, rubyFeed])
            expect(to('summary')[0]?.markdown).toContain('b › lodash')
            expect(to('summary')[0]?.markdown).not.toContain('Resolved')
        } finally {
            await chmod(join(rootPath, 'a', 'ios'), 0o755)
        }
    })

    it('is not told when its project\'s directory is gone', async function () {
        await legacyRows('a')
        setConfigValue(handle.db, 'globalIgnore', ['elsewhere'])
        ruby = new Map()
        await sweep([fakeAudit, rubyFeed])
        closedNamingNoManifest('a')
        await rm(join(rootPath, 'a'), { recursive: true })
        await request('manual', { projectId: id('a') }, [fakeAudit, rubyFeed])
        expect(to('summary')).toHaveLength(1)
        expect(to('summary')[0]?.markdown).not.toContain('Resolved')
    })
})

// A row that names its manifests can be asked about them. Discovery dropping a directory an ignore file now covers closes
// the row with the lockfile untouched, and that closing says nothing about the package.
describe('a resolved row that names its manifests', function () {
    // Project a holds these directories' Gemfile.locks and one finding with a copy through each.
    async function rowThrough(...directories: string[]): Promise<void> {
        target('summary', 'run_summary')
        setConfigValue(handle.db, sourceEnabledKey('osv', 'RubyGems'), true)
        for (const directory of directories) {
            await mkdir(join(rootPath, 'a', directory))
            await writeFile(join(rootPath, 'a', directory, 'Gemfile.lock'), GEMFILE_LOCK)
        }
        ruby = new Map([['a', ['GHSA-a']]])
        await sweep([fakeAudit, rubyFeed])
        expect(rowOf().resolvedAt).toBeNull()
        sent = []
    }

    function rowsOf(): (typeof schema.findings.$inferSelect)[] {
        return handle.db.select().from(schema.findings).all().filter(function ofProject(row) { return row.projectId === id('a') })
    }

    function rowOf(): typeof schema.findings.$inferSelect {
        const rows = rowsOf()
        expect(rows).toHaveLength(1)
        return rows[0] as typeof schema.findings.$inferSelect
    }

    function closedNaming(...manifests: string[]): void {
        const row = rowOf()
        expect(row.resolvedAt).not.toBeNull()
        expect((JSON.parse(row.installationsJson) as { manifestPath: string }[]).map(function path(copy) { return copy.manifestPath }).sort()).toEqual(manifests)
    }

    // One more finding on b, which is what carries a resolved row. b keeps the earlier ones, so none of them resolves.
    async function sweepWithNews(): Promise<RenderedMessage> {
        const earlier = audit.get('b') as Reported[] | undefined ?? []
        const packageName = 'news-' + earlier.length
        audit.set('b', [...earlier, high('GHSA-' + packageName, packageName)])
        sent = []
        await sweep([fakeAudit, rubyFeed])
        expect(to('summary')).toHaveLength(1)
        expect(to('summary')[0]?.markdown).toContain('b › ' + packageName)
        return to('summary')[0] as RenderedMessage
    }

    it.each(IGNORE_ONLY_CASES)('is not told while a %s hides an unchanged lockfile, and is told once it is gone', async function (_name, ignoreFile, rule, exclusions) {
        await rowThrough('ios')
        setConfigValue(handle.db, 'globalIgnore', exclusions)
        await writeFile(join(rootPath, ignoreFile), rule)
        ruby = new Map()
        expect((await sweepWithNews()).markdown).not.toContain('Resolved')
        closedNaming('ios/Gemfile.lock')
        // Held, not acknowledged: a second message still leaves it out, and it is owed when the lockfile goes.
        expect((await sweepWithNews()).markdown).not.toContain('Resolved')
        await rm(join(rootPath, 'a', 'ios'), { recursive: true })
        expect((await sweepWithNews()).markdown).toContain('*Resolved*\n• a › rack')
        expect((await sweepWithNews()).markdown).not.toContain('Resolved')
    })

    it.each([
        ['.gitignore', '.gitignore'],
        ['.sentinelloignore', '.sentinelloignore']
    ])('is told once a %s rule is lifted and a scan reads the lockfile it hid', async function (_name, ignoreFile) {
        await rowThrough('ios')
        await writeFile(join(rootPath, 'a', ignoreFile), 'ios/')
        ruby = new Map()
        expect((await sweepWithNews()).markdown).not.toContain('Resolved')
        await rm(join(rootPath, 'a', ignoreFile))
        expect((await sweepWithNews()).markdown).toContain('*Resolved*\n• a › rack')
    })

    // Both copies go from the scan at once: one was read and is clean, the other was never read and proves nothing.
    it.each([
        ['.gitignore', '.gitignore', []],
        ['.gitignore', '.gitignore', ['elsewhere']],
        ['.sentinelloignore', '.sentinelloignore', []],
        ['.sentinelloignore', '.sentinelloignore', ['elsewhere']]
    ] as const)('a checked copy does not clear one a %s hides', async function (_name, ignoreFile, exclusions) {
        await rowThrough('ios', 'web')
        setConfigValue(handle.db, 'globalIgnore', [...exclusions])
        await writeFile(join(rootPath, 'a', ignoreFile), 'ios/')
        ruby = new Map()
        expect((await sweepWithNews()).markdown).not.toContain('Resolved')
        closedNaming('ios/Gemfile.lock', 'web/Gemfile.lock')
        await rm(join(rootPath, 'a', 'ios'), { recursive: true })
        expect((await sweepWithNews()).markdown).toContain('*Resolved*\n• a › rack')
    })

    it('with a hidden copy and a checked one is told once the rule is lifted and a scan reads both', async function () {
        await rowThrough('ios', 'web')
        await writeFile(join(rootPath, 'a', '.gitignore'), 'ios/')
        ruby = new Map()
        expect((await sweepWithNews()).markdown).not.toContain('Resolved')
        await rm(join(rootPath, 'a', '.gitignore'))
        expect((await sweepWithNews()).markdown).toContain('*Resolved*\n• a › rack')
    })

    it('is told when the manifest an ignore file hides is not one it names', async function () {
        await rowThrough('ios')
        await mkdir(join(rootPath, 'a', 'other'))
        await writeFile(join(rootPath, 'a', 'other', 'Gemfile.lock'), GEMFILE_LOCK)
        await writeFile(join(rootPath, 'a', '.gitignore'), 'other/')
        ruby = new Map()
        expect((await sweepWithNews()).markdown).toContain('*Resolved*\n• a › rack')
        closedNaming('ios/Gemfile.lock')
    })

    it('is told when its hidden lockfile was deleted, and a hidden manifest of another ecosystem is left in that directory', async function () {
        await rowThrough('ios')
        await writeFile(join(rootPath, 'a', 'ios', 'requirements.txt'), 'flask==2.0.0\n')
        await rm(join(rootPath, 'a', 'ios', 'Gemfile.lock'))
        await writeFile(join(rootPath, 'a', '.gitignore'), 'ios/')
        ruby = new Map()
        expect((await sweepWithNews()).markdown).toContain('*Resolved*\n• a › rack')
    })

    // A directory holds one manifest of an ecosystem, so whichever it holds now is the one the copy came through.
    it('is not told when the hidden directory still holds the bare manifest its lockfile left', async function () {
        await rowThrough('ios')
        await writeFile(join(rootPath, 'a', 'ios', 'Gemfile'), "gem 'rack'\n")
        await rm(join(rootPath, 'a', 'ios', 'Gemfile.lock'))
        await writeFile(join(rootPath, 'a', '.gitignore'), 'ios/')
        ruby = new Map()
        expect((await sweepWithNews()).markdown).not.toContain('Resolved')
    })

    // The walk classifies directories only: a rule naming the file stops nothing, so a scan read it.
    it('is told when an ignore rule names the lockfile but not its directory', async function () {
        await rowThrough('ios')
        await writeFile(join(rootPath, 'a', '.gitignore'), 'ios/Gemfile.lock')
        ruby = new Map()
        expect((await sweepWithNews()).markdown).toContain('*Resolved*\n• a › rack')
    })

    it('is told when nothing hides it', async function () {
        await rowThrough('ios')
        ruby = new Map()
        expect((await sweepWithNews()).markdown).toContain('*Resolved*\n• a › rack')
    })

    it('is held by an unreadable directory holding its manifest, not by another one', async function () {
        await rowThrough('ios')
        await mkdir(join(rootPath, 'a', 'other'))
        ruby = new Map()
        await sweep([fakeAudit, rubyFeed])
        closedNaming('ios/Gemfile.lock')
        await chmod(join(rootPath, 'a', 'ios'), 0o000)
        try {
            expect((await sweepWithNews()).markdown).not.toContain('Resolved')
        } finally {
            await chmod(join(rootPath, 'a', 'ios'), 0o755)
        }
        await chmod(join(rootPath, 'a', 'other'), 0o000)
        try {
            expect((await sweepWithNews()).markdown).toContain('*Resolved*\n• a › rack')
        } finally {
            await chmod(join(rootPath, 'a', 'other'), 0o755)
        }
    })

    it('is told when its project\'s directory is gone', async function () {
        await rowThrough('ios')
        ruby = new Map()
        await sweep([fakeAudit, rubyFeed])
        closedNaming('ios/Gemfile.lock')
        await rm(join(rootPath, 'a'), { recursive: true })
        sent = []
        await request('manual', { projectId: id('a') }, [fakeAudit, rubyFeed])
        expect(to('summary')).toHaveLength(1)
        expect(to('summary')[0]?.markdown).toContain('*Resolved*\n• a › rack')
    })

    // The rule's lifting finds the same advisory again. The merge opens a new row for it, so the old row is no longer
    // hidden and its closing is no longer true: the package is still vulnerable. It stays owed until that row closes too.
    it('is not told when it goes back to open, and is told once when the new row really closes', async function () {
        await rowThrough('ios')
        await writeFile(join(rootPath, 'a', '.gitignore'), 'ios/')
        ruby = new Map()
        expect((await sweepWithNews()).markdown).not.toContain('Resolved')
        closedNaming('ios/Gemfile.lock')
        await rm(join(rootPath, 'a', '.gitignore'))
        ruby = new Map([['a', ['GHSA-a']]])
        expect((await sweepWithNews()).markdown).not.toContain('Resolved')
        expect(rowsOf().map(function open(row) { return row.resolvedAt === null }).sort()).toEqual([false, true])
        expect(handle.db.select().from(schema.runSummaryResolvedTold).all()).toEqual([])
        ruby = new Map()
        const told = (await sweepWithNews()).markdown
        expect(told).toContain('*Resolved*\n• a › rack (Ruby): 1 advisory')
        expect(rowsOf().every(function closed(row) { return row.resolvedAt !== null })).toBe(true)
        expect(handle.db.select().from(schema.runSummaryResolvedTold).all()).toHaveLength(2)
        expect((await sweepWithNews()).markdown).not.toContain('Resolved')
    })

    // An older episode stays held for a hidden copy while a newer one of the same advisory comes and goes elsewhere. The
    // newer row names only what the scan read, so judged alone it would tell a fix with the hidden lockfile unread.
    describe('and a newer episode of its advisory closes while it is held', function () {
        function told(): string[] {
            return handle.db.select().from(schema.runSummaryResolvedTold).all().map(function finding(row) { return row.findingId }).sort()
        }

        // Project a: the row naming ios closes held, then a new row through web opens and closes. Leaves both owed.
        async function heldBesideClosedEpisode(): Promise<void> {
            await rowThrough('ios')
            await writeFile(join(rootPath, 'a', '.gitignore'), 'ios/')
            ruby = new Map()
            expect((await sweepWithNews()).markdown).not.toContain('Resolved')
            closedNaming('ios/Gemfile.lock')
            await mkdir(join(rootPath, 'a', 'web'))
            await writeFile(join(rootPath, 'a', 'web', 'Gemfile.lock'), GEMFILE_LOCK)
            ruby = new Map([['a', ['GHSA-a']]])
            expect((await sweepWithNews()).markdown).not.toContain('Resolved')
            ruby = new Map()
            expect((await sweepWithNews()).markdown).not.toContain('Resolved')
            expect(rowsOf()).toHaveLength(2)
            expect(rowsOf().every(function closed(row) { return row.resolvedAt !== null })).toBe(true)
            expect(told()).toEqual([])
        }

        it('tells neither while the copy is hidden, and one advisory once when the lockfile is gone', async function () {
            await heldBesideClosedEpisode()
            expect((await sweepWithNews()).markdown).not.toContain('Resolved')
            expect(told()).toEqual([])
            await rm(join(rootPath, 'a', 'ios'), { recursive: true })
            expect((await sweepWithNews()).markdown).toContain('*Resolved*\n• a › rack (Ruby): 1 advisory')
            expect(told()).toHaveLength(2)
            expect((await sweepWithNews()).markdown).not.toContain('Resolved')
        })

        it('tells one advisory once when the rule is lifted and a scan reads the lockfile clean', async function () {
            await heldBesideClosedEpisode()
            await rm(join(rootPath, 'a', '.gitignore'))
            expect((await sweepWithNews()).markdown).toContain('*Resolved*\n• a › rack (Ruby): 1 advisory')
            expect(told()).toHaveLength(2)
            expect((await sweepWithNews()).markdown).not.toContain('Resolved')
        })

        // Rows copied from the held one and changed in one respect, the key kept where it would otherwise join them.
        it('holds nothing of another project, ecosystem, package or advisory', async function () {
            await heldBesideClosedEpisode()
            const held = rowsOf()[0] as typeof schema.findings.$inferSelect
            const installationsJson = JSON.stringify([{ manifestPath: 'web/Gemfile.lock', version: '2.0.8' }])
            const others = {
                'other-project': { projectId: id('b') },
                'other-ecosystem': { ecosystem: 'npm' },
                'other-package': { packageName: 'sinatra' },
                'other-advisory': { advisoryId: 'GHSA-other', advisoryKey: 'ghsa-other' }
            }
            for (const [rowId, change] of Object.entries(others)) {
                handle.db.insert(schema.findings).values({ ...held, id: rowId, installationsJson, ...change }).run()
            }
            const { markdown } = await sweepWithNews()
            expect(markdown).toContain('b › rack (Ruby): 1 advisory')
            expect(markdown).toContain('a › rack (Node.js): 1 advisory')
            expect(markdown).toContain('a › sinatra (Ruby): 1 advisory')
            expect(markdown).toContain('a › rack (Ruby): 1 advisory')
            expect(told()).toEqual(['other-advisory', 'other-ecosystem', 'other-package', 'other-project'])
            await rm(join(rootPath, 'a', 'ios'), { recursive: true })
            expect((await sweepWithNews()).markdown).toContain('*Resolved*\n• a › rack (Ruby): 1 advisory')
            expect(told()).toHaveLength(6)
        })
    })

    // An edit to the ignore file while another copy is still reported: the scan sees one copy of a row that has two.
    describe.each([['.gitignore'], ['.sentinelloignore']])('and has a copy a %s hides while another is still reported', function (ignoreFile) {
        const IOS = { manifestPath: 'ios/Gemfile.lock', version: '2.0.7' }
        const WEB = { manifestPath: 'web/Gemfile.lock', version: '2.0.8' }

        function installations(): { manifestPath: string; version: string }[] {
            return (JSON.parse(rowOf().installationsJson) as { manifestPath: string; version: string }[]).sort(function byPath(x, y) { return x.manifestPath.localeCompare(y.manifestPath) })
        }

        // The row as a first scan left it, with facts only the ios copy carries; then that copy goes out of the scan.
        async function hiddenBesideReported(): Promise<void> {
            await rowThrough('ios', 'web')
            handle.sqlite.prepare('UPDATE findings SET installations_json = ?, installed_version = ?, dep_path_json = ?, is_dev = 1 WHERE project_id = ?')
                .run(JSON.stringify([IOS, WEB]), '2.0.7', JSON.stringify(['ios-app > rack']), id('a'))
            await writeFile(join(rootPath, 'a', ignoreFile), 'ios/')
            expect((await sweepWithNews()).markdown).not.toContain('Resolved')
            expect(rowOf().resolvedAt).toBeNull()
            expect(installations()).toEqual([IOS, WEB])
            expect(rowOf()).toMatchObject({ installedVersion: '2.0.7', isProd: true, isDev: true })
            expect(JSON.parse(rowOf().depPathJson)).toEqual(['ios-app > rack'])
        }

        it('keeps the copy and its facts, is not told when the other goes clean, and is told once the lockfile is gone', async function () {
            await hiddenBesideReported()
            ruby = new Map()
            expect((await sweepWithNews()).markdown).not.toContain('Resolved')
            expect(rowOf().resolvedAt).not.toBeNull()
            expect(installations()).toEqual([IOS, WEB])
            // Held, not acknowledged.
            expect((await sweepWithNews()).markdown).not.toContain('Resolved')
            expect(handle.db.select().from(schema.runSummaryResolvedTold).all()).toEqual([])
            await rm(join(rootPath, 'a', 'ios'), { recursive: true })
            expect((await sweepWithNews()).markdown).toContain('*Resolved*\n• a › rack')
            expect((await sweepWithNews()).markdown).not.toContain('Resolved')
        })

        it('drops the copy once its lockfile is gone while the row goes on', async function () {
            await hiddenBesideReported()
            await rm(join(rootPath, 'a', 'ios', 'Gemfile.lock'))
            expect((await sweepWithNews()).markdown).not.toContain('Resolved')
            expect(rowOf().resolvedAt).toBeNull()
            expect(installations()).toEqual([{ ...WEB, version: '2.0.8' }])
            expect(rowOf().installedVersion).toBe('2.0.8')
            expect(rowOf().isDev).toBe(false)
        })

        it('drops the copy once the rule is lifted and a scan reads it clean, and tells the row when the other goes clean', async function () {
            await hiddenBesideReported()
            await writeFile(join(rootPath, 'a', 'ios', 'Gemfile.lock'), GEMFILE_LOCK.replace('rack (2.0.8)', 'rack (3.1.0)'))
            await rm(join(rootPath, 'a', ignoreFile))
            expect((await sweepWithNews()).markdown).not.toContain('Resolved')
            expect(rowOf().resolvedAt).toBeNull()
            expect(installations()).toEqual([WEB])
            ruby = new Map()
            expect((await sweepWithNews()).markdown).toContain('*Resolved*\n• a › rack')
        })

        it('writes what a scan sees once the rule is lifted and the copy still reports the advisory, and tells nothing', async function () {
            await hiddenBesideReported()
            await rm(join(rootPath, 'a', ignoreFile))
            expect((await sweepWithNews()).markdown).not.toContain('Resolved')
            expect(rowOf().resolvedAt).toBeNull()
            expect(installations()).toEqual([{ ...IOS, version: '2.0.8' }, WEB])
            expect(rowOf()).toMatchObject({ installedVersion: '2.0.8', isDev: false })
        })

        it('is not told when the other goes clean, the rule is lifted and the copy still reports the advisory', async function () {
            await hiddenBesideReported()
            ruby = new Map()
            expect((await sweepWithNews()).markdown).not.toContain('Resolved')
            await rm(join(rootPath, 'a', ignoreFile))
            ruby = new Map([['a', ['GHSA-a']]])
            expect((await sweepWithNews()).markdown).not.toContain('Resolved')
            ruby = new Map()
            expect((await sweepWithNews()).markdown).toContain('*Resolved*\n• a › rack (Ruby): 1 advisory')
        })
    })

    it('keeps a copy in a directory neither walk can read, beside one still reported', async function () {
        await rowThrough('ios', 'web')
        await writeFile(join(rootPath, 'a', '.gitignore'), 'ios/')
        await chmod(join(rootPath, 'a', 'ios'), 0o000)
        try {
            expect((await sweepWithNews()).markdown).not.toContain('Resolved')
            expect(rowOf().resolvedAt).toBeNull()
            expect(JSON.parse(rowOf().installationsJson)).toHaveLength(2)
        } finally {
            await chmod(join(rootPath, 'a', 'ios'), 0o755)
        }
    })

    // An operator's exclusion keeps its own rule: a row in both places narrows to what is scanned (SENTINEL-172).
    it.each([
        ['an exclusion', ['a/ios'], false],
        ['an exclusion and an ignore file', ['a/ios'], true]
    ] as const)('narrows to what is scanned when %s covers the copy', async function (_name, exclusions, alsoIgnored) {
        await rowThrough('ios', 'web')
        setConfigValue(handle.db, 'globalIgnore', [...exclusions])
        if (alsoIgnored) await writeFile(join(rootPath, 'a', '.gitignore'), 'ios/')
        await sweepWithNews()
        expect(rowOf().resolvedAt).toBeNull()
        expect((JSON.parse(rowOf().installationsJson) as { manifestPath: string }[]).map(function path(copy) { return copy.manifestPath })).toEqual(['web/Gemfile.lock'])
    })

    it('keeps nothing when an ignore file hides a manifest the row never named', async function () {
        await rowThrough('web')
        await mkdir(join(rootPath, 'a', 'other'))
        await writeFile(join(rootPath, 'a', 'other', 'Gemfile.lock'), GEMFILE_LOCK)
        await writeFile(join(rootPath, 'a', '.gitignore'), 'other/')
        await sweepWithNews()
        expect((JSON.parse(rowOf().installationsJson) as { manifestPath: string }[]).map(function path(copy) { return copy.manifestPath })).toEqual(['web/Gemfile.lock'])
    })

    // An exclusion over one copy says nothing about that copy, whatever the checked one beside it says. The walk skips
    // only directories, so a rule naming the file never reaches `hidden`: the copy is asked about what is on the disk.
    describe.each([
        ['directory', 'a/ios'],
        ['file pattern', 'a/ios/Gemfile.lock']
    ])('and has one copy a %s exclusion covers, the other read clean', function (_kind, exclusion) {
        async function excludedBesideClean(): Promise<void> {
            await rowThrough('ios', 'web')
            setConfigValue(handle.db, 'globalIgnore', [exclusion])
            ruby = new Map()
            expect((await sweepWithNews()).markdown).not.toContain('Resolved')
            closedNaming('ios/Gemfile.lock', 'web/Gemfile.lock')
        }

        it('is not told, is not acknowledged, and is told once the excluded lockfile is gone', async function () {
            await excludedBesideClean()
            expect((await sweepWithNews()).markdown).not.toContain('Resolved')
            expect(handle.db.select().from(schema.runSummaryResolvedTold).all()).toEqual([])
            await rm(join(rootPath, 'a', 'ios'), { recursive: true })
            expect((await sweepWithNews()).markdown).toContain('*Resolved*\n• a › rack')
            expect((await sweepWithNews()).markdown).not.toContain('Resolved')
        })

        it('is told once the exclusion is lifted and a scan reads both clean', async function () {
            await excludedBesideClean()
            setConfigValue(handle.db, 'globalIgnore', [])
            expect((await sweepWithNews()).markdown).toContain('*Resolved*\n• a › rack')
        })

        it('is not told when the exclusion is lifted and the copy still reports the advisory', async function () {
            await excludedBesideClean()
            setConfigValue(handle.db, 'globalIgnore', [])
            ruby = new Map([['a', ['GHSA-a']]])
            expect((await sweepWithNews()).markdown).not.toContain('Resolved')
        })

        it('is held by the bare manifest its lockfile left, and not by a manifest of another ecosystem', async function () {
            await excludedBesideClean()
            await writeFile(join(rootPath, 'a', 'ios', 'Gemfile'), "gem 'rack'\n")
            await rm(join(rootPath, 'a', 'ios', 'Gemfile.lock'))
            expect((await sweepWithNews()).markdown).not.toContain('Resolved')
            await rm(join(rootPath, 'a', 'ios', 'Gemfile'))
            await writeFile(join(rootPath, 'a', 'ios', 'requirements.txt'), 'flask==2.0.0\n')
            expect((await sweepWithNews()).markdown).toContain('*Resolved*\n• a › rack')
        })
    })

    it('is held by an excluded copy in a directory it cannot read', async function () {
        await rowThrough('ios', 'web')
        setConfigValue(handle.db, 'globalIgnore', ['a/ios'])
        ruby = new Map()
        await chmod(join(rootPath, 'a', 'ios'), 0o000)
        try {
            expect((await sweepWithNews()).markdown).not.toContain('Resolved')
        } finally {
            await chmod(join(rootPath, 'a', 'ios'), 0o755)
        }
    })

    it('is not told while an exclusion covers every copy, even once the lockfile is gone', async function () {
        await rowThrough('ios')
        setConfigValue(handle.db, 'globalIgnore', ['a/ios'])
        ruby = new Map()
        expect((await sweepWithNews()).markdown).not.toContain('Resolved')
        closedNaming('ios/Gemfile.lock')
        await rm(join(rootPath, 'a', 'ios'), { recursive: true })
        expect((await sweepWithNews()).markdown).not.toContain('Resolved')
    })
})

// Scans do not wait for the summary queue. A recovery has to be read when its run ends, or a later scan overwrites it
// before anything sees it, and the told row silences that later failure until another recovery.
describe('a recovery while a send holds the queue', function () {
    function held(): { send: NotificationSender; release: () => void } {
        let release: () => void = function notYet() {}
        const gate = new Promise<void>(function wait(resolve) { release = resolve })
        return {
            release: function open() { release() },
            send: async function waiting(t, message) {
                sent.push({ targetId: t.id, message })
                await gate
                return { ok: true }
            }
        }
    }

    function sendStarted(count: number): Promise<void> {
        return vi.waitFor(function started() { expect(sent).toHaveLength(count) })
    }

    // The poller's line right after a scan, written just before the run's end is handled.
    function scansFinished(count: number): Promise<void> {
        return vi.waitFor(function finished() {
            const lines = vi.mocked(console.log).mock.calls.filter(function line(call) { return String(call[0]).includes('single-project scan finished') })
            expect(lines).toHaveLength(count)
        })
    }

    async function toldFailure(name: string): Promise<void> {
        target('summary', 'run_summary')
        audit.set(name, 'fail')
        await sweep()
        expect(to('summary')[0]?.markdown).toContain('• ' + name + ':')
        sent = []
    }

    it('survives another scan failing before the send settles, so that failure is told', async function () {
        await toldFailure('a')
        const hold = held()
        audit.set('b', [high('GHSA-b')])
        const running = sweepProjects({ db: handle.db, sqlite: handle.sqlite, runtime, send: hold.send }, async function list() { return [fakeAudit] })
        await sendStarted(1)
        audit.set('a', [])
        const recovery = request('automatic', { projectId: id('a') })
        await scansFinished(1)
        audit.set('a', 'fail')
        const failure = request('automatic', { projectId: id('a') })
        await scansFinished(2)
        hold.release()
        await Promise.all([running, recovery, failure])
        sent = []
        await sweep()
        expect(to('summary')).toHaveLength(1)
        expect(to('summary')[0]?.markdown).toContain('*Newly unscannable*\n• a:')
    })

    it('still goes after a told row the send in flight writes', async function () {
        target('summary', 'run_summary')
        const hold = held()
        audit.set('a', 'fail')
        const running = sweepProjects({ db: handle.db, sqlite: handle.sqlite, runtime, send: hold.send }, async function list() { return [fakeAudit] })
        await sendStarted(1)
        audit.set('a', [])
        const recovery = request('automatic', { projectId: id('a') })
        await scansFinished(1)
        hold.release()
        await Promise.all([running, recovery])
        expect(handle.db.select().from(schema.runSummaryUnscannableTold).all()).toEqual([])
    })

    it('is read by a full sweep before it waits for a baseline summary', async function () {
        await toldFailure('a')
        const newFeed: ScannerPlugin = {
            name: 'osv',
            scan: async function scan(path) {
                const findings = path.endsWith('/b') ? [rawFinding(high('GHSA-baseline'))] : []
                return { status: 'ok', reasonCode: 'ok', findings, rawJson: '{}', errorText: null, durationMs: 1 }
            }
        } as ScannerPlugin
        setConfigValue(handle.db, sourceEnabledKey('osv', 'npm'), true)
        recordSourceCellEnabled(handle.db, { source: 'osv', ecosystem: 'npm' }, Date.now())
        await new Promise(function later(resolve) { setTimeout(resolve, 3) })
        const hold = held()
        audit.set('a', [])
        const running = sweepProjects({ db: handle.db, sqlite: handle.sqlite, runtime, send: hold.send }, async function list() { return [fakeAudit, newFeed] })
        await sendStarted(1)
        expect(sent[0]?.message.title).toBe('Sentinello now checks Node.js with OSV')
        audit.set('a', 'fail')
        const failure = request('automatic', { projectId: id('a') }, [fakeAudit, newFeed])
        await scansFinished(1)
        hold.release()
        await Promise.all([running, failure])
        // The sweep's own summary follows its baseline's, and reads the failure as new.
        expect(to('summary')).toHaveLength(2)
        expect(to('summary')[1]?.markdown).toContain('*Newly unscannable*\n• a:')
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
