import cron, { type ScheduledTask } from 'node-cron'
import {
    getConfigValue,
    listProjects,
    listRoots,
    type DrizzleDb,
    type SqliteDb
} from '@sentinello/db'
import { npmAuditPlugin } from '@sentinello/scanners'
import {
    CONFIG_KEYS,
    DEFAULT_GLOBAL_IGNORE,
    DEFAULT_PARALLELISM,
    DEFAULT_SCHEDULE,
    intervalHoursToCron,
    type Schedule
} from './config-loader'
import { discoverProjects } from './discovery'
import { runBatch } from './runner'
import type { WorkerRuntime } from './runtime'

export type SchedulerHandles = {
    activeTask: ScheduledTask
    stop(): void
}

export type StartSchedulerInput = {
    db: DrizzleDb
    sqlite: SqliteDb
    runtime: WorkerRuntime
}

export function startScheduler(input: StartSchedulerInput): SchedulerHandles {
    const schedule: Schedule = (getConfigValue<Schedule>(input.db, CONFIG_KEYS.schedule)) || DEFAULT_SCHEDULE
    const cronExpr = intervalHoursToCron(schedule.intervalHours, schedule.startHour)
    // Interpret startHour in the configured IANA timezone. Unset => node-cron uses the worker's
    // system timezone (the pre-existing behaviour).
    const cronOptions = schedule.timezone ? { timezone: schedule.timezone } : undefined
    const activeTask = cron.schedule(cronExpr, function runActiveSweep() {
        const work = sweepActiveProjects(input).catch(logSweepError.bind(null, 'active'))
        input.runtime.track(work)
        return work
    }, cronOptions)
    return {
        activeTask,
        stop() {
            activeTask.stop()
        }
    }
}

export async function sweepActiveProjects(input: StartSchedulerInput): Promise<void> {
    const startedAt = Date.now()
    const at = startedAt
    const roots = listRoots(input.db)
    const globalIgnore = (getConfigValue<string[]>(input.db, CONFIG_KEYS.globalIgnore)) || DEFAULT_GLOBAL_IGNORE
    discoverProjects({ db: input.db, roots, globalIgnore, at })
    const projects = listProjects(input.db)
    console.log('[scheduler] active sweep started (' + projects.length + ' project' + (projects.length === 1 ? '' : 's') + ')')
    if (projects.length === 0) {
        console.log('[scheduler] active sweep finished (0 projects, ' + formatDurationMs(Date.now() - startedAt) + ')')
        return
    }
    const parallelism = (getConfigValue<number>(input.db, CONFIG_KEYS.parallelism)) || DEFAULT_PARALLELISM
    await runBatch({
        db: input.db,
        sqlite: input.sqlite,
        scanner: npmAuditPlugin,
        projects,
        parallelism,
        abortSignal: input.runtime.abortController.signal
    })
    console.log('[scheduler] active sweep finished (' + projects.length + ' project' + (projects.length === 1 ? '' : 's') + ', ' + formatDurationMs(Date.now() - startedAt) + ')')
}

function logSweepError(kind: string, err: unknown): void {
    const message = err instanceof Error && err.message || String(err)
    console.error('[scheduler] ' + kind + ' sweep failed: ' + message)
}

function formatDurationMs(ms: number): string {
    if (ms < 1000) return ms + 'ms'
    return (ms / 1000).toFixed(2) + 's'
}
