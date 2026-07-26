import { Readable } from 'node:stream'

// Network primitives shared by the OSV and gemnasium feeds.
//
// These use the runtime's built-in `fetch` rather than axios — a deliberate, scoped exception to the
// project-wide axios rule. This package is bundled into the published CLI, where the goal is zero declared
// runtime dependencies; axios would pull `follow-redirects`, `form-data`, and `proxy-from-env` into that
// bundle to do what `fetch` already does natively, streaming included via `Readable.fromWeb`. The worker
// and portal keep axios everywhere else.

export type FetchOptions = {
    abortSignal?: AbortSignal
    timeoutMs?: number
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

// Statuses worth retrying. Observed in practice: GitLab intermittently answers 406 to the archive download
// (abuse throttling — the identical request succeeds moments later), which would otherwise abandon the
// gemnasium seed for the whole run and leave the source silently unauditable. 429 and 5xx are the
// conventional transient set.
function isTransientStatus(status: number): boolean {
    if (status === 406 || status === 408 || status === 425 || status === 429) return true
    return status >= 500 && status < 600
}

// Backoff is exponential and deliberately generous. GitLab's throttle window on the archive endpoint
// outlasts a short linear backoff: a first run that seeds OSV and then immediately requests the gemnasium
// archive — the exact default sequence — was observed failing all attempts across ~2s of retries and
// succeeding on a later run. 1s, 3s, then 9s clears it while still giving up inside ~13s when a feed is
// genuinely down, rather than stalling someone's terminal.
const MAX_ATTEMPTS = 4
const RETRY_BASE_MS = 1000
const RETRY_FACTOR = 3

function delay(ms: number): Promise<void> {
    return new Promise(function schedule(resolve) {
        setTimeout(resolve, ms)
    })
}

// Performs a request, retrying transient failures with linear backoff. Retries are deliberately few and
// short: a feed that is genuinely down should surface quickly as a degraded source rather than stall a
// developer's scan.
async function fetchWithRetry(url: string, init: RequestInit, options: FetchOptions | undefined, timeoutMs: number): Promise<Response> {
    let lastStatus = 0
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const response = await fetch(url, { ...init, signal: signalFor(options, timeoutMs) })
        if (!isTransientStatus(response.status)) return response
        lastStatus = response.status
        // The body must be discarded or the connection is held open for the life of the process.
        if (response.body) await response.body.cancel()
        if (attempt === MAX_ATTEMPTS) break
        if (options && options.abortSignal && options.abortSignal.aborted) break
        await delay(RETRY_BASE_MS * Math.pow(RETRY_FACTOR, attempt - 1))
    }
    throw new Error(describeMethod(init) + ' ' + url + ' failed: HTTP ' + lastStatus + ' after ' + MAX_ATTEMPTS + ' attempts')
}

function describeMethod(init: RequestInit): string {
    return typeof init.method === 'string' && init.method.length > 0 ? init.method : 'GET'
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
export async function openDownloadStream(url: string, onProgress?: ProgressReporter, options?: FetchOptions): Promise<DownloadStream> {
    const response = await fetchWithRetry(url, { headers: baseHeaders() }, options, DOWNLOAD_TIMEOUT_MS)
    if (!response.ok) throw new Error('GET ' + url + ' failed: HTTP ' + response.status)
    if (!response.body) throw new Error('GET ' + url + ' returned no body')
    const rawLength = response.headers.get('content-length')
    const parsedLength = rawLength === null ? NaN : Number(rawLength)
    const contentLength = Number.isFinite(parsedLength) ? parsedLength : null
    const stream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
    if (onProgress) {
        let bytesRead = 0
        stream.on('data', function countChunk(chunk: Buffer): void {
            bytesRead += chunk.length
            onProgress(bytesRead, contentLength)
        })
    }
    return { stream, contentLength, lastModified: response.headers.get('last-modified') }
}
