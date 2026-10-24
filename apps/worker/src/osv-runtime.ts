import cron, { type ScheduledTask } from 'node-cron'
import {
    ECOSYSTEMS,
    GEMNASIUM_SCANNER_NAME,
    OSV_SCANNER_NAME,
    errText,
    cacheEcosystemKey,
    sourceStatusKey,
    type EcosystemId,
    type OsvAdvisoryLink,
    type OsvAdvisoryRow,
    type SourceStatus
} from '@sentinello/core'
import {
    OSV_META_KEYS,
    OSV_NORMALIZER_VERSION,
    getOsvMeta,
    getSourceEnabled,
    lookupOsvByPackages,
    lookupOsvLinksByPackages,
    openOsvDb,
    osvMetaKeyFor,
    runOsvMigrations,
    enqueueScanRequest,
    hasStaleSourceUnavailableScans,
    setConfigValue,
    type DrizzleDb,
    type OsvDrizzleDb
} from '@sentinello/db'
import {
    createOsvScanner,
    npmAuditPlugin,
    type OsvAdvisory,
    type ScannerPlugin
} from '@sentinello/scanners'

export type { ScannerPlugin }
import { incrementalSyncOsv, osvFeedDisabled, seedOsv } from './osv-sync'
import { enabledGemnasiumEcosystems, gemnasiumSourceEnabled, type GemnasiumController } from './gemnasium-runtime'
import type { WorkerRuntime } from './runtime'

// Owns the OSV cache connection + the OSV scanner instance + the periodic sync job. Opened lazily so a
// worker that needs no OSV data never creates osv.db or touches the network. The main DB is read to learn
// which cells the operator enabled.
//
// The cache serves two consumers. The OSV scanner matches it for the (osv, ecosystem) cells the operator
// enabled. The gemnasium scanner reads it as WITHDRAWAL EVIDENCE for every gemnasium cell, enabled OSV
// cell or not: gemnasium-db records no withdrawal, and OSV mirrors GitHub's. So the cache is synced for
// the union of both sets, while OSV findings still come only from enabled OSV cells.

// 24h sync cadence (the OSV exports refresh roughly daily). Anchored at 03:17 to avoid clustering with the
// on-the-hour scan schedule.
const SYNC_CRON = '17 3 * * *'

export type OsvRuntime = {
    scanner: ScannerPlugin
    osvDb: OsvDrizzleDb
    runSyncNow: () => Promise<void>
    refreshEvidence: () => Promise<void>
    stop: () => void
}

// What the gemnasium scanner reads to stamp withdrawals, by ecosystem. Both answer from the live runtime,
// so a runtime started or stopped by a Settings toggle is picked up on the next scan.
export type WithdrawalEvidence = {
    // Whether gemnasium may scan the ecosystem. True when the OSV snapshot is complete at the current
    // normalizer version. Also true with the OSV feed switched off: that is the operator's explicit,
    // air-gapped opt-out, so a complete snapshot seeded earlier is still used and otherwise nothing is
    // stamped. A runtime that failed to start is NOT the opt-out, and answers false.
    ready: (ecosystem: string) => boolean
    // Every OSV row's identity for the packages, withdrawn or not, or null when there is no complete
    // snapshot to read. Never served from a partial one: a rebuild that has streamed a withdrawn duplicate
    // but not yet its active twin would suppress a live advisory. A rebuild is gated by seedComplete; an
    // incremental pass never shows a partial state, because incrementalSyncOsv publishes it in one
    // transaction and only when every changed advisory was re-read.
    links: (ecosystem: string, packageNames: string[]) => Map<string, OsvAdvisoryLink[]> | null
}

// Long-lived controller that owns the OSV runtime lifecycle across enable/disable toggles. The worker
// holds one; the scheduler/poller read getScanner() each batch (so a toggle takes effect on the next
// scan), and reload() — fired by the 'reload-sources' worker signal — starts or stops the runtime to
// match the live config flag. This reuses the existing worker_signals mailbox rather than polling.
export type OsvController = {
    getScanner: () => ScannerPlugin | null
    evidence: WithdrawalEvidence
    reload: () => void
    refresh: () => Promise<void>
    // Brings every gemnasium ecosystem's withdrawal evidence up to date; awaited before each batch.
    refreshEvidence: () => Promise<void>
    stop: () => void
}

export function createOsvController(mainDb: DrizzleDb, runtime: WorkerRuntime): OsvController {
    let current: OsvRuntime | null = null
    function syncToConfig(): void {
        const enabled = osvCacheNeeded(mainDb)
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
            console.log('[osv] no OSV or gemnasium cell enabled; runtime stopped')
        }
    }
    syncToConfig()
    return {
        getScanner: function getScanner() {
            return current && current.scanner || null
        },
        evidence: withdrawalEvidenceFrom(function liveOsvDb() {
            return current && current.osvDb
        }),
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
        refreshEvidence: async function refreshEvidence() {
            if (current) await current.refreshEvidence()
        },
        stop: function stop() {
            if (current) current.stop()
            current = null
        }
    }
}

// The OSV cache is needed when it has a consumer: an enabled OSV cell (findings) or an enabled gemnasium
// cell (withdrawal evidence).
export function osvCacheNeeded(db: DrizzleDb): boolean {
    return syncedOsvEcosystems(db).length > 0
}

// The ecosystems the OSV cache is synced for: the union of the enabled OSV and gemnasium cells, in
// registry order. Matching is gated separately, per (osv, ecosystem) cell, by the scanner.
export function syncedOsvEcosystems(db: DrizzleDb): EcosystemId[] {
    const wanted = new Set<EcosystemId>([...enabledOsvEcosystems(db), ...enabledGemnasiumEcosystems(db)])
    return ECOSYSTEMS.map(function id(eco): EcosystemId {
        return eco.id
    }).filter(function isWanted(id): boolean {
        return wanted.has(id)
    })
}

// Withdrawal evidence read through whatever OSV cache the getter currently returns. The controller passes
// its live runtime; the scratch tools pass a copy of osv.db.
export function withdrawalEvidenceFrom(getOsvDb: () => OsvDrizzleDb | null): WithdrawalEvidence {
    function completeCache(ecosystem: string): OsvDrizzleDb | null {
        const osvDb = getOsvDb()
        return osvDb !== null && osvCacheUsable(osvDb, ecosystem) ? osvDb : null
    }
    return {
        ready: function ready(ecosystem: string): boolean {
            return completeCache(ecosystem) !== null || osvFeedDisabled()
        },
        links: function links(ecosystem: string, packageNames: string[]): Map<string, OsvAdvisoryLink[]> | null {
            const osvDb = completeCache(ecosystem)
            if (osvDb === null) return null
            // The cache `ecosystem` column holds the canonical OSV id (== the registry osvEcosystem).
            return lookupOsvLinksByPackages(osvDb, cacheEcosystemKey(ecosystem), packageNames)
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

// The scanners for one batch, with the withdrawal evidence refreshed first. Every batch entry point (the
// scheduler's sweep and the poller's project, root and full sweeps) goes through here, so a new entry
// point cannot forget the refresh: without it a withdrawal published since the last sync would still be
// reported by the batch that follows it.
export async function scannersForBatch(input: SourceControllers & { db: DrizzleDb }): Promise<ScannerPlugin[]> {
    if (input.osvController) await input.osvController.refreshEvidence()
    return selectScanners(input.db, npmAuditPlugin, extraSourceCells(input))
}

// The OSV scanner bound to an opened cache, with no sync attached. The runtime below adds the sync; the
// scratch tools use this alone, against a copy of osv.db, so a verification run never touches the feed.
export function createOsvScannerFor(mainDb: DrizzleDb, osvDb: OsvDrizzleDb): ScannerPlugin {
    return createOsvScanner({
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
}

// Opens (and migrates) the OSV cache, builds the scanner bound to it, runs an initial sync if needed
// (seed when unseeded, otherwise an incremental catch-up), and schedules the daily sync. Returns the
// scanner so the scheduler can include it in the per-project run set.
export function startOsvRuntime(mainDb: DrizzleDb, runtime: WorkerRuntime): OsvRuntime {
    const { db: osvDb } = openOsvDb()
    runOsvMigrations(osvDb)

    const scanner = createOsvScannerFor(mainDb, osvDb)

    // Mirror an initial status snapshot immediately (even before the first sync) so the Settings panel
    // shows "not seeded yet" rather than nothing the moment the source is enabled.
    mirrorStatus(mainDb, osvDb)
    reconcileStaleVerdicts(mainDb, osvDb)

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
        osvDb,
        runSyncNow: function runSyncNow() {
            return runSync(mainDb, osvDb, runtime)
        },
        refreshEvidence: function refreshEvidence() {
            return refreshWithdrawalEvidence(mainDb, osvDb, runtime)
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

// Boot-time counterpart to the transition check in runSync. runSync enqueues a sweep when it WATCHES a
// cache become matchable; this asks whether one already did without anyone watching — a cache seeded
// under a previous build, or while the worker was down, leaves every project holding an
// osv_db_not_seeded verdict that nothing is left to clear. The two are mutually exclusive by
// construction: if the cache is usable now, runSync takes the incremental path and its own check does
// not fire.
//
// gemnasium is checked too: while its withdrawal evidence was incomplete it recorded the same
// osv_db_not_seeded verdict, and only this cache landing can clear it.
function reconcileStaleVerdicts(mainDb: DrizzleDb, osvDb: OsvDrizzleDb): void {
    const usable = syncedOsvEcosystems(mainDb).some(function anyUsable(ecosystem) {
        return osvCacheUsable(osvDb, ecosystem)
    })
    if (!usable) return
    const stale = hasStaleSourceUnavailableScans(mainDb, OSV_SCANNER_NAME)
        || hasStaleSourceUnavailableScans(mainDb, GEMNASIUM_SCANNER_NAME)
    if (!stale) return
    enqueueScanRequest(mainDb, {}, Date.now())
    console.log('[osv] cache is matchable but projects still hold unauditable verdicts — enqueued a full re-scan')
}

// Manually trigger a sync (seed-or-incremental) for every synced OSV ecosystem, then mirror each cell's
// status into the main DB so the portal reflects it. Used by the "refresh now" action, the scheduled tick,
// and the initial run. Ecosystems are synced sequentially to keep disk/network pressure bounded; an error
// in one ecosystem is captured in its own status row and does not abort the others. An ecosystem already
// syncing (a batch's evidence refresh, say) is joined rather than synced twice.
export async function runSync(mainDb: DrizzleDb, osvDb: OsvDrizzleDb, runtime: WorkerRuntime): Promise<void> {
    const ecosystems = syncedOsvEcosystems(mainDb)
    const signal = runtime.abortController.signal
    // Set when ANY ecosystem's cache ends this pass matchable after a window in which it was not. Every
    // scan that ran inside that window recorded unauditable/osv_db_not_seeded, and nothing else in the
    // system ever revisits those rows. Accumulated across the loop and acted on once.
    let becameUsable = false
    for (const ecosystem of ecosystems) {
        if (signal.aborted) break
        const flight = syncOnce(mainDb, osvDb, ecosystem, signal)
        // A joined sync reports its transition to the caller that started it, which enqueues for it.
        if (await flight.done && flight.started) becameUsable = true
    }
    if (becameUsable) enqueueRescan(mainDb)
}

// Re-checks the withdrawal evidence of every gemnasium ecosystem before a batch matches against it, with no
// age gate: an unchanged feed answers the stored ETag with a body-less 304, so the 8.4 MB modified_id.csv
// is paid once per OSV republication however many batches run, and a withdrawal published a minute before
// a batch is seen by that batch.
//
//   - A usable cache is refreshed and AWAITED, joining a sync already in flight for the ecosystem (the
//     cron, the initial sync, "Refresh now", another batch) instead of starting a second one.
//   - An unusable cache is never waited on: a seed is started in the background unless one is running,
//     and the gemnasium scanner reports the ecosystem unauditable until it lands.
//   - A failed refresh leaves the last complete snapshot in use; incrementalSyncOsv records lastError.
//   - With the feed switched off this is a no-op.
async function refreshWithdrawalEvidence(mainDb: DrizzleDb, osvDb: OsvDrizzleDb, runtime: WorkerRuntime): Promise<void> {
    if (osvFeedDisabled()) return
    const signal = runtime.abortController.signal
    let becameUsable = false
    for (const ecosystem of enabledGemnasiumEcosystems(mainDb)) {
        if (signal.aborted) break
        const usable = osvCacheUsable(osvDb, ecosystem)
        const flight = syncOnce(mainDb, osvDb, ecosystem, signal)
        if (!usable) {
            if (flight.started) runtime.track(rescanWhenUsable(mainDb, ecosystem, flight.done))
            continue
        }
        try {
            if (await flight.done && flight.started) becameUsable = true
        } catch (err) {
            console.error('[osv] withdrawal evidence refresh failed for ' + ecosystem + '; scanning against the last complete snapshot: ' + errText(err))
        }
    }
    if (becameUsable) enqueueRescan(mainDb)
}

async function rescanWhenUsable(mainDb: DrizzleDb, ecosystem: EcosystemId, done: Promise<boolean>): Promise<void> {
    try {
        if (await done) enqueueRescan(mainDb)
    } catch (err) {
        console.error('[osv] background seed failed for ' + ecosystem + ': ' + errText(err))
    }
}

// A full sweep, not a targeted subset: every project scanned while a cache was unusable recorded
// unauditable/osv_db_not_seeded (the OSV scanner, and gemnasium for its withdrawal evidence), and nothing
// else revisits those rows — not the cron (it waits out the interval), not the watcher (it needs a
// lockfile to change), not the portal (the operator has to notice and click).
//
// Deliberately NOT guarded by isAnyScanInFlight. That guard stops a human double-clicking Scan now; here an
// in-flight sweep is the strongest reason TO enqueue, because it is the sweep that ran against the cache
// while it was down and whose verdicts must be superseded. On a cold start the boot sweep is still
// finishing when the seed lands, so guarding would skip the one enqueue that makes the estate auditable.
// The poller claims one request per tick and runs them sequentially, so the cost is one more pass, never
// concurrency.
function enqueueRescan(mainDb: DrizzleDb): void {
    enqueueScanRequest(mainDb, {}, Date.now())
    console.log('[osv] cache is matchable again — enqueued a full re-scan to replace stale unauditable verdicts')
}

// One OSV sync per (cache, ecosystem) at a time. Keyed by the cache handle so every caller holding it —
// runSync and the evidence refresh alike — shares one registry, without threading it through each. A
// sync that already finished is gone from the map, so a later caller starts a fresh one: completing a
// sync never exempts a later batch from its own refresh.
type SyncFlight = {
    // Resolves true when this sync turned an unusable cache matchable.
    done: Promise<boolean>
    // True for the caller that started the sync, false for one that joined it.
    started: boolean
}

const inFlightSyncs = new WeakMap<OsvDrizzleDb, Map<EcosystemId, Promise<boolean>>>()

function syncOnce(mainDb: DrizzleDb, osvDb: OsvDrizzleDb, ecosystem: EcosystemId, signal: AbortSignal): SyncFlight {
    const flights = inFlightSyncs.get(osvDb) ?? new Map<EcosystemId, Promise<boolean>>()
    inFlightSyncs.set(osvDb, flights)
    const running = flights.get(ecosystem)
    if (running) return { done: running, started: false }
    const done = syncEcosystem(mainDb, osvDb, ecosystem, signal)
    flights.set(ecosystem, done)
    // Settles on both arms, so a failed sync frees the slot too and the derived promise never rejects.
    function settle(): void {
        flights.delete(ecosystem)
    }
    done.then(settle, settle)
    return { done, started: true }
}

// Seed-or-incremental for ONE ecosystem, with its status mirrored at start, cache discard and end.
async function syncEcosystem(mainDb: DrizzleDb, osvDb: OsvDrizzleDb, ecosystem: EcosystemId, signal: AbortSignal): Promise<boolean> {
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
    return (!usableBefore || discarded) && osvCacheUsable(osvDb, ecosystem)
}

// Initial snapshot for every synced cell (before the first sync), so each (osv, ecosystem) row in
// Settings shows "not seeded yet" rather than nothing the moment the source is enabled. Also the self-heal
// for a worker SIGKILLed mid-rebuild: it unconditionally clears syncStartedAt, so a stuck "Rebuilding…"
// cannot survive a restart.
function mirrorStatus(mainDb: DrizzleDb, osvDb: OsvDrizzleDb): void {
    for (const ecosystem of syncedOsvEcosystems(mainDb)) {
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
