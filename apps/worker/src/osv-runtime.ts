import cron, { type ScheduledTask } from 'node-cron'
import { OSV_SCANNER_NAME, SOURCE_CONFIG_KEYS, type OsvSourceStatus } from '@sentinello/core'
import {
    OSV_META_KEYS,
    getConfigValue,
    getOsvMeta,
    lookupOsvByPackages,
    openOsvDb,
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
import type { WorkerRuntime } from './runtime'

// Owns the OSV cache connection + the OSV scanner instance + the periodic sync job. Opened lazily so a
// worker with the OSV source disabled never creates osv.db or touches the network. The main DB is read
// to learn whether the operator enabled the source.

const NPM_ECOSYSTEM = 'npm'
// 24h sync cadence (the OSV npm export refreshes roughly daily). Anchored at 03:17 to avoid clustering
// with the on-the-hour scan schedule.
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

export function osvSourceEnabled(db: DrizzleDb): boolean {
    return getConfigValue<boolean>(db, SOURCE_CONFIG_KEYS.osvEnabled) === true
}

// Assembles the ordered scanner list for a batch. npm-audit is always first (it's the authoritative
// source for dedup); the OSV scanner is appended only when the operator has enabled the source AND the
// runtime actually created an OSV scanner. Evaluated per batch so toggling the source in Settings takes
// effect on the next scan without a worker restart.
export function selectScanners(db: DrizzleDb, npmAudit: ScannerPlugin, osvScanner: ScannerPlugin | null): ScannerPlugin[] {
    if (osvScanner && osvSourceEnabled(db)) {
        return [npmAudit, osvScanner]
    }
    return [npmAudit]
}

// Opens (and migrates) the OSV cache, builds the scanner bound to it, runs an initial sync if needed
// (seed when unseeded, otherwise an incremental catch-up), and schedules the daily sync. Returns the
// scanner so the scheduler can include it in the per-project run set.
export function startOsvRuntime(mainDb: DrizzleDb, runtime: WorkerRuntime): OsvRuntime {
    const { db: osvDb } = openOsvDb()
    runOsvMigrations(osvDb)

    const scanner = createOsvScanner({
        isSeeded: function isSeeded() {
            return getOsvMeta<boolean>(osvDb, OSV_META_KEYS.seedComplete) === true
        },
        lookup: function lookup(packageNames: string[]): Map<string, OsvAdvisory[]> {
            const rows = lookupOsvByPackages(osvDb, NPM_ECOSYSTEM, packageNames)
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

// Manually trigger a sync (seed-or-incremental), then mirror the resulting status into the main DB so
// the portal reflects it. Used by the "refresh now" action, the scheduled tick, and the initial run.
export async function runSync(mainDb: DrizzleDb, osvDb: OsvDrizzleDb, runtime: WorkerRuntime): Promise<void> {
    const seeded = getOsvMeta<boolean>(osvDb, OSV_META_KEYS.seedComplete) === true
    const signal = runtime.abortController.signal
    try {
        if (!seeded) {
            console.log('[osv] seeding cache (first run)...')
            await seedOsv(osvDb, signal)
        } else {
            await incrementalSyncOsv(osvDb, signal)
        }
    } finally {
        await mirrorStatusWithSpace(mainDb, osvDb)
    }
}

// Reads the OSV cache's meta + free space and writes the compact OsvSourceStatus snapshot into the main
// app_config so the portal (which never opens osv.db) can render sync status from the main DB alone.
async function mirrorStatusWithSpace(mainDb: DrizzleDb, osvDb: OsvDrizzleDb): Promise<void> {
    // checkOsvFreeSpace() already swallows stat errors (reporting 0 free), so no try/catch needed here.
    const space = await checkOsvFreeSpace()
    writeStatus(mainDb, osvDb, space.freeBytes)
}

function mirrorStatus(mainDb: DrizzleDb, osvDb: OsvDrizzleDb): void {
    writeStatus(mainDb, osvDb, null)
}

function writeStatus(mainDb: DrizzleDb, osvDb: OsvDrizzleDb, freeBytes: number | null): void {
    const status: OsvSourceStatus = {
        seedComplete: getOsvMeta<boolean>(osvDb, OSV_META_KEYS.seedComplete) === true,
        recordCount: getOsvMeta<number>(osvDb, OSV_META_KEYS.recordCount) ?? 0,
        refreshedAt: getOsvMeta<number>(osvDb, OSV_META_KEYS.refreshedAt) ?? null,
        lastError: getOsvMeta<string>(osvDb, OSV_META_KEYS.lastError) ?? null,
        freeBytes
    }
    setConfigValue(mainDb, SOURCE_CONFIG_KEYS.osvStatus, status)
}

function toScannerAdvisory(row: {
    advisoryId: string
    aliases: string[]
    ranges: { introduced: string; fixed: string | null }[]
    severity: string | null
    summary: string | null
    url: string | null
    malicious: boolean
}): OsvAdvisory {
    return {
        advisoryId: row.advisoryId,
        aliases: row.aliases,
        ranges: row.ranges,
        severity: row.severity,
        summary: row.summary,
        url: row.url,
        malicious: row.malicious
    }
}

export { OSV_SCANNER_NAME }
