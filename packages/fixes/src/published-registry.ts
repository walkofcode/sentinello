import type { NpmPackageSummary, PublishedResult, PublishedSummary } from '@sentinello/feeds'
import { createCachedRegistry, type CachedEntry, type CachedRegistryOptions, type PackumentRequest, type RegistryClient, type RegistryStore } from './registry-client'
import type { PublishedVersion, RegistryView } from './settle'

// What settlement asks of one ecosystem's registry, whichever it is: for each package, what was published,
// as the view settleFix reads. `stated` maps every package asked about to the fix versions its advisories
// state that could still be the fix (statedFixCandidates). Only Go reads them — its list omits
// pseudo-versions, so it confirms a stated one on its own — every other registry lists all it has.
// Every package asked about is answered.
export type PublicationClient = {
    published(stated: ReadonlyMap<string, readonly string[]>): Promise<Map<string, RegistryView>>
}

// What the settlement may conclude from one registry answer. A missing entry (the lookup did not answer
// for the package) is an error: unknown, never "no fix".
export function registryView<S>(entry: CachedEntry<S> | undefined, publishedOf: (summary: S) => PublishedVersion[]): RegistryView {
    if (!entry || entry.status === 'error') return { status: 'error' }
    if (entry.status === 'not_found') return { status: 'not_found', dataAsOf: entry.checkedAt }
    return { status: entry.status, published: publishedOf(entry.summary), dataAsOf: entry.checkedAt }
}

// npm's releases, deprecated ones flagged (the picker prefers a current one). Prereleases are kept apart
// in the summary, so they are never here.
export function publishedVersions(summary: NpmPackageSummary): PublishedVersion[] {
    return Object.entries(summary.versions).map(function toPublished([version, meta]) {
        return { version, deprecated: meta.deprecated !== null }
    })
}

// Every release still offered: a yanked one is never a fix. None of these registries deprecates a single
// release the way npm does.
export function liveVersions(summary: PublishedSummary): PublishedVersion[] {
    return Object.entries(summary.versions).flatMap(function live([version, release]) {
        return release.yanked ? [] : [{ version, deprecated: false }]
    })
}

// npm's package-data client, seen as settlement sees every registry.
export function npmPublication(client: RegistryClient): PublicationClient {
    return {
        published: async function published(stated) {
            const names = [...stated.keys()]
            const entries = await client.lookup(names)
            return new Map(names.map(function view(name) { return [name, registryView(entries.get(name), publishedVersions)] as const }))
        }
    }
}

// The cache-first client for a registry that answers with the published summary: PyPI, crates.io and
// RubyGems. `fetchPackage` is that registry's fetcher from @sentinello/feeds.
export function createPublishedRegistryClient(
    store: RegistryStore,
    fetchPackage: (name: string, request: PackumentRequest) => Promise<PublishedResult>,
    options?: CachedRegistryOptions
): PublicationClient {
    const registry = createCachedRegistry(store, { fetch: fetchPackage, parse: parsePublishedSummary }, options)
    return {
        published: async function published(stated) {
            const names = [...stated.keys()]
            const entries = await registry.lookup(names)
            return new Map(names.map(function view(name) { return [name, registryView(entries.get(name), liveVersions)] as const }))
        }
    }
}

// A cached published summary, or null when the row holds anything else — it is then refetched in full.
export function parsePublishedSummary(json: string | null): PublishedSummary | null {
    const parsed = parseJson(json)
    return isPublishedSummary(parsed) ? parsed : null
}

export function isPublishedSummary(value: unknown): value is PublishedSummary {
    return isRecord(value) && value.v === 1 && typeof value.name === 'string' && isRecord(value.versions) &&
        Object.values(value.versions).every(function isRelease(release) { return isRecord(release) && typeof release.yanked === 'boolean' })
}

export function parseJson(json: string | null): unknown {
    if (json === null) return null
    try {
        return JSON.parse(json) as unknown
    } catch {
        return null
    }
}

// A plain object: not null, not an array.
export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}
