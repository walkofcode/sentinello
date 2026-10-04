import { fetchNpmPackage, type NpmPackageResult, type NpmPackageSummary } from '@sentinello/feeds'
import { getRegistryPackages, upsertRegistryPackage, type DrizzleDb, type RegistryPackageRow } from '@sentinello/db'

// The npm registry as the worker reads it: cache first, the network only on a miss. Shared by fix
// settlement (and, later, the way-out guidance) so a package is fetched at most once per scan and at most
// once per freshness window across scans.
//
// Cache policy:
//   - an 'ok' or 'not_found' answer is fresh for REGISTRY_FRESH_MS; after that the next scan that needs
//     the package refetches it;
//   - a failed fetch is never cached, and never deletes what is there: a stale 'ok' row is served instead,
//     marked 'stale', so the finding says how old its data is rather than pretending it is current.

export const REGISTRY_FRESH_MS = 24 * 60 * 60 * 1000
export const REGISTRY_FETCH_CONCURRENCY = 4
const NPM = 'npm'

// One package's answer as served to a reader, with where it came from. `checkedAt` is when the registry
// gave the data that is being served — not when it was served.
export type RegistryEntry =
    | { status: 'ok'; summary: NpmPackageSummary; checkedAt: number; origin: 'fetched' | 'cache' }
    | { status: 'stale'; summary: NpmPackageSummary; checkedAt: number; reason: string }
    | { status: 'not_found'; checkedAt: number; origin: 'fetched' | 'cache' }
    | { status: 'error'; reason: string }

export type RegistryClient = {
    lookup(names: readonly string[]): Promise<Map<string, RegistryEntry>>
}

export type NpmRegistryClientOptions = {
    fetchPackage?: (name: string, abortSignal?: AbortSignal) => Promise<NpmPackageResult>
    now?: () => number
    abortSignal?: AbortSignal
}

export function createNpmRegistryClient(db: DrizzleDb, options?: NpmRegistryClientOptions): RegistryClient {
    const fetchPackage = options?.fetchPackage ?? function fetchLive(name: string, abortSignal?: AbortSignal) {
        return fetchNpmPackage(name, { abortSignal })
    }
    const now = options?.now ?? Date.now
    return {
        lookup: async function lookup(names: readonly string[]): Promise<Map<string, RegistryEntry>> {
            const unique = [...new Set(names)]
            const at = now()
            const cached = getRegistryPackages(db, NPM, unique)
            const out = new Map<string, RegistryEntry>()
            const misses: string[] = []
            for (const name of unique) {
                const row = cached.get(name)
                const entry = row && row.checkedAt >= at - REGISTRY_FRESH_MS ? fromCache(row) : null
                if (entry) out.set(name, entry)
                else misses.push(name)
            }
            await forEachLimited(misses, REGISTRY_FETCH_CONCURRENCY, async function refresh(name) {
                const result = await fetchPackage(name, options?.abortSignal)
                out.set(name, settleFetch(db, name, result, now(), cached.get(name)))
            })
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

// Runs `work` over `items` with at most `limit` in flight.
async function forEachLimited<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
    let next = 0
    async function lane(): Promise<void> {
        while (next < items.length) {
            const item = items[next] as T
            next++
            await work(item)
        }
    }
    const lanes: Promise<void>[] = []
    for (let i = 0; i < Math.min(limit, items.length); i++) lanes.push(lane())
    await Promise.all(lanes)
}
