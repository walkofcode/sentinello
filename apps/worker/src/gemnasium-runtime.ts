import cron, { type ScheduledTask } from 'node-cron'
import { DEFAULT_ECOSYSTEM, ECOSYSTEMS, GEMNASIUM_SCANNER_NAME, sourceStatusKey, type EcosystemId, type SourceStatus } from '@sentinello/core'
import {
    GEMNASIUM_META_KEYS,
    GEMNASIUM_NORMALIZER_VERSION,
    getGemnasiumMeta,
    getSourceEnabled,
    lookupGemnasiumByPackages,
    lookupOsvByPackages,
    openGemnasiumDb,
    openOsvDb,
    runGemnasiumMigrations,
    setConfigValue,
    type DrizzleDb,
    type GemnasiumDrizzleDb,
    type GemnasiumRange,
    type OsvDrizzleDb
} from '@sentinello/db'
import { errText } from '@sentinello/feeds'
import {
    createGemnasiumScanner,
    type GemnasiumAdvisory,
    type ScannerPlugin
} from '@sentinello/scanners'

export type { ScannerPlugin }
import type { OsvRangeLookup } from './gemnasium-resolve'
import { checkGemnasiumFreeSpace, gemnasiumFeedDisabled, syncGemnasium } from './gemnasium-sync'
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
            // Gate on BOTH the seed flag and the normalizer version: a normalizer bump rebuilds the cache,
            // and the old rows lack the new fields — stay unauditable until the re-seed lands.
            return getGemnasiumMeta<boolean>(gemnasiumDb, GEMNASIUM_META_KEYS.seedComplete) === true
                && getGemnasiumMeta<number>(gemnasiumDb, GEMNASIUM_META_KEYS.normalizerVersion) === GEMNASIUM_NORMALIZER_VERSION
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

// gemnasium has no incremental delta source, so a sync is always a full re-seed. Mirrors the resulting
// status into the main DB so the portal reflects it. Used by "refresh now", the scheduled tick, and the
// initial run.
export async function runSync(mainDb: DrizzleDb, gemnasiumDb: GemnasiumDrizzleDb, runtime: WorkerRuntime): Promise<void> {
    const signal = runtime.abortController.signal
    // The OSV cache is the LAST tier of gemnasium's range recovery, and it is strictly optional: the
    // connection is opened only when the operator has an OSV cell enabled, held for the sync, and closed
    // straight after. With OSV off, `osvRanges` is undefined, the tier never runs, and a record no sibling
    // or prose could resolve is dropped instead — gemnasium simply contributes nothing for it and npm-audit
    // covers the package as before.
    const osv = openOsvForResolution(mainDb)
    try {
        await syncGemnasium(gemnasiumDb, signal, { osvRanges: osv && osv.lookup || undefined })
    } finally {
        if (osv) osv.close()
        await mirrorStatusWithSpace(mainDb, gemnasiumDb)
    }
}

type OsvResolutionHandle = {
    lookup: OsvRangeLookup
    close: () => void
}

// Binds the range-recovery tier to the live OSV cache, or returns null when no (osv, ecosystem) cell is
// enabled. Opening the cache read-only here is safe alongside the OSV runtime's own connection — SQLite in
// WAL mode allows concurrent readers, and this one only ever selects.
function openOsvForResolution(mainDb: DrizzleDb): OsvResolutionHandle | null {
    const anyEnabled = ECOSYSTEMS.some(function cellEnabled(eco) {
        return getSourceEnabled(mainDb, 'osv', eco.id)
    })
    if (!anyEnabled) return null
    let opened: { db: OsvDrizzleDb; sqlite: { close: () => void } }
    try {
        opened = openOsvDb()
    } catch (err) {
        console.error('[gemnasium] OSV cache unavailable for range recovery: ' + errText(err))
        return null
    }
    return {
        lookup: function lookup(ecosystem: string, packageName: string, ids: string[]): GemnasiumRange[] | null {
            // Per-cell gate: an operator with OSV on for npm but off for PyPI must not have a PyPI gemnasium
            // record silently resolved out of the PyPI OSV cache.
            if (!getSourceEnabled(mainDb, 'osv', ecosystem as EcosystemId)) return null
            const wanted = new Set(ids)
            const byPackage = lookupOsvByPackages(opened.db, ecosystem, [packageName])
            const rows = byPackage.get(packageName)
            if (!rows) return null
            for (const row of rows) {
                // Same vulnerability, matched on id or on either side's alias list.
                const matches = wanted.has(row.advisoryId) || row.aliases.some(function known(alias) {
                    return wanted.has(alias)
                })
                if (!matches) continue
                const ranges = toGemnasiumRanges(row.ranges)
                if (ranges) return ranges
            }
            return null
        },
        close: function close() {
            try {
                opened.sqlite.close()
            } catch {
                // A close failure on a read-only handle is not worth failing the sync over.
            }
        }
    }
}

// OSV ranges carry a `type` and an optional `lastAffected`; gemnasium's shape has neither. The conversion
// is deliberately all-or-nothing — if ANY range cannot be expressed exactly, the whole advisory is refused
// (null) and the record falls through to being dropped.
//
// A GIT range has commit hashes rather than versions, and a `lastAffected` bound is INCLUSIVE where
// gemnasium's `fixed` is exclusive, so keeping it would understate the affected set by one version and
// dropping it would leave the range open-ended and overstate it by every version above. Refusing is the
// only honest option: this whole change exists because the old code preferred a fabricated range to none.
function toGemnasiumRanges(ranges: { type: string; introduced: string; fixed: string | null; lastAffected: string | null }[]): GemnasiumRange[] | null {
    if (ranges.length === 0) return null
    const out: GemnasiumRange[] = []
    for (const range of ranges) {
        if (range.type !== 'SEMVER' && range.type !== 'ECOSYSTEM') return null
        if (range.fixed === null && range.lastAffected !== null) return null
        out.push({ introduced: range.introduced, fixed: range.fixed })
    }
    return out
}

// Reads the gemnasium cache's meta + free space and writes the compact SourceStatus snapshot into the
// main app_config so the portal (which never opens gemnasium.db) can render sync status from the main DB.
async function mirrorStatusWithSpace(mainDb: DrizzleDb, gemnasiumDb: GemnasiumDrizzleDb): Promise<void> {
    const space = await checkGemnasiumFreeSpace()
    writeStatus(mainDb, gemnasiumDb, space.freeBytes)
}

function mirrorStatus(mainDb: DrizzleDb, gemnasiumDb: GemnasiumDrizzleDb): void {
    writeStatus(mainDb, gemnasiumDb, null)
}

// gemnasium's cache is ONE multi-ecosystem download with a single seed/record-count/refreshed-at, so its
// sync status is genuinely global — there is no per-(gemnasium, ecosystem) seed to mirror. We write that one
// status under the canonical npm-cell key as the source's status slot; Phase 5's matrix reads this single
// status for every enabled gemnasium cell rather than expecting a per-cell row that doesn't exist. (OSV
// differs: each OSV ecosystem is a separate download, so it mirrors a status per enabled cell.)
function writeStatus(mainDb: DrizzleDb, gemnasiumDb: GemnasiumDrizzleDb, freeBytes: number | null): void {
    const status: SourceStatus = {
        seedComplete: getGemnasiumMeta<boolean>(gemnasiumDb, GEMNASIUM_META_KEYS.seedComplete) === true,
        recordCount: getGemnasiumMeta<number>(gemnasiumDb, GEMNASIUM_META_KEYS.recordCount) ?? 0,
        refreshedAt: getGemnasiumMeta<number>(gemnasiumDb, GEMNASIUM_META_KEYS.refreshedAt) ?? null,
        lastError: getGemnasiumMeta<string>(gemnasiumDb, GEMNASIUM_META_KEYS.lastError) ?? null,
        freeBytes
    }
    setConfigValue(mainDb, sourceStatusKey('gemnasium', DEFAULT_ECOSYSTEM), status)
}

function toScannerAdvisory(row: {
    advisoryId: string
    aliases: string[]
    ranges: { introduced: string; fixed: string | null }[]
    versions: string[]
    severity: string | null
    summary: string | null
    url: string | null
}): GemnasiumAdvisory {
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
