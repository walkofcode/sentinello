import { errText } from '@sentinello/core'
import { baseHeaders } from '../http'

// The one GET every package-registry client makes: the shared user-agent, a timeout, the caller's abort
// signal, an optional ETag validator, and no retries. The scan path must not stall on a registry outage,
// and a failure is never cached by the callers, so the next scan simply asks again.

// The scan path pays this at most once per package per cache window; a registry slower than this is treated
// as unreachable for the scan, which degrades the fix to "not checked", never fails the scan.
export const REGISTRY_TIMEOUT_MS = 15_000

export type RegistryFetchOptions = {
    // The registry's base URL; the env override (or the public registry) when absent.
    registryUrl?: string
    timeoutMs?: number
    abortSignal?: AbortSignal
    // The ETag of the answer already held. Sent as If-None-Match; a 304 then confirms that answer.
    ifNoneMatch?: string | null
}

// What a registry said about one package, reduced to the summary its client keeps. `etag` is the registry's
// validator for it (null when it sent none); `not_modified` answers a request that sent `ifNoneMatch`.
export type RegistryResult<S> =
    | { status: 'ok'; summary: S; etag: string | null }
    | { status: 'not_modified'; etag: string | null }
    | { status: 'not_found' }
    | { status: 'error'; reason: string }

// `bytes` is the size of the body as read, after any transfer compression is undone.
export type RegistryBody<T> =
    | { status: 'ok'; body: T; bytes: number; etag: string | null }
    | { status: 'not_modified'; etag: string | null }
    | { status: 'not_found' }
    | { status: 'error'; reason: string }

export type RegistryBodySpec<T> = {
    accept: string
    // What the body is, for the error that says it could not be read ("packument", "index file").
    what: string
    // The statuses that mean "no such package" on this registry; every other non-200 is an error.
    notFound: readonly number[]
    // Turns the body text into what the caller reads. A throw is an unreadable body.
    parse: (text: string) => T
}

// A JSON body, parsed on arrival.
export function jsonBody(what: string, notFound: readonly number[]): RegistryBodySpec<unknown> {
    return { accept: 'application/json', what, notFound, parse: function parse(text) { return JSON.parse(text) as unknown } }
}

// Plain text, read as it is.
export function textBody(what: string, notFound: readonly number[]): RegistryBodySpec<string> {
    return { accept: 'text/plain', what, notFound, parse: function asText(text) { return text } }
}

// Plumbing, not a setting: mirrors and the test stub point a registry elsewhere through its env variable.
// There is deliberately no UI switch for registry lookups (they are part of what makes a fix version true).
export function registryBaseUrl(envName: string, fallback: string): string {
    const fromEnv = process.env[envName]
    const raw = fromEnv && fromEnv.trim().length > 0 ? fromEnv.trim() : fallback
    return raw.replace(/\/+$/, '')
}

// One GET. A non-200 is answered from the status line alone; its body is only released, never read —
// reading it could stall or fail after the headers (a proxy that sends a 503 and hangs) and would throw
// past every fallback. Only a conditional request can be answered "not modified": a 304 to a plain GET is
// a broken server, and is an error like any other unexpected status.
export async function getRegistryBody<T>(url: string, options: RegistryFetchOptions | undefined, spec: RegistryBodySpec<T>): Promise<RegistryBody<T>> {
    const validator = options?.ifNoneMatch ?? null
    const timeout = AbortSignal.timeout(options?.timeoutMs ?? REGISTRY_TIMEOUT_MS)
    const signal = options?.abortSignal ? AbortSignal.any([options.abortSignal, timeout]) : timeout
    const headers: Record<string, string> = { ...baseHeaders(), Accept: spec.accept }
    if (validator !== null) headers['If-None-Match'] = validator
    let response: Response
    try {
        response = await fetch(url, { headers, signal })
    } catch (err) {
        return { status: 'error', reason: errorReason(err) }
    }
    const etag = response.headers.get('etag')
    if (response.status !== 200) {
        await discardBody(response)
        if (response.status === 304 && validator !== null) return { status: 'not_modified', etag }
        return spec.notFound.includes(response.status) ? { status: 'not_found' } : { status: 'error', reason: 'HTTP ' + response.status }
    }
    try {
        const bytes = new Uint8Array(await response.arrayBuffer())
        return { status: 'ok', body: spec.parse(new TextDecoder().decode(bytes)), bytes: bytes.byteLength, etag }
    } catch (err) {
        return { status: 'error', reason: 'unreadable ' + spec.what + ': ' + errorReason(err) }
    }
}

// Releases an unread body without waiting for it. Cancelling cannot meaningfully fail here, and nothing
// about the answer depends on it, so its rejection is deliberately ignored.
async function discardBody(response: Response): Promise<void> {
    await response.body?.cancel().catch(function ignore() { return undefined })
}

// fetch throws `TypeError: fetch failed` and keeps the reason (ECONNREFUSED, a DNS failure, a timeout)
// in `cause`, which is the part worth recording.
export function errorReason(err: unknown): string {
    const cause = (err as { cause?: unknown }).cause
    return cause === undefined ? errText(err) : errText(err) + ': ' + errText(cause)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}
