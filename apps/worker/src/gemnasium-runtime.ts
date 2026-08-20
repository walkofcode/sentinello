import cron, { type ScheduledTask } from 'node-cron'
import { DEFAULT_ECOSYSTEM, ECOSYSTEMS, GEMNASIUM_SCANNER_NAME, sourceStatusKey, type EcosystemId, type GemnasiumAdvisoryRow, type SourceStatus } from '@sentinello/core'
import {
    GEMNASIUM_META_KEYS,
    GEMNASIUM_NORMALIZER_VERSION,
    getGemnasiumMeta,
    getSourceEnabled,
    lookupGemnasiumByPackages,
    openGemnasiumDb,
    runGemnasiumMigrations,
    enqueueScanRequest,
    hasStaleSourceUnavailableScans,
    setConfigValue,
    type DrizzleDb,
    type GemnasiumDrizzleDb
} from '@sentinello/db'
import { errText } from '@sentinello/feeds'
import {
    createGemnasiumScanner,
    type GemnasiumAdvisory,
    type ScannerPlugin
} from '@sentinello/scanners'

export type { ScannerPlugin }
import { gemnasiumFeedDisabled, syncGemnasium } from './gemnasium-sync'
import type { WorkerRuntime } from './runtime'

// Owns the gemnasium cache connection + the gemnasium scanner instance + the periodic sync job. Opened
// lazily so a worker with the source disabled never creates gemnasium.db or touches the network. The main
// DB is read to learn whether the operator enabled the source. Structurally a near-twin of osv-runtime —
// the one difference is gemnasium-db has no per-advisory delta feed, so every sync is a full re-seed.

// 24h sync cadence. Anchored at 03:42 to avoid clustering with the on-the-hour scan schedule and the OSV
// sync (03:17).
const SYNC_CRON = '42 3 * * *'

export type GemnasiumRuntime = {
    scanner: ScannerPlugin
    runSyncNow: () => Promise<void>
    stop: () => void
}

// Long-lived controller that owns the gemnasium runtime lifecycle across enable/disable toggles. Mirrors
// OsvController: the scheduler/poller read getScanner() each batch, and reload() — fired by the
// 'reload-sources' worker signal — starts or stops the runtime to match the live config flag.
export type GemnasiumController = {
    getScanner: () => ScannerPlugin | null
    reload: () => void
    refresh: () => Promise<void>
    stop: () => void
}

export function createGemnasiumController(mainDb: DrizzleDb, runtime: WorkerRuntime): GemnasiumController {
    let current: GemnasiumRuntime | null = null
    function syncToConfig(): void {
        const enabled = gemnasiumSourceEnabled(mainDb)
        if (enabled && !current) {
            try {
                current = startGemnasiumRuntime(mainDb, runtime)
            } catch (err) {
                console.error('[gemnasium] runtime failed to start: ' + errText(err))
                current = null
            }
            return
        }
        if (!enabled && current) {
            current.stop()
            current = null
            console.log('[gemnasium] source disabled; runtime stopped')
        }
    }
    syncToConfig()
    return {
        getScanner: function getScanner() {
            return current && current.scanner || null
        },
        reload: function reload() {
            syncToConfig()
        },
        refresh: async function refresh() {
            // "Refresh now" from the portal. Only meaningful when the source is running; if it isn't,
            // reconcile to config first (which starts it and triggers an initial sync on its own).
            if (!current) {
                syncToConfig()
                return
            }
            await current.runSyncNow()
        },
        stop: function stop() {
            if (current) current.stop()
            current = null
        }
    }
}

// The gemnasium ecosystems the operator has enabled — one (gemnasium, ecosystem) cell per entry. Driven by
// the central registry, mirroring enabledOsvEcosystems, so adding a language is a registry edit and never a
// change here. Note gemnasium's CACHE is a single multi-ecosystem download (one seed), so this list gates
// MATCHING per cell, not the download — the whole DB is fetched once and each enabled cell reads its slice.
export function enabledGemnasiumEcosystems(db: DrizzleDb): EcosystemId[] {
    const out: EcosystemId[] = []
    for (const eco of ECOSYSTEMS) {
        if (getSourceEnabled(db, 'gemnasium', eco.id)) out.push(eco.id)
    }
    return out
}

// gemnasium participates in a batch when ANY of its (gemnasium, ecosystem) cells is enabled — not only the
// npm cell. So `sources.gemnasium.PyPI.enabled=true` alone starts the runtime even with the npm cell off,
// matching the OSV source's per-cell semantics (was previously npm-only, which silently ignored non-npm cells).
export function gemnasiumSourceEnabled(db: DrizzleDb): boolean {
    return enabledGemnasiumEcosystems(db).length > 0
}

// Opens (and migrates) the gemnasium cache, builds the scanner bound to it, runs an initial sync if the
// feed is enabled, and schedules the daily sync. Returns the scanner so the scheduler can include it in
// the per-project run set.
export function startGemnasiumRuntime(mainDb: DrizzleDb, runtime: WorkerRuntime): GemnasiumRuntime {
    const { db: gemnasiumDb } = openGemnasiumDb()
    runGemnasiumMigrations(gemnasiumDb)

    const scanner = createGemnasiumScanner({
        isEnabled: function isEnabled(ecosystem: string): boolean {
            // The operator's live (gemnasium, ecosystem) cell flag, read each scan. The single gemnasium
            // cache is seeded for every ecosystem, so without this gate a disabled cell would still match;
            // this is what enforces the (source, ecosystem) configuration unit at scan time.
            return getSourceEnabled(mainDb, 'gemnasium', ecosystem as EcosystemId)
        },
        isSeeded: function isSeeded() {
            return gemnasiumCacheUsable(gemnasiumDb)
        },
        lookup: function lookup(ecosystem: string, packageNames: string[]): Map<string, GemnasiumAdvisory[]> {
            // The gemnasium cache `ecosystem` column holds the registry EcosystemId (stamped by the
            // normalizer from the advisory's package-type directory), so the scanner's ecosystem id queries
            // it directly — no osvEcosystem remapping needed.
            const rows = lookupGemnasiumByPackages(gemnasiumDb, ecosystem, packageNames)
            const out = new Map<string, GemnasiumAdvisory[]>()
            for (const [name, list] of rows.entries()) {
                out.set(name, list.map(toScannerAdvisory))
            }
            return out
        }
    })

    // Mirror an initial status snapshot immediately so the Settings panel shows "not seeded yet" rather
    // than nothing the moment the source is enabled.
    mirrorStatus(mainDb, gemnasiumDb)
    reconcileStaleVerdicts(mainDb, gemnasiumDb)

    if (!gemnasiumFeedDisabled()) {
        const initial = runSync(mainDb, gemnasiumDb, runtime).catch(function onErr(err: unknown) {
            console.error('[gemnasium] initial sync failed: ' + errText(err))
        })
        runtime.track(initial)
    } else {
        console.log('[gemnasium] feed disabled (SENTINELLO_GEMNASIUM_FEED_URL=off); scanner will stay unseeded')
    }

    const task: ScheduledTask = cron.schedule(SYNC_CRON, function onTick() {
        const work = runSync(mainDb, gemnasiumDb, runtime).catch(function onErr(err: unknown) {
            console.error('[gemnasium] scheduled sync failed: ' + errText(err))
        })
        runtime.track(work)
    }, { name: 'sentinello-gemnasium-sync' })
    console.log('[gemnasium] sync scheduled (' + SYNC_CRON + ')')

    return {
        scanner,
        runSyncNow: function runSyncNow() {
            return runSync(mainDb, gemnasiumDb, runtime)
        },
        stop: function stop() {
            task.stop()
        }
    }
}

// Boot-time counterpart to the transition check in runSync — see the OSV twin for why watching the
// transition is not enough on its own.
function reconcileStaleVerdicts(mainDb: DrizzleDb, gemnasiumDb: GemnasiumDrizzleDb): void {
    if (!gemnasiumCacheUsable(gemnasiumDb)) return
    if (!hasStaleSourceUnavailableScans(mainDb, GEMNASIUM_SCANNER_NAME)) return
    enqueueScanRequest(mainDb, {}, Date.now())
    console.log('[gemnasium] cache is matchable but projects still hold unauditable verdicts — enqueued a full re-scan')
}

// The predicate the SCANNER gates on, in one place, so isSeeded and the post-sync "did this cache become
// matchable" check cannot drift apart. Gates on BOTH the seed flag and the normalizer version: a bump
// rebuilds the cache and the old rows lack the new fields, so stay unauditable until the re-seed lands.
export function gemnasiumCacheUsable(gemnasiumDb: GemnasiumDrizzleDb): boolean {
    return getGemnasiumMeta<boolean>(gemnasiumDb, GEMNASIUM_META_KEYS.seedComplete) === true
        && getGemnasiumMeta<number>(gemnasiumDb, GEMNASIUM_META_KEYS.normalizerVersion) === GEMNASIUM_NORMALIZER_VERSION
}

// gemnasium has no incremental delta source, so a sync is always a full re-seed. Mirrors the resulting
// status into the main DB so the portal reflects it. Used by "refresh now", the scheduled tick, and the
// initial run.
export async function runSync(mainDb: DrizzleDb, gemnasiumDb: GemnasiumDrizzleDb, runtime: WorkerRuntime): Promise<void> {
    const signal = runtime.abortController.signal
    // No OSV-style invalidation callback here, and none is missing: rebuildGemnasium upserts OVER the
    // existing rows and purges only after the whole stream succeeds, so the cache never stops being
    // matchable mid-rebuild. The only states in which the scanner refuses it are a first seed and a
    // normalizer bump, and both are visible from the meta before the sync starts — syncGemnasium picks its
    // own path internally and does not need to report which, because the cache's own state answers it.
    const usableBefore = gemnasiumCacheUsable(gemnasiumDb)
    // Stamped before the first network byte so the portal can say a sync is running across a page reload.
    writeStatus(mainDb, gemnasiumDb, Date.now())
    try {
        await syncGemnasium(gemnasiumDb, signal)
    } finally {
        writeStatus(mainDb, gemnasiumDb, null)
    }
    if (!usableBefore && gemnasiumCacheUsable(gemnasiumDb)) {
        // See the OSV twin for why this is a full sweep and why it is deliberately not guarded by
        // isAnyScanInFlight: every project scanned while the cache was unusable holds a stale
        // gemnasium_db_not_seeded verdict that nothing else in the system ever revisits.
        enqueueScanRequest(mainDb, {}, Date.now())
        console.log('[gemnasium] cache is matchable again — enqueued a full re-scan to replace stale unauditable verdicts')
    }
}

// Initial snapshot before the first sync, so the row reads "not seeded yet" rather than nothing the moment
// the source is enabled. Also the self-heal for a worker SIGKILLed mid-rebuild: it unconditionally clears
// syncStartedAt, so a stuck "Rebuilding…" cannot survive a restart.
function mirrorStatus(mainDb: DrizzleDb, gemnasiumDb: GemnasiumDrizzleDb): void {
    writeStatus(mainDb, gemnasiumDb, null)
}

// gemnasium's cache is ONE multi-ecosystem download with a single seed/record-count/refreshed-at, so its
// sync status is genuinely global — there is no per-(gemnasium, ecosystem) seed to mirror. We write that one
// status under the canonical npm-cell key as the source's status slot; Phase 5's matrix reads this single
// status for every enabled gemnasium cell rather than expecting a per-cell row that doesn't exist. (OSV
// differs: each OSV ecosystem is a separate download, so it mirrors a status per enabled cell.)
function writeStatus(mainDb: DrizzleDb, gemnasiumDb: GemnasiumDrizzleDb, syncStartedAt: number | null): void {
    const status: SourceStatus = {
        seedComplete: getGemnasiumMeta<boolean>(gemnasiumDb, GEMNASIUM_META_KEYS.seedComplete) === true,
        normalizerVersion: getGemnasiumMeta<number>(gemnasiumDb, GEMNASIUM_META_KEYS.normalizerVersion),
        recordCount: getGemnasiumMeta<number>(gemnasiumDb, GEMNASIUM_META_KEYS.recordCount) ?? 0,
        refreshedAt: getGemnasiumMeta<number>(gemnasiumDb, GEMNASIUM_META_KEYS.refreshedAt),
        syncStartedAt,
        lastError: getGemnasiumMeta<string>(gemnasiumDb, GEMNASIUM_META_KEYS.lastError)
    }
    setConfigValue(mainDb, sourceStatusKey('gemnasium', DEFAULT_ECOSYSTEM), status)
}

// Takes the real row type rather than restating its shape inline — see the OSV twin for why.
function toScannerAdvisory(row: GemnasiumAdvisoryRow): GemnasiumAdvisory {
    return {
        advisoryId: row.advisoryId,
        aliases: row.aliases,
        ranges: row.ranges,
        versions: row.versions,
        severity: row.severity,
        summary: row.summary,
        url: row.url
    }
}

export { GEMNASIUM_SCANNER_NAME }
