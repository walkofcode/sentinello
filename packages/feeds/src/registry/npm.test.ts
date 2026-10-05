import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startDownloadServer, type DownloadServer } from '../download-server.fixture'
import {
    DEFAULT_NPM_DOWNLOADS_URL,
    DEFAULT_NPM_REGISTRY_URL,
    fetchNpmPackage,
    fetchNpmWeeklyDownloads,
    npmDownloadsUrl,
    npmPackageUrl,
    npmRegistryUrl,
    summarizePackument
} from './npm'

// A server that sends the status line and part of a body, then never finishes it: a proxy that stalls
// after its headers.
async function startStallingServer(status: number): Promise<{ origin: string; close(): Promise<void> }> {
    const server: Server = createServer(function stall(_request, response) {
        response.writeHead(status)
        response.write('partial body')
    })
    await new Promise<void>(function listen(resolve) { server.listen(0, '127.0.0.1', resolve) })
    return {
        origin: 'http://127.0.0.1:' + (server.address() as AddressInfo).port,
        close: function close() {
            return new Promise(function shut(resolve) {
                server.closeAllConnections()
                server.close(function done() { resolve() })
            })
        }
    }
}

const PACKUMENT = {
    name: 'braces',
    'dist-tags': { latest: '3.0.3' },
    maintainers: [{ name: 'a' }, { name: 'b' }],
    repository: { type: 'git', url: 'git+https://github.com/micromatch/braces.git' },
    time: {
        created: '2014-01-01T00:00:00.000Z',
        modified: '2024-05-21T00:00:00.000Z',
        '3.0.2': '2019-04-07T00:00:00.000Z',
        '3.0.3': '2024-05-21T00:00:00.000Z',
        '4.0.0-rc.1': '2024-06-01T00:00:00.000Z'
    },
    versions: {
        '3.0.2': { dependencies: { 'fill-range': '^7.0.1' } },
        '3.0.3': { dependencies: { 'fill-range': '^7.1.1' }, deprecated: 'use something else' },
        '3.0.4-beta': { dependencies: {} },
        '4.0.0-rc.1': { dependencies: {} }
    }
}

describe('summarizePackument', function () {
    it('keeps release versions with their publish time, deprecation and interned edges, and prereleases apart', function () {
        const summary = summarizePackument('braces', PACKUMENT)
        expect(summary).toEqual({
            v: 2,
            name: 'braces',
            latest: '3.0.3',
            modified: Date.parse('2024-05-21T00:00:00.000Z'),
            maintainers: 2,
            repository: 'git+https://github.com/micromatch/braces.git',
            versions: {
                '3.0.2': { publishedAt: Date.parse('2019-04-07T00:00:00.000Z'), deprecated: null, edges: 0 },
                '3.0.3': { publishedAt: Date.parse('2024-05-21T00:00:00.000Z'), deprecated: 'use something else', edges: 1 }
            },
            prereleases: { '3.0.4-beta': null, '4.0.0-rc.1': null },
            edges: [
                { dependencies: { 'fill-range': '^7.0.1' }, optionalDependencies: {}, peerDependencies: {}, optionalPeers: [] },
                { dependencies: { 'fill-range': '^7.1.1' }, optionalDependencies: {}, peerDependencies: {}, optionalPeers: [] }
            ]
        })
    })

    // gensync has published only 1.0.0-beta.x; the proofs must resolve @jest/core's gensync@^1.0.0-beta.2.
    it('keeps a prerelease\'s edges, sharing the interned sets, and drops a version that is not semver', function () {
        const summary = summarizePackument('gensync', {
            versions: {
                '1.0.0-beta.1': { dependencies: { a: '1' } },
                '1.0.0-beta.2+build.5': { dependencies: { a: '1' } },
                '1.0.0-beta.3': {},
                'not-a-version': { dependencies: { b: '1' } }
            }
        })
        expect(summary?.versions).toEqual({})
        expect(summary?.prereleases).toEqual({ '1.0.0-beta.1': 0, '1.0.0-beta.2+build.5': 0, '1.0.0-beta.3': null })
        expect(summary?.edges).toHaveLength(1)
    })

    it('stores an identical dependency map once, whatever its key order', function () {
        const summary = summarizePackument('p', {
            versions: {
                '1.0.0': { dependencies: { a: '1', b: '2' } },
                '1.0.1': { dependencies: { b: '2', a: '1' } },
                '1.0.2': {}
            }
        })
        expect(summary?.edges).toHaveLength(1)
        expect(summary?.versions['1.0.1']?.edges).toBe(0)
        expect(summary?.versions['1.0.2']?.edges).toBeNull()
    })

    it('keeps optional, peer and optional-peer edges', function () {
        const summary = summarizePackument('p', {
            versions: {
                '1.0.0': {
                    optionalDependencies: { fsevents: '^2' },
                    peerDependencies: { react: '>=18', 'react-dom': '>=18' },
                    peerDependenciesMeta: { 'react-dom': { optional: true }, react: { optional: false } }
                }
            }
        })
        expect(summary?.edges[0]).toEqual({
            dependencies: {},
            optionalDependencies: { fsevents: '^2' },
            peerDependencies: { react: '>=18', 'react-dom': '>=18' },
            optionalPeers: ['react-dom']
        })
    })

    it('tolerates malformed fields and rejects a body that is not a packument', function () {
        expect(summarizePackument('p', null)).toBeNull()
        expect(summarizePackument('p', { versions: [] })).toBeNull()
        const summary = summarizePackument('p', {
            versions: { '1.0.0': 'garbage', '1.0.1': { dependencies: { a: 1 }, deprecated: '' } },
            time: { '1.0.0': 'not a date' },
            repository: 'github:o/p',
            maintainers: 'nobody'
        })
        expect(summary).toMatchObject({
            latest: null,
            modified: null,
            maintainers: 0,
            repository: 'github:o/p',
            versions: { '1.0.0': { publishedAt: null, deprecated: null, edges: null }, '1.0.1': { deprecated: null, edges: null } }
        })
        expect(summarizePackument('p', { versions: {}, repository: { url: '' } })?.repository).toBeNull()
    })
})

describe('npmRegistryUrl / npmPackageUrl', function () {
    const saved = process.env.SENTINELLO_NPM_REGISTRY_URL
    afterEach(function () {
        if (saved === undefined) delete process.env.SENTINELLO_NPM_REGISTRY_URL
        else process.env.SENTINELLO_NPM_REGISTRY_URL = saved
    })

    it('defaults to the public registry and honours the env override without a trailing slash', function () {
        delete process.env.SENTINELLO_NPM_REGISTRY_URL
        expect(npmRegistryUrl()).toBe(DEFAULT_NPM_REGISTRY_URL)
        process.env.SENTINELLO_NPM_REGISTRY_URL = '  http://127.0.0.1:9/  '
        expect(npmRegistryUrl()).toBe('http://127.0.0.1:9')
        process.env.SENTINELLO_NPM_REGISTRY_URL = ' '
        expect(npmRegistryUrl()).toBe(DEFAULT_NPM_REGISTRY_URL)
    })

    it('encodes a scoped name the way the registry routes it', function () {
        expect(npmPackageUrl('https://r', '@next/eslint-plugin-next')).toBe('https://r/@next%2Feslint-plugin-next')
        expect(npmPackageUrl('https://r', 'braces')).toBe('https://r/braces')
    })
})

describe('fetchNpmPackage', function () {
    let server: DownloadServer | null = null
    beforeEach(function () {
        server = null
    })
    afterEach(async function () {
        if (server) await server.close()
    })

    it('fetches and summarizes a packument, identifying itself', async function () {
        server = await startDownloadServer({ body: JSON.stringify(PACKUMENT) })
        const result = await fetchNpmPackage('braces', { registryUrl: server.origin })
        expect(result.status).toBe('ok')
        expect(result.status === 'ok' && Object.keys(result.summary.versions)).toEqual(['3.0.2', '3.0.3'])
        expect(server.requests[0]?.url).toBe('/braces')
        expect(server.requests[0]?.headers['user-agent']).toContain('sentinello')
        expect(server.requests[0]?.headers.accept).toBe('application/json')
    })

    it('returns the registry\'s ETag and the size of the body it read', async function () {
        const body = JSON.stringify(PACKUMENT)
        server = await startDownloadServer(function respond(request) {
            return request.url === '/braces' ? { body, headers: { etag: '"58a16aca"' } } : { body }
        })
        expect(await fetchNpmPackage('braces', { registryUrl: server.origin })).toMatchObject({ status: 'ok', etag: '"58a16aca"', bytes: Buffer.byteLength(body) })
        expect(await fetchNpmPackage('untagged', { registryUrl: server.origin })).toMatchObject({ status: 'ok', etag: null })
        expect(server.requests[0]?.headers['if-none-match']).toBeUndefined()
    })

    // registry.npmjs.org answers a conditional GET with 304 and no body (probed 2026-10-04, evidence m3-etag-probe).
    it('sends If-None-Match when asked, and reads a 304 as not modified', async function () {
        server = await startDownloadServer(function respond(request) {
            if (request.headers['if-none-match'] === 'W/"58a16aca"') return { status: 304, headers: { etag: '"58a16aca"' } }
            return { body: JSON.stringify(PACKUMENT), headers: { etag: '"new"' } }
        })
        expect(await fetchNpmPackage('braces', { registryUrl: server.origin, ifNoneMatch: 'W/"58a16aca"' })).toEqual({ status: 'not_modified', etag: '"58a16aca"' })
        expect(server.requests[0]?.headers['if-none-match']).toBe('W/"58a16aca"')
        expect(await fetchNpmPackage('braces', { registryUrl: server.origin, ifNoneMatch: '"old"' })).toMatchObject({ status: 'ok', etag: '"new"' })
        expect(await fetchNpmPackage('braces', { registryUrl: server.origin, ifNoneMatch: null })).toMatchObject({ status: 'ok' })
        expect(server.requests[2]?.headers['if-none-match']).toBeUndefined()
    })

    it('reads a 304 to a request that sent no validator as an error', async function () {
        server = await startDownloadServer({ status: 304 })
        expect(await fetchNpmPackage('braces', { registryUrl: server.origin })).toEqual({ status: 'error', reason: 'HTTP 304' })
    })

    it('reports a 404 as not_found and any other status as an error', async function () {
        server = await startDownloadServer(function respond(request) {
            return request.url === '/missing' ? { status: 404, body: '{}' } : { status: 503, body: 'down' }
        })
        expect(await fetchNpmPackage('missing', { registryUrl: server.origin })).toEqual({ status: 'not_found' })
        expect(await fetchNpmPackage('other', { registryUrl: server.origin })).toEqual({ status: 'error', reason: 'HTTP 503' })
    })

    it('reports an unreadable body or a non-packument as an error', async function () {
        server = await startDownloadServer(function respond(request) {
            return request.url === '/bad' ? { body: 'not json' } : { body: '{"name":"x"}' }
        })
        const bad = await fetchNpmPackage('bad', { registryUrl: server.origin })
        expect(bad.status === 'error' && bad.reason).toMatch(/^unreadable packument/)
        expect(await fetchNpmPackage('x', { registryUrl: server.origin })).toEqual({ status: 'error', reason: 'packument has no versions map' })
    })

    it('reports an unreachable registry as an error, never throwing', async function () {
        const result = await fetchNpmPackage('braces', { registryUrl: 'http://127.0.0.1:9', timeoutMs: 2000 })
        // The cause is the useful half. Port 9 is on fetch's blocked-port list, so it never even connects:
        // "fetch failed: bad port".
        expect(result.status === 'error' && result.reason).toMatch(/^fetch failed: \S/)
    })

    it('honours the caller abort', async function () {
        server = await startDownloadServer({ body: JSON.stringify(PACKUMENT) })
        const controller = new AbortController()
        controller.abort()
        const result = await fetchNpmPackage('braces', { registryUrl: server.origin, abortSignal: controller.signal })
        expect(result.status).toBe('error')
    })
})

describe('fetchNpmPackage — a body that stalls after the status line', function () {
    it.each([[503, { status: 'error', reason: 'HTTP 503' }], [404, { status: 'not_found' }]] as const)('answers %i from the status alone, without throwing', async function (status, expected) {
        const server = await startStallingServer(status)
        try {
            expect(await fetchNpmPackage('a', { registryUrl: server.origin, timeoutMs: 200 })).toEqual(expected)
            expect(await fetchNpmWeeklyDownloads('a', { registryUrl: server.origin, timeoutMs: 200 })).toEqual(expected)
        } finally {
            await server.close()
        }
    })

    it('reports a 200 whose body stalls past the timeout as an error', async function () {
        const server = await startStallingServer(200)
        try {
            const result = await fetchNpmPackage('a', { registryUrl: server.origin, timeoutMs: 200 })
            expect(result.status === 'error' && result.reason).toMatch(/^unreadable packument/)
        } finally {
            await server.close()
        }
    })
})

describe('fetchNpmWeeklyDownloads', function () {
    let server: DownloadServer | null = null
    const saved = process.env.SENTINELLO_NPM_DOWNLOADS_URL
    afterEach(async function () {
        if (server) await server.close()
        server = null
        if (saved === undefined) delete process.env.SENTINELLO_NPM_DOWNLOADS_URL
        else process.env.SENTINELLO_NPM_DOWNLOADS_URL = saved
    })

    it('defaults to api.npmjs.org and honours the env override', function () {
        delete process.env.SENTINELLO_NPM_DOWNLOADS_URL
        expect(npmDownloadsUrl()).toBe(DEFAULT_NPM_DOWNLOADS_URL)
        process.env.SENTINELLO_NPM_DOWNLOADS_URL = ' http://127.0.0.1:9// '
        expect(npmDownloadsUrl()).toBe('http://127.0.0.1:9')
        process.env.SENTINELLO_NPM_DOWNLOADS_URL = ''
        expect(npmDownloadsUrl()).toBe(DEFAULT_NPM_DOWNLOADS_URL)
    })

    it('reads last week\'s count for a scoped package', async function () {
        server = await startDownloadServer({ body: '{"downloads":45923307,"start":"2026-09-25","end":"2026-10-01","package":"@next/eslint-plugin-next"}' })
        process.env.SENTINELLO_NPM_DOWNLOADS_URL = server.origin
        expect(await fetchNpmWeeklyDownloads('@next/eslint-plugin-next')).toEqual({ status: 'ok', weeklyDownloads: 45923307 })
        expect(server.requests[0]?.url).toBe('/downloads/point/last-week/@next%2Feslint-plugin-next')
    })

    it('reports a missing package, an outage, an unreadable body and a missing count', async function () {
        server = await startDownloadServer(function respond(request) {
            if (request.url?.endsWith('/gone')) return { status: 404, body: '{"error":"not found"}' }
            if (request.url?.endsWith('/down')) return { status: 500, body: 'x' }
            if (request.url?.endsWith('/bad')) return { body: 'not json' }
            return { body: '{"downloads":-1}' }
        })
        expect(await fetchNpmWeeklyDownloads('gone', { registryUrl: server.origin })).toEqual({ status: 'not_found' })
        expect(await fetchNpmWeeklyDownloads('down', { registryUrl: server.origin })).toEqual({ status: 'error', reason: 'HTTP 500' })
        const bad = await fetchNpmWeeklyDownloads('bad', { registryUrl: server.origin })
        expect(bad.status === 'error' && bad.reason).toMatch(/^unreadable download count/)
        expect(await fetchNpmWeeklyDownloads('negative', { registryUrl: server.origin })).toEqual({ status: 'error', reason: 'download count missing' })
    })

    it('reads a body that is not an object as a missing count', async function () {
        server = await startDownloadServer({ body: '[1]' })
        expect(await fetchNpmWeeklyDownloads('x', { registryUrl: server.origin })).toEqual({ status: 'error', reason: 'download count missing' })
    })

    it('answers from the status alone when the unread body has already failed, or there is none', async function () {
        const errored = new ReadableStream({ start(controller) { controller.error(new Error('connection reset')) } })
        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(errored, { status: 503 })).mockResolvedValueOnce(new Response(null, { status: 404 })))
        try {
            expect(await fetchNpmWeeklyDownloads('x', { registryUrl: 'http://registry.test' })).toEqual({ status: 'error', reason: 'HTTP 503' })
            expect(await fetchNpmPackage('x', { registryUrl: 'http://registry.test' })).toEqual({ status: 'not_found' })
        } finally {
            vi.unstubAllGlobals()
        }
    })

    it('reports an unreachable service as an error and honours the caller abort', async function () {
        const result = await fetchNpmWeeklyDownloads('braces', { registryUrl: 'http://127.0.0.1:9', timeoutMs: 2000 })
        expect(result.status).toBe('error')
        server = await startDownloadServer({ body: '{"downloads":1}' })
        const controller = new AbortController()
        controller.abort()
        expect((await fetchNpmWeeklyDownloads('braces', { registryUrl: server.origin, abortSignal: controller.signal })).status).toBe('error')
    })
})
