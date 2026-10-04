import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { gunzipSync, gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NpmDownloadsResult, NpmPackageResult, NpmPackageSummary } from '@sentinello/feeds'
import { createNpmRegistryClient, REGISTRY_FRESH_MS, type RegistryRow } from '@sentinello/fixes'
import { tryAcquireLock } from './meta'
import {
    loadRegistryStore,
    mergeRow,
    parseRow,
    registryCacheSummary,
    registryFilePath,
    saveRegistryStore,
    type FileRegistryStore
} from './registry'

// The CLI's registry cache is the worker's registry_packages table as a file. What it must guarantee is
// D-b's: every name it holds answers the next run (not only the installed ones), and a save never drops
// another run's rows.

const NOW = Date.UTC(2026, 9, 4, 12)

let dir: string

beforeEach(async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-registry-'))
})

afterEach(async function cleanup() {
    await rm(dir, { recursive: true, force: true })
})

function summary(name: string): NpmPackageSummary {
    return { v: 1, name, latest: '1.0.0', modified: NOW, maintainers: 1, repository: null, versions: { '1.0.0': { publishedAt: NOW, deprecated: null, edges: null } }, edges: [] }
}

function row(name: string, overrides: Partial<RegistryRow> = {}): RegistryRow {
    return { name, status: 'ok', summaryJson: JSON.stringify(summary(name)), checkedAt: NOW, weeklyDownloads: null, downloadsCheckedAt: null, ...overrides }
}

// A run: its own store over the file as it is now, and a client whose fetches are counted.
async function run(at: number = NOW) {
    const store = await loadRegistryStore(dir)
    const packuments: string[] = []
    const counts: string[] = []
    const client = createNpmRegistryClient(store, {
        now: function now() { return at },
        fetchPackage: async function fetchPackage(name: string): Promise<NpmPackageResult> {
            packuments.push(name)
            return name.startsWith('missing') ? { status: 'not_found' } : { status: 'ok', summary: summary(name) }
        },
        fetchDownloads: async function fetchDownloads(name: string): Promise<NpmDownloadsResult> {
            counts.push(name)
            return { status: 'ok', weeklyDownloads: 1000 }
        }
    })
    return { store, client, packuments, counts }
}

async function onDisk(): Promise<Map<string, RegistryRow>> {
    const text = gunzipSync(await readFile(registryFilePath(dir))).toString('utf8')
    const rows = text.split('\n').filter(function nonEmpty(l) { return l.length > 0 }).map(function parse(l) { return JSON.parse(l) as RegistryRow })
    return new Map(rows.map(function keyed(r) { return [r.name, r] as const }))
}

describe('loadRegistryStore / saveRegistryStore', function () {
    it('starts empty when there is no file, and saves nothing when nothing was answered', async function () {
        const { store } = await run()
        expect(store.get(['a']).size).toBe(0)
        expect(store.dirtyRows()).toEqual([])
        expect(await saveRegistryStore(dir, store)).toBe('unchanged')
        await expect(readFile(registryFilePath(dir))).rejects.toThrow()
    })

    it('a closure-only name cached by run 1 is served by run 2 with no packument request', async function () {
        // `candidate-dep` is never installed: the way out discovers it while walking a candidate release.
        const first = await run()
        await first.client.lookup(['installed', 'candidate-dep', 'missing-pkg'])
        expect(first.packuments.sort()).toEqual(['candidate-dep', 'installed', 'missing-pkg'])
        expect(await saveRegistryStore(dir, first.store)).toBe('saved')

        const second = await run(NOW + REGISTRY_FRESH_MS - 1)
        const answers = await second.client.lookup(['candidate-dep', 'missing-pkg'])
        expect(second.packuments).toEqual([])
        expect(answers.get('candidate-dep')).toMatchObject({ status: 'ok', origin: 'cache', checkedAt: NOW })
        expect(answers.get('missing-pkg')).toMatchObject({ status: 'not_found', origin: 'cache' })
    })

    it('serves an expired answer as stale when the refetch fails, and keeps it on disk', async function () {
        await writeFile(registryFilePath(dir), gzipSync(JSON.stringify(row('a')) + '\n'))
        const store = await loadRegistryStore(dir)
        const client = createNpmRegistryClient(store, {
            now: function now() { return NOW + REGISTRY_FRESH_MS + 1 },
            fetchPackage: async function down(): Promise<NpmPackageResult> { return { status: 'error', reason: 'HTTP 503' } }
        })
        expect((await client.lookup(['a'])).get('a')).toMatchObject({ status: 'stale', checkedAt: NOW, reason: 'HTTP 503' })
        expect(await saveRegistryStore(dir, store)).toBe('unchanged')
        expect((await onDisk()).get('a')).toEqual(row('a'))
    })

    it('A, then B, then A with disjoint packages: A\'s rows survive B\'s save', async function () {
        const a = await run()
        await a.client.lookup(['a1', 'a2'])
        await saveRegistryStore(dir, a.store)
        const b = await run(NOW + 1)
        await b.client.lookup(['b1'])
        expect(b.packuments).toEqual(['b1'])
        await saveRegistryStore(dir, b.store)
        expect([...(await onDisk()).keys()].sort()).toEqual(['a1', 'a2', 'b1'])

        const again = await run(NOW + 2)
        await again.client.lookup(['a1', 'a2'])
        expect(again.packuments).toEqual([])
    })

    it('two overlapping runs whose saves happen one after the other keep both runs\' rows, newest answer winning', async function () {
        // Both load the same (empty) file before either saves.
        const x = await run(NOW + 10)
        const y = await run(NOW)
        await x.client.lookup(['x-only', 'shared'])
        await y.client.lookup(['y-only', 'shared'])
        await y.client.weeklyDownloads(['shared'])
        expect(await saveRegistryStore(dir, x.store)).toBe('saved')
        expect(await saveRegistryStore(dir, y.store)).toBe('saved')
        const rows = await onDisk()
        expect([...rows.keys()].sort()).toEqual(['shared', 'x-only', 'y-only'])
        // y saved last, but x's answer for `shared` is newer and stays; y's count is the only count and is kept.
        expect(rows.get('shared')).toMatchObject({ checkedAt: NOW + 10, weeklyDownloads: 1000, downloadsCheckedAt: NOW })
    })

    it('records a download count only beside an answer', async function () {
        const { store, client } = await run()
        await client.lookup(['a'])
        await client.weeklyDownloads(['a', 'no-answer'])
        expect(store.dirtyRows().map(function n(r) { return r.name })).toEqual(['a'])
        expect(store.dirtyRows()[0]).toMatchObject({ weeklyDownloads: 1000, downloadsCheckedAt: NOW })
    })

    it('a held lock skips the save and leaves the file intact', async function () {
        await writeFile(registryFilePath(dir), gzipSync(JSON.stringify(row('kept')) + '\n'))
        const { store, client } = await run()
        await client.lookup(['new'])
        const lock = await tryAcquireLock(dir)
        expect(lock).not.toBeNull()
        try {
            expect(await saveRegistryStore(dir, store)).toBe('locked')
        } finally {
            await lock?.release()
        }
        expect([...(await onDisk()).keys()]).toEqual(['kept'])
        // The skipped save never touched the lock: once its owner releases it, the next save goes through.
        expect(await saveRegistryStore(dir, store)).toBe('saved')
    })

    it('releases the lock and removes its temp file when the write fails', async function () {
        // A directory where the file should be: the rename fails.
        await mkdir(registryFilePath(dir))
        const { store, client } = await run()
        await client.lookup(['a'])
        await expect(saveRegistryStore(dir, store)).rejects.toThrow()
        expect((await readdir(dir)).sort()).toEqual(['registry-npm.ndjson.gz'])
        const lock = await tryAcquireLock(dir)
        expect(lock).not.toBeNull()
        await lock?.release()
    })

    it('creates the cache directory on first save', async function () {
        const nested = join(dir, 'nested')
        const store: FileRegistryStore = await loadRegistryStore(nested)
        store.put({ name: 'a', status: 'not_found', summaryJson: null, checkedAt: NOW })
        expect(await saveRegistryStore(nested, store)).toBe('saved')
        expect(await registryCacheSummary(nested)).toEqual({ rows: 1, oldestCheckedAt: NOW })
    })

    it('reads a corrupt file as empty, and drops lines that are not rows', async function () {
        await writeFile(registryFilePath(dir), 'not gzip')
        expect((await loadRegistryStore(dir)).get(['a']).size).toBe(0)
        await writeFile(registryFilePath(dir), gzipSync(JSON.stringify(row('good')) + '\n{oops\n\n' + JSON.stringify({ name: 'bad' }) + '\n'))
        const store = await loadRegistryStore(dir)
        expect([...store.get(['good', 'bad']).keys()]).toEqual(['good'])
    })
})

describe('parseRow', function () {
    it('accepts a row, and a count only with its timestamp', function () {
        expect(parseRow(JSON.stringify(row('a', { weeklyDownloads: 5, downloadsCheckedAt: NOW })))).toEqual(row('a', { weeklyDownloads: 5, downloadsCheckedAt: NOW }))
        expect(parseRow(JSON.stringify(row('a', { status: 'not_found', summaryJson: null })))).toEqual(row('a', { status: 'not_found', summaryJson: null }))
        expect(parseRow(JSON.stringify(row('a', { weeklyDownloads: 5 })))).toEqual(row('a'))
    })

    it.each([
        ['not JSON', '{'],
        ['not an object', '42'],
        ['null', 'null'],
        ['no name', JSON.stringify({ ...row('a'), name: '' })],
        ['a name that is not a string', JSON.stringify({ ...row('a'), name: 1 })],
        ['an unknown status', JSON.stringify({ ...row('a'), status: 'error' })],
        ['a summary that is not a string', JSON.stringify({ ...row('a'), summaryJson: {} })],
        ['no checkedAt', JSON.stringify({ ...row('a'), checkedAt: 'yesterday' })]
    ])('rejects %s', function (_label, line) {
        expect(parseRow(line)).toBeNull()
    })
})

describe('mergeRow', function () {
    it('takes the run\'s row when the disk has none', function () {
        expect(mergeRow(undefined, row('a'))).toEqual(row('a'))
    })

    it('judges the answer and the count each on its own timestamp', function () {
        const disk = row('a', { status: 'not_found', summaryJson: null, checkedAt: NOW + 5, weeklyDownloads: 1, downloadsCheckedAt: NOW })
        const mine = row('a', { checkedAt: NOW, weeklyDownloads: 2, downloadsCheckedAt: NOW + 5 })
        expect(mergeRow(disk, mine)).toEqual(row('a', { status: 'not_found', summaryJson: null, checkedAt: NOW + 5, weeklyDownloads: 2, downloadsCheckedAt: NOW + 5 }))
        expect(mergeRow(mine, disk)).toEqual(row('a', { status: 'not_found', summaryJson: null, checkedAt: NOW + 5, weeklyDownloads: 2, downloadsCheckedAt: NOW + 5 }))
    })

    it('keeps the disk\'s count when the run has none', function () {
        const disk = row('a', { weeklyDownloads: 1, downloadsCheckedAt: NOW })
        expect(mergeRow(disk, row('a', { checkedAt: NOW + 1 }))).toMatchObject({ checkedAt: NOW + 1, weeklyDownloads: 1, downloadsCheckedAt: NOW })
    })
})

describe('registryCacheSummary', function () {
    it('is null with no cache, and counts rows and the oldest answer otherwise', async function () {
        expect(await registryCacheSummary(dir)).toBeNull()
        await writeFile(registryFilePath(dir), gzipSync([row('a', { checkedAt: NOW }), row('b', { checkedAt: NOW - 5 })].map(function line(r) { return JSON.stringify(r) + '\n' }).join('')))
        expect(await registryCacheSummary(dir)).toEqual({ rows: 2, oldestCheckedAt: NOW - 5 })
    })
})
