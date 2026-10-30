import { afterEach, describe, expect, it } from 'vitest'
import { startDownloadServer, type DownloadServer } from '../download-server.fixture'
import { DEFAULT_RUBYGEMS_URL, fetchRubyGemsPackage, rubygemsUrl, rubygemsVersionsUrl, summarizeRubyGemsVersions } from './rubygems'

// The shape of https://rubygems.org/api/v1/versions/<name>.json, trimmed: one entry per version per platform.
const VERSIONS = [
    { number: '1.15.0', platform: 'x86_64-linux', prerelease: false },
    { number: '1.15.0', platform: 'ruby', prerelease: false },
    { number: '1.14.5', platform: 'ruby', prerelease: false },
    { number: '1.15.0.rc1', platform: 'ruby', prerelease: true }
]

describe('summarizeRubyGemsVersions', function () {
    it('keeps each version once, whatever the platforms', function () {
        expect(summarizeRubyGemsVersions('nokogiri', VERSIONS)).toEqual({
            v: 1,
            name: 'nokogiri',
            versions: { '1.15.0': { yanked: false }, '1.14.5': { yanked: false }, '1.15.0.rc1': { yanked: false } }
        })
    })

    it('drops an entry with no version number, and rejects a body that is not a list', function () {
        expect(summarizeRubyGemsVersions('g', [null, { number: 1 }, { number: '1.0.0' }])?.versions).toEqual({ '1.0.0': { yanked: false } })
        expect(summarizeRubyGemsVersions('g', [])?.versions).toEqual({})
        expect(summarizeRubyGemsVersions('g', { error: 'x' })).toBeNull()
    })
})

describe('rubygemsUrl / rubygemsVersionsUrl', function () {
    const saved = process.env.SENTINELLO_RUBYGEMS_URL
    afterEach(function () {
        if (saved === undefined) delete process.env.SENTINELLO_RUBYGEMS_URL
        else process.env.SENTINELLO_RUBYGEMS_URL = saved
    })

    it('defaults to rubygems.org and honours the env override', function () {
        delete process.env.SENTINELLO_RUBYGEMS_URL
        expect(rubygemsUrl()).toBe(DEFAULT_RUBYGEMS_URL)
        process.env.SENTINELLO_RUBYGEMS_URL = 'http://127.0.0.1:9/'
        expect(rubygemsUrl()).toBe('http://127.0.0.1:9')
        expect(rubygemsVersionsUrl('https://r', 'rest-client')).toBe('https://r/api/v1/versions/rest-client.json')
    })
})

describe('fetchRubyGemsPackage', function () {
    let server: DownloadServer | null = null
    afterEach(async function () {
        if (server) await server.close()
        server = null
    })

    it('fetches and summarizes a gem\'s versions', async function () {
        server = await startDownloadServer({ body: JSON.stringify(VERSIONS) })
        const result = await fetchRubyGemsPackage('nokogiri', { registryUrl: server.origin })
        expect(result).toMatchObject({ status: 'ok', etag: null, summary: { name: 'nokogiri' } })
        expect(server.requests[0]?.url).toBe('/api/v1/versions/nokogiri.json')
    })

    it('reads a 404 as not_found, another status as an error, and a body that is not a list as an error', async function () {
        server = await startDownloadServer(function respond(request) {
            if (request.url.endsWith('/gone.json')) return { status: 404, body: 'This rubygem could not be found.' }
            if (request.url.endsWith('/odd.json')) return { body: '{}' }
            return { status: 502 }
        })
        expect(await fetchRubyGemsPackage('gone', { registryUrl: server.origin })).toEqual({ status: 'not_found' })
        expect(await fetchRubyGemsPackage('odd', { registryUrl: server.origin })).toEqual({ status: 'error', reason: 'version list is not a list' })
        expect(await fetchRubyGemsPackage('down', { registryUrl: server.origin })).toEqual({ status: 'error', reason: 'HTTP 502' })
    })
})
