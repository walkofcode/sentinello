import { createHash } from 'node:crypto'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { Capability, NotificationTarget } from '@sentinello/core'
import type { DrizzleDb } from '../client'
import { capabilityBaselines, capabilitySummaryDeliveries } from '../schema'
import { eventEligibleForTargetSql } from './notification-deliveries'
import { listEnabledNotificationTargets } from './notifications'
import { listProjectScanStates } from './scan-state'
import { getLastScanFinishedAt } from './scans'

// The silent baseline's state and its summary ledger (schema.ts capability_baselines and
// capability_summary_deliveries). A release that adds a capability — 3.8's Python, Go, Rust and Ruby —
// would otherwise notify every finding that existed all along on the first sweep after the upgrade. Until
// that sweep completes, new finding events in the capability's ecosystems are recorded silently
// (notification_events.baseline_of); when it completes, every enabled target is owed exactly one summary,
// counted under that target's own policy. The worker's dispatcher (apps/worker/src/capability-baseline.ts)
// is the only thing that sends one.

export type BaselineState = 'pending' | 'swept' | 'done'

export type SuppressedReason = 'target_disabled' | 'policy_changed' | 'eligibility_changed'

// What one summary says, counted under one target's policy: N findings across M projects, X of them
// critical, and K projects in the target's scope that no enabled source answers for.
export type BaselineCounts = {
    findings: number
    projects: number
    critical: number
    sourceDisabledProjects: number
}

export type CapabilitySummaryDelivery = {
    capabilityId: string
    targetId: string
    counts: BaselineCounts
    policyFingerprint: string
    attempts: number
    firstAttemptedAt: number | null
    lastAttemptedAt: number | null
    firstSucceededAt: number | null
    dryRunAt: number | null
    gaveUpAt: number | null
    suppressedAt: number | null
    suppressedReason: SuppressedReason | null
    lastErrorText: string | null
}

type DeliveryRow = typeof capabilitySummaryDeliveries.$inferSelect

// Records every capability this install has not seen yet. On a database with no scan at all — a fresh
// install — there is nothing that existed all along, so it is recorded `done` at once and nothing is ever
// held back. Idempotent: run on every boot, it leaves a known capability's state alone.
export function seedCapabilityBaselines(db: DrizzleDb, capabilities: readonly Capability[], at: number): void {
    const fresh = getLastScanFinishedAt(db) === null
    for (const capability of capabilities) {
        db.insert(capabilityBaselines)
            .values({ capabilityId: capability.id, state: fresh ? 'done' : 'pending', createdAt: at, doneAt: fresh ? at : null })
            .onConflictDoNothing()
            .run()
    }
}

export function getBaselineState(db: DrizzleDb, capabilityId: string): BaselineState | null {
    const row = db.select({ state: capabilityBaselines.state }).from(capabilityBaselines).where(eq(capabilityBaselines.capabilityId, capabilityId)).get()
    return row?.state ?? null
}

// The capabilities whose baseline is still recording silently: the notifier stamps their new finding events.
export function pendingBaselineCapabilities(db: DrizzleDb, capabilities: readonly Capability[]): Capability[] {
    return capabilities.filter(function pending(capability) { return getBaselineState(db, capability.id) === 'pending' })
}

// The scope and filter columns a summary was counted under, as one hash. Any edit to them between the
// count and a retry (a narrower root, another severity) changes it, and the frozen counts no longer
// describe what the target would be told, so the retry is dropped instead (SENTINEL-124). Canonical: every
// list sorted, so an edit that changes nothing changes nothing here either.
export function targetPolicyFingerprint(target: NotificationTarget): string {
    const canonical = {
        rootIds: target.rootIds.slice().sort(),
        projectIds: target.projectIds.slice().sort(),
        sourceScope: {
            mode: target.sourceScope.mode,
            cells: target.sourceScope.cells.map(function key(cell) { return cell.source + '|' + cell.ecosystem }).sort()
        },
        severityFilter: target.severityFilter.slice().sort(),
        envFilter: target.envFilter
    }
    return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

// The capability's summary counts under `target`'s current policy at `at` — the same eligibility
// predicate dispatch applies one event at a time (eventEligibleForTargetSql), minus only what is not
// policy: the baseline suppression, delivery state and the target-creation gate. K counts the projects in
// the target's root/project scope with a capability ecosystem no enabled source answers for.
export function baselineCountsForTarget(db: DrizzleDb, capability: Capability, target: NotificationTarget, at: number): BaselineCounts {
    const row = db.get<{ findings: number; projects: number; critical: number | null }>(sql`
        SELECT COUNT(*) AS findings,
               COUNT(DISTINCT e.project_id) AS projects,
               SUM(CASE WHEN e.severity = 'critical' THEN 1 ELSE 0 END) AS critical
        FROM notification_events e
        INNER JOIN notification_targets t ON t.id = ${target.id}
        WHERE e.event_type = 'finding'
          AND e.baseline_of = ${capability.id}
          AND ${eventEligibleForTargetSql('e', 't', at)}
    `)
    return {
        findings: row.findings,
        projects: row.projects,
        critical: row.critical ?? 0,
        sourceDisabledProjects: sourceDisabledProjectsInScope(db, capability, target)
    }
}

function sourceDisabledProjectsInScope(db: DrizzleDb, capability: Capability, target: NotificationTarget): number {
    const rootOf = new Map(db.all<{ id: string; root_id: string }>(sql`SELECT id, root_id FROM projects`).map(function pair(p): [string, string] { return [p.id, p.root_id] }))
    const scoped = target.rootIds.length > 0 || target.projectIds.length > 0
    let count = 0
    for (const [projectId, state] of listProjectScanStates(db)) {
        if (scoped && !target.projectIds.includes(projectId) && !target.rootIds.includes(rootOf.get(projectId) as string)) continue
        const disabled = state.reasons.some(function forCapability(reason) {
            return reason.reasonCode === 'ecosystem_source_disabled' && reason.ecosystem !== null && (capability.ecosystems as string[]).includes(reason.ecosystem)
        })
        if (disabled) count += 1
    }
    return count
}

// Claims the completion of every pending baseline, for a sweep that completed. In one transaction per
// capability: only the caller whose UPDATE moved the row from 'pending' to 'swept' goes on (a concurrent
// completion loses the race and writes nothing), and it writes one summary row per enabled target with
// that target's counts and policy fingerprint. From here on nothing is stamped any more: the scan baseline
// is over whether or not any summary is ever delivered. Returns the capability ids it claimed.
export function claimCompletedBaselines(db: DrizzleDb, capabilities: readonly Capability[], at: number): string[] {
    const claimed: string[] = []
    for (const capability of capabilities) {
        db.transaction(function claim(tx) {
            const moved = tx.update(capabilityBaselines)
                .set({ state: 'swept', sweptAt: at })
                .where(and(eq(capabilityBaselines.capabilityId, capability.id), eq(capabilityBaselines.state, 'pending')))
                .run()
            if (moved.changes !== 1) return
            for (const target of listEnabledNotificationTargets(tx)) {
                tx.insert(capabilitySummaryDeliveries)
                    .values({
                        capabilityId: capability.id,
                        targetId: target.id,
                        countsJson: JSON.stringify(baselineCountsForTarget(tx, capability, target, at)),
                        policyFingerprint: targetPolicyFingerprint(target)
                    })
                    .run()
            }
            claimed.push(capability.id)
        })
    }
    return claimed
}

// Every summary still owed: its baseline swept, and none of succeeded / dry-run / given up / suppressed.
export function listOpenSummaryDeliveries(db: DrizzleDb): CapabilitySummaryDelivery[] {
    const rows = db.select({ delivery: capabilitySummaryDeliveries })
        .from(capabilitySummaryDeliveries)
        .innerJoin(capabilityBaselines, eq(capabilityBaselines.capabilityId, capabilitySummaryDeliveries.capabilityId))
        .where(and(
            eq(capabilityBaselines.state, 'swept'),
            isNull(capabilitySummaryDeliveries.firstSucceededAt),
            isNull(capabilitySummaryDeliveries.dryRunAt),
            isNull(capabilitySummaryDeliveries.gaveUpAt),
            isNull(capabilitySummaryDeliveries.suppressedAt)
        ))
        .all()
    return rows.map(function toDelivery(row) { return rowToDelivery(row.delivery) })
}

export function listSummaryDeliveries(db: DrizzleDb, capabilityId: string): CapabilitySummaryDelivery[] {
    return db.select().from(capabilitySummaryDeliveries).where(eq(capabilitySummaryDeliveries.capabilityId, capabilityId)).all().map(rowToDelivery)
}

function rowToDelivery(row: DeliveryRow): CapabilitySummaryDelivery {
    return {
        capabilityId: row.capabilityId,
        targetId: row.targetId,
        counts: JSON.parse(row.countsJson) as BaselineCounts,
        policyFingerprint: row.policyFingerprint,
        attempts: row.attempts,
        firstAttemptedAt: row.firstAttemptedAt,
        lastAttemptedAt: row.lastAttemptedAt,
        firstSucceededAt: row.firstSucceededAt,
        dryRunAt: row.dryRunAt,
        gaveUpAt: row.gaveUpAt,
        suppressedAt: row.suppressedAt,
        suppressedReason: row.suppressedReason,
        lastErrorText: row.lastErrorText
    }
}

function deliveryKey(capabilityId: string, targetId: string) {
    return and(eq(capabilitySummaryDeliveries.capabilityId, capabilityId), eq(capabilitySummaryDeliveries.targetId, targetId))
}

// Recorded BEFORE the send, so an attempt with no recorded outcome reads as unknown and is retried.
export function recordSummaryAttempt(db: DrizzleDb, capabilityId: string, targetId: string, at: number): void {
    db.update(capabilitySummaryDeliveries)
        .set({
            attempts: sql`${capabilitySummaryDeliveries.attempts} + 1`,
            firstAttemptedAt: sql`COALESCE(${capabilitySummaryDeliveries.firstAttemptedAt}, ${at})`,
            lastAttemptedAt: at
        })
        .where(deliveryKey(capabilityId, targetId))
        .run()
}

export function recordSummarySuccess(db: DrizzleDb, capabilityId: string, targetId: string, at: number): void {
    db.update(capabilitySummaryDeliveries).set({ firstSucceededAt: at, lastErrorText: null }).where(deliveryKey(capabilityId, targetId)).run()
}

// `gaveUpAt` closes the row for good once its attempt budget is spent.
export function recordSummaryFailure(db: DrizzleDb, capabilityId: string, targetId: string, errorText: string, gaveUpAt: number | null): void {
    db.update(capabilitySummaryDeliveries).set({ lastErrorText: errorText, gaveUpAt }).where(deliveryKey(capabilityId, targetId)).run()
}

export function recordSummaryDryRun(db: DrizzleDb, capabilityId: string, targetId: string, at: number): void {
    db.update(capabilitySummaryDeliveries).set({ dryRunAt: at }).where(deliveryKey(capabilityId, targetId)).run()
}

export function suppressSummary(db: DrizzleDb, capabilityId: string, targetId: string, reason: SuppressedReason, at: number): void {
    db.update(capabilitySummaryDeliveries).set({ suppressedAt: at, suppressedReason: reason }).where(deliveryKey(capabilityId, targetId)).run()
}

// Moves every swept baseline whose summary rows are all closed to 'done'. A swept baseline with no target
// at all (none enabled at completion, or every one deleted since) closes too.
export function closeFinishedBaselines(db: DrizzleDb, at: number): void {
    db.run(sql`
        UPDATE capability_baselines SET state = 'done', done_at = ${at}
        WHERE state = 'swept'
          AND NOT EXISTS (
              SELECT 1 FROM capability_summary_deliveries d
              WHERE d.capability_id = capability_baselines.capability_id
                AND d.first_succeeded_at IS NULL AND d.dry_run_at IS NULL AND d.gave_up_at IS NULL AND d.suppressed_at IS NULL
          )
    `)
}
