import cron, { type ScheduledTask } from 'node-cron'
import {
    deleteMute,
    listExpiredMutes,
    recordMuteLift,
    type DrizzleDb
} from '@sentinello/db'
import type { WorkerRuntime } from './runtime'

// Auto-lifts expired mutes. Runs every 15 minutes by default.
// For each expired mute: DELETE the mute row, INSERT a mute_lifts journal entry.
// The next scheduler tick re-runs selectDispatchablePairs which finds prior events with no successful
// delivery row and dispatches them through the normal path. No special "re-emerge" query is needed.

export type MuteExpiryHandle = {
    stop: () => void
}

export type StartMuteExpiryInput = {
    db: DrizzleDb
    runtime: WorkerRuntime
    cronExpression?: string
}

const DEFAULT_CRON = '*/15 * * * *'

export function startMuteExpirySweep(input: StartMuteExpiryInput): MuteExpiryHandle {
    const task: ScheduledTask = cron.schedule(
        input.cronExpression || DEFAULT_CRON,
        function onTick() {
            const work = sweepExpiredMutes({ db: input.db, at: Date.now() }).catch(function onErr(err: unknown) {
                const message = err instanceof Error && err.message || String(err)
                console.error('[mute-expiry] sweep failed: ' + message)
            })
            input.runtime.track(work)
        },
        { name: 'sentinello-mute-expiry' }
    )
    console.log('[mute-expiry] scheduled (' + (input.cronExpression || DEFAULT_CRON) + ')')
    return {
        stop: function stop() {
            task.stop()
        }
    }
}

export type SweepInput = {
    db: DrizzleDb
    at: number
}

export type SweepResult = {
    liftedCount: number
}

export async function sweepExpiredMutes(input: SweepInput): Promise<SweepResult> {
    const expired = listExpiredMutes(input.db, input.at)
    if (expired.length === 0) return { liftedCount: 0 }
    for (const mute of expired) {
        recordMuteLift(input.db, mute, input.at)
        deleteMute(input.db, mute.id)
    }
    console.log('[mute-expiry] lifted ' + expired.length + ' expired mute(s)')
    return { liftedCount: expired.length }
}
