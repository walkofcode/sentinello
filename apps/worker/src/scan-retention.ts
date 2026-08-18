import cron, { type ScheduledTask } from 'node-cron'
import { errText } from '@sentinello/core'
import { deleteScansByIds, getConfigValue, listPrunableScanIds, type DrizzleDb } from '@sentinello/db'
import type { WorkerRuntime } from './runtime'

// Bounds scan history, which nothing else does: cascadeDeleteProjects only removes scans for a project
// that vanished from disk, so a project that stays put accumulates rows forever. One real instance
// reached 60k rows / 2.2 GB in under three months.
//
// The window is operator-configured (Settings → Advanced); the cadence is hardcoded here, matching how
// mute-expiry and the feed syncs work. The minute is offset from mute-expiry's '*/15' so the two
// sweeps never contend for the write lock on the same tick.

export type ScanRetentionHandle = {
    stop: () => void
}

export type StartScanRetentionInput = {
    db: DrizzleDb
    runtime: WorkerRuntime
    cronExpression?: string
}

const DEFAULT_CRON = '7 * * * *'

const DAY_MS = 24 * 60 * 60 * 1000

// 90 days keeps history generously and — deliberately — deletes nothing on an instance upgrading into
// this feature for the first time, since no deployment has been running it longer than that. Trimming
// is then something an operator opts into by lowering the number, not something an upgrade does to
// them silently.
export const DEFAULT_RETENTION_DAYS = 90

// Never prune a project below its most recent 100 scans, however old they are. getProjectEcosystemCoverage
// reads exactly this many to reconstruct per-ecosystem coverage; below it, a partially-auditable project
// starts reading as a clean one. It also keeps the vuln-trend sparkline and, for a rarely-scanned
// project, the difference between "no findings" and "never successfully scanned".
export const KEEP_PER_PROJECT = 100

// Deleting a scan unlinks its overflow pages, so a large batch in one transaction builds a WAL that
// cannot checkpoint until commit while holding the write lock — concurrent scan inserts would hit
// busy_timeout and throw SQLITE_BUSY. Small batches, each its own transaction, with the loop yielding
// between them.
const BATCH_SIZE = 250

// Ceiling per tick so the first sweep on a large backlog spreads over several ticks instead of one
// long stall. The next tick resumes where this one stopped.
const MAX_ROWS_PER_TICK = 5000

export function startScanRetentionSweep(input: StartScanRetentionInput): ScanRetentionHandle {
    const expression = input.cronExpression || DEFAULT_CRON
    const task: ScheduledTask = cron.schedule(
        expression,
        function onTick() {
            const work = sweepOldScans({ db: input.db, at: Date.now() }).catch(function onErr(err: unknown) {
                console.error('[scan-retention] sweep failed: ' + errText(err))
            })
            input.runtime.track(work)
        },
        { name: 'sentinello-scan-retention' }
    )
    console.log('[scan-retention] scheduled (' + expression + ')')
    return {
        stop: function stop() {
            task.stop()
        }
    }
}

export type ScanRetentionSweepInput = {
    db: DrizzleDb
    at: number
}

export type ScanRetentionSweepResult = {
    deletedCount: number
}

export async function sweepOldScans(input: ScanRetentionSweepInput): Promise<ScanRetentionSweepResult> {
    const retentionDays = getConfigValue<number>(input.db, 'scanRetentionDays') ?? DEFAULT_RETENTION_DAYS
    if (retentionDays <= 0) return { deletedCount: 0 }
    const cutoffAt = input.at - retentionDays * DAY_MS
    let deletedCount = 0
    while (deletedCount < MAX_ROWS_PER_TICK) {
        const batchSize = Math.min(BATCH_SIZE, MAX_ROWS_PER_TICK - deletedCount)
        const ids = listPrunableScanIds(input.db, cutoffAt, KEEP_PER_PROJECT, batchSize)
        if (ids.length === 0) break
        const deleted = deleteScansByIds(input.db, ids)
        // A short delete means a foreign key blocked a row the predicate believed was free. That is a
        // bug in the predicate, not a transient condition — retrying would re-select the same rows and
        // spin forever, so stop and say so loudly.
        if (deleted < ids.length) {
            console.error(
                '[scan-retention] aborting: deleted ' + deleted + ' of ' + ids.length + ' selected scans'
            )
            deletedCount += deleted
            break
        }
        deletedCount += deleted
        // Yield between batches so a long sweep does not monopolise the worker's event loop.
        await new Promise(function yieldToLoop(resolve) {
            setImmediate(resolve)
        })
    }
    if (deletedCount > 0) {
        console.log('[scan-retention] deleted ' + deletedCount + ' scan(s) older than ' + retentionDays + ' day(s)')
    }
    return { deletedCount }
}
