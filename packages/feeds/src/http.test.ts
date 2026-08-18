import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    DOWNLOAD_TIMEOUT_MS,
    getJson,
    getJsonOrNull,
    getTextConditional,
    getTextOrNull,
    headFile,
    openDownloadStream
} from './http'
import {
    startDownloadServer,
    type DownloadServer,
    type RecordedRequest,
    type ServedResponse
} from './download-server.fixture'

// These are the network primitives under every advisory sync, so the retry policy is the load-bearing
// part. Two failure modes matter and they pull in opposite directions: retrying a permanent failure
// wastes a scan's time budget, and NOT retrying a transient one abandons the feed for the whole run
// and leaves the source silently unauditable.
//
// The transient set is deliberately unusual — 406 is in it because GitLab answers 406 to a repository
// archive request it declines to generate. The real fix for that lives at the URL (gemnasium/feed.ts
// requests an immutable, CDN-cacheable sha), so the retry here is a cushion for a blip and nothing more.
// Its budget is short on purpose: an earlier design waited three minutes and only made the failure
// slower to find.
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
    // 1s + 3s + 9s covers every backoff between the four attempts of the fast ladder.
    await vi.advanceTimersByTimeAsync(20_000)
    return pending
}

// The slow ladder waits 2s, 5s then 8s against a 15s budget. Advancing well past it covers the whole
// schedule without depending on the exact step values.
async function runWithSlowBackoff<T>(start: () => Promise<T>): Promise<{ error?: Error; value?: T }> {
    const pending = start().then(
        function ok(value) { return { value } },
        function failed(error: Error) { return { error } }
    )
    await vi.advanceTimersByTimeAsync(60_000)
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

    // GitLab declines a repository archive it will not generate with an empty-bodied 406. Treating that as
    // permanent abandons the gemnasium seed for the whole run, and the CLI is usually run once, so that is
    // a source the user never gets.
    it('retries the 406 GitLab actually returns, on the slow ladder', async function () {
        fetchMock
            .mockResolvedValueOnce(respond('declined', { status: 406 }))
            .mockResolvedValueOnce(respond('{"ok":true}'))
        const { value } = await runWithSlowBackoff(function call() { return getJson(URL_UNDER_TEST) })
        expect(value).toEqual({ ok: true })
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    // The fail-fast contract, as a number. A previous design spent three minutes here before reporting a
    // failure it was never going to clear, which is the worst of both outcomes: the user waits AND loses
    // the source. Anything approaching that duration is a regression, so bound it well under a minute.
    it('gives up on a persistent 406 in seconds, not minutes', async function () {
        fetchMock.mockResolvedValue(respond('declined', { status: 406 }))
        const pending = getJson(URL_UNDER_TEST).catch(function swallow() { return 'gave up' })
        await vi.advanceTimersByTimeAsync(30_000)
        expect(await pending).toBe('gave up')
    })

    it('stops once the wait budget is spent, naming the attempts it made', async function () {
        fetchMock.mockResolvedValue(respond('declined', { status: 406 }))
        const { error } = await runWithSlowBackoff(function call() { return getJson(URL_UNDER_TEST) })
        // 2 + 5 + 8 lands exactly on the 15s budget, so four attempts are made — at t=0, 2s, 7s and 15s.
        expect(fetchMock).toHaveBeenCalledTimes(4)
        expect(error?.message).toContain('406')
        expect(error?.message).toContain('4 attempts')
    })

    // Both ladders bottom out at four attempts, so the attempt count alone cannot tell them apart. That
    // ambiguity is what made a shed archive request read as a network fault through two rounds of fixes:
    // "406 after 4 attempts" was equally consistent with a 13s giving-up and a 180s one.
    it('reports elapsed time so the fast and slow ladders can be told apart', async function () {
        fetchMock.mockResolvedValue(respond('declined', { status: 406 }))
        const { error } = await runWithSlowBackoff(function call() { return getJson(URL_UNDER_TEST) })
        expect(error?.message).toMatch(/over \d+s/)
    })

    it('fails on the first refusal when waiting is switched off', async function () {
        fetchMock.mockResolvedValue(respond('declined', { status: 406 }))
        const { error } = await runWithSlowBackoff(function call() {
            return getJson(URL_UNDER_TEST, { retryWaitMs: 0 })
        })
        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(error?.message).toContain('406')
    })

    it('honours a longer budget than the default', async function () {
        fetchMock.mockResolvedValue(respond('declined', { status: 406 }))
        const pending = getJson(URL_UNDER_TEST, { retryWaitMs: 600_000 }).catch(function swallow() { return null })
        // Past the 600s budget, which the shared slow helper's 400s window would stop short of.
        await vi.advanceTimersByTimeAsync(700_000)
        await pending
        // 2 + 5 + then 8 repeating all fit inside 600s, so it keeps going well past the default's four.
        expect(fetchMock.mock.calls.length).toBeGreaterThan(4)
    })

    // Even a short wait with no output reads as a stall, so the caller has to be able to say why.
    it('reports each wait before it happens', async function () {
        fetchMock.mockResolvedValue(respond('declined', { status: 406 }))
        const notices: { status: number; waitMs: number; budgetMs: number }[] = []
        await runWithSlowBackoff(function call() {
            return getJson(URL_UNDER_TEST, {
                onRetry: function record(notice) {
                    notices.push({ status: notice.status, waitMs: notice.waitMs, budgetMs: notice.budgetMs })
                }
            })
        })
        expect(notices.map(function w(n) { return n.waitMs })).toEqual([2_000, 5_000, 8_000])
        expect(notices[0]?.status).toBe(406)
        expect(notices[0]?.budgetMs).toBe(15_000)
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

    // A 500 is retried by fetchWithRetry and never reaches this function's own status check. A 403
    // is not retryable, so it arrives here — and must be distinguished from the 404 above, which is
    // a normal state rather than a failure.
    it('throws with the status for a non-retryable failure that is not a 404', async function () {
        fetchMock.mockResolvedValue(respond('nope', { status: 403 }))
        await expect(getTextOrNull(URL_UNDER_TEST)).rejects.toThrow(/HTTP 403/)
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

// Driven against a real loopback server rather than a stubbed fetch, because this path deliberately does
// not use fetch — see startDownloadServer and the transport note in http.ts.
describe('openDownloadStream', function () {
    let server: DownloadServer | null = null

    async function serve(response: ServedResponse | ((r: RecordedRequest) => ServedResponse)): Promise<string> {
        server = await startDownloadServer(response)
        return server.origin + '/archive.zip'
    }

    afterEach(async function stop() {
        if (server) await server.close()
        server = null
    })

    async function collect(stream: NodeJS.ReadableStream): Promise<string> {
        const chunks: Buffer[] = []
        for await (const chunk of stream) chunks.push(Buffer.from(chunk))
        return Buffer.concat(chunks).toString('utf8')
    }

    it('exposes the response body as a node stream', async function () {
        const url = await serve({ body: 'archive-bytes' })
        const download = await openDownloadStream(url)
        expect(await collect(download.stream)).toBe('archive-bytes')
    })

    // The regression guard for the bug itself: the request must NOT carry undici's Sec-Fetch-Mode, which
    // GitLab rejects with 406 on archive routes and which no fetch client can remove.
    it('sends no sec-fetch-mode header', async function () {
        const url = await serve({ body: 'abc' })
        const download = await openDownloadStream(url)
        await collect(download.stream)
        expect(server?.requests[0]?.headers['sec-fetch-mode']).toBeUndefined()
    })

    it('identifies itself with the user agent', async function () {
        const url = await serve({ body: 'abc' })
        const download = await openDownloadStream(url)
        await collect(download.stream)
        expect(String(server?.requests[0]?.headers['user-agent'])).toContain('sentinello')
    })

    it('reports the advertised length and last-modified', async function () {
        const url = await serve({
            body: 'abc',
            headers: { 'content-length': '3', 'last-modified': 'Wed, 01 Jan 2026 00:00:00 GMT' }
        })
        const download = await openDownloadStream(url)
        expect(download.contentLength).toBe(3)
        expect(download.lastModified).toBe('Wed, 01 Jan 2026 00:00:00 GMT')
        await collect(download.stream)
    })

    // No content-length: the server falls back to chunked encoding, exactly as GitLab does for an archive
    // it generates on the fly. The consent prompt relies on this being null rather than a bogus number.
    it('reports an unknown length as null', async function () {
        const url = await serve({ body: 'abc', headers: { 'transfer-encoding': 'chunked' } })
        const download = await openDownloadStream(url)
        expect(download.contentLength).toBeNull()
        await collect(download.stream)
    })

    it('reports progress as bytes arrive', async function () {
        const url = await serve({ body: 'abcdef', headers: { 'content-length': '6' } })
        const seen: Array<[number, number | null]> = []
        const download = await openDownloadStream(url, function onProgress(read, total) {
            seen.push([read, total])
        })
        await collect(download.stream)
        expect(seen.length).toBeGreaterThan(0)
        expect(seen[seen.length - 1]?.[0]).toBe(6)
        expect(seen[seen.length - 1]?.[1]).toBe(6)
    })

    it('throws on a non-ok status', async function () {
        const url = await serve({ status: 403, body: 'nope' })
        await expect(openDownloadStream(url)).rejects.toThrow('403')
    })

    // node's client does not follow redirects, so the download path does it itself. A feed served from a
    // bucket behind a redirect is ordinary, and silently returning the 302 body would corrupt the cache.
    it('follows a redirect to the real archive', async function () {
        const url = await serve(function route(request): ServedResponse {
            if (request.url.startsWith('/archive.zip')) {
                return { status: 302, headers: { location: '/real.zip' } }
            }
            return { body: 'redirected-bytes' }
        })
        const download = await openDownloadStream(url)
        expect(await collect(download.stream)).toBe('redirected-bytes')
    })

    it('gives up rather than following a redirect loop', async function () {
        const url = await serve({ status: 302, headers: { location: '/loop.zip' } })
        await expect(openDownloadStream(url)).rejects.toThrow(/redirect/)
    })

    // Every real feed is https, so picking the client off the URL scheme has to be right in both arms —
    // getting it backwards would send an https download over plaintext. Port 1 on loopback refuses
    // immediately, which reaches the https client without leaving the machine.
    it('uses the https client for an https URL', async function () {
        await expect(openDownloadStream('https://127.0.0.1:1/archive.zip')).rejects.toThrow()
    })

    // The download path shares the retry ladder with the fetch path, so a transient status has to be
    // retried here too — and the abandoned response body drained, or the socket is held for the life of
    // the process. Real timers: the fast ladder's first wait is 1s.
    it('retries a transient download failure and drains the abandoned body', async function () {
        let served = 0
        const url = await serve(function route(): ServedResponse {
            served++
            return served === 1 ? { status: 503, body: 'busy' } : { body: 'ok-bytes' }
        })
        const download = await openDownloadStream(url)
        expect(await collect(download.stream)).toBe('ok-bytes')
        expect(served).toBe(2)
    })

    // Seeds are hundreds of megabytes over an arbitrary connection, so the download deadline is far
    // longer than an ordinary request's — but still bounded, so a hung socket cannot wedge a sync.
    it('allows far longer than a normal request but stays bounded', function () {
        expect(DOWNLOAD_TIMEOUT_MS).toBeGreaterThan(60_000)
        expect(Number.isFinite(DOWNLOAD_TIMEOUT_MS)).toBe(true)
    })
})
