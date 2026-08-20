import cron, { type ScheduledTask } from 'node-cron'
import {
    ECOSYSTEMS,
    OSV_SCANNER_NAME,
    errText,
    cacheEcosystemKey,
    sourceStatusKey,
    type EcosystemId,
    type OsvAdvisoryRow,
    type SourceStatus
} from '@sentinello/core'
import {
    OSV_META_KEYS,
    OSV_NORMALIZER_VERSION,
    getOsvMeta,
    getSourceEnabled,
    lookupOsvByPackages,
    openOsvDb,
    osvMetaKeyFor,
    runOsvMigrations,
    enqueueScanRequest,
    setConfigValue,
    type DrizzleDb,
    type OsvDrizzleDb
} from '@sentinello/db'
import {
    createOsvScanner,
    type OsvAdvisory,
    type ScannerPlugin
} from '@sentinello/scanners'

export type { ScannerPlugin }
import { incrementalSyncOsv, osvFeedDisabled, seedOsv } from './osv-sync'
import { gemnasiumSourceEnabled, type GemnasiumController } from './gemnasium-runtime'
import type { WorkerRuntime } from './runtime'

// Owns the OSV cache connection + the OSV scanner instance + the periodic sync job. Opened lazily so a
// worker with the OSV source disabled never creates osv.db or touches the network. The main DB is read
// to learn whether the operator enabled the source.

// 24h sync cadence (the OSV exports refresh roughly daily). Anchored at 03:17 to avoid clustering with the
// on-the-hour scan schedule.
const SYNC_CRON = '17 3 * * *'

export type OsvRuntime = {
    scanner: ScannerPlugin
    runSyncNow: () => Promise<void>
    stop: () => void
}

// Long-lived controller that owns the OSV runtime lifecycle across enable/disable toggles. The worker
// holds one; the scheduler/poller read getScanner() each batch (so a toggle takes effect on the next
// scan), and reload() — fired by the 'reload-sources' worker signal — starts or stops the runtime to
// match the live config flag. This reuses the existing worker_signals mailbox rather than polling.
export type OsvController = {
    getScanner: () => ScannerPlugin | null
    reload: () => void
    refresh: () => Promise<void>
    stop: () => void
}

export function createOsvController(mainDb: DrizzleDb, runtime: WorkerRuntime): OsvController {
    let current: OsvRuntime | null = null
    function syncToConfig(): void {
        const enabled = osvSourceEnabled(mainDb)
        if (enabled && !current) {
            try {
                current = startOsvRuntime(mainDb, runtime)
            } catch (err) {
                console.error('[osv] runtime failed to start: ' + errText(err))
                current = null
            }
            return
        }
        if (!enabled && current) {
            current.stop()
            current = null
            console.log('[osv] source disabled; runtime stopped')
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

// OSV participates in a batch when ANY of its (osv, ecosystem) cells is enabled — the source is a family of
// per-ecosystem cells, so the runtime starts and the scanner runs as soon as the operator turns on the
// first language. The scanner itself only matches the ecosystems that are actually seeded.
export function osvSourceEnabled(db: DrizzleDb): boolean {
    return enabledOsvEcosystems(db).length > 0
}

// The OSV ecosystems the operator has enabled — one (osv, ecosystem) cell per entry. These are the
// ecosystems the sync downloads and the scanner is allowed to match. Driven entirely by the central
// registry so adding a language is a registry edit, never a change here.
export function enabledOsvEcosystems(db: DrizzleDb): EcosystemId[] {
    const out: EcosystemId[] = []
    for (const eco of ECOSYSTEMS) {
        if (getSourceEnabled(db, 'osv', eco.id)) out.push(eco.id)
    }
    return out
}

// npm-audit's JS cell is on by default but disableable (the "always a source on" invariant guarantees it
// can't be turned off when it's the last active source). selectScanners gates it on this so a disabled
// npm-audit cell drops the scanner from the batch.
export function npmAuditSourceEnabled(db: DrizzleDb): boolean {
    return getSourceEnabled(db, 'npm-audit')
}

// One additional (non-npm-audit) source cell offered to a batch: the scanner the source's runtime
// produced (null when the source is off or still starting) plus the live config predicate that decides
// whether it participates. This is the N-cell generalization of the old 2-source literal — adding a
// source is now "append a cell" rather than editing the selection logic.
export type SourceCell = {
    scanner: ScannerPlugin | null
    isEnabled: (db: DrizzleDb) => boolean
}

// Assembles the ordered scanner list for a batch. npm-audit is always first (it's the authoritative
// source for dedup); each extra cell is appended, in the order given, only when its runtime produced a
// scanner AND the operator has the source enabled. The order IS the dedup priority (npm-audit, then OSV,
// then gemnasium). Evaluated per batch so toggling a source in Settings takes effect on the next scan
// without a worker restart.
export function selectScanners(db: DrizzleDb, npmAudit: ScannerPlugin, extras: SourceCell[]): ScannerPlugin[] {
    const out: ScannerPlugin[] = []
    if (npmAuditSourceEnabled(db)) out.push(npmAudit)
    for (const cell of extras) {
        if (cell.scanner && cell.isEnabled(db)) out.push(cell.scanner)
    }
    return out
}

// Builds the ordered list of non-npm-audit source cells for a batch from the optional source controllers.
// The array order is the dedup priority appended after npm-audit (OSV, then gemnasium). Centralized here
// so every scan entry point (scheduler sweep + the poller's project/root/sweep paths) offers the same
// sources. Phase 5 will replace this hand-listed pair with the full (source, ecosystem) matrix registry.
export type SourceControllers = {
    osvController?: OsvController | null
    gemnasiumController?: GemnasiumController | null
}

export function extraSourceCells(deps: SourceControllers): SourceCell[] {
    return [
        { scanner: deps.osvController?.getScanner() ?? null, isEnabled: osvSourceEnabled },
        { scanner: deps.gemnasiumController?.getScanner() ?? null, isEnabled: gemnasiumSourceEnabled }
    ]
}

// Opens (and migrates) the OSV cache, builds the scanner bound to it, runs an initial sync if needed
// (seed when unseeded, otherwise an incremental catch-up), and schedules the daily sync. Returns the
// scanner so the scheduler can include it in the per-project run set.
export function startOsvRuntime(mainDb: DrizzleDb, runtime: WorkerRuntime): OsvRuntime {
    const { db: osvDb } = openOsvDb()
    runOsvMigrations(osvDb)

    const scanner = createOsvScanner({
        isEnabled: function isEnabled(ecosystem: string): boolean {
            // The operator's live (osv, ecosystem) cell flag, read each scan so a Settings toggle takes
            // effect on the next batch. A cell disabled after it was seeded still has rows in osv.db and
            // passes isSeeded — this gate is what stops the scanner matching that disabled cell anyway.
            return getSourceEnabled(mainDb, 'osv', ecosystem as EcosystemId)
        },
        isSeeded: function isSeeded(ecosystem: string): boolean {
            return osvCacheUsable(osvDb, ecosystem)
        },
        lookup: function lookup(ecosystem: string, packageNames: string[]): Map<string, OsvAdvisory[]> {
            // The cache `ecosystem` column holds the canonical OSV id (== the registry osvEcosystem).
            const rows = lookupOsvByPackages(osvDb, cacheEcosystemKey(ecosystem), packageNames)
            const out = new Map<string, OsvAdvisory[]>()
            for (const [name, list] of rows.entries()) {
                out.set(name, list.map(toScannerAdvisory))
            }
            return out
        }
    })

    // Mirror an initial status snapshot immediately (even before the first sync) so the Settings panel
    // shows "not seeded yet" rather than nothing the moment the source is enabled.
    mirrorStatus(mainDb, osvDb)

    if (!osvFeedDisabled()) {
        const initial = runSync(mainDb, osvDb, runtime).catch(function onErr(err: unknown) {
            console.error('[osv] initial sync failed: ' + ((err instanceof Error && err.message) || String(err)))
        })
        runtime.track(initial)
    } else {
        console.log('[osv] feed disabled (SENTINELLO_OSV_FEED_URL=off); scanner will stay unseeded')
    }

    const task: ScheduledTask = cron.schedule(SYNC_CRON, function onTick() {
        const work = runSync(mainDb, osvDb, runtime).catch(function onErr(err: unknown) {
            console.error('[osv] scheduled sync failed: ' + ((err instanceof Error && err.message) || String(err)))
        })
        runtime.track(work)
    }, { name: 'sentinello-osv-sync' })
    console.log('[osv] sync scheduled (' + SYNC_CRON + ')')

    return {
        scanner,
        runSyncNow: function runSyncNow() {
            return runSync(mainDb, osvDb, runtime)
        },
        stop: function stop() {
            task.stop()
        }
    }
}

// The predicate the SCANNER gates on, in one place. isSeeded (above), runSync's seed-vs-incremental
// decision, and the post-sync "did this cache become matchable" check all read it, so they cannot drift
// apart — which is how Settings came to report "Up to date" about a cache every scan was refusing.
//
// Gates per ecosystem on BOTH the ecosystem's seed flag AND its own normalizer-version stamp: when the
// row shape has changed the cache is rebuilding (forced re-seed) and old rows lack the new fields, so
// stay unauditable for that ecosystem until its re-seed lands rather than match stale data. Both keys
// are per-ecosystem, so a multi-ecosystem rebuild never marks a not-yet-rebuilt ecosystem current just
// because a sibling finished first.
export function osvCacheUsable(osvDb: OsvDrizzleDb, ecosystem: string): boolean {
    return getOsvMeta<boolean>(osvDb, osvMetaKeyFor(OSV_META_KEYS.seedComplete, ecosystem)) === true
        && getOsvMeta<number>(osvDb, osvMetaKeyFor(OSV_META_KEYS.normalizerVersion, ecosystem)) === OSV_NORMALIZER_VERSION
}

// Manually trigger a sync (seed-or-incremental) for every enabled OSV ecosystem, then mirror each cell's
// status into the main DB so the portal reflects it. Used by the "refresh now" action, the scheduled tick,
// and the initial run. Ecosystems are synced sequentially to keep disk/network pressure bounded; an error
// in one ecosystem is captured in its own status row and does not abort the others.
export async function runSync(mainDb: DrizzleDb, osvDb: OsvDrizzleDb, runtime: WorkerRuntime): Promise<void> {
    const ecosystems = enabledOsvEcosystems(mainDb)
    const signal = runtime.abortController.signal
    // Set when ANY ecosystem's cache ends this pass matchable after a window in which it was not. Every
    // scan that ran inside that window recorded unauditable/osv_db_not_seeded, and nothing else in the
    // system ever revisits those rows. Accumulated across the loop and acted on once.
    let becameUsable = false
    for (const ecosystem of ecosystems) {
        if (signal.aborted) break
        const seeded = getOsvMeta<boolean>(osvDb, osvMetaKeyFor(OSV_META_KEYS.seedComplete, ecosystem)) === true
        // Per-ecosystem normalizer stamp: a bump (or a never-seeded ecosystem) forces a full re-seed for
        // THIS ecosystem only; siblings already at the current version still take the cheap incremental path.
        const usableBefore = osvCacheUsable(osvDb, ecosystem)
        let discarded = false
        const startedAt = Date.now()
        function onCacheDiscarded(): void {
            discarded = true
            writeStatus(mainDb, osvDb, ecosystem, startedAt)
        }
        // Stamped BEFORE the first network byte: the portal's only other signal that work was happening
        // was client-side memory a page reload threw away.
        writeStatus(mainDb, osvDb, ecosystem, startedAt)
        try {
            if (!usableBefore) {
                console.log('[osv] ' + (seeded ? 'normalizer changed — rebuilding cache' : 'seeding cache (first run)') + ' for ' + ecosystem + '...')
                await seedOsv(osvDb, ecosystem, signal, onCacheDiscarded)
            } else {
                await incrementalSyncOsv(osvDb, ecosystem, signal, onCacheDiscarded)
            }
        } finally {
            writeStatus(mainDb, osvDb, ecosystem, null)
        }
        // `discarded` covers the one rebuild that starts from a usable cache: a change set past
        // OSV_INCREMENTAL_MAX_IDS re-seeds from inside incrementalSyncOsv, and the scanner is unauditable
        // for its duration just as much as for any other rebuild.
        if ((!usableBefore || discarded) && osvCacheUsable(osvDb, ecosystem)) becameUsable = true
    }
    if (becameUsable) {
        // A full sweep, not a targeted subset: every project scanned while this cache was unusable
        // recorded unauditable/osv_db_not_seeded, and nothing else revisits those rows — not the cron (it
        // waits out the interval), not the watcher (it needs a lockfile to change), not the portal (the
        // operator has to notice and click).
        //
        // Deliberately NOT guarded by isAnyScanInFlight. That guard stops a human double-clicking Scan
        // now; here an in-flight sweep is the strongest reason TO enqueue, because it is the sweep that
        // ran against the cache while it was down and whose verdicts must be superseded. On a cold start
        // the boot sweep is still finishing when the seed lands, so guarding would skip the one enqueue
        // that makes the estate auditable. The poller claims one request per tick and runs them
        // sequentially, so the cost is one more pass, never concurrency.
        enqueueScanRequest(mainDb, {}, Date.now())
        console.log('[osv] cache is matchable again — enqueued a full re-scan to replace stale unauditable verdicts')
    }
}

// Initial snapshot for every enabled cell (before the first sync), so each enabled (osv, ecosystem) row in
// Settings shows "not seeded yet" rather than nothing the moment the source is enabled. Also the self-heal
// for a worker SIGKILLed mid-rebuild: it unconditionally clears syncStartedAt, so a stuck "Rebuilding…"
// cannot survive a restart.
function mirrorStatus(mainDb: DrizzleDb, osvDb: OsvDrizzleDb): void {
    for (const ecosystem of enabledOsvEcosystems(mainDb)) {
        writeStatus(mainDb, osvDb, ecosystem, null)
    }
}

// Reads one ecosystem cell's meta and writes the compact SourceStatus snapshot into the main app_config so
// the portal (which never opens osv.db) can render sync status from the main DB alone. Called at three
// points per sync — start, cache discard, and end — because sampling only at the ends is what let Settings
// report a pre-rebuild snapshot for the whole of a rebuild.
function writeStatus(mainDb: DrizzleDb, osvDb: OsvDrizzleDb, ecosystem: EcosystemId, syncStartedAt: number | null): void {
    const status: SourceStatus = {
        seedComplete: getOsvMeta<boolean>(osvDb, osvMetaKeyFor(OSV_META_KEYS.seedComplete, ecosystem)) === true,
        normalizerVersion: getOsvMeta<number>(osvDb, osvMetaKeyFor(OSV_META_KEYS.normalizerVersion, ecosystem)),
        recordCount: getOsvMeta<number>(osvDb, osvMetaKeyFor(OSV_META_KEYS.recordCount, ecosystem)) ?? 0,
        refreshedAt: getOsvMeta<number>(osvDb, osvMetaKeyFor(OSV_META_KEYS.refreshedAt, ecosystem)),
        syncStartedAt,
        lastError: getOsvMeta<string>(osvDb, osvMetaKeyFor(OSV_META_KEYS.lastError, ecosystem))
    }
    setConfigValue(mainDb, sourceStatusKey('osv', ecosystem), status)
}

// Takes the real row type rather than restating its shape inline. The inline version had to be edited by
// hand every time the row gained a field, and a structural type that has drifted from the one it mirrors
// still compiles right up until the moment it doesn't.
function toScannerAdvisory(row: OsvAdvisoryRow): OsvAdvisory {
    return {
        advisoryId: row.advisoryId,
        aliases: row.aliases,
        ranges: row.ranges,
        versions: row.versions,
        severity: row.severity,
        summary: row.summary,
        url: row.url,
        malicious: row.malicious,
        withdrawn: row.withdrawn
    }
}

export { OSV_SCANNER_NAME }
