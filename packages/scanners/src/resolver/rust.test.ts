import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseCargoLock } from './rust'
import type { ResolverResult } from './types'

// Cargo.lock pins the complete resolved graph, so Rust is the offline-complete case and resolves to
// `ok`. The two things that could go quietly wrong: auditing the workspace's own crate as if it were a
// third-party dependency, and losing the dev/prod split that only Cargo.toml carries.

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
        const result = await parseCargoLock(dir, join(dir, 'nope.lock'))
        expect(result.status).toBe('unauditable')
        expect(result.status === 'unauditable' && result.reasonCode).toBe('unsupported_lockfile')
    })

    it('is unauditable when there are no registry packages', async function () {
        const result = await parseCargoLock(dir, await writeLock(entry('my-app', '0.1.0', null)))
        expect(result.status).toBe('unauditable')
        expect(result.status === 'unauditable' && result.reasonCode).toBe('ambiguous_dependency_spec')
    })

    it('always reports the crates.io ecosystem', async function () {
        expect((await parseCargoLock(dir, join(dir, 'nope.lock'))).ecosystem).toBe('crates.io')
    })
})

describe('parseCargoLock package extraction', function () {
    it('resolves to ok because Cargo.lock is complete', async function () {
        const result = await parseCargoLock(dir, await writeLock(entry('anyhow', '1.0.86')))
        expect(result.status).toBe('ok')
    })

    it('reads every registry crate', async function () {
        const lock = entry('anyhow', '1.0.86') + entry('serde', '1.0.200')
        expect(names(await parseCargoLock(dir, await writeLock(lock))).sort()).toEqual(['anyhow', 'serde'])
    })

    // A package with no `source` is the workspace's own crate or a path member — auditing it as a
    // third-party dependency would produce findings against the user's own code.
    it('skips a workspace crate that has no source', async function () {
        const lock = entry('my-app', '0.1.0', null) + entry('anyhow', '1.0.86')
        expect(names(await parseCargoLock(dir, await writeLock(lock)))).toEqual(['anyhow'])
    })

    it('skips an entry with an empty source', async function () {
        const lock = entry('my-app', '0.1.0', '') + entry('anyhow', '1.0.86')
        expect(names(await parseCargoLock(dir, await writeLock(lock)))).toEqual(['anyhow'])
    })

    it('skips an entry missing a name or version', async function () {
        const lock = '[[package]]\nsource = "' + REGISTRY + '"\n\n' + entry('anyhow', '1.0.86')
        expect(names(await parseCargoLock(dir, await writeLock(lock)))).toEqual(['anyhow'])
    })

    it('keeps the crate name and version verbatim for the OSV key', async function () {
        const result = await parseCargoLock(dir, await writeLock(entry('anyhow', '1.0.86')))
        expect(result.status !== 'unauditable' && result.graph.packages[0]).toMatchObject({
            name: 'anyhow',
            version: '1.0.86',
            ecosystem: 'crates.io'
        })
    })
})

describe('parseCargoLock dev classification', function () {
    it('treats every crate as prod when there is no Cargo.toml', async function () {
        const result = await parseCargoLock(dir, await writeLock(entry('anyhow', '1.0.86')))
        expect(result.status !== 'unauditable' && result.graph.classify('anyhow', '1.0.86')).toMatchObject({
            isProd: true,
            isDev: false
        })
    })

    it('marks a direct dev-dependency as dev', async function () {
        await writeToml('[dependencies]\nanyhow = "1.0"\n\n[dev-dependencies]\ncriterion = "0.5"\n')
        const lock = entry('anyhow', '1.0.86') + entry('criterion', '0.5.1')
        const result = await parseCargoLock(dir, await writeLock(lock))
        if (result.status === 'unauditable') throw new Error('expected a graph')
        expect(result.graph.classify('criterion', '0.5.1')).toMatchObject({ isProd: false, isDev: true })
        expect(result.graph.classify('anyhow', '1.0.86')).toMatchObject({ isProd: true, isDev: false })
    })

    it('handles the table form of a dev-dependency', async function () {
        await writeToml('[dev-dependencies]\ncriterion = { version = "0.5" }\n')
        const result = await parseCargoLock(dir, await writeLock(entry('criterion', '0.5.1')))
        expect(result.status !== 'unauditable' && result.graph.classify('criterion', '0.5.1')).toMatchObject({
            isDev: true
        })
    })

    it('counts a target-specific dev-dependencies table', async function () {
        await writeToml('[target.\'cfg(unix)\'.dev-dependencies]\ncriterion = "0.5"\n')
        const result = await parseCargoLock(dir, await writeLock(entry('criterion', '0.5.1')))
        expect(result.status !== 'unauditable' && result.graph.classify('criterion', '0.5.1')).toMatchObject({
            isDev: true
        })
    })

    it('stops reading dev names at the next table header', async function () {
        await writeToml('[dev-dependencies]\ncriterion = "0.5"\n\n[dependencies]\nanyhow = "1.0"\n')
        const lock = entry('anyhow', '1.0.86') + entry('criterion', '0.5.1')
        const result = await parseCargoLock(dir, await writeLock(lock))
        expect(result.status !== 'unauditable' && result.graph.classify('anyhow', '1.0.86')).toMatchObject({
            isProd: true,
            isDev: false
        })
    })

    it('ignores comments in Cargo.toml', async function () {
        await writeToml('[dev-dependencies]\n# criterion = "0.5"\ncriterion = "0.5"\n')
        const result = await parseCargoLock(dir, await writeLock(entry('criterion', '0.5.1')))
        expect(result.status !== 'unauditable' && result.graph.classify('criterion', '0.5.1')).toMatchObject({
            isDev: true
        })
    })

    // Transitives are prod even when pulled in by a dev crate, which keeps real findings visible.
    it('leaves a transitive of a dev crate as prod', async function () {
        await writeToml('[dev-dependencies]\ncriterion = "0.5"\n')
        const lock = entry('criterion', '0.5.1') + entry('plotters', '0.3.0')
        const result = await parseCargoLock(dir, await writeLock(lock))
        expect(result.status !== 'unauditable' && result.graph.classify('plotters', '0.3.0')).toMatchObject({
            isProd: true
        })
    })
})
