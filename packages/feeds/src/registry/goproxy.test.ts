import { afterEach, describe, expect, it } from 'vitest'
import { startDownloadServer, type DownloadServer } from '../download-server.fixture'
import { DEFAULT_GOPROXY_URL, escapeGoPath, fetchGoModuleList, fetchGoVersionInfo, goproxyUrl, summarizeGoList } from './goproxy'

const PSEUDO = 'v0.0.0-20200622213623-75b288015ac9'

describe('escapeGoPath', function () {
    it('escapes every uppercase letter as ! and its lowercase, keeping the slashes', function () {
        expect(escapeGoPath('github.com/BurntSushi/toml')).toBe('github.com/!burnt!sushi/toml')
        expect(escapeGoPath('golang.org/x/crypto')).toBe('golang.org/x/crypto')
        expect(escapeGoPath('v1.0.0-RC1')).toBe('v1.0.0-!r!c1')
        expect(escapeGoPath('example.com/a b')).toBe('example.com/a%20b')
    })
})

describe('summarizeGoList', function () {
    it('keeps every listed version, and reads an empty list as a module with no tags', function () {
        expect(summarizeGoList('github.com/BurntSushi/toml', 'v1.3.0\nv0.3.0\n\n v1.6.0 \n')).toEqual({
            v: 1,
            name: 'github.com/BurntSushi/toml',
            versions: { 'v1.3.0': { yanked: false }, 'v0.3.0': { yanked: false }, 'v1.6.0': { yanked: false } }
        })
        expect(summarizeGoList('m', '')).toEqual({ v: 1, name: 'm', versions: {} })
    })
})

describe('goproxyUrl', function () {
    const saved = process.env.SENTINELLO_GOPROXY_URL
    afterEach(function () {
        if (saved === undefined) delete process.env.SENTINELLO_GOPROXY_URL
        else process.env.SENTINELLO_GOPROXY_URL = saved
    })

    it('defaults to proxy.golang.org and honours the env override', function () {
        delete process.env.SENTINELLO_GOPROXY_URL
        expect(goproxyUrl()).toBe(DEFAULT_GOPROXY_URL)
        process.env.SENTINELLO_GOPROXY_URL = 'http://127.0.0.1:9/'
        expect(goproxyUrl()).toBe('http://127.0.0.1:9')
    })
})

describe('fetchGoModuleList', function () {
    let server: DownloadServer | null = null
    afterEach(async function () {
        if (server) await server.close()
        server = null
    })

    it('fetches the escaped module\'s list as plain text', async function () {
        server = await startDownloadServer({ body: 'v1.3.0\nv1.6.0\n' })
        const result = await fetchGoModuleList('github.com/BurntSushi/toml', { registryUrl: server.origin })
        expect(result).toEqual({ status: 'ok', etag: null, summary: { v: 1, name: 'github.com/BurntSushi/toml', versions: { 'v1.3.0': { yanked: false }, 'v1.6.0': { yanked: false } } } })
        expect(server.requests[0]?.url).toBe('/github.com/!burnt!sushi/toml/@v/list')
        expect(server.requests[0]?.headers.accept).toBe('text/plain')
    })

    it('reads 404 and 410 as not_found and a 5xx as an error', async function () {
        server = await startDownloadServer(function respond(request) {
            if (request.url.startsWith('/example.com/gone/')) return { status: 404, body: 'not found: module example.com/gone' }
            if (request.url.startsWith('/example.com/old/')) return { status: 410 }
            return { status: 500 }
        })
        expect(await fetchGoModuleList('example.com/gone', { registryUrl: server.origin })).toEqual({ status: 'not_found' })
        expect(await fetchGoModuleList('example.com/old', { registryUrl: server.origin })).toEqual({ status: 'not_found' })
        expect(await fetchGoModuleList('example.com/down', { registryUrl: server.origin })).toEqual({ status: 'error', reason: 'HTTP 500' })
    })
})

describe('fetchGoVersionInfo', function () {
    let server: DownloadServer | null = null
    afterEach(async function () {
        if (server) await server.close()
        server = null
    })

    it('reads a 200 as published, 404 or 410 as absent, and anything else as an error — never as absence', async function () {
        server = await startDownloadServer(function respond(request) {
            if (request.url === '/golang.org/x/crypto/@v/' + PSEUDO + '.info') return { body: JSON.stringify({ Version: PSEUDO, Time: '2020-06-22T21:36:23Z' }) }
            if (request.url.includes('000000000000')) return { status: 404, body: 'not found: invalid version: unknown revision' }
            if (request.url.includes('111111111111')) return { status: 410 }
            return { status: 503 }
        })
        const options = { registryUrl: server.origin }
        expect(await fetchGoVersionInfo('golang.org/x/crypto', PSEUDO, options)).toEqual({ status: 'published' })
        expect(await fetchGoVersionInfo('golang.org/x/crypto', 'v0.0.0-20200622213623-000000000000', options)).toEqual({ status: 'absent' })
        expect(await fetchGoVersionInfo('golang.org/x/crypto', 'v0.0.0-20200622213623-111111111111', options)).toEqual({ status: 'absent' })
        expect(await fetchGoVersionInfo('golang.org/x/crypto', 'v0.0.0-20200622213623-222222222222', options)).toEqual({ status: 'error', reason: 'HTTP 503' })
        expect(server.requests[0]?.headers['if-none-match']).toBeUndefined()
    })

    it('escapes the version too, and reads an unreachable proxy as an error', async function () {
        server = await startDownloadServer({ body: '{}' })
        await fetchGoVersionInfo('example.com/M', 'v1.0.0-RC1', { registryUrl: server.origin })
        expect(server.requests[0]?.url).toBe('/example.com/!m/@v/v1.0.0-!r!c1.info')
        const result = await fetchGoVersionInfo('example.com/m', PSEUDO, { registryUrl: 'http://127.0.0.1:9', timeoutMs: 2000 })
        expect(result.status).toBe('error')
    })
})
