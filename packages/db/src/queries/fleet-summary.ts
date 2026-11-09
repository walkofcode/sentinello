import { eq, inArray, sql } from 'drizzle-orm'
import { isCacheNotReadyReason, severityInFilter, type Finding, type NotificationEvent, type NotificationTarget, type ScanStateReason, type Severity, type TargetDelivery } from '@sentinello/core'
import type { DrizzleDb } from '../client'
import { notificationTargets, runSummaryResolvedTold, runSummaryUnscannableTold } from '../schema'
import { advisoryIdentitySql, findingMuteExclusionSql, severityRankSql, statesModerateSql } from './advisory-identity'
import type { SeverityCounts } from './dashboard'
import { listFindingsByIds } from './findings'
import { findingEligibleForTargetSql, findingSeverityInFilterSql, recordSuccess } from './notification-deliveries'
import { setFirstNotifiedAt } from './notification-events'
import { listProjectScanStates, listScanStatesForProjects } from './scan-state'
import { activeSourceCellClause } from './sources'

// What the run summary and the weekly digest read: who is outstanding, unscannable or resolved under one target's
// policy, and what a target has already been told. The worker decides when to send (apps/worker/src/run-summary.ts,
// weekly-digest.ts); nothing here sends.

// A reason that says something is actually wrong: `not_yet_run` and a cache still downloading say only that nothing
// has answered yet.
function isFailureReason(reason: ScanStateReason): boolean {
    return reason.reasonCode !== 'not_yet_run' && !isCacheNotReadyReason(reason.reasonCode)
}

export type UnscannableProject = {
    projectId: string
    projectName: string
    state: 'cannot_scan' | 'partial'
    // Only the reasons that say something is wrong.
    reasons: ScanStateReason[]
}

// The one query behind the run summary's "newly unscannable" and the digest's "currently unscannable": projects in
// the target's root and project scope, in the run's scope (null: every project), that cannot be fully scanned for a
// reason other than not having answered yet, and under no active project-scope mute. That is the policy
// eventEligibleForTargetSql applies to a scan failure: severity, env and finding-scoped mutes do not silence an
// operational failure, a project mute does.
export function unscannableForTarget(db: DrizzleDb, target: NotificationTarget, at: number, projectIds: readonly string[] | null = null): UnscannableProject[] {
    if (projectIds !== null && projectIds.length === 0) return []
    const rows = db.all<{ id: string; name: string; alias: string | null; root_id: string }>(sql`
        SELECT p.id, p.name, p.alias, p.root_id
        FROM projects p
        WHERE NOT EXISTS (
            SELECT 1 FROM mutes m
            WHERE m.scope = 'project' AND m.project_id = p.id AND (m.expires_at IS NULL OR m.expires_at > ${at})
        )
    `)
    const scoped = target.rootIds.length > 0 || target.projectIds.length > 0
    const inScope = rows.filter(function covered(p) {
        if (projectIds !== null && !projectIds.includes(p.id)) return false
        return !scoped || target.projectIds.includes(p.id) || target.rootIds.includes(p.root_id)
    })
    const states = listScanStatesForProjects(db, inScope.map(function id(p) { return p.id }))
    const out: UnscannableProject[] = []
    for (const project of inScope) {
        const scanState = states.get(project.id)
        if (scanState?.state !== 'cannot_scan' && scanState?.state !== 'partial') continue
        const reasons = scanState.reasons.filter(isFailureReason)
        if (reasons.length === 0) continue
        out.push({ projectId: project.id, projectName: project.alias ?? project.name, state: scanState.state, reasons })
    }
    return out
}

export function listUnscannableTold(db: DrizzleDb, targetId: string): Set<string> {
    const rows = db.select({ projectId: runSummaryUnscannableTold.projectId }).from(runSummaryUnscannableTold).where(eq(runSummaryUnscannableTold.targetId, targetId)).all()
    return new Set(rows.map(function id(row) { return row.projectId }))
}

// Recovery is a fact a completed run observes, apart from any send: the told rows of each of its projects that are
// fully scanned now go, for every target, even on a quiet run, so the same failure later is told again. A project
// whose only reasons are `not_yet_run` or a cache not ready has not recovered, since nothing answered for it, and
// keeps its row, or a cache rebuild would re-report every old failure.
//
// Two steps, because scans do not wait for the summary queue and sends do. The read happens the moment the run ends:
// read later, another scan's failure could already have replaced the state it saw. It looks at every project of the
// run, told or not, since a send in flight may be about to write the told row. The write happens in the queue, after
// that send has recorded what it told.
export function readScanRecoveries(db: DrizzleDb, projectIds: readonly string[] | null): string[] {
    const states = projectIds === null ? listProjectScanStates(db) : listScanStatesForProjects(db, projectIds)
    return Array.from(states.entries()).filter(function scanned([, state]) { return state.state === 'scanned' }).map(function id([projectId]) { return projectId })
}

export function applyScanRecoveries(db: DrizzleDb, projectIds: readonly string[]): void {
    if (projectIds.length === 0) return
    db.delete(runSummaryUnscannableTold).where(inArray(runSummaryUnscannableTold.projectId, [...projectIds])).run()
}

// Opting in or out. In one transaction: opting in sets the point resolved rows are owed from and seeds the told rows
// with what cannot be scanned at this moment, so old gaps are not reported as new and a quiet or scoped first run has
// nothing to decide. Opting out clears both, and undelivered events dispatch per project on each project's next scan.
// Already there is nothing to do: choosing run summary again must not forget what is owed.
export function setNotificationTargetDelivery(db: DrizzleDb, target: NotificationTarget, delivery: TargetDelivery, at: number): void {
    if (target.delivery === delivery) return
    db.transaction(function write(tx) {
        tx.update(notificationTargets)
            .set({ delivery, runSummarySinceAt: delivery === 'run_summary' ? at : null })
            .where(eq(notificationTargets.id, target.id))
            .run()
        if (delivery === 'per_project') {
            tx.delete(runSummaryResolvedTold).where(eq(runSummaryResolvedTold.targetId, target.id)).run()
            tx.delete(runSummaryUnscannableTold).where(eq(runSummaryUnscannableTold.targetId, target.id)).run()
            return
        }
        for (const project of unscannableForTarget(tx, target, at)) {
            tx.insert(runSummaryUnscannableTold).values({ targetId: target.id, projectId: project.projectId, toldAt: at }).run()
        }
    })
}

// Resolved findings of the run's scope this target has not been told, from the moment it opted in. Read from
// resolved_at and the per-target acknowledgements directly, never through a scan: a row a source that is no longer
// attempted closed has no resolving scan (resolved_scan_id is null), and it is news all the same. A notice is not a
// vulnerability, so its going is not news either.
export type ResolvedCandidate = {
    finding: Finding
    rootPath: string
    relPath: string
    projectName: string
}

export function listOwedResolvedFindings(db: DrizzleDb, targetId: string, at: number, projectIds: readonly string[] | null): ResolvedCandidate[] {
    if (projectIds !== null && projectIds.length === 0) return []
    const scope = projectIds === null ? sql`` : sql`AND f.project_id IN (${sql.join(projectIds.map(function value(id) { return sql`${id}` }), sql`, `)})`
    const rows = db.all<{ id: string; root_path: string; rel_path: string; name: string; alias: string | null }>(sql`
        SELECT f.id, r.path AS root_path, p.rel_path, p.name, p.alias
        FROM findings f
        INNER JOIN notification_targets t ON t.id = ${targetId}
        INNER JOIN projects p ON p.id = f.project_id
        INNER JOIN roots r ON r.id = p.root_id
        WHERE f.resolved_at IS NOT NULL
          AND t.run_summary_since_at IS NOT NULL
          AND f.resolved_at >= t.run_summary_since_at
          AND NOT EXISTS (SELECT 1 FROM run_summary_resolved_told told WHERE told.target_id = t.id AND told.finding_id = f.id)
          AND ${findingEligibleForTargetSql('f', 't')}
          AND ${findingSeverityInFilterSql('f', 't')}
          ${findingMuteExclusionSql(at, 'f')}
          ${scope}
    `)
    const byId = new Map(listFindingsByIds(db, rows.map(function id(row) { return row.id })).map(function pair(f): [string, Finding] { return [f.id, f] }))
    return rows.map(function toCandidate(row): ResolvedCandidate {
        return { finding: byId.get(row.id) as Finding, rootPath: row.root_path, relPath: row.rel_path, projectName: row.alias ?? row.name }
    })
}

// What one successful run summary covered, in one transaction: each event delivered, each resolved row and project
// told, counting those behind "and N more". A crash after the channel accepted and before this can repeat a message,
// the limit capability-baseline.ts already documents.
export function recordRunSummaryDelivered(db: DrizzleDb, input: { targetId: string; events: readonly NotificationEvent[]; resolvedFindingIds: readonly string[]; unscannableProjectIds: readonly string[]; at: number }): void {
    db.transaction(function write(tx) {
        for (const event of input.events) {
            recordSuccess(tx, event.id, input.targetId, input.at)
            setFirstNotifiedAt(tx, event.id, input.at)
        }
        for (const findingId of input.resolvedFindingIds) {
            tx.insert(runSummaryResolvedTold).values({ targetId: input.targetId, findingId, toldAt: input.at }).onConflictDoNothing().run()
        }
        for (const projectId of input.unscannableProjectIds) {
            tx.insert(runSummaryUnscannableTold).values({ targetId: input.targetId, projectId, toldAt: input.at }).onConflictDoNothing().run()
        }
    })
}

export type OutstandingForTarget = {
    // Under the target's filters, grouped by (project, ecosystem, package, advisory identity) as the dashboard groups.
    counts: SeverityCounts
    // Every row of the critical and high groups those counts hold, for the message's list.
    severe: Finding[]
}

const GROUP_RANK_SEVERITY: Record<number, Severity> = { 5: 'critical', 4: 'high' }

// What the weekly digest counts: everything open this target would be told about, by the same rules as the portal.
// A test pins it to getDashboardSummary on one fixture with equal filters. A group is judged on its one grade, the
// worst any of its rows states, because that is the grade the portal shows it under.
export function outstandingForTarget(db: DrizzleDb, target: NotificationTarget, at: number): OutstandingForTarget {
    const eligible = sql`
        f.resolved_at IS NULL
        AND ${findingEligibleForTargetSql('f', 't')}
        ${activeSourceCellClause(db)}
        ${findingMuteExclusionSql(at, 'f')}
    `
    const row = db.get<SeverityCounts>(sql`
        WITH deduped AS (
            SELECT MAX(${severityRankSql('f')}) AS sev_rank, MAX(${statesModerateSql('f')}) AS states_moderate
            FROM findings f
            INNER JOIN notification_targets t ON t.id = ${target.id}
            WHERE ${eligible}
            GROUP BY f.project_id, f.ecosystem, f.package_name, ${advisoryIdentitySql('f')}
        )
        SELECT
            COALESCE(SUM(CASE WHEN sev_rank = 5 THEN 1 ELSE 0 END), 0) AS critical,
            COALESCE(SUM(CASE WHEN sev_rank = 4 THEN 1 ELSE 0 END), 0) AS high,
            COALESCE(SUM(CASE WHEN sev_rank = 3 AND states_moderate = 1 THEN 1 ELSE 0 END), 0) AS moderate,
            COALESCE(SUM(CASE WHEN sev_rank = 3 AND states_moderate = 0 THEN 1 ELSE 0 END), 0) AS unrated,
            COALESCE(SUM(CASE WHEN sev_rank = 2 THEN 1 ELSE 0 END), 0) AS low,
            COALESCE(SUM(CASE WHEN sev_rank = 1 THEN 1 ELSE 0 END), 0) AS info
        FROM deduped
    `)
    const counts: SeverityCounts = {
        critical: severityInFilter(target.severityFilter, 'critical') ? row.critical : 0,
        high: severityInFilter(target.severityFilter, 'high') ? row.high : 0,
        moderate: severityInFilter(target.severityFilter, 'moderate') ? row.moderate : 0,
        unrated: severityInFilter(target.severityFilter, 'unrated') ? row.unrated : 0,
        low: severityInFilter(target.severityFilter, 'low') ? row.low : 0,
        info: severityInFilter(target.severityFilter, 'info') ? row.info : 0
    }
    const severeRows = db.all<{ id: string; group_rank: number }>(sql`
        SELECT id, group_rank FROM (
            SELECT f.id, MAX(${severityRankSql('f')}) OVER (PARTITION BY f.project_id, f.ecosystem, f.package_name, ${advisoryIdentitySql('f')}) AS group_rank
            FROM findings f
            INNER JOIN notification_targets t ON t.id = ${target.id}
            WHERE ${eligible}
        )
        WHERE group_rank >= 4
    `)
    const severe = severeRows.filter(function inFilter(r) {
        return severityInFilter(target.severityFilter, GROUP_RANK_SEVERITY[r.group_rank] as Severity)
    })
    return { counts, severe: listFindingsByIds(db, severe.map(function id(r) { return r.id })) }
}
