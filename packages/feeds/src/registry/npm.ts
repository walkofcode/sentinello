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

export type NpmPackageSummary = {
    v: 1
    name: string
    latest: string | null
    modified: number | null
    maintainers: number
    repository: string | null
    // Non-prerelease versions only — a prerelease is never offered as a fix or an escape.
    versions: Record<string, NpmVersionSummary>
    edges: NpmEdges[]
}

export type NpmPackageResult =
    | { status: 'ok'; summary: NpmPackageSummary }
    | { status: 'not_found' }
    | { status: 'error'; reason: string }

export type FetchNpmPackageOptions = {
    registryUrl?: string
    timeoutMs?: number
    abortSignal?: AbortSignal
}

// `@scope/name` travels as `@scope%2Fname`; the registry routes the encoded form.
export function npmPackageUrl(registryUrl: string, name: string): string {
    return registryUrl + '/' + encodeURIComponent(name).replace(/^%40/, '@')
}

export async function fetchNpmPackage(name: string, options?: FetchNpmPackageOptions): Promise<NpmPackageResult> {
    const url = npmPackageUrl(options?.registryUrl ?? npmRegistryUrl(), name)
    const timeout = AbortSignal.timeout(options?.timeoutMs ?? NPM_REGISTRY_TIMEOUT_MS)
    const signal = options?.abortSignal ? AbortSignal.any([options.abortSignal, timeout]) : timeout
    let response: Response
    try {
        // No retries: the scan path must not stall on a registry outage, and a failure is never cached,
        // so the next scan asks again.
        response = await fetch(url, { headers: { ...baseHeaders(), Accept: 'application/json' }, signal })
    } catch (err) {
        return { status: 'error', reason: errorReason(err) }
    }
    if (response.status === 404) {
        await response.arrayBuffer()
        return { status: 'not_found' }
    }
    if (response.status !== 200) {
        await response.arrayBuffer()
        return { status: 'error', reason: 'HTTP ' + response.status }
    }
    let body: unknown
    try {
        body = await response.json()
    } catch (err) {
        return { status: 'error', reason: 'unreadable packument: ' + errorReason(err) }
    }
    const summary = summarizePackument(name, body)
    if (summary === null) return { status: 'error', reason: 'packument has no versions map' }
    return { status: 'ok', summary }
}

// fetch throws `TypeError: fetch failed` and keeps the reason (ECONNREFUSED, a DNS failure, a timeout)
// in `cause`, which is the part worth recording.
function errorReason(err: unknown): string {
    const cause = (err as { cause?: unknown }).cause
    return cause === undefined ? errText(err) : errText(err) + ': ' + errText(cause)
}

// A full release version: three numeric parts, no prerelease tag (build metadata allowed). Prereleases
// are dropped here, once, so nothing downstream can offer one.
const RELEASE_VERSION_RE = /^v?\d+\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?$/

// Reduces a packument to the summary. Null when the body is not a packument at all (no versions map); a
// malformed field inside one is dropped rather than failing the package.
export function summarizePackument(name: string, body: unknown): NpmPackageSummary | null {
    if (!isRecord(body) || !isRecord(body.versions)) return null
    const time = isRecord(body.time) ? body.time : {}
    const edges: NpmEdges[] = []
    const edgeIndex = new Map<string, number>()
    const versions: Record<string, NpmVersionSummary> = {}
    for (const [version, manifest] of Object.entries(body.versions)) {
        if (!RELEASE_VERSION_RE.test(version)) continue
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
        versions[version] = {
            publishedAt: timestamp(time[version]),
            deprecated: typeof m.deprecated === 'string' && m.deprecated.length > 0 ? m.deprecated : null,
            edges: index
        }
    }
    const distTags = isRecord(body['dist-tags']) ? body['dist-tags'] : {}
    return {
        v: 1,
        name,
        latest: typeof distTags.latest === 'string' ? distTags.latest : null,
        modified: timestamp(time.modified),
        maintainers: Array.isArray(body.maintainers) ? body.maintainers.length : 0,
        repository: repositoryOf(body.repository),
        versions,
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
