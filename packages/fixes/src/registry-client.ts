import { errText } from '@sentinello/core'
import { fetchNpmPackage, fetchNpmWeeklyDownloads, type NpmDownloadsResult, type NpmPackageResult, type NpmPackageSummary, type RegistryResult } from '@sentinello/feeds'

// A package registry as the worker reads it: cache first, the network only on a miss. One cached client
// per registry — npm, PyPI, crates.io, Go, RubyGems — built from the one core here (createCachedRegistry),
// so a package is fetched at most once per scan and at most once per freshness window across scans. Where
// the cache lives is the caller's: a client reads and writes it only through a RegistryStore.
//
// One set of clients serves the whole worker batch (runBatch creates it), so each client's limits are the
// worker's, per registry:
//   - at most REGISTRY_FETCH_CONCURRENCY requests in flight, across every project being scanned;
//   - a package already being fetched is joined, never fetched a second time.
//
// Cache policy:
//   - an 'ok' or 'not_found' answer is fresh for REGISTRY_FRESH_MS; after that the next scan that needs
//     the package refetches it — conditionally, when the row has the registry's ETag: a 304 confirms the
//     cached summary, which is then served as fetched now, without downloading the package again;
//   - a failed fetch is never cached, and never deletes what is there: a stale 'ok' row is served instead,
//     marked 'stale', so the finding says how old its data is rather than pretending it is current.
//
// npm's client is the richer one: its summary also feeds the way out, and it reads weekly downloads.

export const REGISTRY_FRESH_MS = 24 * 60 * 60 * 1000
// Measured on the 157-project scratch fleet, cold cache (2026-10-04): post-scan 109.8 s at 4, 94.8 s at 8,
// 86.7 s at 16, with no 429 or 5xx from registry.npmjs.org at any of them. The fastest is kept.
export const REGISTRY_FETCH_CONCURRENCY = 16

// One cached answer, as a store keeps it. `summaryJson` is the registry's reduced answer for 'ok' (parsed
// by the client, which owns its shape — a packument summary for npm, the published summary elsewhere) and
// null for 'not_found'; `etag` is the registry's validator for it, null when there is none. The download
// count is a separate, rarer npm fetch, recorded beside the answer.
export type RegistryRow = {
    name: string
    status: 'ok' | 'not_found'
    summaryJson: string | null
    checkedAt: number
    etag: string | null
    weeklyDownloads: number | null
    downloadsCheckedAt: number | null
}

// Where a client keeps its answers, for one registry. The worker's store is the registry_packages table,
// keyed by ecosystem; the CLI's is a file in its cache directory (npm only). Contract:
//   - get: the stored row for each name it has; a name it does not have is absent from the result;
//   - put: records an answer ('ok' or 'not_found', or an 'ok' the registry confirmed with a 304), leaving
//     any download count as it is. Only ever called with an answer: a failed fetch is not one, so the last
//     good row survives it;
//   - setDownloads: records a count beside an existing answer; a name with no row is left alone.
export type RegistryStore = {
    get(names: readonly string[]): Map<string, RegistryRow>
    put(row: Omit<RegistryRow, 'weeklyDownloads' | 'downloadsCheckedAt'>): void
    setDownloads(name: string, weeklyDownloads: number, checkedAt: number): void
}

// One package's answer as served to a reader, with where it came from. `checkedAt` is when the registry
// gave the data that is being served — not when it was served.
export type CachedEntry<S> =
    | { status: 'ok'; summary: S; checkedAt: number; origin: 'fetched' | 'cache' }
    | { status: 'stale'; summary: S; checkedAt: number; reason: string }
    | { status: 'not_found'; checkedAt: number; origin: 'fetched' | 'cache' }
    | { status: 'error'; reason: string }

// npm's, which the way out reads too.
export type RegistryEntry = CachedEntry<NpmPackageSummary>

export type RegistryClient = {
    lookup(names: readonly string[]): Promise<Map<string, RegistryEntry>>
    // Last week's downloads per package; null when the count could not be had. A signal for the reader,
    // never an input to a verdict, so a failure is not an error here.
    weeklyDownloads(names: readonly string[]): Promise<Map<string, number | null>>
}

// What one package request carries: the ETag of the cached summary, when there is one to revalidate.
export type PackumentRequest = { ifNoneMatch: string | null; abortSignal?: AbortSignal }

// How one registry is read and its answer cached. `parse` reads a cached summary back, null when it is not
// one this client can use (it is then refetched in full, never revalidated). `keep` is what a fresh answer
// carries over from the summary it replaces (Go's per-version checks); without it the fresh answer stands
// alone.
export type CachedRegistrySpec<S> = {
    fetch: (name: string, request: PackumentRequest) => Promise<RegistryResult<S>>
    parse: (json: string | null) => S | null
    keep?: (fetched: S, held: S) => S
}

export type CachedRegistryOptions = {
    now?: () => number
    abortSignal?: AbortSignal
    // Requests in flight at once; REGISTRY_FETCH_CONCURRENCY unless a measurement run sets it.
    concurrency?: number
}

export type Limiter = <T>(work: () => Promise<T>) => Promise<T>

// The core every registry client is built from. `limit` and `now` are handed back so a client can run its
// own extra requests (npm's download counts, Go's version checks) under the same limit and clock.
export type CachedRegistry<S> = {
    lookup(names: readonly string[]): Promise<Map<string, CachedEntry<S>>>
    limit: Limiter
    now: () => number
}

export function createCachedRegistry<S>(store: RegistryStore, spec: CachedRegistrySpec<S>, options?: CachedRegistryOptions): CachedRegistry<S> {
    const now = options?.now ?? Date.now
    const limit = createLimiter(options?.concurrency ?? REGISTRY_FETCH_CONCURRENCY)
    const inFlight = new Map<string, Promise<CachedEntry<S>>>()

    function refresh(name: string, previous: RegistryRow | undefined): Promise<CachedEntry<S>> {
        const running = inFlight.get(name)
        if (running) return running
        // Only a summary this client can still read is worth revalidating: a 304 hands it back as current.
        const held = previous && previous.status === 'ok' ? spec.parse(previous.summaryJson) : null
        const ifNoneMatch = held !== null && previous ? previous.etag : null
        const started = limit(async function fetchOne(): Promise<CachedEntry<S>> {
            let result: RegistryResult<S>
            try {
                result = await spec.fetch(name, { ifNoneMatch, abortSignal: options?.abortSignal })
            } catch (err) {
                // The fetcher is meant to answer, not throw; if one does, it is an answer of "error".
                result = { status: 'error', reason: errText(err) }
            }
            return settleFetch(store, spec, name, result, now(), previous, held)
        }).finally(function forget() {
            inFlight.delete(name)
        })
        inFlight.set(name, started)
        return started
    }

    return {
        limit,
        now,
        lookup: async function lookup(names): Promise<Map<string, CachedEntry<S>>> {
            const unique = [...new Set(names)]
            const at = now()
            const cached = store.get(unique)
            const out = new Map<string, CachedEntry<S>>()
            const pending: Promise<void>[] = []
            for (const name of unique) {
                const row = cached.get(name)
                const entry = row && row.checkedAt >= at - REGISTRY_FRESH_MS ? fromCache(row, spec) : null
                if (entry) {
                    out.set(name, entry)
                    continue
                }
                pending.push(refresh(name, row).then(function store(served) {
                    out.set(name, served)
                }))
            }
            await Promise.all(pending)
            return out
        }
    }
}

export type NpmRegistryClientOptions = CachedRegistryOptions & {
    fetchPackage?: (name: string, request: PackumentRequest) => Promise<NpmPackageResult>
    fetchDownloads?: (name: string, abortSignal?: AbortSignal) => Promise<NpmDownloadsResult>
}

export function createNpmRegistryClient(store: RegistryStore, options?: NpmRegistryClientOptions): RegistryClient {
    const fetchPackage = options?.fetchPackage ?? function fetchLive(name: string, request: PackumentRequest) {
        return fetchNpmPackage(name, request)
    }
    const fetchDownloads = options?.fetchDownloads ?? function fetchLiveDownloads(name: string, abortSignal?: AbortSignal) {
        return fetchNpmWeeklyDownloads(name, { abortSignal })
    }
    const registry = createCachedRegistry(store, { fetch: fetchPackage, parse: parseSummary }, options)
    const { limit, now } = registry
    const downloadsInFlight = new Map<string, Promise<number | null>>()

    function countOf(name: string): Promise<number | null> {
        const running = downloadsInFlight.get(name)
        if (running) return running
        const started = limit(async function fetchCount(): Promise<number | null> {
            let result: NpmDownloadsResult
            try {
                result = await fetchDownloads(name, options?.abortSignal)
            } catch {
                return null
            }
            if (result.status !== 'ok') return null
            store.setDownloads(name, result.weeklyDownloads, now())
            return result.weeklyDownloads
        }).finally(function forget() {
            downloadsInFlight.delete(name)
        })
        downloadsInFlight.set(name, started)
        return started
    }

    return {
        lookup: registry.lookup,
        weeklyDownloads: async function weeklyDownloads(names): Promise<Map<string, number | null>> {
            const unique = [...new Set(names)]
            const at = now()
            const cached = store.get(unique)
            const out = new Map<string, number | null>()
            const pending: Promise<void>[] = []
            for (const name of unique) {
                const row = cached.get(name)
                if (row && row.weeklyDownloads !== null && row.downloadsCheckedAt !== null && row.downloadsCheckedAt >= at - REGISTRY_FRESH_MS) {
                    out.set(name, row.weeklyDownloads)
                    continue
                }
                pending.push(countOf(name).then(function store(count) {
                    // A failed refetch still has last known count to offer; it is a signal, not a verdict.
                    out.set(name, count ?? row?.weeklyDownloads ?? null)
                }))
            }
            await Promise.all(pending)
            return out
        }
    }
}

function fromCache<S>(row: RegistryRow, spec: CachedRegistrySpec<S>): CachedEntry<S> | null {
    if (row.status === 'not_found') return { status: 'not_found', checkedAt: row.checkedAt, origin: 'cache' }
    const summary = spec.parse(row.summaryJson)
    // An unreadable cached summary is no answer: refetch rather than serve it.
    return summary === null ? null : { status: 'ok', summary, checkedAt: row.checkedAt, origin: 'cache' }
}

// `held` is the previous row's summary when it is still readable — what a 304 confirms, what a fresh answer
// keeps from, and what a failed refetch falls back to.
function settleFetch<S>(store: RegistryStore, spec: CachedRegistrySpec<S>, name: string, result: RegistryResult<S>, fetchedAt: number, previous: RegistryRow | undefined, held: S | null): CachedEntry<S> {
    if (result.status === 'ok') {
        const summary = held !== null && spec.keep ? spec.keep(result.summary, held) : result.summary
        store.put({ name, status: 'ok', summaryJson: JSON.stringify(summary), checkedAt: fetchedAt, etag: result.etag })
        return { status: 'ok', summary, checkedAt: fetchedAt, origin: 'fetched' }
    }
    if (result.status === 'not_found') {
        store.put({ name, status: 'not_found', summaryJson: null, checkedAt: fetchedAt, etag: null })
        return { status: 'not_found', checkedAt: fetchedAt, origin: 'fetched' }
    }
    if (result.status === 'not_modified' && previous && held !== null) {
        // The registry confirmed, now, that the summary held is current: it is as good as a fresh fetch.
        store.put({ name, status: 'ok', summaryJson: previous.summaryJson, checkedAt: fetchedAt, etag: result.etag ?? previous.etag })
        return { status: 'ok', summary: held, checkedAt: fetchedAt, origin: 'fetched' }
    }
    // The refetch failed (a 304 with nothing held to confirm is a broken answer, not a confirmation). The
    // last good answer is still the best evidence there is, labelled as old.
    const reason = result.status === 'not_modified' ? 'HTTP 304 with no cached packument to confirm' : result.reason
    if (previous && held !== null) return { status: 'stale', summary: held, checkedAt: previous.checkedAt, reason }
    return { status: 'error', reason }
}

// A cached summary is evidence only when it is whole: every field of the v2 shape, and every edge reference
// of a release or a prerelease pointing at an edge set that is there. Anything less — a v1 summary, which
// lacks prereleases, or a v2 summary missing an edge set — is no summary, so it is refetched in full and
// never revalidated: a 304 confirms the registry's packument, not that our reduction of it is complete.
export function parseSummary(json: string | null): NpmPackageSummary | null {
    if (json === null) return null
    let parsed: unknown
    try {
        parsed = JSON.parse(json)
    } catch {
        return null
    }
    return isSummary(parsed) ? parsed : null
}

function isSummary(value: unknown): value is NpmPackageSummary {
    if (!isRecord(value) || value.v !== 2 || typeof value.name !== 'string' || !isNullable(value.latest, 'string') ||
        !isNullable(value.modified, 'number') || typeof value.maintainers !== 'number' || !isNullable(value.repository, 'string')) return false
    const { versions, prereleases, edges } = value
    if (!Array.isArray(edges) || !edges.every(isEdgeSet) || !isRecord(versions) || !isRecord(prereleases)) return false
    function inBounds(index: unknown): boolean {
        return index === null || (Number.isInteger(index) && (index as number) >= 0 && (index as number) < (edges as unknown[]).length)
    }
    return Object.values(versions).every(function isRelease(release) {
        return isRecord(release) && isNullable(release.publishedAt, 'number') && isNullable(release.deprecated, 'string') && inBounds(release.edges)
    }) && Object.values(prereleases).every(inBounds)
}

function isEdgeSet(value: unknown): boolean {
    return isRecord(value) && isStringMap(value.dependencies) && isStringMap(value.optionalDependencies) && isStringMap(value.peerDependencies) &&
        Array.isArray(value.optionalPeers) && value.optionalPeers.every(function isName(peer) { return typeof peer === 'string' })
}

function isStringMap(value: unknown): boolean {
    return isRecord(value) && Object.values(value).every(function isRange(range) { return typeof range === 'string' })
}

function isNullable(value: unknown, type: 'string' | 'number'): boolean {
    return value === null || typeof value === type
}

// A plain object: not null, not an array.
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// A counting semaphore: `limit(work)` runs work once fewer than `max` are running, in arrival order. A
// finishing task hands its slot straight to the next waiter, so a newcomer can never slip in between.
function createLimiter(max: number): Limiter {
    let running = 0
    const waiting: (() => void)[] = []
    function release(): void {
        const next = waiting.shift()
        if (next) next()
        else running--
    }
    return async function limit<T>(work: () => Promise<T>): Promise<T> {
        if (running >= max) {
            await new Promise<void>(function wait(resolve) { waiting.push(resolve) })
        } else {
            running++
        }
        try {
            return await work()
        } finally {
            release()
        }
    }
}
