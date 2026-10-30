import { afterEach, describe, expect, it } from 'vitest'
import { startDownloadServer, type DownloadServer } from '../download-server.fixture'
import { DEFAULT_PYPI_URL, fetchPypiPackage, pypiPackageUrl, pypiUrl, summarizePypiProject } from './pypi'

// The shape of https://pypi.org/pypi/<name>/json, trimmed to what the summary reads (probed 2026-10-29:
// Django lists 1.0.1 with no files, and 4.2.12 with every file yanked).
const PROJECT = {
    info: { name: 'Django' },
    releases: {
        '1.0.1': [],
        '4.2.11': [{ filename: 'Django-4.2.11.tar.gz', yanked: false }, { filename: 'Django-4.2.11-py3-none-any.whl', yanked: false }],
        '4.2.12': [{ filename: 'Django-4.2.12.tar.gz', yanked: true, yanked_reason: 'regression' }],
        '4.2.13': [{ filename: 'Django-4.2.13.tar.gz', yanked: true }, { filename: 'Django-4.2.13-py3-none-any.whl', yanked: false }],
        '5.0a1': [{ filename: 'Django-5.0a1.tar.gz', yanked: false }]
    }
}

describe('summarizePypiProject', function () {
    it('keeps every release with files, yanked only when all of its files are, and drops a release with none', function () {
        expect(summarizePypiProject('django', PROJECT)).toEqual({
            v: 1,
            name: 'django',
            versions: {
                '4.2.11': { yanked: false },
                '4.2.12': { yanked: true },
                '4.2.13': { yanked: false },
                '5.0a1': { yanked: false }
            }
        })
    })

    it('drops a malformed release, reads a malformed file as not yanked, and rejects a body with no releases map', function () {
        expect(summarizePypiProject('p', { releases: { '1.0': 'garbage', '1.1': [null] } })?.versions).toEqual({ '1.1': { yanked: false } })
        expect(summarizePypiProject('p', { releases: [] })).toBeNull()
        expect(summarizePypiProject('p', null)).toBeNull()
    })
})

describe('pypiUrl / pypiPackageUrl', function () {
    const saved = process.env.SENTINELLO_PYPI_URL
    afterEach(function () {
        if (saved === undefined) delete process.env.SENTINELLO_PYPI_URL
        else process.env.SENTINELLO_PYPI_URL = saved
    })

    it('defaults to pypi.org and honours the env override without a trailing slash', function () {
        delete process.env.SENTINELLO_PYPI_URL
        expect(pypiUrl()).toBe(DEFAULT_PYPI_URL)
        process.env.SENTINELLO_PYPI_URL = ' http://127.0.0.1:9/ '
        expect(pypiUrl()).toBe('http://127.0.0.1:9')
    })

    it('builds the JSON API path with the name encoded', function () {
        expect(pypiPackageUrl('https://p', 'zope.interface')).toBe('https://p/pypi/zope.interface/json')
        expect(pypiPackageUrl('https://p', 'a b')).toBe('https://p/pypi/a%20b/json')
    })
})

describe('fetchPypiPackage', function () {
    let server: DownloadServer | null = null
    afterEach(async function () {
        if (server) await server.close()
        server = null
    })

    it('fetches and summarizes a project, identifying itself and returning the ETag', async function () {
        server = await startDownloadServer({ body: JSON.stringify(PROJECT), headers: { etag: '"p1"' } })
        const result = await fetchPypiPackage('Django', { registryUrl: server.origin })
        expect(result).toMatchObject({ status: 'ok', etag: '"p1"' })
        expect(result.status === 'ok' && Object.keys(result.summary.versions)).toEqual(['4.2.11', '4.2.12', '4.2.13', '5.0a1'])
        expect(server.requests[0]?.url).toBe('/pypi/Django/json')
        expect(server.requests[0]?.headers['user-agent']).toContain('sentinello')
        expect(server.requests[0]?.headers.accept).toBe('application/json')
    })

    it('revalidates with If-None-Match and reads a 304 as not modified', async function () {
        server = await startDownloadServer({ status: 304, headers: { etag: '"p1"' } })
        expect(await fetchPypiPackage('django', { registryUrl: server.origin, ifNoneMatch: '"p1"' })).toEqual({ status: 'not_modified', etag: '"p1"' })
        expect(server.requests[0]?.headers['if-none-match']).toBe('"p1"')
    })

    it('reports a 404 as not_found, another status as an error, and a body that is no project as an error', async function () {
        server = await startDownloadServer(function respond(request) {
            if (request.url === '/pypi/gone/json') return { status: 404, body: 'Not Found' }
            if (request.url === '/pypi/bad/json') return { body: 'not json' }
            if (request.url === '/pypi/odd/json') return { body: '{"info":{}}' }
            return { status: 503 }
        })
        expect(await fetchPypiPackage('gone', { registryUrl: server.origin })).toEqual({ status: 'not_found' })
        expect(await fetchPypiPackage('down', { registryUrl: server.origin })).toEqual({ status: 'error', reason: 'HTTP 503' })
        const bad = await fetchPypiPackage('bad', { registryUrl: server.origin })
        expect(bad.status === 'error' && bad.reason).toMatch(/^unreadable project document: /)
        expect(await fetchPypiPackage('odd', { registryUrl: server.origin })).toEqual({ status: 'error', reason: 'project document has no releases map' })
    })

    it('reports an unreachable registry as an error, never throwing', async function () {
        const result = await fetchPypiPackage('django', { registryUrl: 'http://127.0.0.1:9', timeoutMs: 2000 })
        expect(result.status === 'error' && result.reason).toMatch(/^fetch failed: \S/)
    })
})
