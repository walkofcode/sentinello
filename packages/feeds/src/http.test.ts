import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    DOWNLOAD_TIMEOUT_MS,
    errText,
    getJson,
    getJsonOrNull,
    getTextConditional,
    getTextOrNull,
    headFile,
    openDownloadStream
} from './http'

// These are the network primitives under every advisory sync, so the retry policy is the load-bearing
// part. Two failure modes matter and they pull in opposite directions: retrying a permanent failure
// wastes a scan's time budget, and NOT retrying a transient one abandons the feed for the whole run
// and leaves the source silently unauditable.
//
// The transient set is deliberately unusual — 406 is in it because GitLab intermittently answers 406
// to the archive download as abuse throttling, and the identical request succeeds moments later.
//
// fetch is stubbed with real Response objects rather than hand-rolled fakes, so header parsing, body
// consumption, cancellation and the ReadableStream that openDownloadStream converts all behave the
// way they do in production. Backoff is 1s/3s/9s, so the retry cases run on fake timers — real ones
// would add ~13s per case and this suite is meant to stay cheap enough to always run.

const URL_UNDER_TEST = 'https://feeds.example.test/advisories.json'

let fetchMock: ReturnType<typeof vi.fn>

function respond(body: string | null, init: ResponseInit = {}): Response {
    return new Response(body, init)
}

// Drives a call that will exhaust its retries, advancing fake timers past each backoff step.
async function runWithBackoff<T>(start: () => Promise<T>): Promise<{ error?: Error; value?: T }> {
    const pending = start().then(
        function ok(value) { return { value } },
        function failed(error: Error) { return { error } }
    )
    // 1s + 3s + 9s covers every backoff between the four attempts.
    await vi.advanceTimersByTimeAsync(20_000)
    return pending
}

beforeEach(function setup() {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
})

afterEach(function teardown() {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    delete process.env.SENTINELLO_USER_AGENT
})

describe('request headers', function () {
    // Feed operators can see who is calling and throttle or contact us, rather than blocking an
    // anonymous client.
    it('identifies itself on every request', async function () {
        fetchMock.mockResolvedValue(respond('{}'))
        await getJson(URL_UNDER_TEST)
        const headers = fetchMock.mock.calls[0]?.[1].headers as Record<string, string>
        expect(headers['User-Agent']).toContain('sentinello')
    })

    it('lets an operator override the agent string', async function () {
        process.env.SENTINELLO_USER_AGENT = 'acme-proxy/1.0'
        fetchMock.mockResolvedValue(respond('{}'))
        await getJson(URL_UNDER_TEST)
        expect((fetchMock.mock.calls[0]?.[1].headers as Record<string, string>)['User-Agent']).toBe('acme-proxy/1.0')
    })

    it('ignores a blank override', async function () {
        process.env.SENTINELLO_USER_AGENT = '   '
        fetchMock.mockResolvedValue(respond('{}'))
        await getJson(URL_UNDER_TEST)
        expect((fetchMock.mock.calls[0]?.[1].headers as Record<string, string>)['User-Agent']).toContain('sentinello')
    })

    // These endpoints serve JSON, CSV, YAML and zip; stating Accept explicitly avoids
    // content-negotiation surprises.
    it('accepts any content type', async function () {
        fetchMock.mockResolvedValue(respond('{}'))
        await getJson(URL_UNDER_TEST)
        expect((fetchMock.mock.calls[0]?.[1].headers as Record<string, string>).Accept).toBe('*/*')
    })

    it('bounds every request with an abort signal', async function () {
        fetchMock.mockResolvedValue(respond('{}'))
        await getJson(URL_UNDER_TEST)
        expect(fetchMock.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal)
    })
})

describe('retry policy', function () {
    beforeEach(function useFake() {
        vi.useFakeTimers()
    })

    it('does not retry a success', async function () {
        fetchMock.mockResolvedValue(respond('{}'))
        await getJson(URL_UNDER_TEST)
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    // A permanent failure must surface immediately rather than burning the retry budget.
    it('does not retry a client error', async function () {
        fetchMock.mockResolvedValue(respond('nope', { status: 400 }))
        const { error } = await runWithBackoff(function call() { return getJson(URL_UNDER_TEST) })
        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(error?.message).toContain('400')
    })

    it('does not retry a 404', async function () {
        fetchMock.mockResolvedValue(respond(null, { status: 404 }))
        expect(await getJsonOrNull(URL_UNDER_TEST)).toBeNull()
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('retries a 429 and succeeds on the next attempt', async function () {
        fetchMock
            .mockResolvedValueOnce(respond('slow down', { status: 429 }))
            .mockResolvedValueOnce(respond('{"ok":true}'))
        const { value } = await runWithBackoff(function call() { return getJson(URL_UNDER_TEST) })
        expect(value).toEqual({ ok: true })
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    // GitLab answers 406 to the archive download as abuse throttling; treating it as permanent would
    // abandon the gemnasium seed for the whole run.
    it('retries the 406 GitLab actually returns', async function () {
        fetchMock
            .mockResolvedValueOnce(respond('throttled', { status: 406 }))
            .mockResolvedValueOnce(respond('{"ok":true}'))
        const { value } = await runWithBackoff(function call() { return getJson(URL_UNDER_TEST) })
        expect(value).toEqual({ ok: true })
    })

    it('retries the rest of the transient set', async function () {
        for (const status of [408, 425, 500, 502, 503]) {
            fetchMock.mockReset()
            fetchMock
                .mockResolvedValueOnce(respond('transient', { status }))
                .mockResolvedValueOnce(respond('{"ok":true}'))
            const { value } = await runWithBackoff(function call() { return getJson(URL_UNDER_TEST) })
            expect(value, 'status ' + status).toEqual({ ok: true })
        }
    })

    // Bounded so a feed that is genuinely down surfaces as a degraded source rather than stalling a
    // developer's terminal.
    it('gives up after four attempts', async function () {
        fetchMock.mockResolvedValue(respond('down', { status: 503 }))
        const { error } = await runWithBackoff(function call() { return getJson(URL_UNDER_TEST) })
        expect(fetchMock).toHaveBeenCalledTimes(4)
        expect(error?.message).toContain('503')
        expect(error?.message).toContain('4 attempts')
    })

    it('names the method in the give-up message', async function () {
        fetchMock.mockResolvedValue(respond(null, { status: 503 }))
        const { error } = await runWithBackoff(function call() { return headFile(URL_UNDER_TEST) })
        expect(error?.message).toContain('HEAD')
    })

    // A retried response body must be discarded or the connection stays open for the life of the
    // process — across a whole sync that leaks a socket per retry.
    it('discards the body of a retried response', async function () {
        const throttled = respond('throttled', { status: 429 })
        const cancel = vi.spyOn(throttled.body as ReadableStream, 'cancel')
        fetchMock
            .mockResolvedValueOnce(throttled)
            .mockResolvedValueOnce(respond('{"ok":true}'))
        await runWithBackoff(function call() { return getJson(URL_UNDER_TEST) })
        expect(cancel).toHaveBeenCalled()
    })

    it('stops retrying once the caller aborts', async function () {
        const controller = new AbortController()
        fetchMock.mockImplementation(async function throttle() {
            controller.abort()
            return respond('throttled', { status: 429 })
        })
        const { error } = await runWithBackoff(function call() {
            return getJson(URL_UNDER_TEST, { abortSignal: controller.signal })
        })
        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(error).toBeDefined()
    })
})

describe('getTextConditional', function () {
    // What makes "sync on every scan" affordable: OSV's modified_id.csv is 8.4 MB, but an unchanged
    // feed answers 304 with no payload.
    it('reports unchanged for a 304', async function () {
        fetchMock.mockResolvedValue(respond(null, { status: 304 }))
        expect(await getTextConditional(URL_UNDER_TEST, '"abc"')).toEqual({ status: 'unchanged' })
    })

    it('sends the cached etag as If-None-Match', async function () {
        fetchMock.mockResolvedValue(respond(null, { status: 304 }))
        await getTextConditional(URL_UNDER_TEST, '"abc"')
        expect((fetchMock.mock.calls[0]?.[1].headers as Record<string, string>)['If-None-Match']).toBe('"abc"')
    })

    it('omits If-None-Match on a first fetch', async function () {
        fetchMock.mockResolvedValue(respond('body'))
        await getTextConditional(URL_UNDER_TEST, null)
        expect((fetchMock.mock.calls[0]?.[1].headers as Record<string, string>)['If-None-Match']).toBeUndefined()
    })

    it('returns the body and the new validators', async function () {
        fetchMock.mockResolvedValue(respond('id,modified\n1,2', {
            headers: { etag: '"def"', 'last-modified': 'Wed, 01 Jan 2026 00:00:00 GMT' }
        }))
        expect(await getTextConditional(URL_UNDER_TEST, '"abc"')).toEqual({
            status: 'ok',
            body: 'id,modified\n1,2',
            etag: '"def"',
            lastModified: 'Wed, 01 Jan 2026 00:00:00 GMT'
        })
    })

    it('nulls absent validators rather than inventing them', async function () {
        fetchMock.mockResolvedValue(respond('body'))
        const result = await getTextConditional(URL_UNDER_TEST, null)
        expect(result).toMatchObject({ etag: null, lastModified: null })
    })

    it('throws on a non-ok status that is not 304', async function () {
        fetchMock.mockResolvedValue(respond('gone', { status: 410 }))
        await expect(getTextConditional(URL_UNDER_TEST, null)).rejects.toThrow('410')
    })
})

describe('getJson and getJsonOrNull', function () {
    it('parses a JSON body', async function () {
        fetchMock.mockResolvedValue(respond('{"id":"CVE-1"}'))
        expect(await getJson(URL_UNDER_TEST)).toEqual({ id: 'CVE-1' })
    })

    it('throws on a non-ok status', async function () {
        fetchMock.mockResolvedValue(respond('nope', { status: 403 }))
        await expect(getJson(URL_UNDER_TEST)).rejects.toThrow('403')
    })

    // An advisory withdrawn upstream, or a gemnasium file that vanished between the compare call and
    // the fetch, are normal states rather than failures.
    it('returns null for a missing resource', async function () {
        fetchMock.mockResolvedValue(respond(null, { status: 404 }))
        expect(await getJsonOrNull(URL_UNDER_TEST)).toBeNull()
    })

    it('still parses a present resource', async function () {
        fetchMock.mockResolvedValue(respond('{"id":"CVE-1"}'))
        expect(await getJsonOrNull(URL_UNDER_TEST)).toEqual({ id: 'CVE-1' })
    })

    it('still throws on other errors', async function () {
        fetchMock.mockResolvedValue(respond('nope', { status: 403 }))
        await expect(getJsonOrNull(URL_UNDER_TEST)).rejects.toThrow('403')
    })
})

describe('getTextOrNull', function () {
    it('returns null for a missing resource', async function () {
        fetchMock.mockResolvedValue(respond(null, { status: 404 }))
        expect(await getTextOrNull(URL_UNDER_TEST)).toBeNull()
    })

    it('returns the body when present', async function () {
        fetchMock.mockResolvedValue(respond('advisory: yaml'))
        expect(await getTextOrNull(URL_UNDER_TEST)).toBe('advisory: yaml')
    })

    it('throws on other errors', async function () {
        fetchMock.mockResolvedValue(respond('boom', { status: 500 }))
        vi.useFakeTimers()
        const { error } = await runWithBackoff(function call() { return getTextOrNull(URL_UNDER_TEST) })
        expect(error).toBeDefined()
    })
})

describe('headFile', function () {
    it('issues a HEAD request', async function () {
        fetchMock.mockResolvedValue(respond(null, { headers: { 'content-length': '1024' } }))
        await headFile(URL_UNDER_TEST)
        expect(fetchMock.mock.calls[0]?.[1].method).toBe('HEAD')
    })

    // The byte count is what lets the CLI show a real size in its consent prompt and pre-flight free
    // space, instead of asking an operator to approve an unknown quantity.
    it('reports the advertised size', async function () {
        fetchMock.mockResolvedValue(respond(null, {
            headers: { 'content-length': '96000000', etag: '"z"', 'last-modified': 'Wed, 01 Jan 2026 00:00:00 GMT' }
        }))
        expect(await headFile(URL_UNDER_TEST)).toEqual({
            contentLength: 96000000,
            etag: '"z"',
            lastModified: 'Wed, 01 Jan 2026 00:00:00 GMT'
        })
    })

    // Null rather than NaN, so a caller can distinguish "unknown size" from "zero bytes".
    it('reports an unknown size as null', async function () {
        fetchMock.mockResolvedValue(respond(null))
        expect((await headFile(URL_UNDER_TEST)).contentLength).toBeNull()
    })

    it('reports an unparseable size as null', async function () {
        fetchMock.mockResolvedValue(respond(null, { headers: { 'content-length': 'not-a-number' } }))
        expect((await headFile(URL_UNDER_TEST)).contentLength).toBeNull()
    })

    it('throws on a non-ok status', async function () {
        fetchMock.mockResolvedValue(respond(null, { status: 403 }))
        await expect(headFile(URL_UNDER_TEST)).rejects.toThrow('403')
    })
})

describe('openDownloadStream', function () {
    async function collect(stream: NodeJS.ReadableStream): Promise<string> {
        const chunks: Buffer[] = []
        for await (const chunk of stream) chunks.push(Buffer.from(chunk))
        return Buffer.concat(chunks).toString('utf8')
    }

    it('exposes the response body as a node stream', async function () {
        fetchMock.mockResolvedValue(respond('archive-bytes'))
        const download = await openDownloadStream(URL_UNDER_TEST)
        expect(await collect(download.stream)).toBe('archive-bytes')
    })

    it('reports the advertised length and last-modified', async function () {
        fetchMock.mockResolvedValue(respond('abc', {
            headers: { 'content-length': '3', 'last-modified': 'Wed, 01 Jan 2026 00:00:00 GMT' }
        }))
        const download = await openDownloadStream(URL_UNDER_TEST)
        expect(download.contentLength).toBe(3)
        expect(download.lastModified).toBe('Wed, 01 Jan 2026 00:00:00 GMT')
        await collect(download.stream)
    })

    it('reports an unknown length as null', async function () {
        fetchMock.mockResolvedValue(respond('abc'))
        const download = await openDownloadStream(URL_UNDER_TEST)
        expect(download.contentLength).toBeNull()
        await collect(download.stream)
    })

    it('reports progress as bytes arrive', async function () {
        fetchMock.mockResolvedValue(respond('abcdef', { headers: { 'content-length': '6' } }))
        const seen: Array<[number, number | null]> = []
        const download = await openDownloadStream(URL_UNDER_TEST, function onProgress(read, total) {
            seen.push([read, total])
        })
        await collect(download.stream)
        expect(seen.length).toBeGreaterThan(0)
        expect(seen[seen.length - 1]?.[0]).toBe(6)
        expect(seen[seen.length - 1]?.[1]).toBe(6)
    })

    it('throws on a non-ok status', async function () {
        fetchMock.mockResolvedValue(respond(null, { status: 403 }))
        await expect(openDownloadStream(URL_UNDER_TEST)).rejects.toThrow('403')
    })

    it('throws when the response carries no body', async function () {
        fetchMock.mockResolvedValue(respond(null, { status: 204 }))
        await expect(openDownloadStream(URL_UNDER_TEST)).rejects.toThrow('no body')
    })

    // Seeds are hundreds of megabytes over an arbitrary connection, so the download deadline is far
    // longer than an ordinary request's — but still bounded, so a hung socket cannot wedge a sync.
    it('allows far longer than a normal request but stays bounded', function () {
        expect(DOWNLOAD_TIMEOUT_MS).toBeGreaterThan(60_000)
        expect(Number.isFinite(DOWNLOAD_TIMEOUT_MS)).toBe(true)
    })
})

describe('errText', function () {
    it('uses an Error message', function () {
        expect(errText(new Error('connect ECONNREFUSED'))).toBe('connect ECONNREFUSED')
    })

    it('stringifies a non-Error', function () {
        expect(errText('just a string')).toBe('just a string')
        expect(errText(404)).toBe('404')
        expect(errText(null)).toBe('null')
    })
})
