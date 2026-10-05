import { beforeEach, describe, expect, it } from 'vitest'
import type { NpmDownloadsResult, NpmPackageResult, NpmPackageSummary } from '@sentinello/feeds'
import { createMemoryRegistryStore } from './memory-store'
import { createNpmRegistryClient, parseSummary, REGISTRY_FETCH_CONCURRENCY, REGISTRY_FRESH_MS, type PackumentRequest, type RegistryStore } from './registry-client'

// The client over an in-memory store; the worker's registry-store.test.ts drives it over the real table.
const NOW = Date.UTC(2026, 9, 3, 12)

let store: RegistryStore

function summary(name: string): NpmPackageSummary {
    return { v: 2, name, latest: '1.0.0', modified: NOW, maintainers: 1, repository: null, versions: { '1.0.0': { publishedAt: NOW, deprecated: null, edges: null } }, prereleases: {}, edges: [] }
}

function ok(name: string, etag: string | null = null): NpmPackageResult {
    return { status: 'ok', summary: summary(name), etag, bytes: 100 }
}

function cache(name: string, status: 'ok' | 'not_found', checkedAt: number, summaryJson: string | null = status === 'ok' ? JSON.stringify(summary(name)) : null, etag: string | null = null): void {
    store.put({ name, status, summaryJson, checkedAt, etag })
}

// A fetcher answering from a table, counting calls and recording the validator each one sent.
function fetcher(answers: Record<string, NpmPackageResult>) {
    const calls: string[] = []
    const validators: Record<string, string | null> = {}
    return {
        calls,
        validators,
        fetchPackage: async function fetchPackage(name: string, request: PackumentRequest): Promise<NpmPackageResult> {
            calls.push(name)
            validators[name] = request.ifNoneMatch
            return answers[name] ?? { status: 'error', reason: 'no answer' }
        }
    }
}

beforeEach(function setup() {
    store = createMemoryRegistryStore()
})

describe('createNpmRegistryClient — cache first', function () {
    it('serves fresh rows from the cache without fetching', async function () {
        cache('a', 'ok', NOW - REGISTRY_FRESH_MS)
        cache('b', 'not_found', NOW - 1000)
        const f = fetcher({})
        const out = await createNpmRegistryClient(store, { fetchPackage: f.fetchPackage, now: () => NOW }).lookup(['a', 'b', 'a'])
        expect(f.calls).toEqual([])
        expect(out.get('a')).toEqual({ status: 'ok', summary: summary('a'), checkedAt: NOW - REGISTRY_FRESH_MS, origin: 'cache' })
        expect(out.get('b')).toEqual({ status: 'not_found', checkedAt: NOW - 1000, origin: 'cache' })
    })

    it('refetches an expired row and caches the answer', async function () {
        cache('a', 'ok', NOW - REGISTRY_FRESH_MS - 1)
        const f = fetcher({ a: ok('a'), gone: { status: 'not_found' } })
        const out = await createNpmRegistryClient(store, { fetchPackage: f.fetchPackage, now: () => NOW }).lookup(['a', 'gone'])
        expect(f.calls.sort()).toEqual(['a', 'gone'])
        expect(out.get('a')).toMatchObject({ status: 'ok', checkedAt: NOW, origin: 'fetched' })
        expect(out.get('gone')).toEqual({ status: 'not_found', checkedAt: NOW, origin: 'fetched' })
        const rows = store.get(['a', 'gone'])
        expect(rows.get('a')).toMatchObject({ status: 'ok', checkedAt: NOW })
        expect(rows.get('gone')).toMatchObject({ status: 'not_found', summaryJson: null, checkedAt: NOW })
    })

    it('refetches a fresh row whose summary cannot be read', async function () {
        cache('a', 'ok', NOW, '{broken')
        const f = fetcher({ a: ok('a') })
        const out = await createNpmRegistryClient(store, { fetchPackage: f.fetchPackage, now: () => NOW }).lookup(['a'])
        expect(f.calls).toEqual(['a'])
        expect(out.get('a')).toMatchObject({ origin: 'fetched' })
    })
})

describe('createNpmRegistryClient — a failed refetch', function () {
    it('serves the last good row as stale and keeps it', async function () {
        const old = NOW - REGISTRY_FRESH_MS * 3
        cache('a', 'ok', old)
        const f = fetcher({ a: { status: 'error', reason: 'HTTP 503' } })
        const out = await createNpmRegistryClient(store, { fetchPackage: f.fetchPackage, now: () => NOW }).lookup(['a'])
        expect(out.get('a')).toEqual({ status: 'stale', summary: summary('a'), checkedAt: old, reason: 'HTTP 503' })
        expect(store.get(['a']).get('a')).toMatchObject({ status: 'ok', checkedAt: old })
    })

    it('is an error, never cached, when there is no good row to fall back on', async function () {
        cache('gone', 'not_found', NOW - REGISTRY_FRESH_MS * 2)
        cache('junk', 'ok', NOW - REGISTRY_FRESH_MS * 2, 'null')
        const f = fetcher({})
        const out = await createNpmRegistryClient(store, { fetchPackage: f.fetchPackage, now: () => NOW }).lookup(['gone', 'junk', 'new'])
        expect(out.get('gone')).toEqual({ status: 'error', reason: 'no answer' })
        expect(out.get('junk')).toEqual({ status: 'error', reason: 'no answer' })
        expect(out.get('new')).toEqual({ status: 'error', reason: 'no answer' })
        expect(store.get(['new']).size).toBe(0)
    })

    it('reaches the live fetcher by default, which degrades to an error when the registry is unreachable', async function () {
        // vitest.config.ts points SENTINELLO_NPM_REGISTRY_URL at a refusing port.
        const out = await createNpmRegistryClient(store).lookup(['braces'])
        expect(out.get('braces')?.status).toBe('error')
    })
})

describe('createNpmRegistryClient — concurrency', function () {
    it(`keeps at most ${REGISTRY_FETCH_CONCURRENCY} fetches in flight`, async function () {
        let inFlight = 0
        let peak = 0
        const names = Array.from({ length: REGISTRY_FETCH_CONCURRENCY * 2 + 1 }, function n(_v, i) { return 'p' + i })
        const client = createNpmRegistryClient(store, {
            now: () => NOW,
            fetchPackage: async function slow(name): Promise<NpmPackageResult> {
                inFlight++
                peak = Math.max(peak, inFlight)
                await new Promise(function wait(r) { setTimeout(r, 5) })
                inFlight--
                return ok(name)
            }
        })
        const out = await client.lookup(names)
        expect(out.size).toBe(names.length)
        expect(peak).toBe(REGISTRY_FETCH_CONCURRENCY)
    })

    it('shares one limit and one fetch per package across simultaneous lookups (two projects at once)', async function () {
        let inFlight = 0
        let peak = 0
        const calls: string[] = []
        const client = createNpmRegistryClient(store, {
            now: () => NOW,
            fetchPackage: async function slow(name): Promise<NpmPackageResult> {
                calls.push(name)
                inFlight++
                peak = Math.max(peak, inFlight)
                await new Promise(function wait(r) { setTimeout(r, 10) })
                inFlight--
                return ok(name)
            }
        })
        const names = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']
        const [a, b] = await Promise.all([client.lookup(names), client.lookup([...names].reverse())])
        expect(peak).toBeLessThanOrEqual(REGISTRY_FETCH_CONCURRENCY)
        expect(calls.sort()).toEqual(names)
        expect(a.get('p6')).toEqual(b.get('p6'))
    })

    it('takes another limit when a measurement run sets one', async function () {
        let inFlight = 0
        let peak = 0
        const client = createNpmRegistryClient(store, {
            now: () => NOW,
            concurrency: 8,
            fetchPackage: async function slow(name): Promise<NpmPackageResult> {
                inFlight++
                peak = Math.max(peak, inFlight)
                await new Promise(function wait(r) { setTimeout(r, 5) })
                inFlight--
                return ok(name)
            }
        })
        await client.lookup(Array.from({ length: 20 }, function n(_v, i) { return 'p' + i }))
        expect(peak).toBe(8)
    })

    it('answers a throwing fetcher as an error', async function () {
        const client = createNpmRegistryClient(store, { now: () => NOW, fetchPackage: async function boom(): Promise<NpmPackageResult> { throw new Error('socket hang up') } })
        expect((await client.lookup(['a'])).get('a')).toEqual({ status: 'error', reason: 'socket hang up' })
    })

    it('fetches nothing for an empty lookup', async function () {
        const f = fetcher({})
        expect((await createNpmRegistryClient(store, { fetchPackage: f.fetchPackage }).lookup([])).size).toBe(0)
        expect(f.calls).toEqual([])
    })
})

describe('createNpmRegistryClient — ETag revalidation', function () {
    it('never revalidates a cached v1 summary: it refetches it in full', async function () {
        const { prereleases: _none, ...v1 } = { ...summary('a'), v: 1 }
        cache('a', 'ok', NOW - REGISTRY_FRESH_MS - 1, JSON.stringify(v1), '"e1"')
        const f = fetcher({ a: ok('a', '"e2"') })
        const out = await createNpmRegistryClient(store, { fetchPackage: f.fetchPackage, now: () => NOW }).lookup(['a'])
        expect(f.validators).toEqual({ a: null })
        expect(out.get('a')).toMatchObject({ status: 'ok', summary: summary('a') })
    })

    it('stores the ETag of a fetched answer, and none for not_found', async function () {
        const f = fetcher({ a: ok('a', '"e1"'), gone: { status: 'not_found' } })
        await createNpmRegistryClient(store, { fetchPackage: f.fetchPackage, now: () => NOW }).lookup(['a', 'gone'])
        expect(f.validators).toEqual({ a: null, gone: null })
        expect(store.get(['a']).get('a')).toMatchObject({ etag: '"e1"' })
        expect(store.get(['gone']).get('gone')).toMatchObject({ etag: null })
    })

    it('revalidates an expired row with its ETag; a 304 serves the held summary as fetched now', async function () {
        const old = NOW - REGISTRY_FRESH_MS - 1
        cache('a', 'ok', old, undefined, 'W/"e1"')
        store.setDownloads('a', 7, old)
        const f = fetcher({ a: { status: 'not_modified', etag: '"e1"' } })
        const out = await createNpmRegistryClient(store, { fetchPackage: f.fetchPackage, now: () => NOW }).lookup(['a'])
        expect(f.validators).toEqual({ a: 'W/"e1"' })
        expect(out.get('a')).toEqual({ status: 'ok', summary: summary('a'), checkedAt: NOW, origin: 'fetched' })
        expect(store.get(['a']).get('a')).toEqual({ name: 'a', status: 'ok', summaryJson: JSON.stringify(summary('a')), checkedAt: NOW, etag: '"e1"', weeklyDownloads: 7, downloadsCheckedAt: old })
    })

    it('keeps the stored ETag when a 304 carries none', async function () {
        cache('a', 'ok', NOW - REGISTRY_FRESH_MS - 1, undefined, '"e1"')
        const f = fetcher({ a: { status: 'not_modified', etag: null } })
        await createNpmRegistryClient(store, { fetchPackage: f.fetchPackage, now: () => NOW }).lookup(['a'])
        expect(store.get(['a']).get('a')).toMatchObject({ checkedAt: NOW, etag: '"e1"' })
    })

    it('replaces the summary and its ETag when the packument changed', async function () {
        cache('a', 'ok', NOW - REGISTRY_FRESH_MS - 1, undefined, '"e1"')
        const f = fetcher({ a: ok('a', '"e2"') })
        await createNpmRegistryClient(store, { fetchPackage: f.fetchPackage, now: () => NOW }).lookup(['a'])
        expect(f.validators).toEqual({ a: '"e1"' })
        expect(store.get(['a']).get('a')).toMatchObject({ checkedAt: NOW, etag: '"e2"' })
    })

    it('sends no validator for a row without an ETag, a not_found row, or a summary it cannot read', async function () {
        const old = NOW - REGISTRY_FRESH_MS - 1
        cache('plain', 'ok', old)
        cache('gone', 'not_found', old, null, '"x"')
        cache('junk', 'ok', old, '{broken', '"x"')
        const f = fetcher({ plain: ok('plain'), gone: ok('gone'), junk: ok('junk') })
        await createNpmRegistryClient(store, { fetchPackage: f.fetchPackage, now: () => NOW }).lookup(['plain', 'gone', 'junk'])
        expect(f.validators).toEqual({ plain: null, gone: null, junk: null })
    })

    it('reads a 304 with nothing held to confirm as an error, never as an answer', async function () {
        cache('junk', 'ok', NOW - REGISTRY_FRESH_MS - 1, '{broken', '"x"')
        const f = fetcher({ junk: { status: 'not_modified', etag: '"x"' }, new: { status: 'not_modified', etag: null } })
        const out = await createNpmRegistryClient(store, { fetchPackage: f.fetchPackage, now: () => NOW }).lookup(['junk', 'new'])
        expect(out.get('junk')).toEqual({ status: 'error', reason: 'HTTP 304 with no cached packument to confirm' })
        expect(out.get('new')).toEqual({ status: 'error', reason: 'HTTP 304 with no cached packument to confirm' })
        expect(store.get(['new']).size).toBe(0)
        expect(store.get(['junk']).get('junk')).toMatchObject({ checkedAt: NOW - REGISTRY_FRESH_MS - 1 })
    })
})

describe('createNpmRegistryClient — no cap', function () {
    it('fetches every miss in one lookup, however many there are', async function () {
        const names = Array.from({ length: 200 }, function name(_x, i) { return 'p' + i })
        const f = fetcher(Object.fromEntries(names.map(function answer(n) { return [n, ok(n)] })))
        const out = await createNpmRegistryClient(store, { fetchPackage: f.fetchPackage, now: () => NOW }).lookup(names)
        expect([...out.values()].every(function fetched(e) { return e.status === 'ok' && e.origin === 'fetched' })).toBe(true)
        expect(f.calls).toHaveLength(200)
    })
})

describe('createNpmRegistryClient — weekly downloads', function () {
    it('serves a fresh cached count, fetches and records a missing one, and degrades a failure to the last count or null', async function () {
        cache('fresh', 'ok', NOW)
        cache('old', 'ok', NOW)
        cache('fetched', 'ok', NOW)
        store.setDownloads('fresh', 7, NOW - 1000)
        store.setDownloads('old', 3, NOW - REGISTRY_FRESH_MS - 1)
        const calls: string[] = []
        const client = createNpmRegistryClient(store, {
            now: () => NOW,
            fetchDownloads: async function count(name): Promise<NpmDownloadsResult> {
                calls.push(name)
                if (name === 'fetched') return { status: 'ok', weeklyDownloads: 42 }
                if (name === 'throws') throw new Error('boom')
                return { status: 'error', reason: 'HTTP 500' }
            }
        })
        const out = await client.weeklyDownloads(['fresh', 'old', 'fetched', 'missing', 'throws', 'fetched'])
        expect(Object.fromEntries(out)).toEqual({ fresh: 7, old: 3, fetched: 42, missing: null, throws: null })
        expect(calls.sort()).toEqual(['fetched', 'missing', 'old', 'throws'])
        expect(store.get(['fetched']).get('fetched')).toMatchObject({ weeklyDownloads: 42, downloadsCheckedAt: NOW })
    })

    it('fetches one count once when two callers ask at the same time, and reaches the live service by default', async function () {
        let calls = 0
        const client = createNpmRegistryClient(store, {
            now: () => NOW,
            fetchDownloads: async function count(): Promise<NpmDownloadsResult> {
                calls++
                await new Promise(function wait(r) { setTimeout(r, 5) })
                return { status: 'ok', weeklyDownloads: 1 }
            }
        })
        await Promise.all([client.weeklyDownloads(['a']), client.weeklyDownloads(['a'])])
        expect(calls).toBe(1)
        // vitest.config.ts points SENTINELLO_NPM_DOWNLOADS_URL at a refusing port.
        expect((await createNpmRegistryClient(store).weeklyDownloads(['braces'])).get('braces')).toBeNull()
    })
})

describe('parseSummary', function () {
    // A v1 summary was cached before prereleases were kept: it is no summary, so it is refetched in full.
    it('accepts a v2 summary and rejects anything else, a cached v1 summary included', function () {
        expect(parseSummary(JSON.stringify(summary('a')))).toEqual(summary('a'))
        expect(parseSummary(null)).toBeNull()
        expect(parseSummary('{')).toBeNull()
        expect(parseSummary('null')).toBeNull()
        const { prereleases: _none, ...v1 } = { ...summary('a'), v: 1 }
        expect(parseSummary(JSON.stringify(v1))).toBeNull()
        expect(parseSummary(JSON.stringify({ ...summary('a'), v: 3 }))).toBeNull()
        expect(parseSummary(JSON.stringify({ ...summary('a'), prereleases: null }))).toBeNull()
        expect(parseSummary(JSON.stringify({ ...summary('a'), versions: null }))).toBeNull()
        expect(parseSummary(JSON.stringify({ ...summary('a'), versions: 'x' }))).toBeNull()
    })

    // Issue 033: a v2 summary missing what a closure proof reads is no summary either — a dangling edge index
    // would read as "no dependencies" and certify a closure that does reach the target.
    const edged: NpmPackageSummary = {
        ...summary('a'),
        versions: { '1.0.0': { publishedAt: NOW, deprecated: null, edges: 0 }, '2.0.0': { publishedAt: null, deprecated: 'old', edges: null } },
        prereleases: { '2.0.0-rc.1': 0, '2.0.0-rc.2': null },
        edges: [{ dependencies: { vuln: '1.0.0' }, optionalDependencies: {}, peerDependencies: { p: '^1' }, optionalPeers: ['p'] }]
    }
    const edgeSet = edged.edges[0] as NpmPackageSummary['edges'][number]

    it('accepts a whole summary with edges, deprecations and prereleases', function () {
        expect(parseSummary(JSON.stringify(edged))).toEqual(edged)
    })

    it.each([
        ['an array for versions', { ...edged, versions: [] }],
        ['an array for prereleases', { ...edged, prereleases: [] }],
        ['a missing edge table', { ...edged, edges: undefined }],
        ['an edge table that is not an array', { ...edged, edges: {} }],
        ['a release pointing past the edge table', { ...edged, edges: [] }],
        ['a negative edge index', { ...edged, versions: { '1.0.0': { publishedAt: NOW, deprecated: null, edges: -1 } } }],
        ['a fractional edge index', { ...edged, versions: { '1.0.0': { publishedAt: NOW, deprecated: null, edges: 0.5 } } }],
        ['a release without its edge index', { ...edged, versions: { '1.0.0': { publishedAt: NOW, deprecated: null } } }],
        ['a release that is not an object', { ...edged, versions: { '1.0.0': 0 } }],
        ['a release with a non-string deprecation', { ...edged, versions: { '1.0.0': { publishedAt: NOW, deprecated: true, edges: null } } }],
        ['a release with a non-numeric publish time', { ...edged, versions: { '1.0.0': { publishedAt: 'today', deprecated: null, edges: null } } }],
        ['a prerelease pointing past the edge table', { ...edged, prereleases: { '2.0.0-rc.1': 1 } }],
        ['a prerelease edge index that is not a number', { ...edged, prereleases: { '2.0.0-rc.1': '0' } }],
        ['an edge set that is not an object', { ...edged, edges: [null] }],
        ['an edge set without its dependency map', { ...edged, edges: [{ ...edgeSet, dependencies: undefined }] }],
        ['an edge set with a non-string range', { ...edged, edges: [{ ...edgeSet, optionalDependencies: { x: 1 } }] }],
        ['an edge set with peers that are not a list', { ...edged, edges: [{ ...edgeSet, optionalPeers: 'p' }] }],
        ['an edge set with a non-string optional peer', { ...edged, edges: [{ ...edgeSet, optionalPeers: [1] }] }],
        ['a name that is not a string', { ...edged, name: 1 }],
        ['a latest tag that is not a string', { ...edged, latest: 1 }],
        ['a modified time that is not a number', { ...edged, modified: 'x' }],
        ['a maintainer count that is not a number', { ...edged, maintainers: null }],
        ['a repository that is not a string', { ...edged, repository: {} }]
    ] as const)('rejects a v2 summary with %s', function (_label, broken) {
        expect(parseSummary(JSON.stringify(broken))).toBeNull()
    })

    it('never revalidates an incomplete v2 summary: no validator is sent, and a stray 304 is an error, not evidence', async function () {
        const old = NOW - REGISTRY_FRESH_MS - 1
        cache('a', 'ok', old, JSON.stringify({ ...edged, edges: [] }), '"same-packument"')
        const f = fetcher({ a: { status: 'not_modified', etag: '"same-packument"' } })
        const out = await createNpmRegistryClient(store, { fetchPackage: f.fetchPackage, now: () => NOW }).lookup(['a'])
        expect(f.validators).toEqual({ a: null })
        expect(out.get('a')).toEqual({ status: 'error', reason: 'HTTP 304 with no cached packument to confirm' })
        expect(store.get(['a']).get('a')).toMatchObject({ checkedAt: old })
    })

    it('refetches an incomplete v2 summary in full, even while it is fresh, and never falls back to it', async function () {
        cache('a', 'ok', NOW, JSON.stringify({ ...edged, edges: [] }), '"e1"')
        const refetched = await createNpmRegistryClient(store, { fetchPackage: fetcher({ a: { status: 'ok', summary: edged, etag: '"e2"', bytes: 10 } }).fetchPackage, now: () => NOW }).lookup(['a'])
        expect(refetched.get('a')).toEqual({ status: 'ok', summary: edged, checkedAt: NOW, origin: 'fetched' })
        cache('b', 'ok', NOW, JSON.stringify({ ...edged, name: 'b', edges: [] }), '"e1"')
        const failed = await createNpmRegistryClient(store, { fetchPackage: fetcher({}).fetchPackage, now: () => NOW }).lookup(['b'])
        expect(failed.get('b')).toEqual({ status: 'error', reason: 'no answer' })
    })
})
