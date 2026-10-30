import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { GoVersionInfoResult, PublishedResult } from '@sentinello/feeds'
import { versionSetFromSemverRange, type FixEvidence } from '@sentinello/scanners'
import { createGoRegistryClient, GO_INFO_CHECKS_PER_MODULE, parseGoSummary, type GoModuleSummary } from './go-registry'
import { createMemoryRegistryStore } from './memory-store'
import { fixEvidenceKey, settleProject, type FixIdentity } from './project'
import { REGISTRY_FRESH_MS, type RegistryStore } from './registry-client'

// The Go client: the proxy's list, cache first, plus a `.info` check for each stated fix version the list
// omits (SENTINEL-126). The three settlements the decision requires run against a real loopback proxy.

const NOW = Date.UTC(2026, 9, 29, 12)
const MODULE = 'golang.org/x/crypto'
const PSEUDO = 'v0.0.0-20200622213623-75b288015ac9'
const OTHER = 'v0.0.0-20210101000000-bbbbbbbbbbbb'

let store: RegistryStore

beforeEach(function setup() {
    store = createMemoryRegistryStore()
})

function list(versions: string[]): PublishedResult {
    return { status: 'ok', etag: null, summary: { v: 1, name: MODULE, versions: Object.fromEntries(versions.map(function v(version) { return [version, { yanked: false }] })) } }
}

// A proxy answering from tables, recording every request.
function fakeProxy(listed: PublishedResult, info: Record<string, GoVersionInfoResult> = {}) {
    const lists: string[] = []
    const checks: string[] = []
    return {
        lists,
        checks,
        fetchList: async function fetchList(module: string): Promise<PublishedResult> {
            lists.push(module)
            return listed
        },
        fetchInfo: async function fetchInfo(_module: string, version: string): Promise<GoVersionInfoResult> {
            checks.push(version)
            return info[version] ?? { status: 'error', reason: 'HTTP 503' }
        }
    }
}

function cachedSummary(): GoModuleSummary {
    return parseGoSummary(store.get([MODULE]).get(MODULE)?.summaryJson ?? null) as GoModuleSummary
}

describe('createGoRegistryClient', function () {
    it('serves the list as published versions, asking nothing more when every stated fix is listed', async function () {
        const proxy = fakeProxy(list(['v0.1.0', 'v0.2.0']))
        const out = await createGoRegistryClient(store, { ...proxy, now: () => NOW }).published(new Map([[MODULE, ['0.2.0']]]))
        expect(out.get(MODULE)).toEqual({ status: 'ok', published: [{ version: 'v0.1.0', deprecated: false }, { version: 'v0.2.0', deprecated: false }], dataAsOf: NOW })
        expect(proxy.checks).toEqual([])
    })

    it('confirms each unlisted stated version once, spelled with its v, and caches both kinds of answer with their time', async function () {
        const proxy = fakeProxy(list([]), { [PSEUDO]: { status: 'published' }, [OTHER]: { status: 'absent' } })
        const client = createGoRegistryClient(store, { ...proxy, now: () => NOW })
        const out = await client.published(new Map([[MODULE, [OTHER.slice(1), PSEUDO, PSEUDO.slice(1), 'junk']]]))
        expect(proxy.checks).toEqual([PSEUDO, OTHER])
        expect(out.get(MODULE)).toEqual({ status: 'ok', published: [{ version: PSEUDO, deprecated: false }], dataAsOf: NOW })
        expect(cachedSummary().info).toEqual({ [PSEUDO]: { published: true, checkedAt: NOW }, [OTHER]: { published: false, checkedAt: NOW } })
        // The next settlement reads both from the row.
        const again = await createGoRegistryClient(store, { ...fakeProxy(list([])), now: () => NOW + 1000 }).published(new Map([[MODULE, [PSEUDO, OTHER]]]))
        expect(again.get(MODULE)).toMatchObject({ published: [{ version: PSEUDO, deprecated: false }] })
        expect(again.get(MODULE)).not.toHaveProperty('unconfirmed')
    })

    it('keeps a confirmed publication for good, but asks again about an absence once it is old', async function () {
        const proxy = fakeProxy(list([]), { [PSEUDO]: { status: 'published' }, [OTHER]: { status: 'published' } })
        store.put({ name: MODULE, status: 'ok', checkedAt: NOW, etag: '"l1"', summaryJson: JSON.stringify({ v: 1, name: MODULE, versions: {}, info: { [PSEUDO]: { published: true, checkedAt: 0 }, [OTHER]: { published: false, checkedAt: NOW - REGISTRY_FRESH_MS - 1 } } }) })
        const out = await createGoRegistryClient(store, { ...proxy, now: () => NOW }).published(new Map([[MODULE, [PSEUDO, OTHER]]]))
        expect(proxy.lists).toEqual([])
        expect(proxy.checks).toEqual([OTHER])
        expect(out.get(MODULE)).toMatchObject({ published: [{ version: PSEUDO }, { version: OTHER }] })
        // The row keeps its list's check time and ETag; only the check is new.
        expect(store.get([MODULE]).get(MODULE)).toMatchObject({ checkedAt: NOW, etag: '"l1"' })
        expect(cachedSummary().info[OTHER]).toEqual({ published: true, checkedAt: NOW })
    })

    it('reads a failed check as unconfirmed and caches nothing for it, so the next settlement asks again', async function () {
        const proxy = fakeProxy(list([]))
        const client = createGoRegistryClient(store, { ...proxy, now: () => NOW })
        expect((await client.published(new Map([[MODULE, [PSEUDO]]]))).get(MODULE)).toEqual({ status: 'ok', published: [], dataAsOf: NOW, unconfirmed: [PSEUDO] })
        expect(cachedSummary().info).toEqual({})
        await client.published(new Map([[MODULE, [PSEUDO]]]))
        expect(proxy.checks).toEqual([PSEUDO, PSEUDO])
    })

    it('reads a fetcher that throws as no answer', async function () {
        const client = createGoRegistryClient(store, {
            now: () => NOW,
            fetchList: fakeProxy(list([])).fetchList,
            fetchInfo: async function boom(): Promise<GoVersionInfoResult> { throw new Error('socket hang up') }
        })
        expect((await client.published(new Map([[MODULE, [PSEUDO]]]))).get(MODULE)).toMatchObject({ unconfirmed: [PSEUDO] })
    })

    it('checks at most three versions per module per settlement, lowest first, leaving the rest unconfirmed', async function () {
        const stated = ['v0.0.0-20200105000000-aaaaaaaaaaaa', 'v0.0.0-20200104000000-aaaaaaaaaaaa', 'v0.0.0-20200103000000-aaaaaaaaaaaa', 'v0.0.0-20200102000000-aaaaaaaaaaaa']
        const absent = Object.fromEntries(stated.map(function a(v) { return [v, { status: 'absent' } as const] }))
        const proxy = fakeProxy(list([]), absent)
        const out = await createGoRegistryClient(store, { ...proxy, now: () => NOW }).published(new Map([[MODULE, stated]]))
        expect(GO_INFO_CHECKS_PER_MODULE).toBe(3)
        expect(proxy.checks).toEqual([...stated].reverse().slice(0, 3))
        expect(out.get(MODULE)).toMatchObject({ published: [], unconfirmed: [stated[0]] })
    })

    it('joins a check already in flight for the same version', async function () {
        let release: () => void = function none() {}
        let calls = 0
        const client = createGoRegistryClient(store, {
            now: () => NOW,
            fetchList: fakeProxy(list([])).fetchList,
            fetchInfo: async function slow(): Promise<GoVersionInfoResult> {
                calls++
                await new Promise<void>(function wait(resolve) { release = resolve })
                return { status: 'published' }
            }
        })
        const first = client.published(new Map([[MODULE, [PSEUDO]]]))
        const second = client.published(new Map([[MODULE, [PSEUDO]]]))
        await new Promise(function tick(resolve) { setTimeout(resolve, 10) })
        release()
        expect((await first).get(MODULE)).toMatchObject({ published: [{ version: PSEUDO }] })
        expect((await second).get(MODULE)).toMatchObject({ published: [{ version: PSEUDO }] })
        expect(calls).toBe(1)
    })

    it('keeps the checks across a refreshed list, and answers not_found and errors without checking', async function () {
        store.put({ name: MODULE, status: 'ok', checkedAt: NOW - REGISTRY_FRESH_MS - 1, etag: null, summaryJson: JSON.stringify({ v: 1, name: MODULE, versions: {}, info: { [PSEUDO]: { published: true, checkedAt: 1 } } }) })
        const proxy = fakeProxy(list(['v0.1.0']))
        const out = await createGoRegistryClient(store, { ...proxy, now: () => NOW }).published(new Map([[MODULE, [PSEUDO]]]))
        expect(out.get(MODULE)).toMatchObject({ dataAsOf: NOW, published: [{ version: 'v0.1.0' }, { version: PSEUDO }] })
        expect(cachedSummary()).toEqual({ v: 1, name: MODULE, versions: { 'v0.1.0': { yanked: false } }, info: { [PSEUDO]: { published: true, checkedAt: 1 } } })

        const gone = fakeProxy({ status: 'not_found' })
        expect((await createGoRegistryClient(createMemoryRegistryStore(), { ...gone, now: () => NOW }).published(new Map([['example.com/gone', [PSEUDO]]]))).get('example.com/gone'))
            .toEqual({ status: 'not_found', dataAsOf: NOW })
        const down = fakeProxy({ status: 'error', reason: 'HTTP 502' })
        expect((await createGoRegistryClient(createMemoryRegistryStore(), { ...down, now: () => NOW }).published(new Map([['example.com/down', [PSEUDO]]]))).get('example.com/down'))
            .toEqual({ status: 'error' })
        expect(gone.checks).toEqual([])
        expect(down.checks).toEqual([])
    })

    // Another settlement's refetch can replace the row between the lookup and the write.
    it('keeps nothing when the row is gone by the time the checks are written, and still answers', async function () {
        const inner = createMemoryRegistryStore()
        let forget = false
        const forgetful: RegistryStore = {
            get: function get(names) { return forget ? new Map() : inner.get(names) },
            put: function put(row) {
                inner.put(row)
                forget = true
            },
            setDownloads: inner.setDownloads
        }
        const out = await createGoRegistryClient(forgetful, { ...fakeProxy(list([]), { [PSEUDO]: { status: 'published' } }), now: () => NOW }).published(new Map([[MODULE, [PSEUDO]]]))
        expect(out.get(MODULE)).toMatchObject({ published: [{ version: PSEUDO }] })
        expect(parseGoSummary(inner.get([MODULE]).get(MODULE)?.summaryJson ?? null)?.info).toEqual({})
    })
})

describe('parseGoSummary', function () {
    const whole = { v: 1, name: MODULE, versions: { 'v0.1.0': { yanked: false } }, info: { [PSEUDO]: { published: true, checkedAt: 1 } } }

    it('accepts a whole summary and rejects anything else', function () {
        expect(parseGoSummary(JSON.stringify(whole))).toEqual(whole)
        expect(parseGoSummary(null)).toBeNull()
        expect(parseGoSummary('{')).toBeNull()
        expect(parseGoSummary(JSON.stringify({ ...whole, info: undefined }))).toBeNull()
        expect(parseGoSummary(JSON.stringify({ ...whole, info: { [PSEUDO]: { published: 'yes', checkedAt: 1 } } }))).toBeNull()
        expect(parseGoSummary(JSON.stringify({ ...whole, info: { [PSEUDO]: null } }))).toBeNull()
        expect(parseGoSummary(JSON.stringify({ ...whole, versions: { 'v0.1.0': {} } }))).toBeNull()
    })
})

// The decision's three fixtures, end to end: settleProject → the Go client's own fetchers → a loopback
// proxy whose list is empty and whose `.info` answers 200, 404 or 503. Same host, no Go binary.
describe('a Go module fixed only in a commit, against a real proxy', function () {
    let server: Server
    let infoStatus = 200
    const requests: string[] = []
    const saved = process.env.SENTINELLO_GOPROXY_URL

    beforeEach(async function start() {
        requests.length = 0
        server = createServer(function proxy(request, response) {
            requests.push(request.url ?? '')
            if ((request.url ?? '').endsWith('/@v/list')) {
                response.writeHead(200, { 'content-type': 'text/plain' })
                response.end('')
                return
            }
            response.writeHead(infoStatus)
            response.end(infoStatus === 200 ? JSON.stringify({ Version: PSEUDO, Time: '2020-06-22T21:36:23Z' }) : 'not found')
        })
        await new Promise<void>(function listen(resolve) { server.listen(0, '127.0.0.1', resolve) })
        process.env.SENTINELLO_GOPROXY_URL = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
    })

    afterEach(async function stop() {
        if (saved === undefined) delete process.env.SENTINELLO_GOPROXY_URL
        else process.env.SENTINELLO_GOPROXY_URL = saved
        await new Promise<void>(function close(resolve) {
            server.closeAllConnections()
            server.close(function done() { resolve() })
        })
    })

    const finding: FixIdentity = { source: 'osv', ecosystem: 'Go', advisoryId: 'GO-2020-0012', packageName: 'golang.org/x/Crypto' }
    const evidence: FixEvidence = {
        source: 'osv',
        installed: ['v0.0.0-20200101000000-aaaaaaaaaaaa'],
        affected: { ...versionSetFromSemverRange('<0.0.0-20200622213623-75b288015ac9'), comparator: 'go' },
        patched: null,
        patchedSet: null,
        statedFix: PSEUDO.slice(1),
        fixViaParent: false
    }

    async function settle() {
        const out = await settleProject({
            findings: [finding],
            evidence: new Map([[fixEvidenceKey(finding), [evidence]]]),
            graph: null,
            registry: { Go: createGoRegistryClient(createMemoryRegistryStore()) },
            checkedAt: NOW
        })
        return out.settlements.get(fixEvidenceKey(finding))
    }

    it('list empty, .info 200 → released', async function () {
        infoStatus = 200
        expect(await settle()).toMatchObject({ fixStatus: 'released', fixVersion: PSEUDO })
        expect(requests).toEqual(['/golang.org/x/!crypto/@v/list', '/golang.org/x/!crypto/@v/' + PSEUDO + '.info'])
    })

    it('list empty, .info 404 → none_released', async function () {
        infoStatus = 404
        expect(await settle()).toMatchObject({ fixStatus: 'none_released', fixVersion: null })
    })

    it('list empty, .info failing → unverified, never none_released', async function () {
        infoStatus = 503
        expect(await settle()).toMatchObject({ fixStatus: 'unverified', fixVersion: PSEUDO.slice(1), fixCheck: { registry: 'error' } })
    })
})
