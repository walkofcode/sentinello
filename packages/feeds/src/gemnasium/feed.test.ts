import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeZip } from '../zip.fixture'
import {
    GEMNASIUM_COMPARE_MAX_FILES,
    advisoryIdFromPath,
    fetchGemnasiumChangedPaths,
    fetchGemnasiumFileRows,
    fetchGemnasiumHeadSha,
    gemnasiumFeedDisabled,
    streamGemnasiumArchive
} from './feed'

// gemnasium-db has no per-advisory delta feed, so the whole design here is about avoiding the 80 MB
// archive: the GitLab API answers "is there anything new?" (HEAD sha) and "what changed?" (compare) for a
// few KB, with the archive as the fallback. Both cheap paths degrade to "rebuild from the archive" rather
// than risk a subtly stale cache, and each degradation trigger is pinned separately below.
//
// The trap this file exists to guard is advisoryPathEcosystem's rootOffset. Archive entries are nested
// under "gemnasium-db-master/" (offset 1) while API paths are repo-relative (offset 0), and passing the
// wrong one silently matches NOTHING — a green test suite over an empty cache. The archive fixtures below
// therefore reproduce the real prefix, and one test asserts the un-prefixed shape is rejected.

const API = 'https://gitlab.test/api/v4/projects/gemnasium'
const ARCHIVE = 'https://gitlab.test/archive.zip'

let fetchMock: ReturnType<typeof vi.fn>

function respond(body: ConstructorParameters<typeof Response>[0], init: ResponseInit = {}): Response {
    return new Response(body, init)
}

function advisoryYaml(overrides: Record<string, string> = {}): string {
    const fields: Record<string, string> = {
        identifier: 'CVE-2024-1',
        package_slug: 'npm/lodash',
        title: 'Prototype pollution',
        affected_range: '<4.17.21',
        ...overrides
    }
    return Object.entries(fields).map(function line([k, v]) { return k + ': "' + v + '"' }).join('\n') + '\n'
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
    const out: T[] = []
    for await (const item of gen) out.push(item)
    return out
}

beforeEach(function setup() {
    vi.stubEnv('SENTINELLO_GEMNASIUM_API_URL', API)
    vi.stubEnv('SENTINELLO_GEMNASIUM_FEED_URL', ARCHIVE)
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
})

afterEach(function teardown() {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.useRealTimers()
})

describe('gemnasiumFeedDisabled', function () {
    it('is off by default', function () {
        expect(gemnasiumFeedDisabled()).toBe(false)
    })

    it.each(['off', 'OFF'])('treats the literal %j as a hard disable', function (value) {
        vi.stubEnv('SENTINELLO_GEMNASIUM_FEED_URL', value)
        expect(gemnasiumFeedDisabled()).toBe(true)
    })

    it('falls back to the real gitlab archive when the override is unset', function () {
        vi.unstubAllEnvs()
        expect(gemnasiumFeedDisabled()).toBe(false)
    })

    // The archive URL and the API base read separate env vars, and only the archive one has a
    // fallback test above. An API base that silently stayed on a stale override would send the
    // incremental sync somewhere the archive never points.
    it('falls back to the real gitlab api when the override is unset', async function () {
        vi.unstubAllEnvs()
        fetchMock.mockResolvedValue(respond(JSON.stringify([{ id: 'a'.repeat(40) }])))
        await fetchGemnasiumHeadSha()
        expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
            'https://gitlab.com/api/v4/projects/gitlab-org%2Fsecurity-products%2Fgemnasium-db'
        )
    })
})

describe('fetchGemnasiumHeadSha', function () {
    it('returns the sha of the newest commit on master', async function () {
        fetchMock.mockResolvedValue(respond(JSON.stringify([{ id: 'a'.repeat(40) }]), { status: 200 }))
        expect(await fetchGemnasiumHeadSha()).toBe('a'.repeat(40))
        expect(String(fetchMock.mock.calls[0]?.[0])).toBe(API + '/repository/commits?ref_name=master&per_page=1')
    })

    // "Unknown" is handled conservatively by the caller (it re-seeds), so every unexpected answer must
    // collapse to null rather than throwing out of a sync.
    it.each([
        ['the API is unreachable', null],
        ['the response is not an array', JSON.stringify({ id: 'abc' })],
        ['the array is empty', JSON.stringify([])],
        ['the commit has no id', JSON.stringify([{}])],
        ['the id is not a string', JSON.stringify([{ id: 123 }])],
        ['the id is empty', JSON.stringify([{ id: '' }])]
    ])('returns null when %s', async function (_label, body) {
        if (body === null) {
            fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
        } else {
            fetchMock.mockResolvedValue(respond(body as string, { status: 200 }))
        }
        expect(await fetchGemnasiumHeadSha()).toBeNull()
    })
})

describe('fetchGemnasiumChangedPaths', function () {
    function compare(diffs: unknown[], extra: Record<string, unknown> = {}): Response {
        return respond(JSON.stringify({ diffs, ...extra }), { status: 200 })
    }

    it('separates changed from deleted advisory files', async function () {
        fetchMock.mockResolvedValue(compare([
            { new_path: 'npm/lodash/CVE-2024-1.yml' },
            { new_path: 'npm/express/CVE-2024-2.yml', deleted_file: true }
        ]))
        expect(await fetchGemnasiumChangedPaths('a'.repeat(40), 'b'.repeat(40))).toEqual({
            status: 'ok',
            changed: ['npm/lodash/CVE-2024-1.yml'],
            deleted: ['npm/express/CVE-2024-2.yml'],
            toSha: 'b'.repeat(40)
        })
    })

    it('encodes both shas into the compare URL', async function () {
        fetchMock.mockResolvedValue(compare([]))
        await fetchGemnasiumChangedPaths('from/sha', 'to sha')
        expect(String(fetchMock.mock.calls[0]?.[0])).toBe(API + '/repository/compare?from=from%2Fsha&to=to%20sha')
    })

    // An upstream commit touching only maven or gem advisories must correctly yield an empty changed set
    // rather than dragging unsupported ecosystems into the cache.
    it('ignores paths under a package type with no resolver', async function () {
        fetchMock.mockResolvedValue(compare([
            { new_path: 'maven/org.example/CVE-2024-3.yml' },
            { new_path: 'gem/rails/CVE-2024-4.yml' },
            { new_path: 'npm/lodash/CVE-2024-1.yml' }
        ]))
        const result = await fetchGemnasiumChangedPaths('a', 'b')
        expect(result.status === 'ok' && result.changed).toEqual(['npm/lodash/CVE-2024-1.yml'])
    })

    it('ignores non-advisory paths and diffs with no new_path', async function () {
        fetchMock.mockResolvedValue(compare([
            { new_path: 'README.md' },
            { new_path: 'npm/lodash/notes.txt' },
            { old_path: 'npm/lodash/CVE-2024-9.yml' },
            { new_path: 'npm/lodash/CVE-2024-1.yml' }
        ]))
        const result = await fetchGemnasiumChangedPaths('a', 'b')
        expect(result.status === 'ok' && result.changed).toEqual(['npm/lodash/CVE-2024-1.yml'])
    })

    it('accepts a .yaml extension as well as .yml', async function () {
        fetchMock.mockResolvedValue(compare([{ new_path: 'npm/lodash/CVE-2024-1.yaml' }]))
        const result = await fetchGemnasiumChangedPaths('a', 'b')
        expect(result.status === 'ok' && result.changed).toHaveLength(1)
    })

    it('rejects a path too short to name a package and a file', async function () {
        fetchMock.mockResolvedValue(compare([{ new_path: 'npm/CVE-2024-1.yml' }]))
        const result = await fetchGemnasiumChangedPaths('a', 'b')
        expect(result.status === 'ok' && result.changed).toEqual([])
    })

    // A leading slash makes the package-type segment the empty string, which is long enough to pass
    // the segment-count check but names no ecosystem. Reading it as a type would key every advisory
    // under a prefix of "/" and match nothing.
    it('rejects a path whose package-type segment is empty', async function () {
        fetchMock.mockResolvedValue(compare([{ new_path: '/lodash/CVE-2024-1.yml' }]))
        const result = await fetchGemnasiumChangedPaths('a', 'b')
        expect(result.status === 'ok' && result.changed).toEqual([])
    })

    // getJson can reject with something that is not an Error — an abort, or a thrown string from a
    // fetch polyfill. The reason string has to survive that rather than reading "undefined".
    it('reports a non-Error rejection in the reason', async function () {
        fetchMock.mockRejectedValue('socket hang up')
        const result = await fetchGemnasiumChangedPaths('a', 'b')
        expect(result).toMatchObject({ status: 'unavailable', reason: 'compare request failed: socket hang up' })
    })

    // A truncated diff would silently under-report changes and leave the cache subtly stale.
    it('falls back to the archive when upstream reports the compare timed out', async function () {
        fetchMock.mockResolvedValue(compare([{ new_path: 'npm/lodash/CVE-2024-1.yml' }], { compare_timeout: true }))
        const result = await fetchGemnasiumChangedPaths('a', 'b')
        expect(result).toMatchObject({ status: 'unavailable', reason: 'compare timed out upstream' })
    })

    it('falls back to the archive once the diff hits GitLab\'s cap', async function () {
        const diffs = Array.from({ length: GEMNASIUM_COMPARE_MAX_FILES }, function diff(_u, i) {
            return { new_path: 'npm/pkg' + i + '/CVE-' + i + '.yml' }
        })
        fetchMock.mockResolvedValue(compare(diffs))
        const result = await fetchGemnasiumChangedPaths('a', 'b')
        expect(result.status).toBe('unavailable')
        expect(result.status === 'unavailable' && result.reason).toContain(String(GEMNASIUM_COMPARE_MAX_FILES))
    })

    it('stays on the incremental path just under the cap', async function () {
        const diffs = Array.from({ length: GEMNASIUM_COMPARE_MAX_FILES - 1 }, function diff(_u, i) {
            return { new_path: 'npm/pkg' + i + '/CVE-' + i + '.yml' }
        })
        fetchMock.mockResolvedValue(compare(diffs))
        expect((await fetchGemnasiumChangedPaths('a', 'b')).status).toBe('ok')
    })

    it('falls back to the archive when the compare request fails outright', async function () {
        fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
        const result = await fetchGemnasiumChangedPaths('a', 'b')
        expect(result).toMatchObject({ status: 'unavailable' })
        expect(result.status === 'unavailable' && result.reason).toContain('ECONNREFUSED')
    })

    it('treats a response with no diffs array as an empty change set', async function () {
        fetchMock.mockResolvedValue(respond(JSON.stringify({}), { status: 200 }))
        const result = await fetchGemnasiumChangedPaths('a', 'b')
        expect(result).toMatchObject({ status: 'ok', changed: [], deleted: [] })
    })
})

describe('fetchGemnasiumFileRows', function () {
    it('fetches and normalizes one advisory file at a pinned ref', async function () {
        fetchMock.mockResolvedValue(respond(advisoryYaml(), { status: 200 }))
        const rows = await fetchGemnasiumFileRows('npm/lodash/CVE-2024-1.yml', 'a'.repeat(40))
        expect(rows.map(function pkg(r) { return r.packageName })).toEqual(['lodash'])
        expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
            API + '/repository/files/npm%2Flodash%2FCVE-2024-1.yml/raw?ref=' + 'a'.repeat(40)
        )
    })

    // Deleted between the compare and the fetch — the caller applies it as "no longer matches".
    it('returns nothing when the file 404s', async function () {
        fetchMock.mockResolvedValue(respond('not found', { status: 404 }))
        expect(await fetchGemnasiumFileRows('npm/lodash/CVE-2024-1.yml', 'sha')).toEqual([])
    })

    it('returns nothing for a path outside a supported package type, without fetching', async function () {
        expect(await fetchGemnasiumFileRows('maven/org.example/CVE-2024-1.yml', 'sha')).toEqual([])
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('returns nothing when the YAML does not parse', async function () {
        fetchMock.mockResolvedValue(respond('key: [unclosed\n  bad: indent', { status: 200 }))
        expect(await fetchGemnasiumFileRows('npm/lodash/CVE-2024-1.yml', 'sha')).toEqual([])
    })
})

describe('advisoryIdFromPath', function () {
    // gemnasium names each file "<identifier>.yml", which IS the row's advisoryId — that is what lets a
    // deleted file be dropped from the cache without re-fetching it.
    it('takes the basename without its extension', function () {
        expect(advisoryIdFromPath('npm/lodash/CVE-2024-1.yml')).toBe('CVE-2024-1')
    })

    it('keeps dots inside the identifier and strips only the last extension', function () {
        expect(advisoryIdFromPath('npm/lodash/GMS-2024-1.2.yml')).toBe('GMS-2024-1.2')
    })

    it('accepts a bare filename with no directories', function () {
        expect(advisoryIdFromPath('CVE-2024-1.yml')).toBe('CVE-2024-1')
    })

    it('returns the whole name when there is no extension', function () {
        expect(advisoryIdFromPath('npm/lodash/CVE-2024-1')).toBe('CVE-2024-1')
    })

    it.each(['', 'npm/lodash/'])('returns null for %j', function (path) {
        expect(advisoryIdFromPath(path as string)).toBeNull()
    })

    // The extension split guards on `dot > 0`, not `dot !== -1`, so a LEADING dot is never treated as an
    // extension separator: '.yml' is a name with no extension rather than an empty id. Worth stating,
    // because the obvious reading of the code is that this returns null.
    it('treats a leading dot as part of the name, not an extension', function () {
        expect(advisoryIdFromPath('npm/lodash/.yml')).toBe('.yml')
    })
})

describe('streamGemnasiumArchive', function () {
    function zipResponse(files: Record<string, string>): Response {
        return respond(makeZip(files), { headers: { 'last-modified': 'Wed, 01 Jul 2026 00:00:00 GMT' } })
    }

    // The streamer must hand rows back in fixed-size batches rather than accumulating the whole
    // archive. The real one carries well over 100k advisories, so buffering it is the difference
    // between a seed that completes and one that exhausts memory. BATCH_SIZE is 2000.
    it('yields in batches rather than accumulating the whole archive', async function () {
        const files: Record<string, string> = {}
        for (let i = 0; i < 2001; i++) {
            files['gemnasium-db-master/npm/pkg' + i + '/CVE-2024-' + i + '.yml'] = advisoryYaml({
                identifier: 'CVE-2024-' + i,
                package_slug: 'npm/pkg' + i
            })
        }
        fetchMock.mockResolvedValue(zipResponse(files))
        const batches = await collect(streamGemnasiumArchive())
        expect(batches).toHaveLength(2)
        expect(batches[0]?.rows).toHaveLength(2000)
        expect(batches[1]?.rows).toHaveLength(1)
    })

    it('normalizes advisories nested under the archive root folder', async function () {
        fetchMock.mockResolvedValue(zipResponse({
            'gemnasium-db-master/npm/lodash/CVE-2024-1.yml': advisoryYaml(),
            'gemnasium-db-master/npm/express/CVE-2024-2.yml': advisoryYaml({ identifier: 'CVE-2024-2', package_slug: 'npm/express' })
        }))
        const batches = await collect(streamGemnasiumArchive())
        expect(batches[0]?.rows.map(function pkg(r) { return r.packageName }).sort()).toEqual(['express', 'lodash'])
    })

    // The rootOffset trap, stated as a test: without the archive's top-level folder the path is one
    // segment short of the expected shape and is skipped, which would look like an empty upstream.
    it('skips an advisory path that is not nested under a root folder', async function () {
        fetchMock.mockResolvedValue(zipResponse({ 'npm/lodash/CVE-2024-1.yml': advisoryYaml() }))
        expect(await collect(streamGemnasiumArchive())).toEqual([])
    })

    it('skips package types with no resolver', async function () {
        fetchMock.mockResolvedValue(zipResponse({
            'gemnasium-db-master/maven/org.example/CVE-2024-3.yml': advisoryYaml({ package_slug: 'maven/org.example' }),
            'gemnasium-db-master/npm/lodash/CVE-2024-1.yml': advisoryYaml()
        }))
        const batches = await collect(streamGemnasiumArchive())
        expect(batches[0]?.rows).toHaveLength(1)
    })

    it('skips non-advisory files in the archive', async function () {
        fetchMock.mockResolvedValue(zipResponse({
            'gemnasium-db-master/README.md': '# gemnasium-db',
            'gemnasium-db-master/npm/lodash/CVE-2024-1.yml': advisoryYaml()
        }))
        const batches = await collect(streamGemnasiumArchive())
        expect(batches[0]?.rows).toHaveLength(1)
    })

    it('drops an advisory whose YAML does not parse and keeps going', async function () {
        fetchMock.mockResolvedValue(zipResponse({
            'gemnasium-db-master/npm/broken/CVE-bad.yml': 'key: [unclosed\n  bad: indent',
            'gemnasium-db-master/npm/lodash/CVE-2024-1.yml': advisoryYaml()
        }))
        const batches = await collect(streamGemnasiumArchive())
        expect(batches[0]?.rows.map(function pkg(r) { return r.packageName })).toEqual(['lodash'])
    })

    it('carries the archive last-modified onto the batch', async function () {
        fetchMock.mockResolvedValue(zipResponse({ 'gemnasium-db-master/npm/lodash/CVE-2024-1.yml': advisoryYaml() }))
        const batches = await collect(streamGemnasiumArchive())
        expect(batches[0]?.lastModified).toBe('Wed, 01 Jul 2026 00:00:00 GMT')
    })

    it('yields nothing for an archive with no supported advisories', async function () {
        fetchMock.mockResolvedValue(zipResponse({ 'gemnasium-db-master/README.md': 'nothing' }))
        expect(await collect(streamGemnasiumArchive())).toEqual([])
    })

    it('reports download progress as bytes arrive', async function () {
        fetchMock.mockResolvedValue(zipResponse({ 'gemnasium-db-master/npm/lodash/CVE-2024-1.yml': advisoryYaml() }))
        const seen: number[] = []
        await collect(streamGemnasiumArchive(function onProgress(read) { seen.push(read) }))
        expect(seen.length).toBeGreaterThan(0)
    })

    it('aborts mid-archive when the signal fires', async function () {
        fetchMock.mockResolvedValue(zipResponse({ 'gemnasium-db-master/npm/lodash/CVE-2024-1.yml': advisoryYaml() }))
        const controller = new AbortController()
        controller.abort()
        await expect(collect(streamGemnasiumArchive(undefined, { abortSignal: controller.signal }))).rejects.toThrow('aborted')
    })

    it('fails loudly when the archive download is rejected', async function () {
        fetchMock.mockResolvedValue(respond('nope', { status: 404 }))
        await expect(collect(streamGemnasiumArchive())).rejects.toThrow(/HTTP 404/)
    })
})
