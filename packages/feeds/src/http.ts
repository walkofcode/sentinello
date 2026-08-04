import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
// Type-only: IncomingMessage IS a Readable, so the public DownloadStream contract is unchanged and
// callers keep piping it exactly as before.
import type { Readable } from 'node:stream'

// Network primitives shared by the OSV and gemnasium feeds.
//
// These use the runtime's built-ins rather than axios — a deliberate, scoped exception to the
// project-wide axios rule. This package is bundled into the published CLI, where the goal is zero declared
// runtime dependencies; axios would pull `follow-redirects`, `form-data`, and `proxy-from-env` into that
// bundle to do what the runtime already does natively. The worker and portal keep axios everywhere else.
//
// Two transports, and the split is forced rather than stylistic:
//
//   - JSON and text calls use `fetch`, which is the pleasanter API.
//   - Archive DOWNLOADS use node:https, because `fetch` physically cannot perform them.
//
// Node's fetch is undici, and undici stamps `Sec-Fetch-Mode: cors` onto every request. GitLab answers any
// repository-archive request carrying that header with an empty-bodied HTTP 406. It is a forbidden header
// name under the fetch spec, so user code cannot unset it — passing `Sec-Fetch-Mode: navigate` is silently
// discarded and `cors` still goes on the wire. That makes the failure total and permanent for a fetch
// client: every user, every IP, every retry. It is why this looked for two rounds of fixes like an IP
// block or a rate limit, when curl and a browser — neither of which sends the header — always worked.
//
// Verified per-endpoint: /repository/commits, /repository/files/…/raw and /repository/compare all answer
// 200 to fetch. ONLY /repository/archive.zip enforces it. So the incremental sync was never broken; only
// the first seed was, which is exactly the shape of the reports (everyone on a fresh install).
//
// Do not "simplify" openDownloadStream back onto fetch.

// Reported before each slow-transient wait, so a caller with a terminal can say why it is sitting there
// instead of looking hung. `waitMs` is the pause about to happen; `elapsedMs` is what the budget has spent.
export type RetryNotice = {
    status: number
    attempt: number
    waitMs: number
    elapsedMs: number
    budgetMs: number
}

export type FetchOptions = {
    abortSignal?: AbortSignal
    timeoutMs?: number
    // Total time to keep re-trying a slow-transient rejection (see SLOW_TRANSIENT_STATUSES). 0 disables
    // waiting entirely and fails on the first such response. Defaults to DEFAULT_RETRY_WAIT_MS.
    retryWaitMs?: number
    onRetry?: (notice: RetryNotice) => void
}

// Identify ourselves on every request, so feed operators can see who is calling and throttle or contact us
// rather than silently blocking an anonymous client. Overridable for operators behind a proxy that filters
// on agent strings.
function userAgent(): string {
    const fromEnv = process.env.SENTINELLO_USER_AGENT
    if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim()
    return 'sentinello (+https://sentinello.org)'
}

// Base headers for every feed request. Accept is deliberately permissive — these endpoints serve JSON,
// CSV, YAML, and zip archives — but stating it explicitly avoids content-negotiation surprises.
function baseHeaders(): Record<string, string> {
    return { 'User-Agent': userAgent(), Accept: '*/*' }
}

const DEFAULT_TIMEOUT_MS = 60_000
// Seeds are hundreds of megabytes over an arbitrary connection; generous but still bounded so a hung
// socket can never wedge a scan or a worker sync forever.
export const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000

// Combines the caller's cancellation with a request deadline. AbortSignal.any short-circuits if either
// fires, so a caller abort still cancels an in-flight download that has not yet hit its timeout.
function signalFor(options: FetchOptions | undefined, fallbackTimeoutMs: number): AbortSignal {
    const timeoutMs = options && options.timeoutMs || fallbackTimeoutMs
    const timeout = AbortSignal.timeout(timeoutMs)
    if (options && options.abortSignal) return AbortSignal.any([options.abortSignal, timeout])
    return timeout
}

export function errText(err: unknown): string {
    if (err instanceof Error) return err.message
    return String(err)
}

// Conventionally transient: the server is momentarily busy and clears in seconds.
function isFastTransientStatus(status: number): boolean {
    if (status === 408 || status === 425 || status === 429) return true
    return status >= 500 && status < 600
}

// GitLab answers 406 with an empty body to repository archive requests it declines. Two earlier attempts
// read this as a stateful, client-scoped block and tried to out-wait it — first on a 1s/3s/9s ladder, then
// on a 45s/60s/75s one with a three-minute budget. Both were wrong, and the second was wrong expensively:
// users sat through the full three minutes and still got "HTTP 406 after 4 attempts".
//
// What it actually is: load shedding on archive GENERATION, not a penalty aimed at the caller. The
// evidence that settles it — the rejection carries GitLab's own counters untouched (ratelimit-name
// throttle_unauthenticated_web, limit 500, observed 2) and lands in ~50ms with content-length 0, so
// nothing is being measured or generated; and a client that gets 406 for a moving ref can be served 200
// for a sha-addressed URL at the same instant, from the same IP, because the latter is a cache hit that
// never reaches origin. It was never about who was asking. It was about what was being asked for.
//
// So the fix belongs at the URL (see archiveUrl in gemnasium/feed.ts — sha-addressed, hence cacheable),
// and retrying here is only a thin cushion for a genuine blip. Keep the budget short: a request that is
// going to fail should say so while the user is still watching, and every retry into a shedding origin is
// one more request it has to shed.
function isSlowTransientStatus(status: number): boolean {
    return status === 406
}

const FAST_MAX_ATTEMPTS = 4
const RETRY_BASE_MS = 1000
const RETRY_FACTOR = 3

// Short on purpose. This absorbs a blip, it does not try to out-wait a shedding origin — that was the
// previous design and it just made the failure slower to discover. A caller who genuinely wants to wait
// can raise it via FetchOptions.retryWaitMs (the CLI exposes `--feed-wait`); 0 fails on the first
// rejection. The interactive retry prompt is what covers "I'd like to try that again" for everyone else.
export const DEFAULT_RETRY_WAIT_MS = 15_000

// ~2s, ~7s, ~15s from the first failure: enough spacing that a transient blip clears, short enough that
// the whole ladder finishes while the user is still looking at the terminal.
const SLOW_RETRY_WAITS_MS = [2_000, 5_000, 8_000]

function delay(ms: number): Promise<void> {
    return new Promise(function schedule(resolve) {
        setTimeout(resolve, ms)
    })
}

function retryBudgetMs(options: FetchOptions | undefined): number {
    if (options && typeof options.retryWaitMs === 'number' && options.retryWaitMs >= 0) return options.retryWaitMs
    return DEFAULT_RETRY_WAIT_MS
}

// Performs a request, retrying transient failures. Fast-transient statuses keep the short exponential
// ladder — a feed that is genuinely down should surface quickly rather than stall a scan. Slow-transient
// ones spend a wall-clock budget instead.
//
// Transport-agnostic so the fetch and node:https paths cannot drift into two different retry policies:
// `perform` issues one attempt and `discard` releases the body of one that will not be returned.
async function withRetry<T extends { status: number }>(
    describe: string,
    perform: (signal: AbortSignal) => Promise<T>,
    discard: (response: T) => Promise<void> | void,
    options: FetchOptions | undefined,
    timeoutMs: number
): Promise<T> {
    const budgetMs = retryBudgetMs(options)
    const startedAt = Date.now()
    // No initializer: the loop always runs, and every path that reaches the throw has assigned this first.
    let lastStatus: number
    let attempt = 0
    let fastAttempts = 0
    let slowAttempts = 0
    for (;;) {
        attempt++
        const response = await perform(signalFor(options, timeoutMs))
        const slow = isSlowTransientStatus(response.status)
        if (!slow && !isFastTransientStatus(response.status)) return response
        lastStatus = response.status
        // The body must be discarded or the connection is held open for the life of the process.
        await discard(response)
        if (options && options.abortSignal && options.abortSignal.aborted) break
        if (slow) {
            const elapsedMs = Date.now() - startedAt
            if (elapsedMs >= budgetMs) break
            // Clamped to what is left rather than skipped when it would overrun. Comparing the full nominal
            // wait against the budget discards the LAST probe — the late one most likely to find the block
            // cleared — because request latency alone pushes the sum a few hundred ms over.
            const nominalMs = SLOW_RETRY_WAITS_MS[Math.min(slowAttempts, SLOW_RETRY_WAITS_MS.length - 1)] as number
            const waitMs = Math.min(nominalMs, budgetMs - elapsedMs)
            slowAttempts++
            if (options && options.onRetry) options.onRetry({ status: lastStatus, attempt, waitMs, elapsedMs, budgetMs })
            await delay(waitMs)
            continue
        }
        fastAttempts++
        if (fastAttempts >= FAST_MAX_ATTEMPTS) break
        await delay(RETRY_BASE_MS * Math.pow(RETRY_FACTOR, fastAttempts - 1))
    }
    // The elapsed time is not decoration. Both ladders bottom out at four attempts, so "after 4 attempts"
    // alone cannot tell you whether a report came from the 13s fast path or the slow one — which is
    // exactly the ambiguity that made the 406 above look like a network fault for two rounds of fixes.
    const elapsedMs = Date.now() - startedAt
    throw new Error(
        describe + ' failed: HTTP ' + lastStatus +
        ' after ' + attempt + ' attempts over ' + Math.round(elapsedMs / 1000) + 's'
    )
}

async function fetchWithRetry(url: string, init: RequestInit, options: FetchOptions | undefined, timeoutMs: number): Promise<Response> {
    return await withRetry(
        describeMethod(init) + ' ' + url,
        function perform(signal): Promise<Response> {
            return fetch(url, { ...init, signal })
        },
        async function discard(response): Promise<void> {
            if (response.body) await response.body.cancel()
        },
        options,
        timeoutMs
    )
}

function describeMethod(init: RequestInit): string {
    return typeof init.method === 'string' && init.method.length > 0 ? init.method : 'GET'
}

const MAX_REDIRECTS = 5

type RawResponse = {
    status: number
    headers: IncomingMessage['headers']
    stream: IncomingMessage
}

// One download attempt over node:https, following redirects itself because node's client does not.
// See the header comment for why this cannot be `fetch`.
function openRawStream(url: string, signal: AbortSignal, redirectsLeft: number): Promise<RawResponse> {
    return new Promise(function attempt(resolve, reject) {
        const target = new URL(url)
        const send = target.protocol === 'http:' ? httpRequest : httpsRequest
        // agent: false — a fresh, unpooled connection per download. Node's global agent keeps sockets
        // alive for reuse, which is pointless for a one-shot CLI making one large transfer, and actively
        // harmful here: a pooled socket outlives the request that created it and can keep the process
        // alive after all the work is done.
        const request = send(target, { method: 'GET', headers: baseHeaders(), signal, agent: false }, function onResponse(response) {
            // IncomingMessage types statusCode as optional because the same class models SERVER-side
            // requests, which have none. On a client response node always sets it.
            const status = response.statusCode as number
            const location = response.headers.location
            if (status >= 300 && status < 400 && location) {
                // Drain rather than leave the socket half-read, then follow. A capped chain stops a
                // misconfigured mirror from looping forever.
                response.resume()
                if (redirectsLeft <= 0) {
                    reject(new Error('GET ' + url + ' exceeded ' + MAX_REDIRECTS + ' redirects'))
                    return
                }
                resolve(openRawStream(new URL(location, target).toString(), signal, redirectsLeft - 1))
                return
            }
            resolve({ status, headers: response.headers, stream: response })
        })
        request.on('error', reject)
        request.end()
    })
}

export type ConditionalResult =
    // The server confirmed our cached copy is current (HTTP 304) — nothing was transferred.
    | { status: 'unchanged' }
    | { status: 'ok'; body: string; etag: string | null; lastModified: string | null }

// Conditional GET for a text resource. This is what makes "sync on every scan" affordable: OSV's
// modified_id.csv is 8.4 MB, but an unchanged feed answers 304 with an empty body, so a repeat scan
// costs one round trip and no payload.
export async function getTextConditional(url: string, etag: string | null, options?: FetchOptions): Promise<ConditionalResult> {
    const headers = baseHeaders()
    if (etag) headers['If-None-Match'] = etag
    const response = await fetchWithRetry(url, { headers }, options, DEFAULT_TIMEOUT_MS)
    if (response.status === 304) return { status: 'unchanged' }
    if (!response.ok) throw new Error('GET ' + url + ' failed: HTTP ' + response.status)
    const body = await response.text()
    return {
        status: 'ok',
        body,
        etag: response.headers.get('etag'),
        lastModified: response.headers.get('last-modified')
    }
}

export async function getJson<T>(url: string, options?: FetchOptions): Promise<T> {
    const response = await fetchWithRetry(url, { headers: baseHeaders() }, options, DEFAULT_TIMEOUT_MS)
    if (!response.ok) throw new Error('GET ' + url + ' failed: HTTP ' + response.status)
    return (await response.json()) as T
}

// GET returning null on 404 instead of throwing. OSV advisories disappear upstream when withdrawn, and a
// gemnasium file can vanish between the compare call and the fetch; both are normal states, not failures.
export async function getJsonOrNull<T>(url: string, options?: FetchOptions): Promise<T | null> {
    const response = await fetchWithRetry(url, { headers: baseHeaders() }, options, DEFAULT_TIMEOUT_MS)
    if (response.status === 404) return null
    if (!response.ok) throw new Error('GET ' + url + ' failed: HTTP ' + response.status)
    return (await response.json()) as T
}

export async function getTextOrNull(url: string, options?: FetchOptions): Promise<string | null> {
    const response = await fetchWithRetry(url, { headers: baseHeaders() }, options, DEFAULT_TIMEOUT_MS)
    if (response.status === 404) return null
    if (!response.ok) throw new Error('GET ' + url + ' failed: HTTP ' + response.status)
    return await response.text()
}

export type RemoteFileInfo = {
    contentLength: number | null
    lastModified: string | null
    etag: string | null
}

// HEAD a large download so the caller can show a real byte count in a consent prompt and pre-flight free
// space, rather than asking the operator to approve an unknown quantity.
export async function headFile(url: string, options?: FetchOptions): Promise<RemoteFileInfo> {
    const response = await fetchWithRetry(url, { method: 'HEAD', headers: baseHeaders() }, options, DEFAULT_TIMEOUT_MS)
    if (!response.ok) throw new Error('HEAD ' + url + ' failed: HTTP ' + response.status)
    const raw = response.headers.get('content-length')
    const parsed = raw === null ? NaN : Number(raw)
    return {
        contentLength: Number.isFinite(parsed) ? parsed : null,
        lastModified: response.headers.get('last-modified'),
        etag: response.headers.get('etag')
    }
}

export type DownloadStream = {
    stream: Readable
    contentLength: number | null
    lastModified: string | null
}

export type ProgressReporter = (bytesRead: number, totalBytes: number | null) => void

// Opens a streaming download as a Node readable, optionally reporting progress as bytes arrive. The
// stream is consumed incrementally by the zip parsers, so memory stays bounded regardless of archive size.
//
// node:https rather than fetch — see the header comment. The response IS already a Node readable here, so
// this path also drops the Readable.fromWeb conversion the fetch version needed.
export async function openDownloadStream(url: string, onProgress?: ProgressReporter, options?: FetchOptions): Promise<DownloadStream> {
    const response = await withRetry(
        'GET ' + url,
        function perform(signal): Promise<RawResponse> {
            return openRawStream(url, signal, MAX_REDIRECTS)
        },
        function discard(raw): void {
            raw.stream.resume()
        },
        options,
        DOWNLOAD_TIMEOUT_MS
    )
    if (response.status < 200 || response.status >= 300) {
        response.stream.resume()
        throw new Error('GET ' + url + ' failed: HTTP ' + response.status)
    }
    const rawLength = response.headers['content-length']
    const parsedLength = rawLength === undefined ? NaN : Number(rawLength)
    const contentLength = Number.isFinite(parsedLength) ? parsedLength : null
    const stream = response.stream
    if (onProgress) {
        let bytesRead = 0
        stream.on('data', function countChunk(chunk: Buffer): void {
            bytesRead += chunk.length
            onProgress(bytesRead, contentLength)
        })
    }
    return { stream, contentLength, lastModified: response.headers['last-modified'] ?? null }
}
