import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ECOSYSTEMS } from '@sentinello/core'
import {
    detectManifests,
    detectManifestsIn,
    graphForEcosystem,
    mergeResolvedGraphs,
    resolveManifest,
    resolveProject,
    resolveProjectGraphs
} from './index'
import { makeGraph } from './graph'
import type { DetectedManifest, ResolvedPackage, ResolverResult } from './types'
import type { DetectedLockfile } from '../types'

// The dispatch layer. A routing mistake here is quiet and total: the wrong parser for a lockfile means
// an entire ecosystem resolves to nothing and the project looks clean.

let dir: string

beforeEach(async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-resolver-'))
})

afterEach(async function cleanup() {
    await rm(dir, { recursive: true, force: true })
})

async function write(name: string, text: string): Promise<string> {
    const path = join(dir, name)
    await writeFile(path, text, 'utf8')
    return path
}

function pkg(name: string, version: string, ecosystem: string): ResolvedPackage {
    return {
        ecosystem,
        name,
        version,
        scope: { isProd: true, isDev: false, isOptional: false },
        depPaths: [],
        manifestPath: 'lockfile'
    }
}

function okResult(ecosystem: string, packages: ResolvedPackage[]): ResolverResult {
    return { status: 'ok', ecosystem, graph: makeGraph(packages) }
}

function partialResult(ecosystem: string, packages: ResolvedPackage[]): ResolverResult {
    return {
        status: 'partial',
        ecosystem,
        graph: makeGraph(packages),
        reasonCode: 'partial_dependency_graph',
        details: []
    }
}

function unauditableResult(ecosystem: string): ResolverResult {
    return { status: 'unauditable', ecosystem, reasonCode: 'unsupported_lockfile', details: [] }
}

const NPM_LOCK = JSON.stringify({ packages: { 'node_modules/lodash': { version: '4.17.20' } } })
const PNPM_LOCK = "lockfileVersion: 5.4\n\npackages:\n  /lodash@4.17.20:\n    resolution: {integrity: sha512-x}\n"
// `source` is required: a package without one is the workspace's own crate, not a registry dependency.
const CARGO_LOCK = '[[package]]\nname = "anyhow"\nversion = "1.0.86"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n'

function manifest(kind: string, ecosystem: string, absolutePath: string): DetectedManifest {
    return { kind, ecosystem, absolutePath }
}

describe('resolveProject', function () {
    it('routes package-lock.json to the npm parser', async function () {
        const absolutePath = await write('package-lock.json', NPM_LOCK)
        const lockfile: DetectedLockfile = { kind: 'package-lock.json', packageManager: 'npm', absolutePath }
        expect((await resolveProject(dir, lockfile))?.packages[0]?.name).toBe('lodash')
    })

    it('routes pnpm-lock.yaml to the pnpm parser', async function () {
        const absolutePath = await write('pnpm-lock.yaml', PNPM_LOCK)
        const lockfile: DetectedLockfile = { kind: 'pnpm-lock.yaml', packageManager: 'pnpm', absolutePath }
        expect((await resolveProject(dir, lockfile))?.packages[0]?.name).toBe('lodash')
    })

    // yarn.lock is not parsed at all; returning null makes the caller fail open rather than report a
    // yarn project as dependency-free.
    it('returns null for yarn.lock', async function () {
        const absolutePath = await write('yarn.lock', '# yarn\n')
        const lockfile: DetectedLockfile = { kind: 'yarn.lock', packageManager: 'yarn', absolutePath }
        expect(await resolveProject(dir, lockfile)).toBeNull()
    })
})

describe('detectManifests', function () {
    it('finds nothing in an empty directory', async function () {
        expect(await detectManifests(dir)).toEqual([])
    })

    // One manifest per offered ecosystem — since 3.8, all five.
    it('detects one manifest per offered ecosystem', async function () {
        await write('package-lock.json', NPM_LOCK)
        await write('requirements.txt', 'a==1.0.0\n')
        await write('go.mod', 'require github.com/a/b v1.0.0\n')
        await write('Cargo.lock', CARGO_LOCK)
        const found = await detectManifests(dir)
        expect(found.map(function eco(m) { return m.ecosystem })).toEqual(['npm', 'PyPI', 'Go', 'crates.io'])
    })

    // Only the first match per ecosystem, in registry preference order — a repo carrying both a
    // package-lock and a pnpm-lock must not resolve twice and double count its packages.
    it('takes only the first matching manifest for an ecosystem', async function () {
        await write('package-lock.json', NPM_LOCK)
        await write('pnpm-lock.yaml', PNPM_LOCK)
        const found = await detectManifests(dir)
        expect(found.filter(function isNpm(m) { return m.ecosystem === 'npm' })).toHaveLength(1)
        expect(found[0]?.kind).toBe('package-lock.json')
    })

    it('records the absolute path of what it found', async function () {
        await write('package-lock.json', NPM_LOCK)
        const found = await detectManifests(dir)
        expect(found[0]?.absolutePath).toBe(join(dir, 'package-lock.json'))
    })

    // A package.json with no lockfile is still the npm manifest: it resolves to unauditable / no_lockfile,
    // so the scan records why the project could not be read instead of recording nothing.
    it('detects a package.json with no lockfile as the npm manifest', async function () {
        await write('package.json', '{}')
        expect(await detectManifests(dir)).toEqual([{ kind: 'package.json', ecosystem: 'npm', absolutePath: join(dir, 'package.json') }])
    })

    it('prefers a lockfile over the bare package.json', async function () {
        await write('package.json', '{}')
        await write('pnpm-lock.yaml', PNPM_LOCK)
        expect((await detectManifests(dir)).map(function k(m) { return m.kind })).toEqual(['pnpm-lock.yaml'])
    })

    it('ignores a directory that happens to share a manifest name', async function () {
        await mkdir(join(dir, 'nested'))
        expect(await detectManifests(join(dir, 'nested'))).toEqual([])
    })
})

describe('resolveManifest', function () {
    it('resolves a package-lock.json manifest', async function () {
        const path = await write('package-lock.json', NPM_LOCK)
        const result = await resolveManifest(dir, manifest('package-lock.json', 'npm', path))
        expect(result.status).toBe('ok')
        expect(result.status !== 'unauditable' && result.graph.packages[0]?.name).toBe('lodash')
    })

    it('resolves a pnpm-lock.yaml manifest', async function () {
        const path = await write('pnpm-lock.yaml', PNPM_LOCK)
        expect((await resolveManifest(dir, manifest('pnpm-lock.yaml', 'npm', path))).status).toBe('ok')
    })

    it('reports a bare package.json as having no lockfile', async function () {
        const path = await write('package.json', '{}')
        const result = await resolveManifest(dir, manifest('package.json', 'npm', path))
        expect(result).toMatchObject({ status: 'unauditable', ecosystem: 'npm', reasonCode: 'no_lockfile' })
    })

    it('reports yarn.lock as an unsupported JavaScript lockfile', async function () {
        const path = await write('yarn.lock', '# yarn\n')
        const result = await resolveManifest(dir, manifest('yarn.lock', 'npm', path))
        expect(result.status).toBe('unauditable')
        expect(result.status === 'unauditable' && result.reasonCode).toBe('unsupported_lockfile')
    })

    // An npm lockfile that parses to null must surface as unauditable, never as an empty ok graph.
    it('reports an unparseable npm lockfile as unauditable', async function () {
        const path = await write('package-lock.json', '{ broken')
        const result = await resolveManifest(dir, manifest('package-lock.json', 'npm', path))
        expect(result.status).toBe('unauditable')
        expect(result.status === 'unauditable' && result.details.join(' ')).toContain('package-lock.json')
    })

    it('routes a Python manifest to the Python resolver', async function () {
        const path = await write('requirements.txt', 'django==4.2.0\n')
        const result = await resolveManifest(dir, manifest('requirements.txt', 'PyPI', path))
        expect(result.ecosystem).toBe('PyPI')
        expect(result.status !== 'unauditable' && result.graph.packages[0]?.name).toBe('django')
    })

    it('routes a Go manifest to the Go resolver', async function () {
        const path = await write('go.mod', 'require github.com/a/b v1.0.0\n')
        const result = await resolveManifest(dir, manifest('go.mod', 'Go', path))
        expect(result.ecosystem).toBe('Go')
        expect(result.status).toBe('partial')
    })

    it('routes a Cargo manifest to the Rust resolver', async function () {
        const path = await write('Cargo.lock', CARGO_LOCK)
        const result = await resolveManifest(dir, manifest('Cargo.lock', 'crates.io', path))
        expect(result.ecosystem).toBe('crates.io')
        expect(result.status !== 'unauditable' && result.graph.packages[0]?.name).toBe('anyhow')
    })

    it('reports an ecosystem with no resolver as unauditable', async function () {
        const result = await resolveManifest(dir, manifest('stack.yaml', 'Hackage', join(dir, 'stack.yaml')))
        expect(result.status).toBe('unauditable')
        expect(result.status === 'unauditable' && result.details.join(' ')).toContain('Hackage')
    })
})

describe('resolveProjectGraphs', function () {
    it('resolves every manifest it is given', async function () {
        const npmPath = await write('package-lock.json', NPM_LOCK)
        const pyPath = await write('requirements.txt', 'django==4.2.0\n')
        const results = await resolveProjectGraphs(dir, [
            manifest('package-lock.json', 'npm', npmPath),
            manifest('requirements.txt', 'PyPI', pyPath)
        ])
        expect(results.map(function eco(r) { return r.ecosystem })).toEqual(['npm', 'PyPI'])
    })

    it('returns nothing for no manifests', async function () {
        expect(await resolveProjectGraphs(dir, [])).toEqual([])
    })
})

describe('mergeResolvedGraphs', function () {
    it('merges packages across ecosystems into one graph', function () {
        const merged = mergeResolvedGraphs([
            okResult('npm', [pkg('lodash', '4.17.20', 'npm')]),
            okResult('PyPI', [pkg('django', '4.2.0', 'PyPI')])
        ])
        expect(merged?.packages).toHaveLength(2)
    })

    // A partial graph still contains real installed packages, so excluding it would hide findings.
    it('includes packages from a partial result', function () {
        const merged = mergeResolvedGraphs([partialResult('Go', [pkg('github.com/a/b', 'v1.0.0', 'Go')])])
        expect(merged?.packages).toHaveLength(1)
    })

    it('contributes nothing from an unauditable result', function () {
        const merged = mergeResolvedGraphs([
            okResult('npm', [pkg('lodash', '4.17.20', 'npm')]),
            unauditableResult('PyPI')
        ])
        expect(merged?.packages).toHaveLength(1)
    })

    it('returns null when nothing resolved', function () {
        expect(mergeResolvedGraphs([unauditableResult('npm')])).toBeNull()
    })

    it('returns null for no results at all', function () {
        expect(mergeResolvedGraphs([])).toBeNull()
    })

    it('keeps same-named packages from different ecosystems distinct', function () {
        const merged = mergeResolvedGraphs([
            okResult('npm', [pkg('requests', '1.0.0', 'npm')]),
            okResult('PyPI', [pkg('requests', '2.0.0', 'PyPI')])
        ])
        expect(merged?.byName('requests')).toHaveLength(2)
    })
})

describe('graphForEcosystem', function () {
    it('returns the graph for the requested ecosystem only', function () {
        const graph = graphForEcosystem(
            [okResult('npm', [pkg('lodash', '4.17.20', 'npm')]), okResult('PyPI', [pkg('django', '4.2.0', 'PyPI')])],
            'npm'
        )
        expect(graph?.packages[0]?.name).toBe('lodash')
    })

    it('accepts a partial graph', function () {
        const graph = graphForEcosystem([partialResult('Go', [pkg('github.com/a/b', 'v1.0.0', 'Go')])], 'Go')
        expect(graph?.packages).toHaveLength(1)
    })

    it('returns null when that ecosystem was unauditable', function () {
        expect(graphForEcosystem([unauditableResult('npm')], 'npm')).toBeNull()
    })

    it('returns null when that ecosystem is absent', function () {
        expect(graphForEcosystem([okResult('npm', [])], 'PyPI')).toBeNull()
    })
})

// Decision SENTINEL-118: a manifest with no lockfile covering it is reported `no_lockfile` for its
// ecosystem, never silently omitted. Only Cargo's lock can sit above the manifest it covers — one per
// workspace — and only up to the owning project's directory.
describe('detectManifestsIn — manifests without a lockfile', function () {
    const PREVIEW = ECOSYSTEMS.filter(function nonNpm(eco) { return eco.id !== 'npm' })

    async function detect(sub: string, files: Record<string, string>, projectPath = dir): Promise<string[]> {
        for (const [path, text] of Object.entries(files)) {
            await mkdir(join(dir, path, '..'), { recursive: true })
            await writeFile(join(dir, path), text, 'utf8')
        }
        const found = await detectManifestsIn(join(dir, sub), projectPath, PREVIEW)
        return found.map(function kind(m) { return m.ecosystem + ':' + m.kind })
    }

    it('detects each lockless manifest kind', async function () {
        expect(await detect('.', { Gemfile: '', 'Cargo.toml': '', 'pyproject.toml': '' })).toEqual(['PyPI:pyproject.toml', 'crates.io:Cargo.toml', 'RubyGems:Gemfile'])
        expect(await detect('other', { 'other/Pipfile': '' })).toEqual(['PyPI:Pipfile'])
    })

    // A supported lockfile beside the manifest covers it; the lockfile is what is detected.
    it('prefers the lockfile beside a manifest', async function () {
        expect(await detect('.', { Gemfile: '', 'Gemfile.lock': '', 'pyproject.toml': '', 'requirements.txt': '', 'Cargo.toml': '', 'Cargo.lock': '' }))
            .toEqual(['PyPI:requirements.txt', 'crates.io:Cargo.lock', 'RubyGems:Gemfile.lock'])
    })

    // A Cargo workspace locks every member at its root.
    it('treats a workspace member under the project lock as covered', async function () {
        expect(await detect('crates/core', { 'Cargo.lock': '', 'Cargo.toml': '', 'crates/core/Cargo.toml': '' })).toEqual([])
    })

    // …but a lock outside the project belongs to another project.
    it('does not look above the owning project for a Cargo lock', async function () {
        const found = await detect('app/member', { 'Cargo.lock': '', 'app/member/Cargo.toml': '' }, join(dir, 'app'))
        expect(found).toEqual(['crates.io:Cargo.toml'])
    })

    // Bundler and the Python tools lock beside the manifest, so a lock elsewhere covers nothing.
    it('does not let a Gemfile.lock elsewhere cover a Gemfile', async function () {
        expect(await detect('android', { 'ios/Gemfile.lock': '', 'android/Gemfile': '' })).toEqual(['RubyGems:Gemfile'])
    })

    it('resolves a lockless manifest to no_lockfile, naming the lockfiles that would cover it', async function () {
        await mkdir(join(dir, 'android'), { recursive: true })
        await writeFile(join(dir, 'android', 'Gemfile'), '', 'utf8')
        const result = await resolveManifest(dir, { kind: 'Gemfile', ecosystem: 'RubyGems', absolutePath: join(dir, 'android', 'Gemfile') })
        expect(result).toEqual({ status: 'unauditable', ecosystem: 'RubyGems', reasonCode: 'no_lockfile', details: ['android/Gemfile has no lockfile covering it (Gemfile.lock)'] })
    })

    // A project with one readable Gemfile.lock and one bare Gemfile: the readable one resolves and the
    // bare one says why it could not, so the readable lock never hides the gap.
    it('keeps a readable lock and a lockless sibling apart', async function () {
        await mkdir(join(dir, 'ios'), { recursive: true })
        await mkdir(join(dir, 'android'), { recursive: true })
        await writeFile(join(dir, 'ios', 'Gemfile.lock'), 'GEM\n  remote: https://rubygems.org/\n  specs:\n    fastlane (2.220.0)\n\nDEPENDENCIES\n  fastlane\n', 'utf8')
        await writeFile(join(dir, 'android', 'Gemfile'), 'gem "fastlane"\n', 'utf8')
        const manifests = [
            ...await detectManifestsIn(join(dir, 'ios'), dir, PREVIEW),
            ...await detectManifestsIn(join(dir, 'android'), dir, PREVIEW)
        ]
        const results = await resolveProjectGraphs(dir, manifests)
        expect(results.map(function status(r) { return r.status + (r.status === 'unauditable' ? ':' + r.reasonCode : '') })).toEqual(['ok', 'unauditable:no_lockfile'])
        expect(results[0]?.status === 'ok' && results[0].graph.packages[0]?.manifestPath).toBe('ios/Gemfile.lock')
    })
})

describe('resolveManifest — RubyGems', function () {
    it('routes a Gemfile.lock to the Ruby resolver', async function () {
        const path = await write('Gemfile.lock', 'GEM\n  remote: https://rubygems.org/\n  specs:\n    rack (2.2.8)\n\nDEPENDENCIES\n  rack\n')
        const result = await resolveManifest(dir, { kind: 'Gemfile.lock', ecosystem: 'RubyGems', absolutePath: path })
        expect(result.status).toBe('ok')
        expect(result.status === 'ok' && result.graph.packages.map(function nv(p) { return p.name + '@' + p.version })).toEqual(['rack@2.2.8'])
    })
})
