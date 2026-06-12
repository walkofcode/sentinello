import cron, { type ScheduledTask } from 'node-cron'
import {
    ECOSYSTEMS,
    OSV_SCANNER_NAME,
    getEcosystem,
    sourceStatusKey,
    type EcosystemId,
    type OsvSourceStatus
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
import { checkOsvFreeSpace, incrementalSyncOsv, osvFeedDisabled, seedOsv } from './osv-sync'
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
                console.error('[osv] runtime failed to start: ' + ((err instanceof Error && err.message) || String(err)))
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
            // Gate per ecosystem on BOTH the ecosystem's seed flag AND its own normalizer-version stamp: when
            // the row shape has changed the cache is rebuilding (forced re-seed) and old rows lack the new
            // fields — stay unauditable for that ecosystem until its re-seed lands rather than match stale
            // data. Both keys are per-ecosystem, so a multi-ecosystem rebuild never marks a not-yet-rebuilt
            // ecosystem current just because a sibling finished first.
            return getOsvMeta<boolean>(osvDb, osvMetaKeyFor(OSV_META_KEYS.seedComplete, ecosystem)) === true
                && getOsvMeta<number>(osvDb, osvMetaKeyFor(OSV_META_KEYS.normalizerVersion, ecosystem)) === OSV_NORMALIZER_VERSION
        },
        lookup: function lookup(ecosystem: string, packageNames: string[]): Map<string, OsvAdvisory[]> {
            // The cache `ecosystem` column holds the canonical OSV id (== the registry osvEcosystem). Resolve
            // through the registry so a future divergence between internal id and feed id can't silently miss.
            const def = getEcosystem(ecosystem)
            const cacheEcosystem = def ? def.osvEcosystem : ecosystem
            const rows = lookupOsvByPackages(osvDb, cacheEcosystem, packageNames)
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

// Manually trigger a sync (seed-or-incremental) for every enabled OSV ecosystem, then mirror each cell's
// status into the main DB so the portal reflects it. Used by the "refresh now" action, the scheduled tick,
// and the initial run. Ecosystems are synced sequentially to keep disk/network pressure bounded; an error
// in one ecosystem is captured in its own status row and does not abort the others.
export async function runSync(mainDb: DrizzleDb, osvDb: OsvDrizzleDb, runtime: WorkerRuntime): Promise<void> {
    const ecosystems = enabledOsvEcosystems(mainDb)
    const signal = runtime.abortController.signal
    for (const ecosystem of ecosystems) {
        if (signal.aborted) break
        const seeded = getOsvMeta<boolean>(osvDb, osvMetaKeyFor(OSV_META_KEYS.seedComplete, ecosystem)) === true
        // Per-ecosystem normalizer stamp: a bump (or a never-seeded ecosystem) forces a full re-seed for
        // THIS ecosystem only; siblings already at the current version still take the cheap incremental path.
        const normalizerCurrent = getOsvMeta<number>(osvDb, osvMetaKeyFor(OSV_META_KEYS.normalizerVersion, ecosystem)) === OSV_NORMALIZER_VERSION
        try {
            if (!seeded || !normalizerCurrent) {
                console.log('[osv] ' + (seeded ? 'normalizer changed — rebuilding cache' : 'seeding cache (first run)') + ' for ' + ecosystem + '...')
                await seedOsv(osvDb, ecosystem, signal)
            } else {
                await incrementalSyncOsv(osvDb, ecosystem, signal)
            }
        } finally {
            await mirrorStatusWithSpace(mainDb, osvDb, ecosystem)
        }
    }
}

// Reads one ecosystem cell's meta + free space and writes the compact OsvSourceStatus snapshot into the main
// app_config so the portal (which never opens osv.db) can render sync status from the main DB alone.
async function mirrorStatusWithSpace(mainDb: DrizzleDb, osvDb: OsvDrizzleDb, ecosystem: EcosystemId): Promise<void> {
    // checkOsvFreeSpace() already swallows stat errors (reporting 0 free), so no try/catch needed here.
    const space = await checkOsvFreeSpace()
    writeStatus(mainDb, osvDb, ecosystem, space.freeBytes)
}

// Initial snapshot for every enabled cell (before the first sync), so each enabled (osv, ecosystem) row in
// Settings shows "not seeded yet" rather than nothing the moment the source is enabled.
function mirrorStatus(mainDb: DrizzleDb, osvDb: OsvDrizzleDb): void {
    for (const ecosystem of enabledOsvEcosystems(mainDb)) {
        writeStatus(mainDb, osvDb, ecosystem, null)
    }
}

function writeStatus(mainDb: DrizzleDb, osvDb: OsvDrizzleDb, ecosystem: EcosystemId, freeBytes: number | null): void {
    const status: OsvSourceStatus = {
        seedComplete: getOsvMeta<boolean>(osvDb, osvMetaKeyFor(OSV_META_KEYS.seedComplete, ecosystem)) === true,
        recordCount: getOsvMeta<number>(osvDb, osvMetaKeyFor(OSV_META_KEYS.recordCount, ecosystem)) ?? 0,
        refreshedAt: getOsvMeta<number>(osvDb, osvMetaKeyFor(OSV_META_KEYS.refreshedAt, ecosystem)) ?? null,
        lastError: getOsvMeta<string>(osvDb, osvMetaKeyFor(OSV_META_KEYS.lastError, ecosystem)) ?? null,
        freeBytes
    }
    setConfigValue(mainDb, sourceStatusKey('osv', ecosystem), status)
}

function toScannerAdvisory(row: {
    advisoryId: string
    aliases: string[]
    ranges: { type: string; introduced: string; fixed: string | null; lastAffected: string | null }[]
    versions: string[]
    severity: string | null
    summary: string | null
    url: string | null
    malicious: boolean
}): OsvAdvisory {
    return {
        advisoryId: row.advisoryId,
        aliases: row.aliases,
        ranges: row.ranges,
        versions: row.versions,
        severity: row.severity,
        summary: row.summary,
        url: row.url,
        malicious: row.malicious
    }
}

export { OSV_SCANNER_NAME }
