import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startDownloadServer, type DownloadServer } from '../download-server.fixture'
import { DEFAULT_NPM_REGISTRY_URL, fetchNpmPackage, npmPackageUrl, npmRegistryUrl, summarizePackument } from './npm'

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
    it('keeps release versions with their publish time, deprecation and interned edges', function () {
        const summary = summarizePackument('braces', PACKUMENT)
        expect(summary).toEqual({
            v: 1,
            name: 'braces',
            latest: '3.0.3',
            modified: Date.parse('2024-05-21T00:00:00.000Z'),
            maintainers: 2,
            repository: 'git+https://github.com/micromatch/braces.git',
            versions: {
                '3.0.2': { publishedAt: Date.parse('2019-04-07T00:00:00.000Z'), deprecated: null, edges: 0 },
                '3.0.3': { publishedAt: Date.parse('2024-05-21T00:00:00.000Z'), deprecated: 'use something else', edges: 1 }
            },
            edges: [
                { dependencies: { 'fill-range': '^7.0.1' }, optionalDependencies: {}, peerDependencies: {}, optionalPeers: [] },
                { dependencies: { 'fill-range': '^7.1.1' }, optionalDependencies: {}, peerDependencies: {}, optionalPeers: [] }
            ]
        })
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
