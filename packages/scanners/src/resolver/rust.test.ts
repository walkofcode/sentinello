import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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

async function writeToml(text: string, at = '.'): Promise<void> {
    await mkdir(join(dir, at), { recursive: true })
    await writeFile(join(dir, at, 'Cargo.toml'), text, 'utf8')
}

// The crates.io id Cargo.lock gives a registry crate: name, version and source.
function registryId(name: string, version: string): string {
    return name + '@' + version + ' (' + REGISTRY + ')'
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
        await writeToml('[package]\nname = "my-app"\n')
        const result = await parseCargoLock(dir, await writeLock(entry('my-app', '0.1.0', null)), 'Cargo.lock')
        expect(result).toMatchObject({ status: 'unauditable', reasonCode: 'ambiguous_dependency_spec', details: ['no crates.io packages found in Cargo.lock'] })
    })

    // Without a manifest the source-less crate cannot be shown to be the project's own, and says so.
    it('names a source-less crate it cannot locate when nothing else is locked', async function () {
        const result = await parseCargoLock(dir, await writeLock(entry('my-app', '0.1.0', null)), 'Cargo.lock')
        expect(result).toMatchObject({ status: 'unauditable', details: ['1 crates from git, local path or other registry sources cannot be audited: my-app (path)'] })
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
        await writeToml('[package]\nname = "my-app"\n\n[dependencies]\nmy-core = { path = "crates/core" }\nvendored = { path = "../vendored", package = "vendored-fork" }\n')
        await writeToml('[package]\nname = "my-core"\n', 'crates/core')
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

    // The chain starts at the project's direct dependency, as npm's does, and reads name@version whatever
    // the node id carries.
    it('gives each crate its shortest chain from the project', async function () {
        await writeToml('[package]\nname = "my-app"\n')
        const result = await parseCargoLock(dir, await writeLock(LOCK), 'Cargo.lock')
        if (result.status === 'unauditable') throw new Error('expected a graph')
        expect(result.graph.byName('bytes')[0]?.depPaths).toEqual(['tokio@1.38.0', 'bytes@1.6.0'])
        expect(result.graph.nodeGraph?.roots.map(function id(r) { return r.nodeId }).sort()).toEqual([registryId('criterion', '0.5.1'), registryId('tokio', '1.38.0')])
    })

    // The roots are the project's own dependencies, so a dev-dependency's own dependencies are dev too.
    it('spreads dev scope through the graph', async function () {
        await writeToml('[package]\nname = "my-app"\n\n[dependencies]\ntokio = "1"\n\n[dev-dependencies]\ncriterion = "0.5"\n')
        const result = await parseCargoLock(dir, await writeLock(LOCK), 'Cargo.lock')
        if (result.status === 'unauditable') throw new Error('expected a graph')
        expect(result.graph.classify('plotters', '0.3.6')).toMatchObject({ isProd: false, isDev: true })
        expect(result.graph.classify('bytes', '1.6.0')).toMatchObject({ isProd: true, isDev: false })
    })

    it('resolves a dependency that names its version', async function () {
        await writeToml('[package]\nname = "my-app"\n')
        const lock = crate('my-app', '0.1.0', null, ['rand 0.8.5', 'rand 0.7.3 (registry+https://github.com/rust-lang/crates.io-index)']) + entry('rand', '0.7.3') + entry('rand', '0.8.5')
        const result = await parseCargoLock(dir, await writeLock(lock), 'Cargo.lock')
        if (result.status === 'unauditable') throw new Error('expected a graph')
        expect(result.graph.byName('rand').map(function chain(p) { return p.depPaths.join(' > ') }).sort()).toEqual(['rand@0.7.3', 'rand@0.8.5'])
        expect(result.graph.nodeGraph?.roots.map(function id(r) { return r.nodeId }).sort()).toEqual([registryId('rand', '0.7.3'), registryId('rand', '0.8.5')])
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
        await writeToml('[package]\nname = "my-app"\n')
        const lock = '[[package]]\nname = "my-app"\nversion = "0.1.0"\ndependencies = [\n "missing",\n { name = "odd" },\n "anyhow",\n "anyhow 1.0.86 (bad",\n]\n\n' + entry('anyhow', '1.0.86')
        const result = await parseCargoLock(dir, await writeLock(lock), 'Cargo.lock')
        expect(result.status !== 'unauditable' && result.graph.nodeGraph?.roots.map(function id(r) { return r.nodeId })).toEqual([registryId('anyhow', '1.0.86')])
    })

    // With no project crate to start from, a crate another depends on is not a root of its own.
    it('roots a lockfile without project crates at what nothing depends on', async function () {
        const lock = crate('tokio', '1.38.0', REGISTRY, ['bytes']) + crate('bytes', '1.6.0', REGISTRY, [])
        const result = await parseCargoLock(dir, await writeLock(lock), 'Cargo.lock')
        expect(result.status !== 'unauditable' && result.graph.nodeGraph?.roots.map(function id(r) { return r.nodeId })).toEqual([registryId('tokio', '1.38.0')])
    })
})

// SENTINEL-129: scope and path ownership belong to the crate whose manifest declares them, not to the
// manifest that happens to sit beside Cargo.lock.
describe('parseCargoLock — workspace members', function () {
    // The reviewer's reproduction: the root package uses `bytes` only for tests, the `app` member ships it.
    it('scopes each member\'s dependencies by its own manifest', async function () {
        await writeToml('[package]\nname = "root"\n\n[workspace]\nmembers = ["app"]\n\n[dev-dependencies]\nbytes = "1"\n')
        await writeToml('[package]\nname = "app"\n\n[dependencies]\nbytes = "1"\n', 'app')
        const lock = crate('root', '0.1.0', null, ['bytes']) + crate('app', '0.1.0', null, ['bytes']) + entry('bytes', '1.6.0')
        const result = await parseCargoLock(dir, await writeLock(lock), 'Cargo.lock')
        expect(result.status).toBe('ok')
        if (result.status === 'unauditable') throw new Error('expected a graph')
        expect(result.graph.classify('bytes', '1.6.0')).toMatchObject({ isProd: true, isDev: true })
        expect(result.graph.nodeGraph?.roots.map(function importer(r) { return r.importer + ' ' + r.kind }).sort()).toEqual(['. dev', 'app prod'])
    })

    // …and a member's dev-dependency is dev even when the root manifest names none.
    it('reads a member\'s dev-dependencies as dev', async function () {
        await writeToml('[workspace]\nmembers = ["crates/*"]\n')
        await writeToml('[package]\nname = "app"\n\n[dev-dependencies]\ncriterion = "0.5"\n', 'crates/app')
        const lock = crate('app', '0.1.0', null, ['criterion']) + entry('criterion', '0.5.1')
        const result = await parseCargoLock(dir, await writeLock(lock), 'Cargo.lock')
        expect(result.status !== 'unauditable' && result.graph.classify('criterion', '0.5.1')).toMatchObject({ isProd: false, isDev: true })
    })

    // The reviewer's second reproduction: only the member declares the path dependency outside the project.
    it('counts a member-only path dependency outside the project as cannot be audited', async function () {
        await writeToml('[workspace]\nmembers = ["crates/*"]\n')
        await writeToml('[package]\nname = "app"\n\n[dependencies]\noutside = { path = "../../../outside" }\n', 'crates/app')
        const lock = crate('app', '0.1.0', null, ['outside', 'anyhow']) + crate('outside', '0.3.0', null, []) + entry('anyhow', '1.0.86')
        const result = await parseCargoLock(dir, await writeLock(lock), 'Cargo.lock')
        expect(result.status).toBe('partial')
        expect(result.status === 'partial' && result.details).toEqual(['1 crates from git, local path or other registry sources cannot be audited: outside (path)'])
    })

    // A crate with no source whose manifest is not found cannot be shown to be the project's own.
    it('never assumes a source-less crate it cannot locate is own code', async function () {
        await writeToml('[workspace]\nmembers = ["crates/*"]\nexclude = ["crates/skipped"]\n')
        await writeToml('[package]\nname = "app"\n', 'crates/app')
        await writeToml('[package]\nname = "skipped"\n', 'crates/skipped')
        await mkdir(join(dir, 'crates', 'not-a-crate'), { recursive: true })
        const lock = crate('app', '0.1.0', null, ['anyhow']) + crate('skipped', '0.1.0', null, []) + crate('stray', '0.1.0', null, []) + entry('anyhow', '1.0.86')
        const result = await parseCargoLock(dir, await writeLock(lock), 'Cargo.lock')
        expect(result.status === 'partial' && result.details).toEqual(['2 crates from git, local path or other registry sources cannot be audited: skipped (path), stray (path)'])
    })

    // A path dependency inside the project is a member too, wherever it is declared — including a
    // `[workspace.dependencies]` entry and a `[patch.crates-io]` override.
    it('follows in-project path dependencies from every manifest', async function () {
        await writeToml('[package]\nname = "root"\n\n[workspace.dependencies]\ncore = { path = "libs/core" }\n\n[patch.crates-io]\nserde = { path = "vendor/serde" }\n\n[dependencies]\ncore = { workspace = true }\n')
        await writeToml('[package]\nname = "core"\n\n[dependencies]\nhelper = { path = "../helper" }\n', 'libs/core')
        await writeToml('[package]\nname = "helper"\n', 'libs/helper')
        await writeToml('[package]\nname = "serde"\n', 'vendor/serde')
        const lock = crate('root', '0.1.0', null, ['core', 'serde']) + crate('core', '0.1.0', null, ['helper']) + crate('helper', '0.1.0', null, []) + crate('serde', '1.0.200', null, []) + entry('anyhow', '1.0.86')
        const result = await parseCargoLock(dir, await writeLock(lock), 'Cargo.lock')
        expect(result.status).toBe('ok')
    })

    // Two manifests can declare one package name; the lockfile cannot tell them apart, so prod wins.
    it('keeps a dependency prod when only one of two same-named manifests calls it dev', async function () {
        await writeToml('[workspace]\nmembers = ["a", "b"]\n')
        await writeToml('[package]\nname = "tool"\n\n[dev-dependencies]\nbytes = "1"\n', 'a')
        await writeToml('[package]\nname = "tool"\n\n[dependencies]\nbytes = "1"\n', 'b')
        const result = await parseCargoLock(dir, await writeLock(crate('tool', '0.1.0', null, ['bytes']) + entry('bytes', '1.6.0')), 'Cargo.lock')
        expect(result.status !== 'unauditable' && result.graph.classify('bytes', '1.6.0')).toMatchObject({ isProd: true, isDev: false })
    })

    it('reads a workspace with no member list or a member that is not there', async function () {
        await writeToml('[package]\nname = "root"\n\n[workspace]\nmembers = ["missing", "./", "gone/*"]\n')
        const result = await parseCargoLock(dir, await writeLock(crate('root', '0.1.0', null, ['anyhow']) + entry('anyhow', '1.0.86')), 'Cargo.lock')
        expect(result.status).toBe('ok')
    })
})

// SENTINEL-130: one lockfile can hold `x 1.0.0` from crates.io and `x 1.0.0` from git. They are two crates:
// only the registry one is audited, and their edges and scope stay their own.
describe('parseCargoLock — one name and version from two sources', function () {
    const GIT = 'git+https://example.test/x?branch=main#abc'
    const appCrate = crate('my-app', '0.1.0', null, ['x 1.0.0 (' + GIT + ')', 'y'])
    const yCrate = crate('y', '1.0.0', REGISTRY, ['x 1.0.0 (' + REGISTRY + ')'])
    const registryX = crate('x', '1.0.0', REGISTRY, ['a'])
    const gitX = crate('x', '1.0.0', GIT, ['b'])
    const leaves = entry('a', '1.0.0') + entry('b', '1.0.0')

    it.each([
        ['registry first', appCrate + yCrate + registryX + gitX + leaves],
        ['git first', appCrate + yCrate + gitX + registryX + leaves]
    ])('keeps them apart (%s)', async function (_order, lock) {
        await writeToml('[package]\nname = "my-app"\n\n[dependencies]\nx = { git = "https://example.test/x" }\n\n[dev-dependencies]\ny = "1"\n')
        const result = await parseCargoLock(dir, await writeLock(lock), 'Cargo.lock')
        if (result.status !== 'partial') throw new Error('expected a partial graph')
        expect(result.details.join(' ')).toContain('x (git)')
        expect(result.graph.byName('x').map(function chain(p) { return p.depPaths.join(' > ') })).toEqual(['y@1.0.0 > x@1.0.0'])
        // The registry x is reached only through the dev-only y; the git x, which ships, is never audited.
        expect(result.graph.classify('x', '1.0.0')).toMatchObject({ isProd: false, isDev: true })
        expect(result.graph.classify('a', '1.0.0')).toMatchObject({ isProd: false, isDev: true })
        expect(result.graph.classify('b', '1.0.0')).toMatchObject({ isProd: true, isDev: false })
    })

    // A dependency reference written without the git commit names the same source.
    it('resolves a source reference written without its commit', async function () {
        await writeToml('[package]\nname = "my-app"\n')
        const lock = crate('my-app', '0.1.0', null, ['x 1.0.0 (git+https://example.test/x?branch=main)']) + gitX + leaves
        const result = await parseCargoLock(dir, await writeLock(lock), 'Cargo.lock')
        expect(result.status !== 'unauditable' && result.graph.classify('b', '1.0.0')).toMatchObject({ isProd: true })
        expect(result.status !== 'unauditable' && result.graph.byName('b')[0]?.depPaths).toEqual(['x@1.0.0', 'b@1.0.0'])
    })
})

// SENTINEL-129, second round: Cargo spells one dependency several ways — a dotted key (`bytes.workspace = true`),
// an inline table, a header of its own, a top-level dotted table — and a member may inherit it, under an alias,
// from `[workspace.dependencies]`. Every spelling names the same locked crate, or a shipped crate reads as dev.
describe('parseCargoLock — dependency spellings and inherited declarations', function () {
    const WORKSPACE = '[workspace]\nmembers = ["app"]\n\n[workspace.dependencies]\nbytes = "1"\n'
    const LOCK = crate('app', '0.1.0', null, ['bytes']) + entry('bytes', '1.6.0')

    // The reviewer's reproduction: app ships bytes through workspace inheritance and also names it for tests.
    it.each([
        ['a dotted key', '[dependencies]\nbytes.workspace = true\n'],
        ['a quoted dotted key', '[dependencies]\n"bytes".workspace = true\n'],
        ['an inline table', '[dependencies]\nbytes = { workspace = true }\n'],
        ['a header of its own', '[dependencies.bytes]\nworkspace = true\n'],
        ['a target table', '[target.\'cfg(unix)\'.dependencies]\nbytes.workspace = true\n']
    ])('reads an inherited prod declaration written as %s', async function (_spelling, dependencies) {
        await writeToml(WORKSPACE)
        await writeToml('[package]\nname = "app"\nversion = "0.1.0"\n\n' + dependencies + '\n[dev-dependencies]\nbytes = "1"\n', 'app')
        const result = await parseCargoLock(dir, await writeLock(LOCK), 'Cargo.lock')
        if (result.status === 'unauditable') throw new Error('expected a graph')
        expect(result.graph.classify('bytes', '1.6.0')).toMatchObject({ isProd: true, isDev: false })
    })

    // A top-level dotted key is a table too: `dev-dependencies.criterion` is `[dev-dependencies] criterion`.
    it('reads a dependency table written as top-level dotted keys', async function () {
        await writeToml('dev-dependencies.criterion = "0.5"\n\n[package]\nname = "app"\n')
        const result = await parseCargoLock(dir, await writeLock(crate('app', '0.1.0', null, ['criterion']) + entry('criterion', '0.5.1')), 'Cargo.lock')
        expect(result.status !== 'unauditable' && result.graph.classify('criterion', '0.5.1')).toMatchObject({ isProd: false, isDev: true })
    })

    // An inherited declaration takes the locked name from the workspace entry's `package` rename.
    it('resolves an inherited alias to the crate it renames', async function () {
        await writeToml('[workspace]\nmembers = ["app"]\n\n[workspace.dependencies]\nnet = { package = "bytes", version = "1" }\nbench.package = "criterion"\nbench.version = "0.5"\n')
        await writeToml('[package]\nname = "app"\n\n[dependencies]\nnet.workspace = true\n\n[dev-dependencies]\nbytes = "1"\nbench = { workspace = true }\n', 'app')
        const lock = crate('app', '0.1.0', null, ['bytes', 'criterion']) + entry('bytes', '1.6.0') + entry('criterion', '0.5.1')
        const result = await parseCargoLock(dir, await writeLock(lock), 'Cargo.lock')
        if (result.status === 'unauditable') throw new Error('expected a graph')
        expect(result.graph.classify('bytes', '1.6.0')).toMatchObject({ isProd: true, isDev: false })
        expect(result.graph.classify('criterion', '0.5.1')).toMatchObject({ isProd: false, isDev: true })
    })

    // An inherited prod declaration the workspace does not define names no crate this reader can trust, so
    // the manifest claims nothing is dev-only rather than hiding what it may ship.
    it('claims no dev-only scope when an inherited prod declaration cannot be resolved', async function () {
        await writeToml('[workspace]\nmembers = ["app"]\n')
        await writeToml('[package]\nname = "app"\n\n[dependencies]\nnet.workspace = true\n\n[dev-dependencies]\nbytes = "1"\n', 'app')
        const result = await parseCargoLock(dir, await writeLock(LOCK), 'Cargo.lock')
        expect(result.status !== 'unauditable' && result.graph.classify('bytes', '1.6.0')).toMatchObject({ isProd: true, isDev: false })
    })

    // An unresolved inherited dev-dependency names nothing (it stays out of the dev set), and a `target` or
    // `[patch]` entry that is not a table holds no declaration.
    it('skips declarations it cannot read without losing the rest', async function () {
        await writeToml('target.odd = "x"\npatch.crates-io = "y"\n\n[package]\nname = "app"\n\n[dev-dependencies]\nnet.workspace = true\ncriterion = "0.5"\n')
        const result = await parseCargoLock(dir, await writeLock(crate('app', '0.1.0', null, ['criterion', 'net']) + entry('criterion', '0.5.1') + entry('net', '1.0.0')), 'Cargo.lock')
        if (result.status === 'unauditable') throw new Error('expected a graph')
        expect(result.graph.classify('criterion', '0.5.1')).toMatchObject({ isProd: false, isDev: true })
        expect(result.graph.classify('net', '1.0.0')).toMatchObject({ isProd: true, isDev: false })
    })

    // Path ownership reads every spelling too: a dotted `path`, a `[patch]` entry with a header of its own.
    it('follows a path dependency written as a dotted key', async function () {
        await writeToml('[workspace]\nmembers = ["app"]\n')
        await writeToml('[package]\nname = "app"\n\n[dependencies]\nhelper.path = "../libs/helper"\n', 'app')
        await writeToml('[package]\nname = "helper"\n', 'libs/helper')
        const lock = crate('app', '0.1.0', null, ['helper', 'anyhow']) + crate('helper', '0.3.0', null, []) + entry('anyhow', '1.0.86')
        const result = await parseCargoLock(dir, await writeLock(lock), 'Cargo.lock')
        expect(result.status).toBe('ok')
    })

    it('reads [patch] and [workspace.dependencies] paths in every spelling', async function () {
        await writeToml('[package]\nname = "root"\n\n[workspace.dependencies]\ncore.path = "libs/core"\n\n[patch.crates-io]\nserde.path = "vendor/serde"\n\n[patch."https://example.test/x".tokio]\npath = "../outside-tokio"\n')
        await writeToml('[package]\nname = "core"\n', 'libs/core')
        await writeToml('[package]\nname = "serde"\n', 'vendor/serde')
        const lock = crate('root', '0.1.0', null, ['core', 'serde', 'tokio']) + crate('core', '0.1.0', null, []) + crate('serde', '1.0.200', null, []) + crate('tokio', '1.38.0', null, []) + entry('anyhow', '1.0.86')
        const result = await parseCargoLock(dir, await writeLock(lock), 'Cargo.lock')
        expect(result.status === 'partial' && result.details).toEqual(['1 crates from git, local path or other registry sources cannot be audited: tokio (path)'])
    })

    // A `[replace]` key is a package id spec (`name:version`, `name@version`, `<source>#name@version`), not a name.
    it.each(['foo:0.1.0', 'foo@0.1.0', 'https://github.com/rust-lang/crates.io-index#foo@0.1.0', 'https://example.test/foo#0.1.0'])('reads the crate a [replace] key %j names', async function (key) {
        await writeToml('[package]\nname = "root"\n\n[workspace]\nmembers = ["foo"]\n\n[replace]\n"' + key + '" = { path = "../outside-foo" }\n')
        await writeToml('[package]\nname = "foo"\n', 'foo')
        const lock = crate('root', '0.1.0', null, ['foo']) + crate('foo', '0.1.0', null, []) + entry('anyhow', '1.0.86')
        const result = await parseCargoLock(dir, await writeLock(lock), 'Cargo.lock')
        expect(result.status === 'partial' && result.details).toEqual(['1 crates from git, local path or other registry sources cannot be audited: foo (path)'])
    })
})

// SENTINEL-135: a source URL in a package id spec may carry a `?branch=…`/`?tag=…`/`?rev=…` query before a
// version-only fragment, and the query may hold a `/`. The crate is the URL's last PATH segment.
describe('parseCargoLock — [replace] source URLs with a query', function () {
    it.each([
        'git+https://example.test/foo?branch=main#0.1.0',
        'git+https://example.test/foo?branch=feature/topic#0.1.0',
        'https://example.test/group/foo?rev=0a1b2c#0.1.0',
        'git+https://example.test/foo/?tag=v0.1.0#0.1.0'
    ])('records an outside replacement from %j under the crate it names', async function (key) {
        await writeToml('[package]\nname = "root"\nversion = "0.1.0"\n\n[workspace]\nmembers = ["local-foo"]\n\n[dependencies]\nfoo = { git = "https://example.test/foo" }\n\n[replace]\n"' + key + '" = { path = "../outside-foo" }\n')
        // An in-project crate of the same name, at another version: name alone would call the replacement own.
        await writeToml('[package]\nname = "foo"\nversion = "0.2.0"\n', 'local-foo')
        const lock = crate('root', '0.1.0', null, ['foo 0.1.0', 'anyhow']) + crate('foo', '0.1.0', null, []) + crate('foo', '0.2.0', null, []) + entry('anyhow', '1.0.86')
        const result = await parseCargoLock(dir, await writeLock(lock), 'Cargo.lock')
        expect(result.status).toBe('partial')
        expect(result.status === 'partial' && result.details.join(' ')).toContain('foo (path)')
    })

    // A URL that does not parse, or has no path to name a crate, names none (Cargo rejects both).
    it.each(['https://#0.1.0', 'git+https://example.test#0.1.0'])('records no crate for the [replace] key %j', async function (key) {
        await writeToml('[package]\nname = "root"\n\n[replace]\n"' + key + '" = { path = "../outside" }\n')
        const result = await parseCargoLock(dir, await writeLock(crate('root', '0.1.0', null, ['anyhow']) + entry('anyhow', '1.0.86')), 'Cargo.lock')
        expect(result.status).toBe('ok')
    })
})

// SENTINEL-129, third round: `workspace = true` inherits from the workspace that OWNS the manifest, which is
// not always the one beside Cargo.lock. A path dependency can be its own workspace root, point at another one
// with `package.workspace`, or be excluded from the outer workspace and owned by a nearer ancestor.
describe('parseCargoLock — inherited declarations resolve against their own workspace', function () {
    // The outer workspace renames `bytes` to tokio; the helper's own workspace does not.
    const OUTER = '[package]\nname = "app"\nversion = "0.1.0"\n\n[workspace.dependencies]\nbytes = { package = "tokio", version = "1" }\n\n[dependencies]\nhelper = { path = "vendor/helper" }\n'
    const HELPER = '[package]\nname = "helper"\nversion = "0.1.0"\n__WORKSPACE__\n[dependencies]\nbytes.workspace = true\n\n[dev-dependencies]\nbytes = "1"\n'
    const LOCK = crate('app', '0.1.0', null, ['helper']) + crate('helper', '0.1.0', null, ['bytes']) + entry('bytes', '1.6.0')

    async function shipped(): Promise<unknown> {
        const result = await parseCargoLock(dir, await writeLock(LOCK), 'Cargo.lock')
        if (result.status === 'unauditable') throw new Error('expected a graph')
        return result.graph.classify('bytes', '1.6.0')
    }

    // The reviewer's reproduction: an excluded path dependency that is a workspace of its own.
    it('reads an excluded nested workspace against its own [workspace.dependencies]', async function () {
        await writeToml(OUTER.replace('[workspace.dependencies]', '[workspace]\nexclude = ["vendor/helper"]\n\n[workspace.dependencies]'))
        await writeToml(HELPER.replace('__WORKSPACE__', '\n[workspace]\n\n[workspace.dependencies]\nbytes = "1"\n'), 'vendor/helper')
        expect(await shipped()).toMatchObject({ isProd: true, isDev: false })
    })

    // `package.workspace` names the root explicitly.
    it('reads a manifest whose package.workspace points at another workspace', async function () {
        await writeToml(OUTER.replace('[workspace.dependencies]', '[workspace]\nexclude = ["vendor"]\n\n[workspace.dependencies]'))
        await writeToml('[workspace]\nmembers = ["../helper"]\n\n[workspace.dependencies]\nbytes = "1"\n', 'vendor/tools')
        await writeToml(HELPER.replace('__WORKSPACE__', 'workspace = "../tools"\n'), 'vendor/helper')
        expect(await shipped()).toMatchObject({ isProd: true, isDev: false })
    })

    // Without either, the owner is the nearest ancestor workspace that does not exclude the manifest; its
    // inherited paths are read relative to that root.
    it('reads a manifest against the nearest ancestor workspace that does not exclude it', async function () {
        await writeToml(OUTER.replace('[workspace.dependencies]', '[workspace]\nexclude = ["vendor"]\n\n[workspace.dependencies]'))
        await writeToml('[workspace]\nmembers = ["helper"]\n\n[workspace.dependencies]\nbytes = "1"\ncore = { path = "core" }\n', 'vendor')
        await writeToml(HELPER.replace('__WORKSPACE__', '').replace('[dev-dependencies]', 'core.workspace = true\n\n[dev-dependencies]'), 'vendor/helper')
        await writeToml('[package]\nname = "core"\n', 'vendor/core')
        const lock = crate('app', '0.1.0', null, ['helper']) + crate('helper', '0.1.0', null, ['bytes', 'core']) + crate('core', '0.1.0', null, []) + entry('bytes', '1.6.0')
        const result = await parseCargoLock(dir, await writeLock(lock), 'Cargo.lock')
        if (result.status === 'unauditable') throw new Error('expected a graph')
        expect(result.status).toBe('ok')
        expect(result.graph.classify('bytes', '1.6.0')).toMatchObject({ isProd: true, isDev: false })
    })

    // An excluded manifest with no other workspace in the project has no owner this reader can read, so it
    // borrows nothing from the outer workspace and claims nothing dev-only.
    it('claims no dev-only scope for a manifest whose owning workspace is not found', async function () {
        await writeToml(OUTER.replace('[workspace.dependencies]', '[workspace]\nexclude = ["vendor"]\n\n[workspace.dependencies]'))
        await writeToml(HELPER.replace('__WORKSPACE__', ''), 'vendor/helper')
        expect(await shipped()).toMatchObject({ isProd: true, isDev: false })
    })

    // A `package.workspace` that leaves the project, or names a directory with no workspace, is no owner either.
    it.each(['../../../elsewhere', '../not-a-workspace'])('claims no dev-only scope when package.workspace is %j', async function (pointer) {
        await writeToml(OUTER.replace('[workspace.dependencies]', '[workspace]\nexclude = ["vendor"]\n\n[workspace.dependencies]'))
        await writeToml('[package]\nname = "other"\n', 'vendor/not-a-workspace')
        await writeToml(HELPER.replace('__WORKSPACE__', 'workspace = "' + pointer + '"\n'), 'vendor/helper')
        expect(await shipped()).toMatchObject({ isProd: true, isDev: false })
    })

    // A member the outer workspace lists explicitly is its own even under an excluded directory.
    it('keeps an explicitly listed member in the outer workspace despite an exclude around it', async function () {
        await writeToml('[package]\nname = "app"\nversion = "0.1.0"\n\n[workspace]\nmembers = ["vendor/helper"]\nexclude = ["vendor"]\n\n[workspace.dependencies]\nbytes = { package = "tokio", version = "1" }\n\n[dependencies]\nhelper = { path = "vendor/helper" }\n')
        await writeToml(HELPER.replace('__WORKSPACE__', ''), 'vendor/helper')
        // Inherited from the outer root, helper ships tokio and names bytes only for tests.
        const lock = crate('app', '0.1.0', null, ['helper']) + crate('helper', '0.1.0', null, ['bytes', 'tokio']) + entry('bytes', '1.6.0') + entry('tokio', '1.38.0')
        const result = await parseCargoLock(dir, await writeLock(lock), 'Cargo.lock')
        if (result.status === 'unauditable') throw new Error('expected a graph')
        expect(result.graph.classify('bytes', '1.6.0')).toMatchObject({ isProd: false, isDev: true })
        expect(result.graph.classify('tokio', '1.38.0')).toMatchObject({ isProd: true, isDev: false })
    })
})
