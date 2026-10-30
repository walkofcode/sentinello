import { afterEach, describe, expect, it } from 'vitest'
import { startDownloadServer, type DownloadServer } from '../download-server.fixture'
import { cratesIndexPath, cratesIndexUrl, DEFAULT_CRATES_INDEX_URL, fetchCratesPackage, summarizeCratesIndex } from './crates'

// One line per version, as https://index.crates.io/se/rd/serde serves it (probed 2026-10-29: 0.7.6 yanked).
const INDEX = [
    { name: 'serde', vers: '0.7.5', deps: [], cksum: 'a', features: {}, yanked: false },
    { name: 'serde', vers: '0.7.6', deps: [], cksum: 'b', features: {}, yanked: true },
    { name: 'serde', vers: '1.0.0', deps: [], cksum: 'c', features: {}, yanked: false, pubtime: '2017-04-20T00:00:00Z' }
].map(function line(entry) { return JSON.stringify(entry) }).join('\n') + '\n'

describe('cratesIndexPath', function () {
    it('places a crate by the length of its lowercased name', function () {
        expect(cratesIndexPath('a')).toBe('1/a')
        expect(cratesIndexPath('cc')).toBe('2/cc')
        expect(cratesIndexPath('log')).toBe('3/l/log')
        expect(cratesIndexPath('Serde')).toBe('se/rd/serde')
        expect(cratesIndexPath('SERDE_json')).toBe('se/rd/serde_json')
    })
})

describe('summarizeCratesIndex', function () {
    it('keeps every version with its yanked flag', function () {
        expect(summarizeCratesIndex('serde', INDEX)).toEqual({
            v: 1,
            name: 'serde',
            versions: { '0.7.5': { yanked: false }, '0.7.6': { yanked: true }, '1.0.0': { yanked: false } }
        })
    })

    it('reads an unreadable line or an empty file as an error, never as nothing published', function () {
        expect(summarizeCratesIndex('x', '{"vers":"1.0.0"}\nnot json\n')).toBe('unreadable index entry')
        expect(summarizeCratesIndex('x', '{"name":"x"}')).toBe('unreadable index entry')
        expect(summarizeCratesIndex('x', '[1]')).toBe('unreadable index entry')
        expect(summarizeCratesIndex('x', '\n \n')).toBe('index file has no versions')
    })
})

describe('cratesIndexUrl', function () {
    const saved = process.env.SENTINELLO_CRATES_INDEX_URL
    afterEach(function () {
        if (saved === undefined) delete process.env.SENTINELLO_CRATES_INDEX_URL
        else process.env.SENTINELLO_CRATES_INDEX_URL = saved
    })

    it('defaults to the sparse index and honours the env override', function () {
        delete process.env.SENTINELLO_CRATES_INDEX_URL
        expect(cratesIndexUrl()).toBe(DEFAULT_CRATES_INDEX_URL)
        process.env.SENTINELLO_CRATES_INDEX_URL = 'http://127.0.0.1:9//'
        expect(cratesIndexUrl()).toBe('http://127.0.0.1:9')
    })
})

describe('fetchCratesPackage', function () {
    let server: DownloadServer | null = null
    afterEach(async function () {
        if (server) await server.close()
        server = null
    })

    it('fetches and summarizes a crate\'s index file from its lowercased path', async function () {
        server = await startDownloadServer({ body: INDEX, headers: { etag: '"971e"' } })
        const result = await fetchCratesPackage('Serde', { registryUrl: server.origin })
        expect(result).toMatchObject({ status: 'ok', etag: '"971e"', summary: { name: 'Serde' } })
        expect(server.requests[0]?.url).toBe('/se/rd/serde')
        expect(server.requests[0]?.headers['user-agent']).toContain('sentinello')
    })

    it('reads 404 and 410 as not_found, another status as an error, and an unreadable file as an error', async function () {
        server = await startDownloadServer(function respond(request) {
            if (request.url === '/go/ne/gone') return { status: 404 }
            if (request.url === '/3/o/old') return { status: 410 }
            if (request.url === '/2/xx') return { body: '<html>' }
            return { status: 500 }
        })
        expect(await fetchCratesPackage('gone', { registryUrl: server.origin })).toEqual({ status: 'not_found' })
        expect(await fetchCratesPackage('old', { registryUrl: server.origin })).toEqual({ status: 'not_found' })
        expect(await fetchCratesPackage('xx', { registryUrl: server.origin })).toEqual({ status: 'error', reason: 'unreadable index entry' })
        expect(await fetchCratesPackage('down', { registryUrl: server.origin })).toEqual({ status: 'error', reason: 'HTTP 500' })
    })
})
