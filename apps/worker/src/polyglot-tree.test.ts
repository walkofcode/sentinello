import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CAPABILITIES, sourceEnabledKey, type EcosystemId } from '@sentinello/core'
import {
    getBaselineState,
    getProjectScanState,
    insertNotificationTarget,
    insertScan,
    listCurrentFindingsForProject,
    listProjects,
    listSummaryDeliveries,
    getSourceEnabled,
    projectId,
    seedCapabilityBaselines,
    setConfigValue,
    upsertRoot
} from '@sentinello/db'
import { createOsvScanner, type OsvAdvisory } from '@sentinello/scanners'
import type { NotificationSender, RenderedMessage } from '@sentinello/notifications'
import { discoverProjects } from './discovery'
import { runBatch } from './runner'
import { onCompletedSweep } from './capability-baseline'
import { closeWorkerTestDb, makeTree, openWorkerTestDb, seedProject, T0, type WorkerTestDb } from './worker-test-db.fixture'

// Milestone 2's smoke case, end to end through the worker on a tree built at runtime: discovery boundaries,
// one finding across two manifests, the source-disabled marker and the silent baseline, together.
//
//   code/                         a repo-root requirements.txt: a Python project of its own...
//     apps/mobile/                ...beside the apps/* npm projects, never instead of them
//       ios/Gemfile.lock          rack 2.0.8   } both owned by the Expo app,
//       android/Gemfile.lock      rack 2.2.3   } one finding listing both
//     apps/web/
//   other/py-only/                a Python-only project, with OSV off for Python

const LOCK = JSON.stringify({ name: 'app', lockfileVersion: 3, packages: { '': { name: 'app', dependencies: { lodash: '4.17.21' } }, 'node_modules/lodash': { version: '4.17.21' } } })

function gemfileLock(rack: string): string {
    return ['GEM', '  remote: https://rubygems.org/', '  specs:', '    rack (' + rack + ')', '', 'PLATFORMS', '  ruby', '', 'DEPENDENCIES', '  rack', '', 'BUNDLED WITH', '   2.4.10', ''].join('\n')
}

const RACK: OsvAdvisory = {
    advisoryId: 'GHSA-rack-1',
    aliases: [],
    ranges: [{ type: 'ECOSYSTEM', introduced: '0', fixed: '2.2.6.4', lastAffected: null }],
    versions: [],
    severity: 'high',
    summary: 'Denial of service in multipart parsing',
    url: 'https://osv.example/GHSA-rack-1',
    malicious: false,
    withdrawn: null
}

let handle: WorkerTestDb
let sent: { targetId: string; message: RenderedMessage }[]

const recordingSender: NotificationSender = async function send(target, message) {
    sent.push({ targetId: target.id, message })
    return { ok: true }
}

beforeEach(async function setup() {
    sent = []
    handle = await openWorkerTestDb('worker-polyglot')
    vi.spyOn(console, 'log').mockImplementation(function silence() {})
})

afterEach(async function teardown() {
    vi.restoreAllMocks()
    await closeWorkerTestDb(handle)
})

describe('a polyglot tree, upgraded to 3.8', function () {
    it('owns sub-manifests, keeps the root Python project beside apps/*, marks Python with no source, and sends one summary', async function () {
        const code = await makeTree(handle.dir, 'code', {
            'requirements.txt': 'django==3.2.0\n',
            'apps/mobile/package.json': JSON.stringify({ name: 'mobile', dependencies: { lodash: '4.17.21' } }),
            'apps/mobile/package-lock.json': LOCK,
            'apps/mobile/ios/Gemfile.lock': gemfileLock('2.0.8'),
            'apps/mobile/android/Gemfile.lock': gemfileLock('2.2.3'),
            'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { lodash: '4.17.21' } }),
            'apps/web/package-lock.json': LOCK
        })
        const other = await makeTree(handle.dir, 'other', { 'py-only/requirements.txt': 'flask==1.0\n' })
        upsertRoot(handle.db, { id: 'code', path: code, label: null, createdAt: T0 })
        upsertRoot(handle.db, { id: 'other', path: other, label: null, createdAt: T0 })
        // An install upgraded from 3.7: it has scanned before, so the new languages start a silent baseline.
        upsertRoot(handle.db, { id: 'old', path: '/not-mounted', label: null, createdAt: T0 })
        seedProject(handle.db, { id: 'old-project', rootId: 'old' })
        insertScan(handle.db, { id: 'old-scan', projectId: 'old-project', startedAt: T0, finishedAt: T0, scanner: 'npm-audit', source: 'npm-audit', ecosystem: 'npm', status: 'ok', reasonCode: 'ok', durationMs: 1, errorText: null, rawJson: '{}' })
        seedCapabilityBaselines(handle.db, CAPABILITIES, T0)
        // OSV for Node.js and Ruby; nothing for Python (the default: OSV and gemnasium are opt-in). npm audit
        // is off so the batch spawns no npm.
        setConfigValue(handle.db, sourceEnabledKey('npm-audit', 'npm'), false)
        setConfigValue(handle.db, sourceEnabledKey('osv', 'npm'), true)
        setConfigValue(handle.db, sourceEnabledKey('osv', 'RubyGems'), true)
        insertNotificationTarget(handle.db, {
            id: 'team', kind: 'webhook', config: { url: 'https://hooks.example.test/team' }, severityFilter: ['critical', 'high'],
            envFilter: 'all', enabled: true, createdAt: T0, rootIds: [], projectIds: [], sourceScope: { mode: 'all', cells: [] }
        })

        discoverProjects({ db: handle.db, roots: [{ id: 'code', path: code, label: null, createdAt: T0 }, { id: 'other', path: other, label: null, createdAt: T0 }], globalIgnore: [], at: T0 })
        const ids = { root: projectId('code', '.'), mobile: projectId('code', 'apps/mobile'), web: projectId('code', 'apps/web'), pyOnly: projectId('other', 'py-only') }
        const byId = new Map(listProjects(handle.db).map(function p(row) { return [row.id, row] }))
        expect(byId.get(ids.root)).toMatchObject({ ecosystems: ['PyPI'], manifests: [{ path: 'requirements.txt', ecosystem: 'PyPI', kind: 'requirements.txt' }] })
        expect(byId.get(ids.web)?.ecosystems).toEqual(['npm'])
        expect(byId.get(ids.mobile)?.manifests.map(function path(m) { return m.path }).sort()).toEqual(['android/Gemfile.lock', 'ios/Gemfile.lock', 'package-lock.json'])

        const osv = createOsvScanner({
            lookup: function lookup(ecosystem: string, names: string[]) {
                return new Map(ecosystem === 'RubyGems' && names.includes('rack') ? [['rack', [RACK]]] : [])
            },
            isSeeded: function seeded() { return true },
            isEnabled: function enabled(ecosystem: string) { return getSourceEnabled(handle.db, 'osv', ecosystem as EcosystemId) }
        })
        const projects = listProjects(handle.db).filter(function scanned(p) { return p.id !== 'old-project' })
        const batch = await runBatch({ db: handle.db, sqlite: handle.sqlite, scanners: [osv], projects, parallelism: 2 })
        expect(batch.completed).toBe(true)

        // The Expo app owns both Gemfile.locks as ONE finding, at its lowest affected version.
        const rack = listCurrentFindingsForProject(handle.db, ids.mobile, Date.now())
        expect(rack).toHaveLength(1)
        expect(rack[0]).toMatchObject({ packageName: 'rack', ecosystem: 'RubyGems', installedVersion: '2.0.8' })
        expect(rack[0]?.installations.slice().sort(function byPath(a, b) { return a.manifestPath < b.manifestPath ? -1 : 1 })).toEqual([
            { manifestPath: 'android/Gemfile.lock', version: '2.2.3' },
            { manifestPath: 'ios/Gemfile.lock', version: '2.0.8' }
        ])
        // A Python-only project with OSV off reads "no source enabled", never clean, never "not scanned yet".
        const disabled = { source: null, ecosystem: 'PyPI', reasonCode: 'ecosystem_source_disabled', side: 'environment' }
        expect(getProjectScanState(handle.db, ids.pyOnly)).toEqual({ state: 'cannot_scan', reasons: [disabled] })
        expect(getProjectScanState(handle.db, ids.root)).toEqual({ state: 'cannot_scan', reasons: [disabled] })
        expect(getProjectScanState(handle.db, ids.web).state).toBe('scanned')

        // The first completed sweep closes the baseline: one summary to the target, rack counted in it.
        await onCompletedSweep(handle.db, { send: recordingSender })
        expect(sent.map(function to(s) { return s.targetId })).toEqual(['team'])
        expect(sent[0]?.message.text).toBe([
            'Sentinello 3.8 now checks Python/Go/Rust/Ruby: 1 finding across 1 project, 0 critical',
            '2 projects have no enabled source, turn one on in Settings → Sources'
        ].join('\n'))
        expect(listSummaryDeliveries(handle.db, 'languages-3.8')[0]?.firstSucceededAt).not.toBeNull()
        expect(getBaselineState(handle.db, 'languages-3.8')).toBe('done')
    })
})
