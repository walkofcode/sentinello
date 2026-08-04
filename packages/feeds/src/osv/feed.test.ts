import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeZip } from '../zip.fixture'
import { startDownloadServer, type DownloadServer } from '../download-server.fixture'
import {
    OSV_INCREMENTAL_MAX_IDS,
    fetchOsvAdvisoryRows,
    fetchOsvChangedIds,
    headOsvSeed,
    osvAdvisoryUrl,
    osvFeedDisabled,
    osvModifiedIdsUrl,
    osvSeedUrl,
    selectChangedIds,
    streamOsvSeed
} from './feed'

// The OSV feed as pure I/O + parsing. Two seams make this testable with no production change:
// SENTINELLO_OSV_FEED_URL redirects every URL this module builds, and the module reaches the network
// through global fetch, which is the same lever packages/feeds/src/http.test.ts already pulls.
//
// The seed streamer is driven through a real ZIP built in memory (see ../zip.fixture), so unzipper, the
// entry filter, the JSON parse and the normalizer all run for real. That matters more than it might look:
// the streamer's contract is that memory stays bounded across a ~860 MB unpacked corpus, so its batching
// and its skip-without-buffering behaviour are the parts worth pinning.

const BASE = 'https://osv.test'

let fetchMock: ReturnType<typeof vi.fn>

// The real Response, so header parsing, body consumption and ReadableStream conversion behave as in
// production — openDownloadStream calls Readable.fromWeb on response.body.
function respond(body: ConstructorParameters<typeof Response>[0], init: ResponseInit = {}): Response {
    return new Response(body, init)
}

function osvRecord(overrides: Record<string, unknown> = {}) {
    return {
        id: 'GHSA-1',
        affected: [{
            package: { name: 'lodash', ecosystem: 'npm' },
            ranges: [{ type: 'SEMVER', events: [{ introduced: '4.0.0' }, { fixed: '4.17.21' }] }]
        }],
        ...overrides
    }
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
    const out: T[] = []
    for await (const item of gen) out.push(item)
    return out
}

beforeEach(function setup() {
    vi.stubEnv('SENTINELLO_OSV_FEED_URL', BASE)
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
})

afterEach(function teardown() {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.useRealTimers()
})

describe('URL construction', function () {
    // The feed directory is the canonical OSV id from the registry, NEVER a lowercase language slug —
    // 'pypi' would 404 the feed while looking entirely plausible in a log.
    it.each([
        ['npm', 'npm'],
        ['PyPI', 'PyPI'],
        ['Go', 'Go']
    ])('uses the canonical OSV directory for %s', function (ecosystem, dir) {
        expect(osvSeedUrl(ecosystem as 'npm')).toBe(BASE + '/' + dir + '/all.zip')
    })

    it('percent-encodes a directory containing reserved characters', function () {
        expect(osvSeedUrl('crates.io')).toBe(BASE + '/crates.io/all.zip')
    })

    it('builds the modified-ids and per-advisory URLs off the same base', function () {
        expect(osvModifiedIdsUrl('npm')).toBe(BASE + '/npm/modified_id.csv')
        expect(osvAdvisoryUrl('GHSA-1', 'npm')).toBe(BASE + '/npm/GHSA-1.json')
    })

    // A typo must fail loudly rather than quietly fetching garbage from a plausible-looking URL.
    it('throws on an unregistered ecosystem', function () {
        expect(function build() {
            osvSeedUrl('nuget' as 'npm')
        }).toThrow(/unknown OSV ecosystem/)
    })

    it('falls back to the real bucket when the override is unset', function () {
        vi.unstubAllEnvs()
        expect(osvSeedUrl('npm')).toContain('osv-vulnerabilities.storage.googleapis.com')
    })

    it('ignores a whitespace-only override', function () {
        vi.stubEnv('SENTINELLO_OSV_FEED_URL', '   ')
        expect(osvSeedUrl('npm')).toContain('osv-vulnerabilities.storage.googleapis.com')
    })
})

describe('osvFeedDisabled', function () {
    it('is off by default', function () {
        expect(osvFeedDisabled()).toBe(false)
    })

    it.each(['off', 'OFF', 'Off'])('treats the literal %j as a hard disable', function (value) {
        vi.stubEnv('SENTINELLO_OSV_FEED_URL', value)
        expect(osvFeedDisabled()).toBe(true)
    })
})

describe('headOsvSeed', function () {
    it('reports the size without downloading the body', async function () {
        fetchMock.mockResolvedValue(respond(null, {
            headers: { 'content-length': '100663296', 'last-modified': 'Wed, 01 Jul 2026 00:00:00 GMT', etag: 'W/"abc"' }
        }))
        expect(await headOsvSeed('npm')).toEqual({
            contentLength: 100663296,
            lastModified: 'Wed, 01 Jul 2026 00:00:00 GMT',
            etag: 'W/"abc"'
        })
        expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'HEAD' })
    })

    it('reports an unknown size when the server omits content-length', async function () {
        fetchMock.mockResolvedValue(respond(null, { headers: {} }))
        expect((await headOsvSeed('npm')).contentLength).toBeNull()
    })
})

// The seed download runs over node:https, not fetch (see the transport note in http.ts), so these serve
// real zip bytes from a loopback server and point the feed-URL override at it.
describe('streamOsvSeed', function () {
    let server: DownloadServer | null = null

    afterEach(async function stop() {
        if (server) await server.close()
        server = null
    })

    async function zipResponse(files: Record<string, string>): Promise<void> {
        server = await startDownloadServer({
            body: makeZip(files),
            headers: { 'last-modified': 'Wed, 01 Jul 2026 00:00:00 GMT' }
        })
        vi.stubEnv('SENTINELLO_OSV_FEED_URL', server.origin)
    }

    // Nothing here may accumulate the full corpus: the unpacked npm export alone is ~860 MB across
    // ~220k files. BATCH_SIZE is 2000, so 2001 records must arrive as two batches rather than one.
    it('yields in batches rather than accumulating the whole export', async function () {
        const files: Record<string, string> = {}
        for (let i = 0; i < 2001; i++) {
            files['GHSA-' + i + '.json'] = JSON.stringify(osvRecord({ id: 'GHSA-' + i }))
        }
        await zipResponse(files)
        const batches = await collect(streamOsvSeed('npm'))
        expect(batches).toHaveLength(2)
        expect(batches[0]?.rows).toHaveLength(2000)
        expect(batches[1]?.rows).toHaveLength(1)
    })

    it('normalizes every .json entry in the archive', async function () {
        await zipResponse({
            'GHSA-1.json': JSON.stringify(osvRecord()),
            'GHSA-2.json': JSON.stringify(osvRecord({ id: 'GHSA-2' }))
        })
        const batches = await collect(streamOsvSeed('npm'))
        expect(batches).toHaveLength(1)
        expect(batches[0]?.rows.map(function id(r) { return r.advisoryId }).sort()).toEqual(['GHSA-1', 'GHSA-2'])
    })

    it('carries the archive last-modified onto every batch', async function () {
        await zipResponse({ 'GHSA-1.json': JSON.stringify(osvRecord()) })
        const batches = await collect(streamOsvSeed('npm'))
        expect(batches[0]?.lastModified).toBe('Wed, 01 Jul 2026 00:00:00 GMT')
    })

    it('skips entries that are not .json', async function () {
        await zipResponse({
            'GHSA-1.json': JSON.stringify(osvRecord()),
            'README.md': 'not an advisory',
            'index.txt': 'nor this'
        })
        const batches = await collect(streamOsvSeed('npm'))
        expect(batches[0]?.rows).toHaveLength(1)
    })

    // A single corrupt entry in a 220k-file export must not abandon the whole seed.
    it('drops an entry whose JSON does not parse and keeps going', async function () {
        await zipResponse({
            'broken.json': '{not json',
            'GHSA-1.json': JSON.stringify(osvRecord())
        })
        const batches = await collect(streamOsvSeed('npm'))
        expect(batches[0]?.rows.map(function id(r) { return r.advisoryId })).toEqual(['GHSA-1'])
    })

    it('drops an entry that normalizes to no rows', async function () {
        await zipResponse({
            'empty.json': JSON.stringify({ id: 'GHSA-empty' }),
            'GHSA-1.json': JSON.stringify(osvRecord())
        })
        const batches = await collect(streamOsvSeed('npm'))
        expect(batches[0]?.rows).toHaveLength(1)
    })

    it('yields nothing at all for an archive with no advisories', async function () {
        await zipResponse({ 'README.md': 'nothing here' })
        expect(await collect(streamOsvSeed('npm'))).toEqual([])
    })

    it('keeps only the requested ecosystem when a record spans several', async function () {
        await zipResponse({
            'GHSA-1.json': JSON.stringify(osvRecord({
                affected: [
                    { package: { name: 'lodash', ecosystem: 'npm' }, versions: ['1.0.0'] },
                    { package: { name: 'flask', ecosystem: 'PyPI' }, versions: ['1.0.0'] }
                ]
            }))
        })
        const batches = await collect(streamOsvSeed('npm'))
        expect(batches[0]?.rows.map(function pkg(r) { return r.packageName })).toEqual(['lodash'])
    })

    it('reports download progress as bytes arrive', async function () {
        await zipResponse({ 'GHSA-1.json': JSON.stringify(osvRecord()) })
        const seen: number[] = []
        await collect(streamOsvSeed('npm', function onProgress(read) { seen.push(read) }))
        expect(seen.length).toBeGreaterThan(0)
        expect(seen[seen.length - 1]).toBeGreaterThan(0)
    })

    // Shutdown must be able to interrupt a seed rather than waiting out a 100 MB download.
    //
    // Aborted BETWEEN batches, not before the request. Aborting up front only proves node rejects the
    // HTTP request — whose AbortError message happens to contain "aborted", so that version of this test
    // passed without ever reaching the guard in the entry loop.
    it('aborts mid-archive when the signal fires', async function () {
        const files: Record<string, string> = {}
        for (let i = 0; i < 2001; i++) {
            files['GHSA-' + i + '.json'] = JSON.stringify(osvRecord({ id: 'GHSA-' + i }))
        }
        await zipResponse(files)
        const controller = new AbortController()
        const batches = streamOsvSeed('npm', undefined, { abortSignal: controller.signal })
        expect((await batches.next()).value?.rows).toHaveLength(2000)
        controller.abort()
        await expect(batches.next()).rejects.toThrow('aborted')
    })

    it('fails loudly when the download is rejected', async function () {
        server = await startDownloadServer({ status: 404, body: 'nope' })
        vi.stubEnv('SENTINELLO_OSV_FEED_URL', server.origin)
        await expect(collect(streamOsvSeed('npm'))).rejects.toThrow(/HTTP 404/)
    })
})

describe('fetchOsvChangedIds', function () {
    // The conditional request is what makes syncing on every scan viable: most runs transfer nothing.
    it('reports unchanged on a 304 without parsing anything', async function () {
        fetchMock.mockResolvedValue(respond(null, { status: 304 }))
        expect(await fetchOsvChangedIds('npm', 0, 'etag-1')).toEqual({ status: 'unchanged' })
    })

    it('replays the cached etag as If-None-Match', async function () {
        fetchMock.mockResolvedValue(respond(null, { status: 304 }))
        await fetchOsvChangedIds('npm', 0, 'etag-1')
        const headers = new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers)
        expect(headers.get('if-none-match')).toBe('etag-1')
    })

    it('returns the ids modified after the cursor, with the new etag', async function () {
        const csv = '2026-07-02T00:00:00Z,GHSA-new\n2026-06-01T00:00:00Z,GHSA-old\n'
        fetchMock.mockResolvedValue(respond(csv, { status: 200, headers: { etag: 'etag-2' } }))
        expect(await fetchOsvChangedIds('npm', Date.parse('2026-07-01T00:00:00Z'), null)).toEqual({
            status: 'ok',
            ids: ['GHSA-new'],
            newestIso: '2026-07-02T00:00:00Z',
            etag: 'etag-2'
        })
    })
})

describe('selectChangedIds', function () {
    it('selects strictly after the cursor and reports the newest timestamp seen', function () {
        const csv = [
            '2026-07-03T00:00:00Z,GHSA-c',
            '2026-07-02T00:00:00Z,GHSA-b',
            '2026-07-01T00:00:00Z,GHSA-a'
        ].join('\n')
        expect(selectChangedIds(csv, Date.parse('2026-07-01T00:00:00Z'))).toEqual({
            ids: ['GHSA-c', 'GHSA-b'],
            newestIso: '2026-07-03T00:00:00Z'
        })
    })

    it('reports no newer timestamp when everything is at or before the cursor', function () {
        expect(selectChangedIds('2026-07-01T00:00:00Z,GHSA-a', Date.parse('2026-07-01T00:00:00Z'))).toEqual({
            ids: [],
            newestIso: null
        })
    })

    it('takes everything from a zero cursor', function () {
        expect(selectChangedIds('2026-07-01T00:00:00Z,GHSA-a', 0).ids).toEqual(['GHSA-a'])
    })

    // The CSV is third-party input, so malformed lines are skipped rather than trusted.
    it.each([
        ['a blank line', '\n\n2026-07-01T00:00:00Z,GHSA-a\n\n'],
        ['a line with no comma', 'garbage\n2026-07-01T00:00:00Z,GHSA-a'],
        ['a line starting with a comma', ',GHSA-x\n2026-07-01T00:00:00Z,GHSA-a'],
        ['a line with an empty id', '2026-07-02T00:00:00Z,\n2026-07-01T00:00:00Z,GHSA-a'],
        ['an unparseable timestamp', 'not-a-date,GHSA-x\n2026-07-01T00:00:00Z,GHSA-a']
    ])('skips %s', function (_label, csv) {
        expect(selectChangedIds(csv as string, 0).ids).toEqual(['GHSA-a'])
    })

    it('handles an empty document', function () {
        expect(selectChangedIds('', 0)).toEqual({ ids: [], newestIso: null })
    })

    it('trims surrounding whitespace from the id', function () {
        expect(selectChangedIds('2026-07-01T00:00:00Z,  GHSA-a  ', 0).ids).toEqual(['GHSA-a'])
    })
})

describe('fetchOsvAdvisoryRows', function () {
    it('returns the normalized rows for one advisory', async function () {
        fetchMock.mockResolvedValue(respond(JSON.stringify(osvRecord()), { status: 200 }))
        const rows = await fetchOsvAdvisoryRows('GHSA-1', 'npm')
        expect(rows.map(function pkg(r) { return r.packageName })).toEqual(['lodash'])
    })

    // Both "removed upstream" and "withdrawn" mean the same thing to the caller: stop matching it.
    it('returns nothing when the advisory 404s', async function () {
        fetchMock.mockResolvedValue(respond('missing', { status: 404 }))
        expect(await fetchOsvAdvisoryRows('GHSA-gone', 'npm')).toEqual([])
    })

    it('filters out rows that came back withdrawn', async function () {
        fetchMock.mockResolvedValue(respond(JSON.stringify(osvRecord({ withdrawn: '2026-07-01T00:00:00Z' })), { status: 200 }))
        expect(await fetchOsvAdvisoryRows('GHSA-1', 'npm')).toEqual([])
    })
})

describe('OSV_INCREMENTAL_MAX_IDS', function () {
    // OSV occasionally lands tens of thousands of malware records in a single day, which is exactly the
    // case that would otherwise turn an incremental sync into an overnight job.
    it('is a five-figure threshold', function () {
        expect(OSV_INCREMENTAL_MAX_IDS).toBe(20_000)
    })
})
