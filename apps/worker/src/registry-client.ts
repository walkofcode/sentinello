import { errText } from '@sentinello/core'
import { fetchNpmPackage, fetchNpmWeeklyDownloads, type NpmDownloadsResult, type NpmPackageResult, type NpmPackageSummary } from '@sentinello/feeds'
import { getRegistryPackages, setRegistryDownloads, upsertRegistryPackage, type DrizzleDb, type RegistryPackageRow } from '@sentinello/db'

// The npm registry as the worker reads it: cache first, the network only on a miss. Shared by fix
// settlement and the way-out guidance so a package is fetched at most once per scan and at most once per
// freshness window across scans.
//
// One client serves the whole worker batch (runBatch creates it), so its limits are the worker's:
//   - at most REGISTRY_FETCH_CONCURRENCY requests in flight, across every project being scanned;
//   - a package already being fetched is joined, never fetched a second time.
//
// Cache policy:
//   - an 'ok' or 'not_found' answer is fresh for REGISTRY_FRESH_MS; after that the next scan that needs
//     the package refetches it;
//   - a failed fetch is never cached, and never deletes what is there: a stale 'ok' row is served instead,
//     marked 'stale', so the finding says how old its data is rather than pretending it is current.

export const REGISTRY_FRESH_MS = 24 * 60 * 60 * 1000
export const REGISTRY_FETCH_CONCURRENCY = 4
export const FETCH_BUDGET_EXHAUSTED = 'fetch budget exhausted'
const NPM = 'npm'

// One package's answer as served to a reader, with where it came from. `checkedAt` is when the registry
// gave the data that is being served — not when it was served.
export type RegistryEntry =
    | { status: 'ok'; summary: NpmPackageSummary; checkedAt: number; origin: 'fetched' | 'cache' }
    | { status: 'stale'; summary: NpmPackageSummary; checkedAt: number; reason: string }
    | { status: 'not_found'; checkedAt: number; origin: 'fetched' | 'cache' }
    | { status: 'error'; reason: string }

// A cap on how many packuments one caller may cause to be fetched. Cache hits and joined in-flight
// fetches are free. Once `remaining` reaches zero, a further miss is answered with an error
// (FETCH_BUDGET_EXHAUSTED) and `exhausted` is set, so the caller can say its answer is partial.
export type FetchBudget = { remaining: number; exhausted: boolean }

export type LookupOptions = { budget?: FetchBudget }

export type RegistryClient = {
    lookup(names: readonly string[], options?: LookupOptions): Promise<Map<string, RegistryEntry>>
    // Last week's downloads per package; null when the count could not be had. A signal for the reader,
    // never an input to a verdict, so a failure is not an error here.
    weeklyDownloads(names: readonly string[]): Promise<Map<string, number | null>>
}

export type NpmRegistryClientOptions = {
    fetchPackage?: (name: string, abortSignal?: AbortSignal) => Promise<NpmPackageResult>
    fetchDownloads?: (name: string, abortSignal?: AbortSignal) => Promise<NpmDownloadsResult>
    now?: () => number
    abortSignal?: AbortSignal
}

export function createNpmRegistryClient(db: DrizzleDb, options?: NpmRegistryClientOptions): RegistryClient {
    const fetchPackage = options?.fetchPackage ?? function fetchLive(name: string, abortSignal?: AbortSignal) {
        return fetchNpmPackage(name, { abortSignal })
    }
    const fetchDownloads = options?.fetchDownloads ?? function fetchLiveDownloads(name: string, abortSignal?: AbortSignal) {
        return fetchNpmWeeklyDownloads(name, { abortSignal })
    }
    const now = options?.now ?? Date.now
    const limit = createLimiter(REGISTRY_FETCH_CONCURRENCY)
    const packumentsInFlight = new Map<string, Promise<RegistryEntry>>()
    const downloadsInFlight = new Map<string, Promise<number | null>>()

    function refresh(name: string, previous: RegistryPackageRow | undefined): Promise<RegistryEntry> {
        const running = packumentsInFlight.get(name)
        if (running) return running
        const started = limit(async function fetchOne(): Promise<RegistryEntry> {
            let result: NpmPackageResult
            try {
                result = await fetchPackage(name, options?.abortSignal)
            } catch (err) {
                // The fetcher is meant to answer, not throw; if one does, it is an answer of "error".
                result = { status: 'error', reason: errText(err) }
            }
            return settleFetch(db, name, result, now(), previous)
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
            setRegistryDownloads(db, NPM, name, result.weeklyDownloads, now())
            return result.weeklyDownloads
        }).finally(function forget() {
            downloadsInFlight.delete(name)
        })
        downloadsInFlight.set(name, started)
        return started
    }

    return {
        lookup: async function lookup(names, lookupOptions): Promise<Map<string, RegistryEntry>> {
            const unique = [...new Set(names)]
            const at = now()
            const cached = getRegistryPackages(db, NPM, unique)
            const out = new Map<string, RegistryEntry>()
            const budget = lookupOptions?.budget
            const pending: Promise<void>[] = []
            for (const name of unique) {
                const row = cached.get(name)
                const entry = row && row.checkedAt >= at - REGISTRY_FRESH_MS ? fromCache(row) : null
                if (entry) {
                    out.set(name, entry)
                    continue
                }
                if (budget && !packumentsInFlight.has(name)) {
                    if (budget.remaining <= 0) {
                        budget.exhausted = true
                        out.set(name, { status: 'error', reason: FETCH_BUDGET_EXHAUSTED })
                        continue
                    }
                    budget.remaining--
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
            const cached = getRegistryPackages(db, NPM, unique)
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

function fromCache(row: RegistryPackageRow): RegistryEntry | null {
    if (row.status === 'not_found') return { status: 'not_found', checkedAt: row.checkedAt, origin: 'cache' }
    const summary = parseSummary(row.summaryJson)
    // An unreadable cached summary is no answer: refetch rather than serve it.
    return summary === null ? null : { status: 'ok', summary, checkedAt: row.checkedAt, origin: 'cache' }
}

function settleFetch(db: DrizzleDb, name: string, result: NpmPackageResult, fetchedAt: number, previous: RegistryPackageRow | undefined): RegistryEntry {
    if (result.status === 'ok') {
        upsertRegistryPackage(db, { ecosystem: NPM, name, status: 'ok', summaryJson: JSON.stringify(result.summary), checkedAt: fetchedAt })
        return { status: 'ok', summary: result.summary, checkedAt: fetchedAt, origin: 'fetched' }
    }
    if (result.status === 'not_found') {
        upsertRegistryPackage(db, { ecosystem: NPM, name, status: 'not_found', summaryJson: null, checkedAt: fetchedAt })
        return { status: 'not_found', checkedAt: fetchedAt, origin: 'fetched' }
    }
    // The refetch failed. The last good answer is still the best evidence there is, labelled as old.
    const staleSummary = previous && previous.status === 'ok' ? parseSummary(previous.summaryJson) : null
    if (previous && staleSummary) return { status: 'stale', summary: staleSummary, checkedAt: previous.checkedAt, reason: result.reason }
    return { status: 'error', reason: result.reason }
}

export function parseSummary(json: string | null): NpmPackageSummary | null {
    if (json === null) return null
    try {
        const parsed = JSON.parse(json) as Partial<NpmPackageSummary> | null
        if (!parsed || parsed.v !== 1 || typeof parsed.versions !== 'object' || parsed.versions === null) return null
        return parsed as NpmPackageSummary
    } catch {
        return null
    }
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
