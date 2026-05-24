import { isNull } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DrizzleDb } from '../client'
import { workerSignals } from '../schema'

export type WorkerSignal = typeof workerSignals.$inferSelect

// Insert a control-plane signal addressed to the worker. The web app calls this from the action that
// changes a worker-affecting setting (e.g. updateScheduleAction); the worker's scan-request poller
// drains it on its next tick. Multiple enqueues collapse harmlessly — dispatch reads authoritative
// state from app_config rather than trusting anything inline.
export function enqueueWorkerSignal(db: DrizzleDb, kind: string, at: number): WorkerSignal {
    const id = ulid()
    db.insert(workerSignals)
        .values({
            id,
            kind,
            enqueuedAt: at,
            claimedAt: null
        })
        .run()
    return { id, kind, enqueuedAt: at, claimedAt: null }
}

// Atomically claim every pending signal in one UPDATE...RETURNING. Returning the rows in the same
// statement that marks them claimed avoids a TOCTOU window where a new signal lands between SELECT
// and UPDATE and gets marked claimed without ever being dispatched.
//
// Crash safety: a claimed-but-undispatched row IS lost in the sense that the worker won't retry it.
// That's intentional — every supported kind has idempotent dispatch (reads authoritative state),
// so the next boot or the next signal naturally reconciles. Persistent at-least-once delivery would
// be overkill for control-plane mailbox traffic.
export function claimPendingSignals(db: DrizzleDb, at: number): WorkerSignal[] {
    const rows = db.update(workerSignals)
        .set({ claimedAt: at })
        .where(isNull(workerSignals.claimedAt))
        .returning()
        .all()
    return rows
}
