import { beforeEach, describe, expect, it } from 'vitest'
import type { PublishedResult, PublishedSummary } from '@sentinello/feeds'
import { createMemoryRegistryStore } from './memory-store'
import { createPublishedRegistryClient, liveVersions, npmPublication, parsePublishedSummary } from './published-registry'
import { fakeRegistry } from './registry-fake.fixture'
import { REGISTRY_FRESH_MS, type PackumentRequest, type RegistryStore } from './registry-client'

// The client PyPI, crates.io and RubyGems share: the cached core under a published summary, seen as
// settlement sees it.

const NOW = Date.UTC(2026, 9, 29, 12)

let store: RegistryStore

beforeEach(function setup() {
    store = createMemoryRegistryStore()
})

function summary(name: string, versions: Record<string, boolean>): PublishedSummary {
    return { v: 1, name, versions: Object.fromEntries(Object.entries(versions).map(function r([v, yanked]) { return [v, { yanked }] })) }
}

describe('createPublishedRegistryClient', function () {
    it('answers every package from one fetch, yanked releases excluded, and caches the answers', async function () {
        const calls: string[] = []
        async function fetchPackage(name: string): Promise<PublishedResult> {
            calls.push(name)
            if (name === 'gone') return { status: 'not_found' }
            if (name === 'down') return { status: 'error', reason: 'HTTP 503' }
            return { status: 'ok', etag: '"e"', summary: summary(name, { '1.0': false, '1.1': true, '1.2': false }) }
        }
        const client = createPublishedRegistryClient(store, fetchPackage, { now: () => NOW })
        const out = await client.published(new Map([['requests', []], ['gone', []], ['down', []]]))
        expect(out.get('requests')).toEqual({ status: 'ok', published: [{ version: '1.0', deprecated: false }, { version: '1.2', deprecated: false }], dataAsOf: NOW })
        expect(out.get('gone')).toEqual({ status: 'not_found', dataAsOf: NOW })
        expect(out.get('down')).toEqual({ status: 'error' })
        expect(store.get(['requests', 'gone', 'down'])).toMatchObject(new Map([['requests', { status: 'ok', etag: '"e"' }], ['gone', { status: 'not_found' }]]))
        await client.published(new Map([['requests', []], ['gone', []]]))
        expect(calls).toEqual(['requests', 'gone', 'down'])
    })

    it('revalidates an expired row with its ETag, and serves the old answer as stale when the refetch fails', async function () {
        store.put({ name: 'a', status: 'ok', summaryJson: JSON.stringify(summary('a', { '1.0': false })), checkedAt: NOW - REGISTRY_FRESH_MS - 1, etag: '"old"' })
        const sent: (string | null)[] = []
        const client = createPublishedRegistryClient(store, async function fail(_name: string, request: PackumentRequest): Promise<PublishedResult> {
            sent.push(request.ifNoneMatch)
            return { status: 'error', reason: 'HTTP 500' }
        }, { now: () => NOW })
        expect((await client.published(new Map([['a', []]]))).get('a')).toEqual({ status: 'stale', published: [{ version: '1.0', deprecated: false }], dataAsOf: NOW - REGISTRY_FRESH_MS - 1 })
        expect(sent).toEqual(['"old"'])
    })
})

describe('npmPublication', function () {
    it('reads npm\'s package data as settlement does, a package the lookup left out as an error', async function () {
        const npm = fakeRegistry({ braces: { releases: { '3.0.2': {}, '3.0.3': { deprecated: 'old' } } } }, { unavailable: ['down'] })
        const out = await npmPublication(npm).published(new Map([['braces', []], ['down', []]]))
        expect(out.get('braces')).toMatchObject({ status: 'ok', published: [{ version: '3.0.2', deprecated: false }, { version: '3.0.3', deprecated: true }] })
        expect(out.get('down')).toEqual({ status: 'error' })
        npm.lookup = async function partial() { return new Map() }
        expect((await npmPublication(npm).published(new Map([['braces', []]]))).get('braces')).toEqual({ status: 'error' })
    })
})

describe('liveVersions / parsePublishedSummary', function () {
    it('drops yanked releases', function () {
        expect(liveVersions(summary('p', { '1': true, '2': false }))).toEqual([{ version: '2', deprecated: false }])
    })

    it('accepts a whole summary and rejects anything else', function () {
        const whole = summary('p', { '1.0': false })
        expect(parsePublishedSummary(JSON.stringify(whole))).toEqual(whole)
        expect(parsePublishedSummary(null)).toBeNull()
        expect(parsePublishedSummary('{')).toBeNull()
        expect(parsePublishedSummary(JSON.stringify({ ...whole, v: 2 }))).toBeNull()
        expect(parsePublishedSummary(JSON.stringify({ ...whole, name: 1 }))).toBeNull()
        expect(parsePublishedSummary(JSON.stringify({ ...whole, versions: [] }))).toBeNull()
        expect(parsePublishedSummary(JSON.stringify({ ...whole, versions: { '1.0': { yanked: 'no' } } }))).toBeNull()
        expect(parsePublishedSummary(JSON.stringify({ ...whole, versions: { '1.0': null } }))).toBeNull()
    })
})
