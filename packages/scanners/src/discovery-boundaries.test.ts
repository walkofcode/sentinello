import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, describe, expect, it } from 'vitest'
import { ECOSYSTEMS } from '@sentinello/core'
import { discoverProjectsInTree, rediscoverProject, withUnreadManifests, type DiscoveredProject } from './discovery'

// Project boundaries once Python, Go, Rust and Ruby are looked for (decision #3 of the 3.8 plan). The worker
// hard-deletes a project that stops being discovered, with its mutes, aliases, tags and history, so the
// property that matters most is that adding a non-npm manifest anywhere never takes an npm project away:
// a package.json directory stays a project with the same relPath (and so the same id) and the same package
// manager, and every non-npm manifest attaches to the nearest project instead of anchoring one above it.
//
// Every case passes the whole registry as `ecosystems`, so these hold before the preview ecosystems are
// promoted and keep holding after.

const PKG = JSON.stringify({ name: 'fixture', version: '1.0.0' })

const created: string[] = []

async function makeTree(spec: Record<string, string>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'sentinello-boundaries-'))
    created.push(root)
    await addFiles(root, spec)
    return root
}

async function addFiles(root: string, spec: Record<string, string>): Promise<void> {
    for (const [relPath, content] of Object.entries(spec)) {
        const full = join(root, relPath)
        await mkdir(dirname(full), { recursive: true })
        await writeFile(full, content)
    }
}

afterAll(async function cleanup() {
    for (const dir of created) {
        await rm(dir, { recursive: true, force: true })
    }
})

function discover(root: string): DiscoveredProject[] {
    return discoverProjectsInTree({ rootPath: root, ecosystems: ECOSYSTEMS })
}

// relPath → the manifests' paths, for compact assertions.
function manifestPaths(projects: DiscoveredProject[]): Record<string, string[]> {
    const out: Record<string, string[]> = {}
    for (const project of projects) {
        out[project.relPath] = project.manifests.map(function path(m) { return m.path })
    }
    return out
}

describe('discoverProjectsInTree — sub-manifests', function () {
    it('gives an npm project its own ios and android Gemfile.lock', async function () {
        const root = await makeTree({
            'package.json': PKG,
            'pnpm-lock.yaml': 'lockfileVersion: 9\n',
            'ios/Gemfile.lock': '',
            'android/Gemfile.lock': ''
        })
        const projects = discover(root)
        expect(projects).toHaveLength(1)
        expect(projects[0]).toMatchObject({
            relPath: '.',
            packageManager: 'pnpm',
            ecosystems: ['npm', 'RubyGems'],
            manifests: [
                { path: 'pnpm-lock.yaml', ecosystem: 'npm', kind: 'pnpm-lock.yaml' },
                { path: 'android/Gemfile.lock', ecosystem: 'RubyGems', kind: 'Gemfile.lock' },
                { path: 'ios/Gemfile.lock', ecosystem: 'RubyGems', kind: 'Gemfile.lock' }
            ]
        })
    })

    it('makes a pure Cargo repository its own project', async function () {
        const root = await makeTree({ 'Cargo.toml': '[package]\n', 'Cargo.lock': '', 'src/main.rs': '' })
        expect(discover(root)).toEqual([expect.objectContaining({
            relPath: '.',
            packageManager: 'cargo',
            ecosystems: ['crates.io'],
            manifests: [{ path: 'Cargo.lock', ecosystem: 'crates.io', kind: 'Cargo.lock' }]
        })])
    })

    // The CRITICAL case: a repo-root requirements.txt must not swallow the npm projects beside it.
    it('keeps the npm projects beside a repo-root requirements.txt project', async function () {
        const root = await makeTree({
            'requirements.txt': 'flask==2.0.0\n',
            'apps/web/package.json': PKG,
            'apps/web/package-lock.json': '{}',
            'apps/web/scripts/requirements.txt': 'requests==2.0.0\n',
            'apps/api/package.json': PKG
        })
        const projects = discover(root)
        expect(manifestPaths(projects)).toEqual({
            '.': ['requirements.txt'],
            'apps/web': ['package-lock.json', 'scripts/requirements.txt'],
            'apps/api': ['package.json']
        })
        const byRel = new Map(projects.map(function pair(p): [string, DiscoveredProject] { return [p.relPath, p] }))
        expect(byRel.get('.')).toMatchObject({ packageManager: 'pip', ecosystems: ['PyPI'] })
        expect(byRel.get('apps/web')).toMatchObject({ packageManager: 'npm', ecosystems: ['npm', 'PyPI'] })
        expect(byRel.get('apps/api')).toMatchObject({ packageManager: 'unknown', ecosystems: ['npm'] })
    })

    // Below a non-npm project, other non-npm manifests are its own; below the npm project nested in it,
    // they are the npm project's.
    it('attaches each manifest to the nearest enclosing project', async function () {
        const root = await makeTree({
            'go.mod': 'module x\n',
            'tools/gen/go.mod': 'module y\n',
            'web/package.json': PKG,
            'web/e2e/Gemfile': ''
        })
        expect(manifestPaths(discover(root))).toEqual({
            '.': ['go.mod', 'tools/gen/go.mod'],
            'web': ['package.json', 'e2e/Gemfile']
        })
    })

    // Within one directory the registry's preference order still picks one manifest per ecosystem.
    it('keeps the first present kind per ecosystem in a directory', async function () {
        const root = await makeTree({ 'package.json': PKG, 'py/requirements.txt': '', 'py/poetry.lock': '' })
        expect(manifestPaths(discover(root))).toEqual({ '.': ['package.json', 'py/poetry.lock'] })
    })

    // A Cargo workspace member is covered by the workspace's Cargo.lock, so only the lock is listed.
    it('lists a Cargo workspace once, by its lock', async function () {
        const root = await makeTree({ 'Cargo.toml': '', 'Cargo.lock': '', 'crates/core/Cargo.toml': '' })
        expect(manifestPaths(discover(root))).toEqual({ '.': ['Cargo.lock'] })
    })

    it('lists a lockless manifest as its own', async function () {
        const root = await makeTree({ 'Gemfile': '', 'android/Gemfile': '' })
        expect(discover(root)).toEqual([expect.objectContaining({
            packageManager: 'bundler',
            manifests: [
                { path: 'Gemfile', ecosystem: 'RubyGems', kind: 'Gemfile' },
                { path: 'android/Gemfile', ecosystem: 'RubyGems', kind: 'Gemfile' }
            ]
        })])
    })
})

describe('discoverProjectsInTree — directories that hold no sub-manifests', function () {
    const SKIPPED = ['node_modules', 'vendor', '.venv', 'venv', 'target', 'Pods', 'build', 'dist']

    function spread(prefix: string): Record<string, string> {
        const spec: Record<string, string> = {}
        for (const name of SKIPPED) {
            spec[prefix + name + '/Gemfile.lock'] = ''
            spec[prefix + name + '/deeper/requirements.txt'] = ''
        }
        return spec
    }

    it('contributes nothing to an npm project', async function () {
        const root = await makeTree({ 'package.json': PKG, ...spread(''), ...spread('ios/') })
        expect(manifestPaths(discover(root))).toEqual({ '.': ['package.json'] })
    })

    it('contributes nothing to a non-npm project', async function () {
        const root = await makeTree({ 'go.mod': 'module x\n', ...spread('') })
        expect(manifestPaths(discover(root))).toEqual({ '.': ['go.mod'] })
    })

    it('anchors no project when nothing encloses it', async function () {
        expect(discover(await makeTree(spread('')))).toEqual([])
    })

    // A package.json in one of them is still found when no npm project encloses it — npm discovery is as
    // it was before 3.8 — and it counts its own skipped directories from itself.
    it('still holds npm projects, with their own sub-manifests', async function () {
        const root = await makeTree({
            'requirements.txt': '',
            'build/tool/package.json': PKG,
            'build/tool/ios/Gemfile.lock': '',
            'build/tool/vendor/Gemfile.lock': ''
        })
        expect(manifestPaths(discover(root))).toEqual({
            '.': ['requirements.txt'],
            'build/tool': ['package.json', 'ios/Gemfile.lock']
        })
    })
})

describe('discoverProjectsInTree — npm projects with and without sub-manifests', function () {
    const NPM_TREE: Record<string, string> = {
        'apps/web/package.json': PKG,
        'apps/web/pnpm-lock.yaml': '',
        'apps/api/package.json': PKG,
        'apps/api/yarn.lock': '',
        'packages/lib/package.json': PKG,
        'packages/lib/nested/package.json': PKG
    }

    function shape(projects: DiscoveredProject[]): string[] {
        return projects
            .map(function line(p) { return p.relPath + ' ' + p.packageManager })
            .sort()
    }

    it('reports the same npm projects', async function () {
        const plain = await makeTree(NPM_TREE)
        const mixedRoot = await makeTree({
            ...NPM_TREE,
            'requirements.txt': '',
            'apps/Gemfile.lock': '',
            'apps/web/ios/Gemfile.lock': '',
            'packages/lib/nested/go.mod': 'module x\n',
            'packages/Cargo.lock': ''
        })
        const npmOnly = shape(discover(plain))
        expect(npmOnly).toEqual(['apps/api yarn', 'apps/web pnpm', 'packages/lib unknown'])
        const mixed = discover(mixedRoot)
        expect(shape(mixed.filter(hasNpm))).toEqual(npmOnly)
        expect(manifestPaths(mixed.filter(function noNpm(p) { return !hasNpm(p) }))).toEqual({
            '.': ['requirements.txt', 'apps/Gemfile.lock', 'packages/Cargo.lock']
        })
    })
})

function hasNpm(project: DiscoveredProject): boolean {
    return project.ecosystems.includes('npm')
}

// Seeded so a failure names a reproducible case; mulberry32.
function prng(seed: number): () => number {
    let state = seed >>> 0
    return function next(): number {
        state = (state + 0x6d2b79f5) >>> 0
        let t = state
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

describe('discoverProjectsInTree — adding non-npm manifests only ever adds', function () {
    const NAMES = ['apps', 'packages', 'web', 'api', 'ios', 'scripts', 'build', 'vendor', 'tools']
    const NPM_LOCKS = ['', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']
    const NON_NPM_KINDS = ECOSYSTEMS
        .filter(function nonNpm(eco) { return eco.id !== 'npm' })
        .flatMap(function kinds(eco) { return [...eco.resolverKinds, ...eco.manifestKinds] })
    const CASES = 300

    function pick<T>(next: () => number, from: readonly T[]): T {
        return from[Math.floor(next() * from.length)]!
    }

    function randomDir(next: () => number): string {
        const depth = Math.floor(next() * 4)
        const parts: string[] = []
        for (let i = 0; i < depth; i++) parts.push(pick(next, NAMES))
        return parts.join('/')
    }

    function under(dir: string, file: string): string {
        return dir === '' ? file : dir + '/' + file
    }

    it('keeps every npm project id and package manager across ' + CASES + ' generated trees', async function () {
        const next = prng(0x5e47)
        for (let i = 0; i < CASES; i++) {
            const npmSpec: Record<string, string> = {}
            const npmCount = 1 + Math.floor(next() * 4)
            for (let j = 0; j < npmCount; j++) {
                const dir = randomDir(next)
                npmSpec[under(dir, 'package.json')] = PKG
                const lock = pick(next, NPM_LOCKS)
                if (lock) npmSpec[under(dir, lock)] = ''
            }
            const root = await makeTree(npmSpec)
            const before = discover(root)

            const extras: Record<string, string> = {}
            const extraCount = 1 + Math.floor(next() * 5)
            for (let j = 0; j < extraCount; j++) {
                extras[under(randomDir(next), pick(next, NON_NPM_KINDS))] = ''
            }
            await addFiles(root, extras)
            const after = discover(root)

            const label = 'case ' + i + ': ' + JSON.stringify({ npmSpec, extras })
            const afterByRel = new Map(after.map(function pair(p): [string, DiscoveredProject] { return [p.relPath, p] }))
            // Additions only: every project found without the extras is still there, unchanged in identity
            // and package manager…
            for (const project of before) {
                expect(afterByRel.get(project.relPath)?.packageManager, label).toBe(project.packageManager)
            }
            // …and the npm projects are exactly the ones there were.
            const npmAfter = after
                .filter(hasNpm)
                .map(function rel(p) { return p.relPath })
                .sort()
            expect(npmAfter, label).toEqual(before.map(function rel(p) { return p.relPath }).sort())
            await rm(root, { recursive: true, force: true })
        }
    }, 60_000)
})

// SENTINEL-139: a scan between sweeps re-reads one project with rediscoverProject. It must see exactly what a
// whole-root walk would record for that project — the same manifests, the same lockfile chosen, the same
// ownership — or a single-project scan and the next sweep would disagree about what the project holds.
describe('rediscoverProject — one project, read as the whole walk reads it', function () {
    const NAMES = ['apps', 'web', 'ios', 'android', 'scripts', 'vendor', 'build', 'svc']
    const KINDS = [
        'package.json', 'package-lock.json', 'pnpm-lock.yaml',
        ...ECOSYSTEMS.filter(function nonNpm(eco) { return eco.id !== 'npm' }).flatMap(function kinds(eco) { return [...eco.resolverKinds, ...eco.manifestKinds] })
    ]
    const CASES = 150

    function pick<T>(next: () => number, from: readonly T[]): T {
        return from[Math.floor(next() * from.length)]!
    }

    it('matches discoverProjectsInTree for every project of ' + CASES + ' generated trees, ignore files and excludes included', async function () {
        const next = prng(0x13c9)
        for (let i = 0; i < CASES; i++) {
            const spec: Record<string, string> = {}
            const count = 2 + Math.floor(next() * 7)
            for (let j = 0; j < count; j++) {
                const depth = Math.floor(next() * 4)
                const parts: string[] = []
                for (let k = 0; k < depth; k++) parts.push(pick(next, NAMES))
                parts.push(pick(next, KINDS))
                spec[parts.join('/')] = parts[parts.length - 1] === 'package.json' ? PKG : ''
            }
            // An ignore file above some projects, so the layers stacked from the root down matter.
            if (next() < 0.5) spec['.gitignore'] = pick(next, NAMES) + '/' + pick(next, NAMES) + '/\n'
            if (next() < 0.3) spec['apps/.sentinelloignore'] = pick(next, NAMES) + '\n'
            const excludes = next() < 0.3 ? [pick(next, NAMES) + '/' + pick(next, NAMES)] : []
            const root = await makeTree(spec)
            const label = 'case ' + i + ': ' + JSON.stringify({ spec, excludes })
            const whole = discoverProjectsInTree({ rootPath: root, ecosystems: ECOSYSTEMS, excludes })
            for (const project of whole) {
                const again = rediscoverProject({ rootPath: root, projectPath: project.absolutePath, ecosystems: ECOSYSTEMS, excludes })
                expect(again, label).toEqual({ project, errors: [] })
            }
            await rm(root, { recursive: true, force: true })
        }
    }, 60_000)

    it('finds nothing outside the root, for a directory that is gone, or for one that anchors no project', async function () {
        const root = await makeTree({ 'notes/README.md': 'x', 'app/package.json': PKG })
        expect(rediscoverProject({ rootPath: join(root, 'app'), projectPath: root })).toEqual({ project: null, errors: [] })
        expect(rediscoverProject({ rootPath: root, projectPath: join(root, 'gone') })).toEqual({ project: null, errors: [] })
        expect(rediscoverProject({ rootPath: root, projectPath: join(root, 'notes') })).toEqual({ project: null, errors: [] })
    })

    it('reads the root itself as a project, on the stable ecosystems by default', async function () {
        const root = await makeTree({ 'requirements.txt': 'django==3.2.0\n', 'ios/Gemfile.lock': '' })
        const again = rediscoverProject({ rootPath: root, projectPath: root })
        expect(again.project).toMatchObject({ relPath: '.', ecosystems: ['PyPI', 'RubyGems'] })
        expect(again.project?.manifests.map(function path(m) { return m.path })).toEqual(['requirements.txt', 'ios/Gemfile.lock'])
    })

    it('reports a directory below the project it could not read', async function () {
        const { chmod } = await import('node:fs/promises')
        const root = await makeTree({ 'app/package.json': PKG, 'app/native/ios/Gemfile.lock': '' })
        await chmod(join(root, 'app', 'native'), 0o000)
        try {
            const again = rediscoverProject({ rootPath: root, projectPath: join(root, 'app') })
            expect(again.project?.manifests.map(function path(m) { return m.path })).toEqual(['package.json'])
            expect(again.errors.map(function path(e) { return e.path })).toEqual([join(root, 'app', 'native')])
        } finally {
            await chmod(join(root, 'app', 'native'), 0o755)
        }
    })
})

// SENTINEL-140: what an incomplete walk could not see is kept from the record, and nothing else is.
describe('withUnreadManifests', function () {
    const project: DiscoveredProject = {
        absolutePath: '/r/app',
        relPath: 'app',
        name: 'app',
        packageManager: 'npm',
        nvmrcVersion: null,
        gitBranch: null,
        ecosystems: ['npm'],
        manifests: [{ path: 'package-lock.json', ecosystem: 'npm', kind: 'package-lock.json' }]
    }
    const recorded = [
        { path: 'package-lock.json', ecosystem: 'npm' as const, kind: 'package-lock.json' },
        { path: 'native/ios/Gemfile.lock', ecosystem: 'RubyGems' as const, kind: 'Gemfile.lock' },
        { path: 'native/Cargo.lock', ecosystem: 'crates.io' as const, kind: 'Cargo.lock' },
        { path: 'android/Gemfile.lock', ecosystem: 'RubyGems' as const, kind: 'Gemfile.lock' }
    ]

    it('returns the project as found when the walk was complete', function () {
        expect(withUnreadManifests(project, recorded, [])).toBe(project)
    })

    it('keeps the recorded manifests in or below an unreadable directory, and derives the ecosystems again', function () {
        const kept = withUnreadManifests(project, recorded, [{ path: '/r/app/native', message: 'EACCES' }])
        expect(kept.manifests.map(function path(m) { return m.path })).toEqual(['package-lock.json', 'native/Cargo.lock', 'native/ios/Gemfile.lock'])
        expect(kept.ecosystems).toEqual(['npm', 'crates.io', 'RubyGems'])
        expect(project.manifests).toHaveLength(1)
    })
})
