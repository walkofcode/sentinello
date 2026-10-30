import { and, eq, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DepTypeFilter, NotificationDelivery, NotificationEvent, NotificationTarget } from '@sentinello/core'
import type { DrizzleDb } from '../client'
import { notificationDeliveries, notificationEvents, notificationTargets } from '../schema'
import { listTargetRootIds } from './notification-target-roots'
import { listTargetProjectIds } from './notification-target-projects'

type NotificationDeliveryRow = typeof notificationDeliveries.$inferSelect
type NotificationEventRow = typeof notificationEvents.$inferSelect
type NotificationTargetRow = typeof notificationTargets.$inferSelect

export type DispatchablePair = {
    event: NotificationEvent
    target: NotificationTarget
}

// Selects (event, target) pairs eligible for dispatch for one project.
// Criteria (all enforced in SQL so the dispatch rule is durable and unforgeable by callers):
//  - event belongs to the project
//  - target is enabled
//  - event.first_seen_at >= target.created_at (no back-flooding new targets) — UNLESS an operator
//    has explicitly requested historical backfill, in which case backfillForNewTarget() has already
//    inserted a placeholder delivery row with first_attempted_at = NULL for the pair; those rows are
//    allowed through this gate so the operator's opt-in to backfill is honored.
//  - the event is not a silent-baseline event (baseline_of IS NULL): those are told once, in their
//    capability's summary (capability-baselines.ts)
//  - no successful delivery row exists for (event_id, target_id)
//  - the target's policy would tell it about the event: severity filter, prod/dev filter, cell scope,
//    root/project scope and active mutes — eventEligibleForTargetSql, below, states each rule
export function selectDispatchablePairs(db: DrizzleDb, projectId: string, at: number): DispatchablePair[] {
    const rows = db
        .select({
            event: notificationEvents,
            target: notificationTargets,
            delivery: notificationDeliveries
        })
        .from(notificationEvents)
        // CROSS JOIN over (events × enabled targets). The time-gate that previously lived in the JOIN
        // ON clause is now in WHERE so it can be OR'd with the operator-backfill bypass below.
        .innerJoin(notificationTargets, sql`1=1`)
        .leftJoin(
            notificationDeliveries,
            and(
                eq(notificationDeliveries.eventId, notificationEvents.id),
                eq(notificationDeliveries.targetId, notificationTargets.id)
            )
        )
        .where(
            and(
                eq(notificationEvents.projectId, projectId),
                eq(notificationTargets.enabled, true),
                or(
                    isNull(notificationDeliveries.id),
                    isNull(notificationDeliveries.firstSucceededAt)
                ),
                // Eligibility gate: either the event was discovered after the target was created
                // (the default no-backflood rule), or there is already a placeholder delivery row
                // with first_attempted_at = NULL — which only backfillForNewTarget() inserts, and
                // only when the operator explicitly opts in to historical send.
                or(
                    sql`${notificationEvents.firstSeenAt} >= ${notificationTargets.createdAt}`,
                    and(
                        isNotNull(notificationDeliveries.id),
                        isNull(notificationDeliveries.firstAttemptedAt)
                    )
                ),
                // Silent-baseline events are told in their capability's one summary, never one by one.
                isNull(notificationEvents.baselineOf),
                eventEligibleForTargetSql('notification_events', 'notification_targets', at)
            )
        )
        .all()
    // Hydrate rootIds/projectIds per unique target so the returned NotificationTarget shape stays in
    // sync with listNotificationTargets. The dispatch SQL above is the load-bearing reader of scope;
    // this is purely for callers that consume the returned target object.
    const targetRootIds = new Map<string, string[]>()
    const targetProjectIds = new Map<string, string[]>()
    for (const row of rows) {
        if (!targetRootIds.has(row.target.id)) {
            targetRootIds.set(row.target.id, listTargetRootIds(db, row.target.id))
            targetProjectIds.set(row.target.id, listTargetProjectIds(db, row.target.id))
        }
    }
    return rows.map(function toPair(row): DispatchablePair {
        return {
            event: eventRowToEvent(row.event),
            target: targetRowToTarget(
                row.target,
                // The loop above sets both maps for every row's target id before this runs.
                targetRootIds.get(row.target.id)!,
                targetProjectIds.get(row.target.id)!
            )
        }
    })
}

// Whether target `t` would be told about event `e` at `at`, by the target's policy alone: its severity
// filter, its prod/dev filter, its (source, ecosystem) cell scope, its root/project scope, and the mutes
// active at `at`. The one statement of that rule, shared by dispatch (selectDispatchablePairs), the
// operator's historical backfill (backfillForNewTarget) and the silent baseline's per-target counts
// (capability-baselines.ts), so a summary counts exactly what the target would have been sent one by one.
// What is NOT in it is each caller's own: enabled targets, delivery state, the creation-time gate and
// baseline suppression. `e` and `t` are the SQL names the caller gave notification_events and
// notification_targets.
//
//  - severity: finding events only; scan_failure events always pass (operational signals).
//  - prod/dev (target.env_filter ∈ {'all','prod','dev'}): scan failures bypass, having no finding row to
//    classify. A finding event matches when ANY of its findings rows (same identity tuple: project, source
//    — the event carries it in `scanner` — ecosystem, advisory, package) is prod (target 'prod') or dev and
//    not prod (target 'dev'), the semantics of packages/db/src/queries/dep-type.ts. The ecosystem is part of
//    the tuple so an npm finding never satisfies the filter for a same-named PyPI one.
//  - cell scope: mode 'all' fires for every cell; mode 'selected' only for the event's (source, ecosystem).
//    Scan failures bypass.
//  - root/project scope: zero rows in both scope tables means everything; otherwise the event's project
//    belongs to a listed root OR is a listed project (additive).
//  - mutes: project-scope mutes silence every event of the project, scan failures included; finding-scope
//    mutes match the finding identity tuple (a NULL mute ecosystem is a legacy row and matches any) and
//    only finding events; a mute with no project is global. Active while expires_at IS NULL or > at.
export function eventEligibleForTargetSql(e: string, t: string, at: number): SQL {
    const ev = sql.raw(e)
    const tg = sql.raw(t)
    return sql`(
        (
            ${ev}.event_type = 'scan_failure'
            OR EXISTS (
                SELECT 1 FROM json_each(${tg}.severity_filter_json)
                WHERE json_each.value = ${ev}.severity
            )
        )
        AND (
            ${ev}.event_type = 'scan_failure'
            OR ${tg}.env_filter = 'all'
            OR EXISTS (
                SELECT 1 FROM findings f
                WHERE f.project_id = ${ev}.project_id
                  AND COALESCE(f.source, f.scanner) = ${ev}.scanner
                  AND f.ecosystem = ${ev}.ecosystem
                  AND f.advisory_id = ${ev}.advisory_id
                  AND f.package_name = ${ev}.package_name
                  AND (
                      (${tg}.env_filter = 'prod' AND f.is_prod = 1)
                      OR (${tg}.env_filter = 'dev' AND f.is_dev = 1 AND f.is_prod = 0)
                  )
            )
        )
        AND (
            ${ev}.event_type = 'scan_failure'
            OR json_extract(${tg}.source_scope_json, '$.mode') = 'all'
            OR EXISTS (
                SELECT 1 FROM json_each(${tg}.source_scope_json, '$.cells')
                WHERE json_extract(json_each.value, '$.source') = ${ev}.scanner
                  AND json_extract(json_each.value, '$.ecosystem') = ${ev}.ecosystem
            )
        )
        AND (
            (
                NOT EXISTS (SELECT 1 FROM notification_target_roots tr WHERE tr.target_id = ${tg}.id)
                AND NOT EXISTS (SELECT 1 FROM notification_target_projects tp WHERE tp.target_id = ${tg}.id)
            )
            OR EXISTS (
                SELECT 1 FROM notification_target_roots tr
                INNER JOIN projects p ON p.id = ${ev}.project_id
                WHERE tr.target_id = ${tg}.id AND tr.root_id = p.root_id
            )
            OR EXISTS (
                SELECT 1 FROM notification_target_projects tp
                WHERE tp.target_id = ${tg}.id AND tp.project_id = ${ev}.project_id
            )
        )
        AND NOT EXISTS (
            SELECT 1 FROM mutes m
            WHERE (m.expires_at IS NULL OR m.expires_at > ${at})
              AND (
                (m.scope = 'project' AND m.project_id = ${ev}.project_id)
                OR (
                    ${ev}.event_type = 'finding'
                    AND m.scope = 'finding'
                    AND (m.project_id IS NULL OR m.project_id = ${ev}.project_id)
                    AND m.scanner = ${ev}.scanner
                    AND (m.ecosystem IS NULL OR m.ecosystem = ${ev}.ecosystem)
                    AND m.advisory_id = ${ev}.advisory_id
                    AND m.package_name = ${ev}.package_name
                )
              )
        )
    )`
}

export function getDelivery(
    db: DrizzleDb,
    eventId: string,
    targetId: string
): NotificationDelivery | null {
    const row = db
        .select()
        .from(notificationDeliveries)
        .where(
            and(eq(notificationDeliveries.eventId, eventId), eq(notificationDeliveries.targetId, targetId))
        )
        .get()
    if (!row) return null
    return rowToDelivery(row)
}

// Records an attempt: INSERTs a new row if none exists, otherwise UPDATEs last_attempted_at.
export function recordAttempt(db: DrizzleDb, eventId: string, targetId: string, at: number): void {
    const existing = getDelivery(db, eventId, targetId)
    if (existing) {
        db.update(notificationDeliveries)
            .set({ lastAttemptedAt: at })
            .where(eq(notificationDeliveries.id, existing.id))
            .run()
        return
    }
    db.insert(notificationDeliveries)
        .values({
            id: ulid(),
            eventId,
            targetId,
            firstAttemptedAt: at,
            firstSucceededAt: null,
            lastAttemptedAt: at,
            lastErrorText: null
        })
        .run()
}

// On success: set first_succeeded_at (only if null), clear last_error_text.
// Caller is responsible for ALSO setting notification_events.first_notified_at as a UI denorm.
export function recordSuccess(db: DrizzleDb, eventId: string, targetId: string, at: number): void {
    db.update(notificationDeliveries)
        .set({
            firstSucceededAt: sql`COALESCE(${notificationDeliveries.firstSucceededAt}, ${at})`,
            lastAttemptedAt: at,
            lastErrorText: null
        })
        .where(
            and(eq(notificationDeliveries.eventId, eventId), eq(notificationDeliveries.targetId, targetId))
        )
        .run()
}

export function recordFailure(
    db: DrizzleDb,
    eventId: string,
    targetId: string,
    at: number,
    errorText: string
): void {
    db.update(notificationDeliveries)
        .set({ lastAttemptedAt: at, lastErrorText: errorText })
        .where(
            and(eq(notificationDeliveries.eventId, eventId), eq(notificationDeliveries.targetId, targetId))
        )
        .run()
}

// Inserts placeholder (event_id, target_id) delivery rows with first_attempted_at = NULL for every
// event that should be backfilled to this target. Operator-triggered: only runs when the operator
// clicks "send historical to this target" in Settings → Notifications.
//
// Filtering applied at backfill time so the rows we insert are actually dispatchable:
//   - target severity filter (finding events only; scan_failures bypass).
//   - active mute exclusion at the given timestamp (project-scope mutes affect ALL event types;
//     finding-scope mutes affect finding events with matching identity tuple).
//   - skip events that already have a delivery row for this target.
//
// The companion change in selectDispatchablePairs allows these placeholder rows to bypass the
// first_seen_at >= target.created_at gate, so on the next dispatch tick the backfill rows are
// actually picked up and sent.
//
// Returns the number of rows inserted so the UI can surface a confirmation count.
export function backfillForNewTarget(db: DrizzleDb, targetId: string, at: number): number {
    const result = db.run(sql`
        INSERT INTO notification_deliveries (id, event_id, target_id, first_attempted_at, first_succeeded_at, last_attempted_at, last_error_text)
        SELECT
            lower(hex(randomblob(13))) AS id,
            e.id AS event_id,
            ${targetId} AS target_id,
            NULL,
            NULL,
            NULL,
            NULL
        FROM notification_events e
        INNER JOIN notification_targets t ON t.id = ${targetId}
        WHERE NOT EXISTS (
            SELECT 1 FROM notification_deliveries d
            WHERE d.event_id = e.id AND d.target_id = ${targetId}
        )
        AND e.baseline_of IS NULL
        AND ${eventEligibleForTargetSql('e', 't', at)}
    `)
    // better-sqlite3 returns RunResult with .changes; drizzle's wrapper exposes it on the result. It is
    // always a number — declaring it optional here and then re-checking was the cast second-guessing
    // itself. scans.ts:187 reads result.changes with no ceremony at all.
    return (result as { changes: number }).changes
}

function rowToDelivery(row: NotificationDeliveryRow): NotificationDelivery {
    return {
        id: row.id,
        eventId: row.eventId,
        targetId: row.targetId,
        firstAttemptedAt: row.firstAttemptedAt,
        firstSucceededAt: row.firstSucceededAt,
        lastAttemptedAt: row.lastAttemptedAt,
        lastErrorText: row.lastErrorText
    }
}

function eventRowToEvent(row: NotificationEventRow): NotificationEvent {
    return {
        id: row.id,
        eventType: row.eventType,
        identityKey: row.identityKey,
        projectId: row.projectId,
        scanner: row.scanner,
        ecosystem: row.ecosystem,
        advisoryId: row.advisoryId,
        packageName: row.packageName,
        severity: row.severity,
        failureSignature: row.failureSignature,
        firstScanId: row.firstScanId,
        firstSeenAt: row.firstSeenAt,
        firstNotifiedAt: row.firstNotifiedAt,
        lastSeenAt: row.lastSeenAt
    }
}

function targetRowToTarget(row: NotificationTargetRow, rootIds: string[], projectIds: string[]): NotificationTarget {
    return {
        id: row.id,
        kind: row.kind,
        config: JSON.parse(row.configJson),
        severityFilter: parseSeverityFilter(row.severityFilterJson),
        envFilter: parseEnvFilter(row.envFilter),
        enabled: row.enabled,
        createdAt: row.createdAt,
        rootIds,
        projectIds,
        sourceScope: parseSourceScope(row.sourceScopeJson)
    }
}

// Lightweight parse for the returned target object (the dispatch SQL above is the load-bearing filter,
// so this only needs to be well-formed). Anything malformed, or mode !== 'selected', is "all".
function parseSourceScope(json: string): NotificationTarget['sourceScope'] {
    let parsed: unknown
    try {
        parsed = JSON.parse(json)
    } catch {
        return { mode: 'all', cells: [] }
    }
    // `null` is valid JSON but not an object, so the catch above does not cover it and reading
    // .mode would throw. Fail open like every other malformed case here.
    if (!parsed || typeof parsed !== 'object') return { mode: 'all', cells: [] }
    const obj = parsed as { mode?: unknown; cells?: unknown }
    if (obj.mode !== 'selected' || !Array.isArray(obj.cells)) return { mode: 'all', cells: [] }
    const cells = obj.cells.filter(function isCell(c: unknown): c is NotificationTarget['sourceScope']['cells'][number] {
        if (!c || typeof c !== 'object') return false
        const cell = c as { source?: unknown; ecosystem?: unknown }
        return typeof cell.source === 'string' && typeof cell.ecosystem === 'string'
    })
    return { mode: 'selected', cells }
}

function parseEnvFilter(raw: string): DepTypeFilter {
    if (raw === 'prod' || raw === 'dev') return raw
    return 'all'
}

function parseSeverityFilter(json: string): NotificationTarget['severityFilter'] {
    const parsed = JSON.parse(json) as unknown
    if (!Array.isArray(parsed)) return []
    const valid = new Set(['critical', 'high', 'moderate', 'low', 'info'])
    return parsed.filter(function isSev(value): value is NotificationTarget['severityFilter'][number] {
        return typeof value === 'string' && valid.has(value)
    })
}
