import { errText } from '@sentinello/core'
import { baseHeaders } from '../http'

// The npm registry, read for one purpose: which versions of a package were actually published, so a fix
// version is a fact rather than arithmetic on a range. Uses `fetch` and nothing else, like the rest of
// this package, so it stays safe to bundle into the zero-dependency CLI.
//
// One full packument per package (`GET {registry}/{name}`), reduced on arrival to a summary that keeps
// only what Sentinello reads: per release, its publish time, deprecation notice and dependency edges —
// the edges are for the transitive "does this release still reach the vulnerable package" proofs — and
// the package's latest tag, last modification, maintainer count and repository. A packument can run to
// tens of megabytes (next, @next/eslint-plugin-next); the summary is what gets cached.
//
// The registry answers a conditional GET: sent the ETag of a packument already summarized, it replies 304
// with no body when nothing changed (probed against registry.npmjs.org, 2026-10-04). That is what keeps the
// daily refresh of an expired cache cheap — most packages publish nothing in a day.

export const DEFAULT_NPM_REGISTRY_URL = 'https://registry.npmjs.org'

// The scan path pays this at most once per package per cache window; a registry slower than this is
// treated as unreachable for the scan, which degrades the fix to "not checked", never fails the scan.
export const NPM_REGISTRY_TIMEOUT_MS = 15_000

// Plumbing, not a setting: mirrors and the test stub point it elsewhere. There is deliberately no UI
// switch for registry lookups (they are part of what makes a fix version true).
export function npmRegistryUrl(): string {
    const fromEnv = process.env.SENTINELLO_NPM_REGISTRY_URL
    const raw = fromEnv && fromEnv.trim().length > 0 ? fromEnv.trim() : DEFAULT_NPM_REGISTRY_URL
    return raw.replace(/\/+$/, '')
}

// A dependency edge set as one release declares it. Optional peers are listed by name, since npm installs
// a peer only when something else asks for it; the proofs still follow them, because an escape that holds
// only while an optional peer is absent is not an escape.
export type NpmEdges = {
    dependencies: Record<string, string>
    optionalDependencies: Record<string, string>
    peerDependencies: Record<string, string>
    optionalPeers: string[]
}

export type NpmVersionSummary = {
    // Epoch ms from the packument's `time` map; null when the registry does not say.
    publishedAt: number | null
    // The deprecation message, null when the release is not deprecated.
    deprecated: string | null
    // Index into NpmPackageSummary.edges, null when the release declares no edges at all. Interned: most
    // consecutive releases declare identical maps, and a large packument repeats them hundreds of times.
    edges: number | null
}

// v2 added `prereleases`. A v1 summary (cached before) lacks them and is read as no summary at all, so it is
// refetched in full: revalidating it with its ETag would have the registry confirm an incomplete summary.
export type NpmPackageSummary = {
    v: 2
    name: string
    latest: string | null
    modified: number | null
    maintainers: number
    repository: string | null
    // Non-prerelease versions only — a prerelease is never offered as a fix or an escape.
    versions: Record<string, NpmVersionSummary>
    // Prerelease versions, each with its index into `edges` (null: no edges). Kept only so the transitive
    // proofs resolve a dependency range the way npm does when only a prerelease satisfies it — gensync has
    // never published anything but 1.0.0-beta.x, and @jest/core requires gensync@^1.0.0-beta.2.
    prereleases: Record<string, number | null>
    edges: NpmEdges[]
}

// `etag` is the registry's validator for this packument (null when it sent none); `bytes` is the size of the
// body as read, after any transfer compression is undone. `not_modified` answers a request that sent
// `ifNoneMatch`: the packument behind that ETag is still current.
export type NpmPackageResult =
    | { status: 'ok'; summary: NpmPackageSummary; etag: string | null; bytes: number }
    | { status: 'not_modified'; etag: string | null }
    | { status: 'not_found' }
    | { status: 'error'; reason: string }

export type FetchNpmPackageOptions = {
    registryUrl?: string
    timeoutMs?: number
    abortSignal?: AbortSignal
}

// A packument request may be conditional: `ifNoneMatch` is the ETag of the summary already held.
export type FetchNpmPackumentOptions = FetchNpmPackageOptions & { ifNoneMatch?: string | null }

// `@scope/name` travels as `@scope%2Fname`; the registry routes the encoded form.
export function npmPackageUrl(registryUrl: string, name: string): string {
    return registryUrl + '/' + encodeName(name)
}

function encodeName(name: string): string {
    return encodeURIComponent(name).replace(/^%40/, '@')
}

type Failure = { status: 'not_found' } | { status: 'error'; reason: string }
type JsonResult = { status: 'ok'; body: unknown; bytes: number } | Failure

// One GET with the shared user-agent, a timeout and no retries: the scan path must not stall on a registry
// outage, and a failure is never cached, so the next scan asks again.
async function request(url: string, options: FetchNpmPackageOptions | undefined, headers: Record<string, string>): Promise<Response | { status: 'error'; reason: string }> {
    const timeout = AbortSignal.timeout(options?.timeoutMs ?? NPM_REGISTRY_TIMEOUT_MS)
    const signal = options?.abortSignal ? AbortSignal.any([options.abortSignal, timeout]) : timeout
    try {
        return await fetch(url, { headers: { ...baseHeaders(), Accept: 'application/json', ...headers }, signal })
    } catch (err) {
        return { status: 'error', reason: errorReason(err) }
    }
}

// A 404 or another status is answered from the status line alone; its body is only released, never read —
// reading it could stall or fail after the headers (a proxy that sends a 503 and hangs) and would throw
// past every fallback.
async function readJson(response: Response, what: string): Promise<JsonResult> {
    if (response.status !== 200) {
        await discardBody(response)
        return response.status === 404 ? { status: 'not_found' } : { status: 'error', reason: 'HTTP ' + response.status }
    }
    try {
        const body = new Uint8Array(await response.arrayBuffer())
        return { status: 'ok', body: JSON.parse(new TextDecoder().decode(body)), bytes: body.byteLength }
    } catch (err) {
        return { status: 'error', reason: 'unreadable ' + what + ': ' + errorReason(err) }
    }
}

async function getJson(url: string, options: FetchNpmPackageOptions | undefined, what: string): Promise<JsonResult> {
    const response = await request(url, options, {})
    return response instanceof Response ? readJson(response, what) : response
}

export async function fetchNpmPackage(name: string, options?: FetchNpmPackumentOptions): Promise<NpmPackageResult> {
    const validator = options?.ifNoneMatch ?? null
    const response = await request(npmPackageUrl(options?.registryUrl ?? npmRegistryUrl(), name), options, validator === null ? {} : { 'If-None-Match': validator })
    if (!(response instanceof Response)) return response
    const etag = response.headers.get('etag')
    // Only a conditional request can be answered "not modified"; a 304 to a plain GET is a broken server,
    // and falls through to the status check as an error like any other unexpected status.
    if (response.status === 304 && validator !== null) {
        await discardBody(response)
        return { status: 'not_modified', etag }
    }
    const result = await readJson(response, 'packument')
    if (result.status !== 'ok') return result
    const summary = summarizePackument(name, result.body)
    if (summary === null) return { status: 'error', reason: 'packument has no versions map' }
    return { status: 'ok', summary, etag, bytes: result.bytes }
}

// Releases an unread body without waiting for it. Cancelling cannot meaningfully fail here, and nothing
// about the answer depends on it, so its rejection is deliberately ignored.
async function discardBody(response: Response): Promise<void> {
    await response.body?.cancel().catch(function ignore() { return undefined })
}

export const DEFAULT_NPM_DOWNLOADS_URL = 'https://api.npmjs.org'

// npm's download counts live on a separate service from the registry, and a registry mirror does not serve
// them. Same plumbing rule as the registry URL: env-only, for tests and unusual networks.
export function npmDownloadsUrl(): string {
    const fromEnv = process.env.SENTINELLO_NPM_DOWNLOADS_URL
    const raw = fromEnv && fromEnv.trim().length > 0 ? fromEnv.trim() : DEFAULT_NPM_DOWNLOADS_URL
    return raw.replace(/\/+$/, '')
}

export type NpmDownloadsResult =
    | { status: 'ok'; weeklyDownloads: number }
    | { status: 'not_found' }
    | { status: 'error'; reason: string }

// Last week's download count for one package (`GET {api}/downloads/point/last-week/{name}`). A signal shown
// beside a package, never an input to a verdict.
export async function fetchNpmWeeklyDownloads(name: string, options?: FetchNpmPackageOptions): Promise<NpmDownloadsResult> {
    const result = await getJson((options?.registryUrl ?? npmDownloadsUrl()) + '/downloads/point/last-week/' + encodeName(name), options, 'download count')
    if (result.status !== 'ok') return result
    const downloads = isRecord(result.body) ? result.body.downloads : undefined
    if (typeof downloads !== 'number' || !Number.isFinite(downloads) || downloads < 0) return { status: 'error', reason: 'download count missing' }
    return { status: 'ok', weeklyDownloads: downloads }
}

// fetch throws `TypeError: fetch failed` and keeps the reason (ECONNREFUSED, a DNS failure, a timeout)
// in `cause`, which is the part worth recording.
function errorReason(err: unknown): string {
    const cause = (err as { cause?: unknown }).cause
    return cause === undefined ? errText(err) : errText(err) + ': ' + errText(cause)
}

// A full release version: three numeric parts, no prerelease tag (build metadata allowed). Prereleases
// are kept apart here, once, so nothing downstream can offer one.
const RELEASE_VERSION_RE = /^v?\d+\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?$/
const PRERELEASE_VERSION_RE = /^v?\d+\.\d+\.\d+-[0-9A-Za-z.-]+(?:\+[0-9A-Za-z.-]+)?$/

// Reduces a packument to the summary. Null when the body is not a packument at all (no versions map); a
// malformed field inside one is dropped rather than failing the package.
export function summarizePackument(name: string, body: unknown): NpmPackageSummary | null {
    if (!isRecord(body) || !isRecord(body.versions)) return null
    const time = isRecord(body.time) ? body.time : {}
    const edges: NpmEdges[] = []
    const edgeIndex = new Map<string, number>()
    const versions: Record<string, NpmVersionSummary> = {}
    const prereleases: Record<string, number | null> = {}
    for (const [version, manifest] of Object.entries(body.versions)) {
        const release = RELEASE_VERSION_RE.test(version)
        if (!release && !PRERELEASE_VERSION_RE.test(version)) continue
        const m = isRecord(manifest) ? manifest : {}
        const edgeSet = edgesOf(m)
        let index: number | null = null
        if (edgeSet !== null) {
            const key = JSON.stringify(edgeSet)
            const known = edgeIndex.get(key)
            if (known !== undefined) {
                index = known
            } else {
                index = edges.length
                edges.push(edgeSet)
                edgeIndex.set(key, index)
            }
        }
        if (!release) {
            prereleases[version] = index
            continue
        }
        versions[version] = {
            publishedAt: timestamp(time[version]),
            deprecated: typeof m.deprecated === 'string' && m.deprecated.length > 0 ? m.deprecated : null,
            edges: index
        }
    }
    const distTags = isRecord(body['dist-tags']) ? body['dist-tags'] : {}
    return {
        v: 2,
        name,
        latest: typeof distTags.latest === 'string' ? distTags.latest : null,
        modified: timestamp(time.modified),
        maintainers: Array.isArray(body.maintainers) ? body.maintainers.length : 0,
        repository: repositoryOf(body.repository),
        versions,
        prereleases,
        edges
    }
}

function edgesOf(manifest: Record<string, unknown>): NpmEdges | null {
    const dependencies = stringMap(manifest.dependencies)
    const optionalDependencies = stringMap(manifest.optionalDependencies)
    const peerDependencies = stringMap(manifest.peerDependencies)
    const meta = isRecord(manifest.peerDependenciesMeta) ? manifest.peerDependenciesMeta : {}
    const optionalPeers = Object.keys(meta).filter(function isOptional(peer) {
        const entry = meta[peer]
        return isRecord(entry) && entry.optional === true
    }).sort()
    const empty = Object.keys(dependencies).length === 0 && Object.keys(optionalDependencies).length === 0 &&
        Object.keys(peerDependencies).length === 0
    if (empty) return null
    return { dependencies, optionalDependencies, peerDependencies, optionalPeers }
}

// Keys sorted so two identical maps written in a different order intern to one entry.
function stringMap(value: unknown): Record<string, string> {
    if (!isRecord(value)) return {}
    const out: Record<string, string> = {}
    for (const key of Object.keys(value).sort()) {
        const range = value[key]
        if (typeof range === 'string') out[key] = range
    }
    return out
}

function timestamp(value: unknown): number | null {
    if (typeof value !== 'string') return null
    const at = Date.parse(value)
    return Number.isNaN(at) ? null : at
}

function repositoryOf(value: unknown): string | null {
    if (typeof value === 'string' && value.length > 0) return value
    if (isRecord(value) && typeof value.url === 'string' && value.url.length > 0) return value.url
    return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}
