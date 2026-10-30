import { errText, requireComparator } from '@sentinello/core'
import { fetchGoModuleList, fetchGoVersionInfo, type GoVersionInfoResult, type PublishedResult, type PublishedSummary, type RegistryResult } from '@sentinello/feeds'
import { isPublishedSummary, isRecord, liveVersions, parseJson, type PublicationClient } from './published-registry'
import { createCachedRegistry, REGISTRY_FRESH_MS, type CachedEntry, type CachedRegistryOptions, type PackumentRequest, type RegistryRow, type RegistryStore } from './registry-client'
import type { RegistryView } from './settle'

// The Go module proxy, cache first like every registry, with one addition (SENTINEL-126). `/@v/list` omits
// pseudo-versions by protocol, and some Go modules are only ever fixed in a commit; pickReleasedFix admits
// such a fix only when an advisory states it AND it is in `published`. So for each stated fix version the
// list does not have, the proxy is asked about that exact version (`/@v/{version}.info`):
//   - 200 — published: it joins `published`;
//   - 404 or 410 — confirmed absent;
//   - anything else (a timeout, a 5xx, a refused connection) — unconfirmed: settlement reads the module as
//     unknown, never as "no fix released".
// At most GO_INFO_CHECKS_PER_MODULE such requests per module per settlement, lowest version first; a
// candidate past the cap is unconfirmed too. Only the two real answers are cached, each with its check time,
// in the module's own registry_packages row beside the list, so a failed check is retried next time and
// never reads as absence. A confirmed publication is kept for good — the proxy never unpublishes a version
// it has served — and a confirmed absence for REGISTRY_FRESH_MS, since a commit can be pushed later.

export const GO_INFO_CHECKS_PER_MODULE = 3

export type GoInfoCheck = { published: boolean; checkedAt: number }

// The published summary of the list, plus the per-version checks, keyed by the version as the proxy spells
// it (with its `v`).
export type GoModuleSummary = PublishedSummary & { info: Record<string, GoInfoCheck> }

export type GoRegistryClientOptions = CachedRegistryOptions & {
    fetchList?: (module: string, request: PackumentRequest) => Promise<PublishedResult>
    fetchInfo?: (module: string, version: string, abortSignal?: AbortSignal) => Promise<GoVersionInfoResult>
}

type CheckOutcome = 'published' | 'absent' | 'unconfirmed'

export function createGoRegistryClient(store: RegistryStore, options?: GoRegistryClientOptions): PublicationClient {
    const fetchList = options?.fetchList ?? function fetchLiveList(module: string, request: PackumentRequest) {
        return fetchGoModuleList(module, request)
    }
    const fetchInfo = options?.fetchInfo ?? function fetchLiveInfo(module: string, version: string, abortSignal?: AbortSignal) {
        return fetchGoVersionInfo(module, version, { abortSignal })
    }
    const registry = createCachedRegistry<GoModuleSummary>(store, {
        fetch: async function fetchModule(module, request): Promise<RegistryResult<GoModuleSummary>> {
            const result = await fetchList(module, request)
            return result.status === 'ok' ? { ...result, summary: { ...result.summary, info: {} } } : result
        },
        parse: parseGoSummary,
        // A refreshed list keeps the checks already made: they are about versions the list never shows.
        keep: function keepChecks(fetched, held) {
            return { ...fetched, info: held.info }
        }
    }, options)
    const { limit, now } = registry
    const comparator = requireComparator('Go')
    const checksInFlight = new Map<string, Promise<GoVersionInfoResult>>()

    function check(module: string, version: string): Promise<GoVersionInfoResult> {
        const key = module + '@' + version
        const running = checksInFlight.get(key)
        if (running) return running
        const started = limit(async function checkOne(): Promise<GoVersionInfoResult> {
            try {
                return await fetchInfo(module, version, options?.abortSignal)
            } catch (err) {
                // The fetcher is meant to answer, not throw; if one does, it is no answer.
                return { status: 'error', reason: errText(err) }
            }
        }).finally(function forget() {
            checksInFlight.delete(key)
        })
        checksInFlight.set(key, started)
        return started
    }

    // Writes new checks into the module's row, keeping the row's list, check time and ETag. The row is read
    // again here, not taken from the lookup, so a concurrent settlement's checks are merged, not lost; one
    // gone since the lookup served it keeps nothing, and the checks still answer this settlement.
    function record(module: string, checks: Record<string, GoInfoCheck>): void {
        const row = store.get([module]).get(module)
        const held = row === undefined ? null : parseGoSummary(row.summaryJson)
        if (held === null) return
        const { checkedAt, etag } = row as RegistryRow
        store.put({ name: module, status: 'ok', summaryJson: JSON.stringify({ ...held, info: { ...held.info, ...checks } }), checkedAt, etag })
    }

    // The stated versions the list does not have, one per normalized version, lowest first, spelled the way
    // the proxy names them.
    function unlisted(summary: GoModuleSummary, stated: readonly string[]): string[] {
        const listed = new Set(Object.keys(summary.versions).map(function normalized(v) { return comparator.normalize(v) }))
        const byVersion = new Map<string, string>()
        for (const raw of stated) {
            const v = comparator.normalize(raw)
            if (v === null || listed.has(v) || byVersion.has(v)) continue
            const bare = raw.trim()
            byVersion.set(v, bare.startsWith('v') ? bare : 'v' + bare)
        }
        return [...byVersion].sort(function byOrder([a], [b]) { return comparator.compare(a, b) }).map(function spelled([, version]) { return version })
    }

    async function viewOf(module: string, entry: CachedEntry<GoModuleSummary>, stated: readonly string[]): Promise<RegistryView> {
        if (entry.status === 'error') return { status: 'error' }
        if (entry.status === 'not_found') return { status: 'not_found', dataAsOf: entry.checkedAt }
        const summary = entry.summary
        const at = now()
        let budget = GO_INFO_CHECKS_PER_MODULE
        const fresh: Record<string, GoInfoCheck> = {}
        const outcomes = await Promise.all(unlisted(summary, stated).map(async function outcomeOf(version): Promise<{ version: string; outcome: CheckOutcome }> {
            const known = summary.info[version]
            if (known && (known.published || known.checkedAt >= at - REGISTRY_FRESH_MS)) return { version, outcome: known.published ? 'published' : 'absent' }
            if (budget === 0) return { version, outcome: 'unconfirmed' }
            budget--
            const result = await check(module, version)
            if (result.status === 'error') return { version, outcome: 'unconfirmed' }
            fresh[version] = { published: result.status === 'published', checkedAt: now() }
            return { version, outcome: result.status }
        }))
        if (Object.keys(fresh).length > 0) record(module, fresh)
        const published = liveVersions(summary)
        const unconfirmed: string[] = []
        for (const { version, outcome } of outcomes) {
            if (outcome === 'published') published.push({ version, deprecated: false })
            if (outcome === 'unconfirmed') unconfirmed.push(version)
        }
        const view = { status: entry.status, published, dataAsOf: entry.checkedAt }
        return unconfirmed.length > 0 ? { ...view, unconfirmed } : view
    }

    return {
        published: async function published(stated) {
            const modules = [...stated.keys()]
            const entries = await registry.lookup(modules)
            const out = new Map<string, RegistryView>()
            await Promise.all(modules.map(async function settleModule(module) {
                // The lookup answers every module it is asked about, and every module asked has its list.
                out.set(module, await viewOf(module, entries.get(module) as CachedEntry<GoModuleSummary>, stated.get(module) as readonly string[]))
            }))
            return out
        }
    }
}

// A cached Go summary, or null when the row holds anything else — it is then refetched in full.
export function parseGoSummary(json: string | null): GoModuleSummary | null {
    const parsed = parseJson(json)
    if (!isPublishedSummary(parsed)) return null
    const info = (parsed as { info?: unknown }).info
    if (!isRecord(info)) return null
    const whole = Object.values(info).every(function isCheck(c) { return isRecord(c) && typeof c.published === 'boolean' && typeof c.checkedAt === 'number' })
    return whole ? parsed as GoModuleSummary : null
}
