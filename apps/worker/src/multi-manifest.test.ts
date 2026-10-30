import { chmod, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sourceEnabledKey, type EcosystemId } from '@sentinello/core'
import {
    getProjectById,
    getRootById,
    getProjectScanState,
    getSourceEnabled,
    listCurrentFindingsForProject,
    listFindingsForProject,
    listLibraryUsage,
    listProjects,
    listRecentScanRequests,
    projectId,
    setConfigValue,
    upsertRoot,
    type Root
} from '@sentinello/db'
import { createOsvScanner, type OsvAdvisory, type ScannerPlugin } from '@sentinello/scanners'
import { closeWorkerTestDb, makeTree, openWorkerTestDb, T0, type WorkerTestDb } from './worker-test-db.fixture'
import { createWorkerRuntime } from './runtime'

// Milestone 2's multi-manifest corrections, end to end through the real discovery, runner and OSV scanner on
// trees built at runtime:
//   - SENTINEL-137: a readable manifest never hides an unreadable sibling of the same ecosystem;
//   - SENTINEL-138: an ok scan of a cell resolves nothing it could not read — the same file, the bare manifest
//     a removed lockfile left, or another manifest replacing it in the same directory;
//   - SENTINEL-139: a scan the watcher asks for scans the lockfile that was just added;
//   - SENTINEL-140: an incomplete discovery walk keeps the manifests it could not see;
//   - SENTINEL-144: an ecosystem whose manifests are all gone resolves what it found;
//   - SENTINEL-145: a copy kept behind an unread manifest still constrains the settled fix, and reads as not
//     re-checked on a row the scan saw through its other copies.
//
// chokidar is stubbed as in watcher.test.ts: the double hands back the registered handlers so a test can
// deliver an event synchronously. Everything downstream of the event is real.

const chokidar = vi.hoisted(function makeChokidarDouble() {
    const handlers = new Map<string, (p: string) => void>()
    return {
        handlers,
        watch: function watch() {
            return {
                on: function on(event: string, handler: (p: string) => void) { handlers.set(event, handler) },
                close: async function close() {}
            }
        }
    }
})

vi.mock('chokidar', function mockChokidar() {
    return { default: { watch: chokidar.watch } }
})

const { discoverProjects } = await import('./discovery')
const { runBatch, runProjectScanners } = await import('./runner')
const { startLockfileWatcher } = await import('./watcher')
const { pollOnce } = await import('./scan-request-poller')

const LOCK = JSON.stringify({ name: 'app', lockfileVersion: 3, packages: { '': { name: 'app', dependencies: { lodash: '4.17.11' } }, 'node_modules/lodash': { version: '4.17.11' } } })

function gemfileLock(version: string, gem = 'rack'): string {
    return ['GEM', '  remote: https://rubygems.org/', '  specs:', '    ' + gem + ' (' + version + ')', '', 'PLATFORMS', '  ruby', '', 'DEPENDENCIES', '  ' + gem, '', 'BUNDLED WITH', '   2.4.10', ''].join('\n')
}

// A lockfile left mid-merge: no gem can be read from it, so it resolves unauditable.
const CONFLICTED = '<<<<<<< HEAD\nGEM\n=======\n>>>>>>> theirs\n'

function uvLock(django: string): string {
    return UV_LOCK.replace('version = "3.2.0"', 'version = "' + django + '"')
}

const UV_LOCK = [
    'version = 1',
    'requires-python = ">=3.12"',
    '',
    '[[package]]',
    'name = "app"',
    'version = "0.1.0"',
    'source = { virtual = "." }',
    'dependencies = [',
    '    { name = "django" },',
    ']',
    '',
    '[[package]]',
    'name = "django"',
    'version = "3.2.0"',
    'source = { registry = "https://pypi.org/simple" }',
    ''
].join('\n')

function advisory(advisoryId: string, fixed: string): OsvAdvisory {
    return {
        advisoryId,
        aliases: [],
        ranges: [{ type: 'ECOSYSTEM', introduced: '0', fixed, lastAffected: null }],
        versions: [],
        severity: 'high',
        summary: advisoryId,
        url: 'https://osv.example/' + advisoryId,
        malicious: false,
        withdrawn: null
    }
}

const ADVISORIES: Record<string, Record<string, OsvAdvisory>> = {
    npm: { lodash: advisory('GHSA-lodash-1', '4.17.21') },
    RubyGems: {
        rack: advisory('GHSA-rack-1', '2.2.6.4'),
        // Two affected branches: 1.5.0 fixes the first, 2.5.0 the second.
        puma: { ...advisory('GHSA-puma-1', '1.5.0'), ranges: [{ type: 'ECOSYSTEM', introduced: '1.0.0', fixed: '1.5.0', lastAffected: null }, { type: 'ECOSYSTEM', introduced: '2.0.0', fixed: '2.5.0', lastAffected: null }] }
    },
    PyPI: { django: advisory('GHSA-django-1', '3.2.20') }
}

let handle: WorkerTestDb
let osv: ScannerPlugin

function enable(...ecosystems: EcosystemId[]): void {
    for (const ecosystem of ecosystems) setConfigValue(handle.db, sourceEnabledKey('osv', ecosystem), true)
}

async function tree(spec: Record<string, string>): Promise<Root> {
    const path = await makeTree(handle.dir, 'code', spec)
    const root = { id: 'code', path, label: null, createdAt: T0 }
    upsertRoot(handle.db, root)
    return root
}

function discover(root: Root): void {
    discoverProjects({ db: handle.db, roots: [root], globalIgnore: [], at: T0 })
}

async function sweep(): Promise<void> {
    const batch = await runBatch({ db: handle.db, sqlite: handle.sqlite, scanners: [osv], projects: listProjects(handle.db), parallelism: 1 })
    expect(batch.completed).toBe(true)
}

function open(id: string, packageName: string) {
    return listCurrentFindingsForProject(handle.db, id, Date.now()).find(function named(f) { return f.packageName === packageName })
}

beforeEach(async function setup() {
    handle = await openWorkerTestDb('worker-multi-manifest')
    vi.spyOn(console, 'log').mockImplementation(function silence() {})
    // npm audit is off so nothing spawns npm; OSV answers from the table above.
    setConfigValue(handle.db, sourceEnabledKey('npm-audit', 'npm'), false)
    osv = createOsvScanner({
        lookup: function lookup(ecosystem: string, names: string[]) {
            const known = ADVISORIES[ecosystem] ?? {}
            return new Map(names.filter(function has(n) { return known[n] !== undefined }).map(function pair(n): [string, OsvAdvisory[]] { return [n, [known[n]!]] }))
        },
        isSeeded: function seeded() { return true },
        isEnabled: function enabled(ecosystem: string) { return getSourceEnabled(handle.db, 'osv', ecosystem as EcosystemId) }
    })
})

afterEach(async function teardown() {
    vi.restoreAllMocks()
    await closeWorkerTestDb(handle)
})

describe('SENTINEL-137 — a readable manifest beside a lockless one of the same ecosystem', function () {
    it.each([
        ['readable first', { 'Gemfile': "source 'https://rubygems.org'\n", 'Gemfile.lock': gemfileLock('2.2.8'), 'ios/Gemfile': "gem 'rack'\n" }, 'ios/Gemfile'],
        ['lockless first', { 'Gemfile': "gem 'rack'\n", 'ios/Gemfile': "source 'https://rubygems.org'\n", 'ios/Gemfile.lock': gemfileLock('2.2.8') }, 'Gemfile']
    ])('reads the project as partly scanned, %s', async function (_label, spec, lockless) {
        enable('RubyGems')
        discover(await tree(spec))
        await sweep()
        const id = projectId('code', '.')
        expect(getProjectScanState(handle.db, id)).toEqual({ state: 'partial', reasons: [{ source: null, ecosystem: 'RubyGems', reasonCode: 'no_lockfile', side: 'project' }] })
        expect(getProjectById(handle.db, id)?.manifests.map(function path(m) { return m.path })).toContain(lockless)
    })
})

describe('SENTINEL-138 — a manifest that cannot be read leaves its findings open', function () {
    // An Expo app: npm at its root, one Gemfile.lock per native platform. Only one of the two holds the
    // vulnerable rack; the other's stays readable throughout, so the Ruby cell's scan is always ok.
    it.each([['android'], ['ios']])('keeps rack open while %s/Gemfile.lock cannot be read, and resolves it once it is fixed', async function (vulnerable) {
        const safe = vulnerable === 'ios' ? 'android' : 'ios'
        enable('npm', 'RubyGems')
        const root = await tree({
            'package.json': JSON.stringify({ name: 'app' }),
            'package-lock.json': LOCK,
            [vulnerable + '/Gemfile.lock']: gemfileLock('2.0.8'),
            [safe + '/Gemfile.lock']: gemfileLock('2.2.8')
        })
        discover(root)
        const id = projectId('code', '.')
        await sweep()
        const first = open(id, 'rack')
        expect(first).toMatchObject({ installations: [{ manifestPath: vulnerable + '/Gemfile.lock', version: '2.0.8' }], notRecheckedBecause: null })
        const lodash = open(id, 'lodash')

        await writeFile(join(root.path, vulnerable, 'Gemfile.lock'), CONFLICTED)
        await sweep()
        const kept = open(id, 'rack')
        expect(kept?.id).toBe(first?.id)
        expect(kept?.notRecheckedBecause).toEqual({ reasonCode: 'ambiguous_dependency_spec', side: 'project', projectState: 'partial', lastOkScanAt: first?.lastSeenAt, manifests: null })
        expect(getProjectScanState(handle.db, id)).toEqual({ state: 'partial', reasons: [{ source: null, ecosystem: 'RubyGems', reasonCode: 'ambiguous_dependency_spec', side: 'project' }] })
        // The npm cell was read in full and re-checked its own finding.
        expect(open(id, 'lodash')).toMatchObject({ id: lodash?.id, notRecheckedBecause: null })

        await writeFile(join(root.path, vulnerable, 'Gemfile.lock'), gemfileLock('2.0.8'))
        await sweep()
        expect(open(id, 'rack')).toMatchObject({ id: first?.id, notRecheckedBecause: null })
        expect(getProjectScanState(handle.db, id).state).toBe('scanned')

        await writeFile(join(root.path, vulnerable, 'Gemfile.lock'), gemfileLock('2.2.8'))
        await sweep()
        expect(open(id, 'rack')).toBeUndefined()
        expect(listFindingsForProject(handle.db, id).find(function rack(f) { return f.id === first?.id })?.resolvedAt).not.toBeNull()
        expect(open(id, 'lodash')?.id).toBe(lodash?.id)
    })

    it('keeps the unread copy of a finding seen elsewhere, and its lowest version', async function () {
        enable('RubyGems')
        const root = await tree({
            'package.json': JSON.stringify({ name: 'app' }),
            'ios/Gemfile.lock': gemfileLock('2.0.8'),
            'android/Gemfile.lock': gemfileLock('2.1.0')
        })
        discover(root)
        const id = projectId('code', '.')
        await sweep()
        const both = [{ manifestPath: 'android/Gemfile.lock', version: '2.1.0' }, { manifestPath: 'ios/Gemfile.lock', version: '2.0.8' }]
        expect(open(id, 'rack')).toMatchObject({ installedVersion: '2.0.8' })
        expect(sortedInstallations(open(id, 'rack')?.installations)).toEqual(both)

        await writeFile(join(root.path, 'ios', 'Gemfile.lock'), CONFLICTED)
        await sweep()
        expect(open(id, 'rack')).toMatchObject({ installedVersion: '2.0.8' })
        expect(sortedInstallations(open(id, 'rack')?.installations)).toEqual(both)
    })
})

function sortedInstallations(list: { manifestPath: string; version: string }[] | undefined) {
    return (list ?? []).slice().sort(function byPath(a, b) { return a.manifestPath < b.manifestPath ? -1 : 1 })
}

describe('SENTINEL-139 — the watcher scans the lockfile that was just added, with no discovery pass', function () {
    const DEBOUNCE = 1_000

    // Watcher event -> scan_requests row -> the poller's single-project path -> the real runner. Discovery
    // ran once, before the change; nothing runs it again.
    async function lockfileAdded(path: string): Promise<void> {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        try {
            chokidar.handlers.get('add')?.(path)
            vi.advanceTimersByTime(DEBOUNCE)
        } finally {
            vi.useRealTimers()
        }
        const runtime = createWorkerRuntime()
        const osvController = {
            getScanner: function getScanner() { return osv },
            evidence: { ready: function ready() { return true }, links: function links() { return null } },
            reload: vi.fn(),
            refresh: vi.fn(async function refresh() {}),
            refreshEvidence: vi.fn(async function refreshEvidence() {}),
            stop: vi.fn()
        }
        await pollOnce({ db: handle.db, sqlite: handle.sqlite, runtime, scheduler: { reload: vi.fn(), stop: vi.fn() }, osvController, gemnasiumController: null } as unknown as Parameters<typeof pollOnce>[0])
        expect(listRecentScanRequests(handle.db).map(function status(r) { return r.status })).toEqual(['done'])
    }

    it('scans a uv.lock added beside a bare pyproject.toml', async function () {
        enable('PyPI')
        const root = await tree({ 'svc/pyproject.toml': '[project]\nname = "svc"\ndependencies = ["django"]\n' })
        discover(root)
        const id = projectId('code', 'svc')
        await sweep()
        expect(getProjectScanState(handle.db, id)).toMatchObject({ state: 'cannot_scan', reasons: expect.arrayContaining([{ source: null, ecosystem: 'PyPI', reasonCode: 'no_lockfile', side: 'project' }]) })
        startLockfileWatcher({ db: handle.db, rootPaths: [root.path], debounceMs: DEBOUNCE })

        await writeFile(join(root.path, 'svc', 'uv.lock'), UV_LOCK)
        await lockfileAdded(join(root.path, 'svc', 'uv.lock'))

        expect(open(id, 'django')).toMatchObject({ ecosystem: 'PyPI', installations: [{ manifestPath: 'uv.lock', version: '3.2.0' }] })
        expect(getProjectById(handle.db, id)).toMatchObject({ packageManager: 'uv', manifests: [{ path: 'uv.lock', ecosystem: 'PyPI', kind: 'uv.lock' }] })
        expect(getProjectScanState(handle.db, id).state).toBe('scanned')
    })

    it('scans an ios/Gemfile.lock added to an npm project', async function () {
        enable('npm', 'RubyGems')
        const root = await tree({ 'app/package.json': JSON.stringify({ name: 'app' }), 'app/package-lock.json': LOCK })
        discover(root)
        const id = projectId('code', 'app')
        await sweep()
        expect(getProjectById(handle.db, id)?.ecosystems).toEqual(['npm'])
        startLockfileWatcher({ db: handle.db, rootPaths: [root.path], debounceMs: DEBOUNCE })

        const { mkdir } = await import('node:fs/promises')
        await mkdir(join(root.path, 'app', 'ios'))
        await writeFile(join(root.path, 'app', 'ios', 'Gemfile.lock'), gemfileLock('2.0.8'))
        await lockfileAdded(join(root.path, 'app', 'ios', 'Gemfile.lock'))

        expect(open(id, 'rack')).toMatchObject({ ecosystem: 'RubyGems', installations: [{ manifestPath: 'ios/Gemfile.lock', version: '2.0.8' }] })
        expect(getProjectById(handle.db, id)?.ecosystems).toEqual(['npm', 'RubyGems'])
        expect(getProjectScanState(handle.db, id).state).toBe('scanned')
    })
})

describe('SENTINEL-140 — a discovery walk that cannot read a directory keeps what was there', function () {
    it('keeps native/ios/Gemfile.lock, its coverage gap and its finding while native cannot be read', async function () {
        enable('npm', 'RubyGems')
        const root = await tree({
            'package.json': JSON.stringify({ name: 'app' }),
            'package-lock.json': LOCK,
            'android/Gemfile.lock': gemfileLock('2.2.8'),
            'native/ios/Gemfile.lock': gemfileLock('2.0.8')
        })
        discover(root)
        const id = projectId('code', '.')
        await sweep()
        const rack = open(id, 'rack')
        expect(rack).toMatchObject({ installations: [{ manifestPath: 'native/ios/Gemfile.lock', version: '2.0.8' }] })

        await chmod(join(root.path, 'native'), 0o000)
        try {
            discover(root)
            expect(getProjectById(handle.db, id)?.manifests.map(function path(m) { return m.path })).toEqual(['package-lock.json', 'android/Gemfile.lock', 'native/ios/Gemfile.lock'])
            expect(getProjectById(handle.db, id)?.ecosystems).toEqual(['npm', 'RubyGems'])
            await sweep()
            expect(open(id, 'rack')?.id).toBe(rack?.id)
            expect(getProjectScanState(handle.db, id)).toEqual({ state: 'partial', reasons: [{ source: null, ecosystem: 'RubyGems', reasonCode: 'unsupported_lockfile', side: 'project' }] })
        } finally {
            await chmod(join(root.path, 'native'), 0o755)
        }
    })

    it('drops a manifest that is gone from a directory the walk could read', async function () {
        enable('npm', 'RubyGems')
        const root = await tree({
            'package.json': JSON.stringify({ name: 'app' }),
            'package-lock.json': LOCK,
            'android/Gemfile.lock': gemfileLock('2.2.8'),
            'native/ios/Gemfile.lock': gemfileLock('2.0.8'),
            'locked/README': 'x'
        })
        discover(root)
        await rm(join(root.path, 'android'), { recursive: true })
        await chmod(join(root.path, 'locked'), 0o000)
        try {
            discover(root)
            expect(getProjectById(handle.db, projectId('code', '.'))?.manifests.map(function path(m) { return m.path })).toEqual(['package-lock.json', 'native/ios/Gemfile.lock'])
        } finally {
            await chmod(join(root.path, 'locked'), 0o755)
        }
    })
})

describe('SENTINEL-138 — a lockfile removed, its manifest kept', function () {
    // ios/Gemfile.lock goes; ios/Gemfile stays, so ios/ is still a Ruby directory whose dependencies could not be
    // read. A readable Android sibling keeps the Ruby cell's scan ok throughout.
    it.each([['android'], ['ios']])('keeps rack open while %s/Gemfile has no lockfile, and resolves it once the lock says it is fixed', async function (vulnerable) {
        const safe = vulnerable === 'ios' ? 'android' : 'ios'
        enable('npm', 'RubyGems')
        const root = await tree({
            'package.json': JSON.stringify({ name: 'app' }),
            'package-lock.json': LOCK,
            [vulnerable + '/Gemfile']: "gem 'rack'\n",
            [vulnerable + '/Gemfile.lock']: gemfileLock('2.0.8'),
            [safe + '/Gemfile.lock']: gemfileLock('2.2.8')
        })
        discover(root)
        const id = projectId('code', '.')
        await sweep()
        const first = open(id, 'rack')
        expect(first).toMatchObject({ installations: [{ manifestPath: vulnerable + '/Gemfile.lock', version: '2.0.8' }], notRecheckedBecause: null })
        const lodash = open(id, 'lodash')

        await rm(join(root.path, vulnerable, 'Gemfile.lock'))
        await sweep()
        expect(getProjectById(handle.db, id)?.manifests.map(function path(m) { return m.path })).toContain(vulnerable + '/Gemfile')
        expect(open(id, 'rack')).toMatchObject({
            id: first?.id,
            installations: [{ manifestPath: vulnerable + '/Gemfile.lock', version: '2.0.8' }],
            notRecheckedBecause: { reasonCode: 'no_lockfile', side: 'project', projectState: 'partial', lastOkScanAt: first?.lastSeenAt, manifests: null }
        })
        expect(open(id, 'lodash')).toMatchObject({ id: lodash?.id, notRecheckedBecause: null })

        await writeFile(join(root.path, vulnerable, 'Gemfile.lock'), gemfileLock('2.0.8'))
        await sweep()
        expect(open(id, 'rack')).toMatchObject({ id: first?.id, notRecheckedBecause: null })

        await writeFile(join(root.path, vulnerable, 'Gemfile.lock'), gemfileLock('2.2.8'))
        await sweep()
        expect(open(id, 'rack')).toBeUndefined()
        expect(open(id, 'lodash')?.id).toBe(lodash?.id)
    })

    it('keeps the copy behind ios/Gemfile on a finding the Android lock still shows', async function () {
        enable('RubyGems')
        const root = await tree({
            'package.json': JSON.stringify({ name: 'app' }),
            'ios/Gemfile': "gem 'rack'\n",
            'ios/Gemfile.lock': gemfileLock('2.0.8'),
            'android/Gemfile.lock': gemfileLock('2.1.0')
        })
        discover(root)
        const id = projectId('code', '.')
        await sweep()
        const both = [{ manifestPath: 'android/Gemfile.lock', version: '2.1.0' }, { manifestPath: 'ios/Gemfile.lock', version: '2.0.8' }]

        await rm(join(root.path, 'ios', 'Gemfile.lock'))
        await sweep()
        expect(open(id, 'rack')).toMatchObject({ installedVersion: '2.0.8' })
        expect(sortedInstallations(open(id, 'rack')?.installations)).toEqual(both)

        // The Gemfile goes too: nothing of ios/ is installed any more, and the Android copy is the whole finding.
        await rm(join(root.path, 'ios'), { recursive: true })
        await sweep()
        expect(open(id, 'rack')).toMatchObject({ installedVersion: '2.1.0', installations: [{ manifestPath: 'android/Gemfile.lock', version: '2.1.0' }] })
    })
})

describe('SENTINEL-138 — a manifest replaced by another in its directory', function () {
    it('keeps django open while the requirements.txt that replaced svc/uv.lock cannot be read, and resolves it once it can', async function () {
        enable('PyPI')
        const root = await tree({
            'package.json': JSON.stringify({ name: 'app' }),
            'svc/uv.lock': uvLock('3.2.0'),
            'web/uv.lock': uvLock('3.2.20')
        })
        discover(root)
        const id = projectId('code', '.')
        await sweep()
        const first = open(id, 'django')
        expect(first).toMatchObject({ installations: [{ manifestPath: 'svc/uv.lock', version: '3.2.0' }] })

        await rm(join(root.path, 'svc', 'uv.lock'))
        await writeFile(join(root.path, 'svc', 'requirements.txt'), 'django>=3.2\n')
        await sweep()
        expect(open(id, 'django')).toMatchObject({ id: first?.id, notRecheckedBecause: { reasonCode: 'ambiguous_dependency_spec', side: 'project', projectState: 'partial', lastOkScanAt: first?.lastSeenAt, manifests: null } })

        await writeFile(join(root.path, 'svc', 'requirements.txt'), 'django==3.2.20\n')
        await sweep()
        expect(open(id, 'django')).toBeUndefined()
    })
})

describe('SENTINEL-144 — an ecosystem whose manifests are all removed', function () {
    async function rubyInNpm(): Promise<{ root: Root; id: string }> {
        enable('npm', 'RubyGems')
        const root = await tree({
            'package.json': JSON.stringify({ name: 'app' }),
            'package-lock.json': LOCK,
            'ios/Gemfile': "gem 'rack'\n",
            'ios/Gemfile.lock': gemfileLock('2.0.8')
        })
        discover(root)
        const id = projectId('code', '.')
        await sweep()
        expect(open(id, 'rack')).toBeDefined()
        return { root, id }
    }

    it('resolves rack once ios/ is gone, on a scan between sweeps', async function () {
        const { root, id } = await rubyInNpm()
        const lodash = open(id, 'lodash')
        await rm(join(root.path, 'ios'), { recursive: true })
        await sweep()
        expect(open(id, 'rack')).toBeUndefined()
        expect(getProjectById(handle.db, id)?.ecosystems).toEqual(['npm'])
        expect(open(id, 'lodash')).toMatchObject({ id: lodash?.id, notRecheckedBecause: null })
        expect(getProjectScanState(handle.db, id).state).toBe('scanned')
    })

    it('resolves rack when a sweep\'s discovery dropped the ecosystem before the scan', async function () {
        const { root, id } = await rubyInNpm()
        await rm(join(root.path, 'ios'), { recursive: true })
        discover(root)
        expect(getProjectById(handle.db, id)?.ecosystems).toEqual(['npm'])
        await sweep()
        expect(open(id, 'rack')).toBeUndefined()
    })

    it('keeps running the Ruby cell until it has resolved rack', async function () {
        const { root, id } = await rubyInNpm()
        await rm(join(root.path, 'ios'), { recursive: true })
        const rack = open(id, 'rack')
        setConfigValue(handle.db, sourceEnabledKey('osv', 'RubyGems'), false)
        await sweep()
        // Hidden while its source is off, and still open: no Ruby cell could run.
        expect(listFindingsForProject(handle.db, id).find(function f(r) { return r.id === rack?.id })?.resolvedAt).toBeNull()
        expect(getProjectById(handle.db, id)?.ecosystems).toEqual(['npm'])
        enable('RubyGems')
        await sweep()
        expect(open(id, 'rack')).toBeUndefined()
    })

    it('keeps rack while ios/ cannot be read', async function () {
        const { root, id } = await rubyInNpm()
        const rack = open(id, 'rack')
        await chmod(join(root.path, 'ios'), 0o000)
        try {
            await sweep()
            expect(open(id, 'rack')?.id).toBe(rack?.id)
        } finally {
            await chmod(join(root.path, 'ios'), 0o755)
        }
    })
})

describe('SENTINEL-148 — a directory that can be searched but not listed', function () {
    // ios/ at 0111: its Gemfile.lock can be stat'ed and read, its listing fails. The lock is the directory's one
    // Ruby manifest, so the bare Gemfile recorded before it is not restored beside it, and the copy the lock
    // shows is read, never kept as unread.
    it('keeps one Ruby manifest in ios/ and one current copy, over repeated scans and a version change', async function () {
        enable('RubyGems')
        const root = await tree({ 'package.json': JSON.stringify({ name: 'app' }), 'ios/Gemfile': "gem 'rack'\n" })
        discover(root)
        const id = projectId('code', '.')
        function rubyManifests(): string[] | undefined {
            return getProjectById(handle.db, id)?.manifests.filter(function ruby(m) { return m.ecosystem === 'RubyGems' }).map(function path(m) { return m.path })
        }
        expect(rubyManifests()).toEqual(['ios/Gemfile'])

        await writeFile(join(root.path, 'ios', 'Gemfile.lock'), gemfileLock('2.0.8'))
        await chmod(join(root.path, 'ios'), 0o111)
        try {
            for (const version of ['2.0.8', '2.0.8', '2.1.0']) {
                await writeFile(join(root.path, 'ios', 'Gemfile.lock'), gemfileLock(version))
                await sweep()
                expect(rubyManifests()).toEqual(['ios/Gemfile.lock'])
                expect(open(id, 'rack')).toMatchObject({ installedVersion: version, installations: [{ manifestPath: 'ios/Gemfile.lock', version }], notRecheckedBecause: null })
            }
        } finally {
            await chmod(join(root.path, 'ios'), 0o755)
        }
    })
})

describe('SENTINEL-145 — a copy kept behind an unread manifest constrains the fix', function () {
    // puma 1.0.0 is in the first affected branch, 2.0.0 in the second: only 2.5.0 is at or above both copies.
    it('settles the fix above the kept copy, not just above the copy the scan read', async function () {
        enable('RubyGems')
        const root = await tree({
            'package.json': JSON.stringify({ name: 'app' }),
            'android/Gemfile.lock': gemfileLock('1.0.0', 'puma'),
            'ios/Gemfile.lock': gemfileLock('2.0.0', 'puma')
        })
        discover(root)
        const id = projectId('code', '.')
        const registry = {
            RubyGems: {
                async published(stated: ReadonlyMap<string, readonly string[]>) {
                    const published = ['1.0.0', '1.5.0', '2.0.0', '2.5.0'].map(function release(version) { return { version, deprecated: false } })
                    return new Map([...stated.keys()].map(function view(name) { return [name, { status: 'ok' as const, published, dataAsOf: T0 }] as const }))
                }
            }
        }
        async function scan(): Promise<void> {
            const project = getProjectById(handle.db, id)!
            expect(getRootById(handle.db, project.rootId)).not.toBeNull()
            await runProjectScanners({ db: handle.db, scanners: [osv], project, registry, notify: async function quiet() {} })
        }
        await scan()
        expect(open(id, 'puma')).toMatchObject({ installedVersion: '1.0.0', fixStatus: 'released', fixVersion: '2.5.0' })

        await writeFile(join(root.path, 'ios', 'Gemfile.lock'), CONFLICTED)
        await scan()
        expect(open(id, 'puma')).toMatchObject({ installedVersion: '1.0.0', fixStatus: 'released', fixVersion: '2.5.0' })
        expect(sortedInstallations(open(id, 'puma')?.installations)).toEqual([{ manifestPath: 'android/Gemfile.lock', version: '1.0.0' }, { manifestPath: 'ios/Gemfile.lock', version: '2.0.0' }])
        // The scan saw puma through Android, so the row's last_seen_at is that scan's; the iOS copy it kept
        // was not re-checked, and every reader says so, naming the manifest and no date of its own.
        const kept = { reasonCode: 'ambiguous_dependency_spec', side: 'project', projectState: 'partial', lastOkScanAt: null, manifests: ['ios/Gemfile.lock'] }
        expect(open(id, 'puma')?.notRecheckedBecause).toEqual(kept)
        expect(listLibraryUsage(handle.db, 'puma', Date.now(), 'all', 'RubyGems')[0]?.notRecheckedBecause).toEqual(kept)

        // iOS reads again: every copy is re-checked, and nothing says otherwise.
        await writeFile(join(root.path, 'ios', 'Gemfile.lock'), gemfileLock('2.0.0', 'puma'))
        await scan()
        expect(open(id, 'puma')).toMatchObject({ fixVersion: '2.5.0', notRecheckedBecause: null })
        expect(listLibraryUsage(handle.db, 'puma', Date.now(), 'all', 'RubyGems')[0]?.notRecheckedBecause).toBeNull()
    })
})

