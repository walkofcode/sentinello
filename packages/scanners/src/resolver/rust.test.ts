import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseCargoLock } from './rust'
import type { ResolverResult } from './types'

// Cargo.lock pins the complete resolved graph, so Rust is the offline-complete case and resolves to
// `ok`. The things that could go quietly wrong: auditing the workspace's own crate as if it were a
// third-party dependency, matching a git or local crate as though it were the crates.io release of the
// same name, and losing the dev/prod split that only Cargo.toml carries.

const REGISTRY = 'registry+https://github.com/rust-lang/crates.io-index'

let dir: string

beforeEach(async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-rust-'))
})

afterEach(async function cleanup() {
    await rm(dir, { recursive: true, force: true })
})

async function writeLock(text: string): Promise<string> {
    const path = join(dir, 'Cargo.lock')
    await writeFile(path, text, 'utf8')
    return path
}

async function writeToml(text: string): Promise<void> {
    await writeFile(join(dir, 'Cargo.toml'), text, 'utf8')
}

function entry(name: string, version: string, source: string | null = REGISTRY): string {
    const lines = ['[[package]]', 'name = "' + name + '"', 'version = "' + version + '"']
    if (source !== null) lines.push('source = "' + source + '"')
    return lines.join('\n') + '\n\n'
}

function names(result: ResolverResult): string[] {
    if (result.status === 'unauditable') return []
    return result.graph.packages.map(function name(p) {
        return p.name
    })
}

describe('parseCargoLock failure handling', function () {
    it('is unauditable when Cargo.lock cannot be read', async function () {
        const result = await parseCargoLock(dir, join(dir, 'nope.lock'), 'Cargo.lock')
        expect(result.status).toBe('unauditable')
        expect(result.status === 'unauditable' && result.reasonCode).toBe('unsupported_lockfile')
    })

    it('is unauditable when there are no registry packages', async function () {
        const result = await parseCargoLock(dir, await writeLock(entry('my-app', '0.1.0', null)), 'Cargo.lock')
        expect(result.status).toBe('unauditable')
        expect(result.status === 'unauditable' && result.reasonCode).toBe('ambiguous_dependency_spec')
    })

    it('always reports the crates.io ecosystem', async function () {
        expect((await parseCargoLock(dir, join(dir, 'nope.lock'), 'Cargo.lock')).ecosystem).toBe('crates.io')
    })
})

describe('parseCargoLock package extraction', function () {
    it('resolves to ok because Cargo.lock is complete', async function () {
        const result = await parseCargoLock(dir, await writeLock(entry('anyhow', '1.0.86')), 'Cargo.lock')
        expect(result.status).toBe('ok')
    })

    it('reads every registry crate', async function () {
        const lock = entry('anyhow', '1.0.86') + entry('serde', '1.0.200')
        expect(names(await parseCargoLock(dir, await writeLock(lock), 'Cargo.lock')).sort()).toEqual(['anyhow', 'serde'])
    })

    // A package with no `source` is the workspace's own crate or a path member — auditing it as a
    // third-party dependency would produce findings against the user's own code.
    it('skips a workspace crate that has no source', async function () {
        const lock = entry('my-app', '0.1.0', null) + entry('anyhow', '1.0.86')
        expect(names(await parseCargoLock(dir, await writeLock(lock), 'Cargo.lock'))).toEqual(['anyhow'])
    })

    it('skips an entry with an empty source', async function () {
        const lock = entry('my-app', '0.1.0', '') + entry('anyhow', '1.0.86')
        expect(names(await parseCargoLock(dir, await writeLock(lock), 'Cargo.lock'))).toEqual(['anyhow'])
    })

    it('skips an entry missing a name or version', async function () {
        const lock = '[[package]]\nsource = "' + REGISTRY + '"\n\n' + entry('anyhow', '1.0.86')
        expect(names(await parseCargoLock(dir, await writeLock(lock), 'Cargo.lock'))).toEqual(['anyhow'])
    })

    it('keeps the crate name and version verbatim for the OSV key', async function () {
        const result = await parseCargoLock(dir, await writeLock(entry('anyhow', '1.0.86')), 'Cargo.lock')
        expect(result.status !== 'unauditable' && result.graph.packages[0]).toMatchObject({
            name: 'anyhow',
            version: '1.0.86',
            ecosystem: 'crates.io'
        })
    })
})

describe('parseCargoLock dev classification', function () {
    it('treats every crate as prod when there is no Cargo.toml', async function () {
        const result = await parseCargoLock(dir, await writeLock(entry('anyhow', '1.0.86')), 'Cargo.lock')
        expect(result.status !== 'unauditable' && result.graph.classify('anyhow', '1.0.86')).toMatchObject({
            isProd: true,
            isDev: false
        })
    })

    it('marks a direct dev-dependency as dev', async function () {
        await writeToml('[dependencies]\nanyhow = "1.0"\n\n[dev-dependencies]\ncriterion = "0.5"\n')
        const lock = entry('anyhow', '1.0.86') + entry('criterion', '0.5.1')
        const result = await parseCargoLock(dir, await writeLock(lock), 'Cargo.lock')
        if (result.status === 'unauditable') throw new Error('expected a graph')
        expect(result.graph.classify('criterion', '0.5.1')).toMatchObject({ isProd: false, isDev: true })
        expect(result.graph.classify('anyhow', '1.0.86')).toMatchObject({ isProd: true, isDev: false })
    })

    it('handles the table form of a dev-dependency', async function () {
        await writeToml('[dev-dependencies]\ncriterion = { version = "0.5" }\n')
        const result = await parseCargoLock(dir, await writeLock(entry('criterion', '0.5.1')), 'Cargo.lock')
        expect(result.status !== 'unauditable' && result.graph.classify('criterion', '0.5.1')).toMatchObject({
            isDev: true
        })
    })

    // A malformed line inside the table must not abort the section or register a nameless dev
    // dependency — everything after it still has to be read, or one stray line silently reclassifies
    // the rest of the dev tree as production.
    it('skips malformed lines inside the dev-dependencies table', async function () {
        await writeToml('[dev-dependencies]\nnonsense\n= "0.1"\ncriterion = "0.5"\n')
        const result = await parseCargoLock(dir, await writeLock(entry('criterion', '0.5.1')), 'Cargo.lock')
        expect(result.status !== 'unauditable' && result.graph.classify('criterion', '0.5.1')).toMatchObject({
            isDev: true
        })
    })

    it('counts a target-specific dev-dependencies table', async function () {
        await writeToml('[target.\'cfg(unix)\'.dev-dependencies]\ncriterion = "0.5"\n')
        const result = await parseCargoLock(dir, await writeLock(entry('criterion', '0.5.1')), 'Cargo.lock')
        expect(result.status !== 'unauditable' && result.graph.classify('criterion', '0.5.1')).toMatchObject({
            isDev: true
        })
    })

    it('stops reading dev names at the next table header', async function () {
        await writeToml('[dev-dependencies]\ncriterion = "0.5"\n\n[dependencies]\nanyhow = "1.0"\n')
        const lock = entry('anyhow', '1.0.86') + entry('criterion', '0.5.1')
        const result = await parseCargoLock(dir, await writeLock(lock), 'Cargo.lock')
        expect(result.status !== 'unauditable' && result.graph.classify('anyhow', '1.0.86')).toMatchObject({
            isProd: true,
            isDev: false
        })
    })

    it('ignores comments in Cargo.toml', async function () {
        await writeToml('[dev-dependencies]\n# criterion = "0.5"\ncriterion = "0.5"\n')
        const result = await parseCargoLock(dir, await writeLock(entry('criterion', '0.5.1')), 'Cargo.lock')
        expect(result.status !== 'unauditable' && result.graph.classify('criterion', '0.5.1')).toMatchObject({
            isDev: true
        })
    })

    // A crate no dev root reaches is prod, which keeps real findings visible.
    it('leaves a crate no dev root reaches as prod', async function () {
        await writeToml('[dev-dependencies]\ncriterion = "0.5"\n')
        const lock = entry('criterion', '0.5.1') + entry('plotters', '0.3.0')
        const result = await parseCargoLock(dir, await writeLock(lock), 'Cargo.lock')
        expect(result.status !== 'unauditable' && result.graph.classify('plotters', '0.3.0')).toMatchObject({
            isProd: true
        })
    })
})

// An entry with its dependency list, the way Cargo writes one.
function crate(name: string, version: string, source: string | null, dependencies: string[]): string {
    const lines = ['[[package]]', 'name = "' + name + '"', 'version = "' + version + '"']
    if (source !== null) lines.push('source = "' + source + '"')
    if (dependencies.length > 0) lines.push('dependencies = [', ...dependencies.map(function dep(d) { return ' "' + d + '",' }), ']')
    return lines.join('\n') + '\n\n'
}

describe('parseCargoLock sources', function () {
    // An advisory about crates.io's `openssl` says nothing about a git checkout of a crate with that name.
    it('counts a git crate as cannot be audited and does not match it', async function () {
        const lock = crate('my-app', '0.1.0', null, ['openssl', 'anyhow']) + entry('openssl', '0.10.0', 'git+https://github.com/example/rust-openssl?branch=main#abc') + entry('anyhow', '1.0.86')
        const result = await parseCargoLock(dir, await writeLock(lock), 'Cargo.lock')
        expect(result.status).toBe('partial')
        expect(names(result)).toEqual(['anyhow'])
        expect(result.status === 'partial' && result.details.join(' ')).toContain('openssl (git)')
    })

    it('counts a crate from another registry as cannot be audited', async function () {
        const lock = crate('my-app', '0.1.0', null, ['internal']) + entry('internal', '1.0.0', 'registry+https://registry.example.test/index')
        const result = await parseCargoLock(dir, await writeLock(lock), 'Cargo.lock')
        expect(result.status).toBe('unauditable')
        expect(result.status === 'unauditable' && result.details.join(' ')).toContain('internal (registry)')
    })

    it('matches a crate from the sparse crates.io index', async function () {
        const result = await parseCargoLock(dir, await writeLock(entry('anyhow', '1.0.86', 'sparse+https://index.crates.io/')), 'Cargo.lock')
        expect(names(result)).toEqual(['anyhow'])
    })

    // A path dependency inside the project is the project's own code; one outside it is someone's local
    // checkout, which no advisory database covers.
    it('treats an in-project path dependency as own code and an outside one as cannot be audited', async function () {
        await writeToml('[dependencies]\nmy-core = { path = "crates/core" }\nvendored = { path = "../vendored", package = "vendored-fork" }\n')
        const lock = crate('my-app', '0.1.0', null, ['my-core', 'vendored-fork']) + crate('my-core', '0.1.0', null, ['anyhow']) + crate('vendored-fork', '2.0.0', null, []) + entry('anyhow', '1.0.86')
        const result = await parseCargoLock(dir, await writeLock(lock), 'Cargo.lock')
        expect(result.status).toBe('partial')
        expect(names(result)).toEqual(['anyhow'])
        expect(result.status === 'partial' && result.details.join(' ')).toContain('vendored-fork (path)')
        expect(result.status === 'partial' && result.details.join(' ')).not.toContain('my-core')
    })
})

describe('parseCargoLock graph', function () {
    const LOCK = crate('my-app', '0.1.0', null, ['tokio', 'criterion'])
        + crate('tokio', '1.38.0', REGISTRY, ['bytes'])
        + crate('bytes', '1.6.0', REGISTRY, [])
        + crate('criterion', '0.5.1', REGISTRY, ['plotters'])
        + crate('plotters', '0.3.6', REGISTRY, [])

    // The chain starts at the project's direct dependency, as npm's does.
    it('gives each crate its shortest chain from the project', async function () {
        const result = await parseCargoLock(dir, await writeLock(LOCK), 'Cargo.lock')
        if (result.status === 'unauditable') throw new Error('expected a graph')
        expect(result.graph.byName('bytes')[0]?.depPaths).toEqual(['tokio@1.38.0', 'bytes@1.6.0'])
        expect(result.graph.nodeGraph?.roots.map(function id(r) { return r.nodeId }).sort()).toEqual(['criterion@0.5.1', 'tokio@1.38.0'])
    })

    // The roots are the project's own dependencies, so a dev-dependency's own dependencies are dev too.
    it('spreads dev scope through the graph', async function () {
        await writeToml('[dependencies]\ntokio = "1"\n\n[dev-dependencies]\ncriterion = "0.5"\n')
        const result = await parseCargoLock(dir, await writeLock(LOCK), 'Cargo.lock')
        if (result.status === 'unauditable') throw new Error('expected a graph')
        expect(result.graph.classify('plotters', '0.3.6')).toMatchObject({ isProd: false, isDev: true })
        expect(result.graph.classify('bytes', '1.6.0')).toMatchObject({ isProd: true, isDev: false })
    })

    it('resolves a dependency that names its version', async function () {
        const lock = crate('my-app', '0.1.0', null, ['rand 0.8.5', 'rand 0.7.3 (registry+https://github.com/rust-lang/crates.io-index)']) + entry('rand', '0.7.3') + entry('rand', '0.8.5')
        const result = await parseCargoLock(dir, await writeLock(lock), 'Cargo.lock')
        if (result.status === 'unauditable') throw new Error('expected a graph')
        expect(result.graph.byName('rand').map(function chain(p) { return p.depPaths.join(' > ') }).sort()).toEqual(['rand@0.7.3', 'rand@0.8.5'])
        expect(result.graph.nodeGraph?.roots.map(function id(r) { return r.nodeId }).sort()).toEqual(['rand@0.7.3', 'rand@0.8.5'])
    })

    it('records the lockfile as the manifest of every crate', async function () {
        const result = await parseCargoLock(dir, await writeLock(LOCK), 'Cargo.lock')
        expect(result.status !== 'unauditable' && result.graph.packages.every(function path(p) { return p.manifestPath === 'Cargo.lock' })).toBe(true)
    })
})

describe('parseCargoLock Cargo.toml dependency tables', function () {
    // `[dev-dependencies.serde]` gives one crate its own table: `serde` is the crate, `version` is not.
    it('reads the dotted-header form as the crate it names', async function () {
        await writeToml('[dev-dependencies.serde_test]\nversion = "1.0"\nfeatures = ["derive"]\n')
        const lock = entry('serde_test', '1.0.177') + entry('version', '0.1.0')
        const result = await parseCargoLock(dir, await writeLock(lock), 'Cargo.lock')
        if (result.status === 'unauditable') throw new Error('expected a graph')
        expect(result.graph.classify('serde_test', '1.0.177')).toMatchObject({ isProd: false, isDev: true })
        expect(result.graph.classify('version', '0.1.0')).toMatchObject({ isProd: true, isDev: false })
    })

    it('reads a target-specific dotted header whose cfg holds an equals sign', async function () {
        await writeToml('[target.\'cfg(target_os = "linux")\'.dev-dependencies.criterion]\nversion = "0.5"\n')
        const result = await parseCargoLock(dir, await writeLock(entry('criterion', '0.5.1')), 'Cargo.lock')
        expect(result.status !== 'unauditable' && result.graph.classify('criterion', '0.5.1')).toMatchObject({ isDev: true })
    })

    // Named as both, the crate ships: prod wins.
    it('keeps a crate named in both tables prod', async function () {
        await writeToml('[dependencies]\nserde = "1"\n\n[dev-dependencies]\nserde = { version = "1", features = ["derive"] }\n')
        const result = await parseCargoLock(dir, await writeLock(entry('serde', '1.0.200')), 'Cargo.lock')
        expect(result.status !== 'unauditable' && result.graph.classify('serde', '1.0.200')).toMatchObject({ isProd: true, isDev: false })
    })
})

describe('parseCargoLock — entries it does not model', function () {
    it('is unauditable when no entry has a name and version', async function () {
        const result = await parseCargoLock(dir, await writeLock('[[package]]\nchecksum = "abc"\n'), 'Cargo.lock')
        expect(result).toMatchObject({ status: 'unauditable', reasonCode: 'ambiguous_dependency_spec', details: ['no packages found in Cargo.lock'] })
    })

    // A dependency naming nothing locked, and one written as something other than a string, are skipped.
    it('skips a dependency it cannot resolve', async function () {
        const lock = '[[package]]\nname = "my-app"\nversion = "0.1.0"\ndependencies = [\n "missing",\n { name = "odd" },\n "anyhow",\n]\n\n' + entry('anyhow', '1.0.86')
        const result = await parseCargoLock(dir, await writeLock(lock), 'Cargo.lock')
        expect(result.status !== 'unauditable' && result.graph.nodeGraph?.roots.map(function id(r) { return r.nodeId })).toEqual(['anyhow@1.0.86'])
    })

    // With no project crate to start from, a crate another depends on is not a root of its own.
    it('roots a lockfile without project crates at what nothing depends on', async function () {
        const lock = crate('tokio', '1.38.0', REGISTRY, ['bytes']) + crate('bytes', '1.6.0', REGISTRY, [])
        const result = await parseCargoLock(dir, await writeLock(lock), 'Cargo.lock')
        expect(result.status !== 'unauditable' && result.graph.nodeGraph?.roots.map(function id(r) { return r.nodeId })).toEqual(['tokio@1.38.0'])
    })
})
