import { errText } from '@sentinello/core'
import { fetchNpmPackage, fetchNpmWeeklyDownloads, type NpmDownloadsResult, type NpmPackageResult, type NpmPackageSummary } from '@sentinello/feeds'

// The npm registry as the worker reads it: cache first, the network only on a miss. Shared by fix
// settlement and the way-out guidance so a package is fetched at most once per scan and at most once per
// freshness window across scans. Where the cache lives is the caller's: the client reads and writes it
// only through a RegistryStore.
//
// One client serves the whole worker batch (runBatch creates it), so its limits are the worker's:
//   - at most REGISTRY_FETCH_CONCURRENCY requests in flight, across every project being scanned;
//   - a package already being fetched is joined, never fetched a second time.
//
// Cache policy:
//   - an 'ok' or 'not_found' answer is fresh for REGISTRY_FRESH_MS; after that the next scan that needs
//     the package refetches it — conditionally, when the row has the registry's ETag: a 304 confirms the
//     cached summary, which is then served as fetched now, without downloading the packument again;
//   - a failed fetch is never cached, and never deletes what is there: a stale 'ok' row is served instead,
//     marked 'stale', so the finding says how old its data is rather than pretending it is current.

export const REGISTRY_FRESH_MS = 24 * 60 * 60 * 1000
// Measured on the 157-project scratch fleet, cold cache (2026-10-04): post-scan 109.8 s at 4, 94.8 s at 8,
// 86.7 s at 16, with no 429 or 5xx from registry.npmjs.org at any of them. The fastest is kept.
export const REGISTRY_FETCH_CONCURRENCY = 16

// One cached npm answer, as a store keeps it. `summaryJson` is the reduced packument for 'ok' (parsed
// here, which owns its shape) and null for 'not_found'; `etag` is the registry's validator for it, null
// when there is none. The download count is a separate, rarer fetch, recorded beside the answer.
export type RegistryRow = {
    name: string
    status: 'ok' | 'not_found'
    summaryJson: string | null
    checkedAt: number
    etag: string | null
    weeklyDownloads: number | null
    downloadsCheckedAt: number | null
}

// Where the client keeps its answers. The worker's store is the registry_packages table; the CLI's is a
// file in its cache directory. Contract:
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
export type RegistryEntry =
    | { status: 'ok'; summary: NpmPackageSummary; checkedAt: number; origin: 'fetched' | 'cache' }
    | { status: 'stale'; summary: NpmPackageSummary; checkedAt: number; reason: string }
    | { status: 'not_found'; checkedAt: number; origin: 'fetched' | 'cache' }
    | { status: 'error'; reason: string }

export type RegistryClient = {
    lookup(names: readonly string[]): Promise<Map<string, RegistryEntry>>
    // Last week's downloads per package; null when the count could not be had. A signal for the reader,
    // never an input to a verdict, so a failure is not an error here.
    weeklyDownloads(names: readonly string[]): Promise<Map<string, number | null>>
}

// What one packument request carries: the ETag of the cached summary, when there is one to revalidate.
export type PackumentRequest = { ifNoneMatch: string | null; abortSignal?: AbortSignal }

export type NpmRegistryClientOptions = {
    fetchPackage?: (name: string, request: PackumentRequest) => Promise<NpmPackageResult>
    fetchDownloads?: (name: string, abortSignal?: AbortSignal) => Promise<NpmDownloadsResult>
    now?: () => number
    abortSignal?: AbortSignal
    // Requests in flight at once; REGISTRY_FETCH_CONCURRENCY unless a measurement run sets it.
    concurrency?: number
}

export function createNpmRegistryClient(store: RegistryStore, options?: NpmRegistryClientOptions): RegistryClient {
    const fetchPackage = options?.fetchPackage ?? function fetchLive(name: string, request: PackumentRequest) {
        return fetchNpmPackage(name, request)
    }
    const fetchDownloads = options?.fetchDownloads ?? function fetchLiveDownloads(name: string, abortSignal?: AbortSignal) {
        return fetchNpmWeeklyDownloads(name, { abortSignal })
    }
    const now = options?.now ?? Date.now
    const limit = createLimiter(options?.concurrency ?? REGISTRY_FETCH_CONCURRENCY)
    const packumentsInFlight = new Map<string, Promise<RegistryEntry>>()
    const downloadsInFlight = new Map<string, Promise<number | null>>()

    function refresh(name: string, previous: RegistryRow | undefined): Promise<RegistryEntry> {
        const running = packumentsInFlight.get(name)
        if (running) return running
        // Only a summary this client can still read is worth revalidating: a 304 hands it back as current.
        const held = previous && previous.status === 'ok' ? parseSummary(previous.summaryJson) : null
        const ifNoneMatch = held !== null && previous ? previous.etag : null
        const started = limit(async function fetchOne(): Promise<RegistryEntry> {
            let result: NpmPackageResult
            try {
                result = await fetchPackage(name, { ifNoneMatch, abortSignal: options?.abortSignal })
            } catch (err) {
                // The fetcher is meant to answer, not throw; if one does, it is an answer of "error".
                result = { status: 'error', reason: errText(err) }
            }
            return settleFetch(store, name, result, now(), previous, held)
        }).finally(function forget() {
            packumentsInFlight.delete(name)
        })
        packumentsInFlight.set(name, started)
        return started
    }

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
        lookup: async function lookup(names): Promise<Map<string, RegistryEntry>> {
            const unique = [...new Set(names)]
            const at = now()
            const cached = store.get(unique)
            const out = new Map<string, RegistryEntry>()
            const pending: Promise<void>[] = []
            for (const name of unique) {
                const row = cached.get(name)
                const entry = row && row.checkedAt >= at - REGISTRY_FRESH_MS ? fromCache(row) : null
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
        },
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

function fromCache(row: RegistryRow): RegistryEntry | null {
    if (row.status === 'not_found') return { status: 'not_found', checkedAt: row.checkedAt, origin: 'cache' }
    const summary = parseSummary(row.summaryJson)
    // An unreadable cached summary is no answer: refetch rather than serve it.
    return summary === null ? null : { status: 'ok', summary, checkedAt: row.checkedAt, origin: 'cache' }
}

// `held` is the previous row's summary when it is still readable — what a 304 confirms, and what a failed
// refetch falls back to.
function settleFetch(store: RegistryStore, name: string, result: NpmPackageResult, fetchedAt: number, previous: RegistryRow | undefined, held: NpmPackageSummary | null): RegistryEntry {
    if (result.status === 'ok') {
        store.put({ name, status: 'ok', summaryJson: JSON.stringify(result.summary), checkedAt: fetchedAt, etag: result.etag })
        return { status: 'ok', summary: result.summary, checkedAt: fetchedAt, origin: 'fetched' }
    }
    if (result.status === 'not_found') {
        store.put({ name, status: 'not_found', summaryJson: null, checkedAt: fetchedAt, etag: null })
        return { status: 'not_found', checkedAt: fetchedAt, origin: 'fetched' }
    }
    if (result.status === 'not_modified' && previous && held) {
        // The registry confirmed, now, that the summary held is current: it is as good as a fresh fetch.
        store.put({ name, status: 'ok', summaryJson: previous.summaryJson, checkedAt: fetchedAt, etag: result.etag ?? previous.etag })
        return { status: 'ok', summary: held, checkedAt: fetchedAt, origin: 'fetched' }
    }
    // The refetch failed (a 304 with nothing held to confirm is a broken answer, not a confirmation). The
    // last good answer is still the best evidence there is, labelled as old.
    const reason = result.status === 'not_modified' ? 'HTTP 304 with no cached packument to confirm' : result.reason
    if (previous && held) return { status: 'stale', summary: held, checkedAt: previous.checkedAt, reason }
    return { status: 'error', reason }
}

export function parseSummary(json: string | null): NpmPackageSummary | null {
    if (json === null) return null
    try {
        const parsed = JSON.parse(json) as Partial<NpmPackageSummary> | null
        if (!parsed || parsed.v !== 2 || !isObject(parsed.versions) || !isObject(parsed.prereleases)) return null
        return parsed as NpmPackageSummary
    } catch {
        return null
    }
}

function isObject(value: unknown): boolean {
    return typeof value === 'object' && value !== null
}

// A counting semaphore: `limit(work)` runs work once fewer than `max` are running, in arrival order. A
// finishing task hands its slot straight to the next waiter, so a newcomer can never slip in between.
function createLimiter(max: number): <T>(work: () => Promise<T>) => Promise<T> {
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
