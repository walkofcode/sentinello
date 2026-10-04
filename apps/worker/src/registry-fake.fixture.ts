import type { NpmEdges, NpmPackageSummary } from '@sentinello/feeds'
import type { LookupOptions, RegistryClient, RegistryEntry } from './registry-client'

// A registry for the way-out tests, written as a table: package → version → its dependency edges. Anything
// not in the table is not on the registry. Shared by closure.test.ts and remediation.test.ts.

export type FakeRelease = {
    dependencies?: Record<string, string>
    optionalDependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
    publishedAt?: number
    deprecated?: string
}

// `latest: null` models a packument with no latest tag.
export type FakePackage = { latest?: string | null; maintainers?: number; releases: Record<string, FakeRelease> }

export const FAKE_PUBLISHED_AT = Date.UTC(2026, 0, 1)

export function fakeSummary(name: string, pkg: FakePackage): NpmPackageSummary {
    const edges: NpmEdges[] = []
    const versions: NpmPackageSummary['versions'] = {}
    for (const [version, r] of Object.entries(pkg.releases)) {
        const set: NpmEdges = { dependencies: r.dependencies ?? {}, optionalDependencies: r.optionalDependencies ?? {}, peerDependencies: r.peerDependencies ?? {}, optionalPeers: [] }
        const empty = Object.keys(set.dependencies).length + Object.keys(set.optionalDependencies).length + Object.keys(set.peerDependencies).length === 0
        let index: number | null = null
        if (!empty) {
            const key = JSON.stringify(set)
            const found = edges.findIndex(function same(e) { return JSON.stringify(e) === key })
            index = found >= 0 ? found : edges.push(set) - 1
        }
        versions[version] = { publishedAt: r.publishedAt ?? FAKE_PUBLISHED_AT, deprecated: r.deprecated ?? null, edges: index }
    }
    const names = Object.keys(pkg.releases)
    return { v: 1, name, latest: pkg.latest === undefined ? names[names.length - 1] ?? null : pkg.latest, modified: null, maintainers: pkg.maintainers ?? 1, repository: null, versions, edges }
}

export type FakeRegistry = RegistryClient & { lookups: string[]; downloads: Record<string, number> }

// `unavailable` names answer an error (a registry outage for that package only).
export function fakeRegistry(table: Record<string, FakePackage>, options: { unavailable?: string[]; downloads?: Record<string, number> } = {}): FakeRegistry {
    const lookups: string[] = []
    const downloads = options.downloads ?? {}
    return {
        lookups,
        downloads,
        lookup: async function lookup(names: readonly string[], lookupOptions?: LookupOptions): Promise<Map<string, RegistryEntry>> {
            const out = new Map<string, RegistryEntry>()
            for (const name of new Set(names)) {
                const budget = lookupOptions?.budget
                if (budget) {
                    if (budget.remaining <= 0) {
                        budget.exhausted = true
                        out.set(name, { status: 'error', reason: 'fetch budget exhausted' })
                        continue
                    }
                    budget.remaining--
                }
                lookups.push(name)
                if (options.unavailable?.includes(name)) out.set(name, { status: 'error', reason: 'HTTP 503' })
                else if (table[name]) out.set(name, { status: 'ok', summary: fakeSummary(name, table[name] as FakePackage), checkedAt: FAKE_PUBLISHED_AT, origin: 'fetched' })
                else out.set(name, { status: 'not_found', checkedAt: FAKE_PUBLISHED_AT, origin: 'fetched' })
            }
            return out
        },
        weeklyDownloads: async function weeklyDownloads(names: readonly string[]): Promise<Map<string, number | null>> {
            return new Map(names.map(function count(n) { return [n, downloads[n] ?? null] as const }))
        }
    }
}
