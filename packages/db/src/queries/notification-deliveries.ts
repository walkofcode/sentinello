import { and, eq, isNotNull, isNull, or, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DepTypeFilter, NotificationDelivery, NotificationEvent, NotificationTarget } from '@sentinello/core'
import type { DrizzleDb } from '../client'
import { mutes, notificationDeliveries, notificationEvents, notificationTargets } from '../schema'
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
//  - for finding events: event.severity is in target.severity_filter_json (a JSON array)
//  - for scan_failure events: severity filter is bypassed (operational signals always pass)
//  - no successful delivery row exists for (event_id, target_id)
//  - the event is not currently muted:
//    * scope='project' mutes match on project_id only and apply to ALL event types (including
//      scan_failure) — muting a project silences both its findings and its scan-failure notifications.
//    * scope='finding' mutes match the full finding-identity tuple (projectId, source-identity,
//      ecosystem, advisoryId, packageName) and apply ONLY to finding events; the source axis is the
//      `scanner` column (which carries the persisted source identity), and ecosystem keeps an npm mute
//      from silencing a same-named package in another ecosystem (a NULL mute.ecosystem is a legacy row
//      that still matches any ecosystem). scan_failure rows have null advisory_id/package_name so they
//      structurally cannot match a finding-scope mute. The global finding mute form
//      (project_id IS NULL) matches across any project.
//    * a mute is active when expires_at IS NULL OR expires_at > at.
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
                // Severity filter — only applies to finding events; scan_failures bypass.
                sql`(${notificationEvents.eventType} = 'scan_failure' OR EXISTS (
                    SELECT 1 FROM json_each(${notificationTargets.severityFilterJson})
                    WHERE json_each.value = ${notificationEvents.severity}
                ))`,
                // Environment filter (target.env_filter ∈ {'all','prod','dev'}). Scan-failure events
                // always bypass — they have no underlying finding row to classify. For finding events
                // we EXISTS-join the findings table on the full finding-identity tuple
                // (project_id, source, ecosystem, advisory_id, package_name): a finding matches the
                // target's env when ANY of its rows for that identity has is_prod=1 (target 'prod') or
                // is_dev=1 AND is_prod=0 (target 'dev'). Same prod/dev semantics as
                // packages/db/src/queries/dep-type.ts. The source axis is the persisted source identity —
                // findings carry it in `source` (COALESCE to scanner for un-backfilled legacy rows), the
                // event carries it in `scanner` — and `ecosystem` is required so an npm finding can't
                // satisfy the env filter for a same-named PyPI finding (and vice versa).
                sql`(
                    ${notificationEvents.eventType} = 'scan_failure'
                    OR ${notificationTargets.envFilter} = 'all'
                    OR EXISTS (
                        SELECT 1 FROM findings f
                        WHERE f.project_id = ${notificationEvents.projectId}
                          AND COALESCE(f.source, f.scanner) = ${notificationEvents.scanner}
                          AND f.ecosystem = COALESCE(${notificationEvents.ecosystem}, 'npm')
                          AND f.advisory_id = ${notificationEvents.advisoryId}
                          AND f.package_name = ${notificationEvents.packageName}
                          AND (
                              (${notificationTargets.envFilter} = 'prod' AND f.is_prod = 1)
                              OR (${notificationTargets.envFilter} = 'dev' AND f.is_dev = 1 AND f.is_prod = 0)
                          )
                    )
                )`,
                // Per-target (source, ecosystem) cell scope. Scan-failure events bypass (no source/
                // ecosystem identity). mode 'all' (the default for every pre-Phase-5 target) fires for
                // every cell; mode 'selected' fires only when the event's (scanner-as-source, ecosystem)
                // is one of the listed cells. ecosystem COALESCEs to 'npm' for un-backfilled legacy events.
                sql`(
                    ${notificationEvents.eventType} = 'scan_failure'
                    OR json_extract(${notificationTargets.sourceScopeJson}, '$.mode') = 'all'
                    OR EXISTS (
                        SELECT 1 FROM json_each(${notificationTargets.sourceScopeJson}, '$.cells')
                        WHERE json_extract(json_each.value, '$.source') = ${notificationEvents.scanner}
                          AND json_extract(json_each.value, '$.ecosystem') = COALESCE(${notificationEvents.ecosystem}, 'npm')
                    )
                )`,
                // Per-target scope. Zero rows in BOTH notification_target_roots and
                // notification_target_projects means "everything" (the default). Otherwise the
                // event passes if its project belongs to a root the operator assigned (root scope,
                // bound via projects.root_id) OR the event's project id is in the explicit project
                // allow-list. Root and project scope are additive.
                sql`(
                    (
                        NOT EXISTS (
                            SELECT 1 FROM notification_target_roots tr
                            WHERE tr.target_id = ${notificationTargets.id}
                        )
                        AND NOT EXISTS (
                            SELECT 1 FROM notification_target_projects tp
                            WHERE tp.target_id = ${notificationTargets.id}
                        )
                    )
                    OR EXISTS (
                        SELECT 1 FROM notification_target_roots tr
                        INNER JOIN projects p ON p.id = ${notificationEvents.projectId}
                        WHERE tr.target_id = ${notificationTargets.id}
                          AND tr.root_id = p.root_id
                    )
                    OR EXISTS (
                        SELECT 1 FROM notification_target_projects tp
                        WHERE tp.target_id = ${notificationTargets.id}
                          AND tp.project_id = ${notificationEvents.projectId}
                    )
                )`,
                // Mute filter — project-scope mutes apply to ALL event types (findings + scan failures);
                // finding-scope mutes apply only to finding events (scan failures have null advisory/package
                // identity, so they cannot structurally match a finding-scope mute).
                sql`NOT EXISTS (
                    SELECT 1 FROM ${mutes} m
                    WHERE (m.expires_at IS NULL OR m.expires_at > ${at})
                      AND (
                        (m.scope = 'project' AND m.project_id = ${notificationEvents.projectId})
                        OR (
                            ${notificationEvents.eventType} = 'finding'
                            AND m.scope = 'finding'
                            AND (m.project_id IS NULL OR m.project_id = ${notificationEvents.projectId})
                            AND m.scanner = ${notificationEvents.scanner}
                            AND (m.ecosystem IS NULL OR m.ecosystem = ${notificationEvents.ecosystem})
                            AND m.advisory_id = ${notificationEvents.advisoryId}
                            AND m.package_name = ${notificationEvents.packageName}
                        )
                      )
                )`
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
                targetRootIds.get(row.target.id) || [],
                targetProjectIds.get(row.target.id) || []
            )
        }
    })
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
        AND (
            e.event_type = 'scan_failure'
            OR EXISTS (
                SELECT 1 FROM json_each(t.severity_filter_json)
                WHERE json_each.value = e.severity
            )
        )
        AND (
            e.event_type = 'scan_failure'
            OR t.env_filter = 'all'
            OR EXISTS (
                SELECT 1 FROM findings f
                WHERE f.project_id = e.project_id
                  AND COALESCE(f.source, f.scanner) = e.scanner
                  AND f.ecosystem = COALESCE(e.ecosystem, 'npm')
                  AND f.advisory_id = e.advisory_id
                  AND f.package_name = e.package_name
                  AND (
                      (t.env_filter = 'prod' AND f.is_prod = 1)
                      OR (t.env_filter = 'dev' AND f.is_dev = 1 AND f.is_prod = 0)
                  )
            )
        )
        AND (
            e.event_type = 'scan_failure'
            OR json_extract(t.source_scope_json, '$.mode') = 'all'
            OR EXISTS (
                SELECT 1 FROM json_each(t.source_scope_json, '$.cells')
                WHERE json_extract(json_each.value, '$.source') = e.scanner
                  AND json_extract(json_each.value, '$.ecosystem') = COALESCE(e.ecosystem, 'npm')
            )
        )
        AND NOT EXISTS (
            SELECT 1 FROM mutes m
            WHERE (m.expires_at IS NULL OR m.expires_at > ${at})
              AND (
                (m.scope = 'project' AND m.project_id = e.project_id)
                OR (
                    e.event_type = 'finding'
                    AND m.scope = 'finding'
                    AND (m.project_id IS NULL OR m.project_id = e.project_id)
                    AND m.scanner = e.scanner
                    AND (m.ecosystem IS NULL OR m.ecosystem = e.ecosystem)
                    AND m.advisory_id = e.advisory_id
                    AND m.package_name = e.package_name
                )
              )
        )
        AND (
            (
                NOT EXISTS (SELECT 1 FROM notification_target_roots tr WHERE tr.target_id = ${targetId})
                AND NOT EXISTS (SELECT 1 FROM notification_target_projects tp WHERE tp.target_id = ${targetId})
            )
            OR EXISTS (
                SELECT 1 FROM notification_target_roots tr
                INNER JOIN projects p ON p.id = e.project_id
                WHERE tr.target_id = ${targetId} AND tr.root_id = p.root_id
            )
            OR EXISTS (
                SELECT 1 FROM notification_target_projects tp
                WHERE tp.target_id = ${targetId} AND tp.project_id = e.project_id
            )
        )
    `)
    // better-sqlite3 returns RunResult with .changes; drizzle's wrapper exposes it on the result.
    const changes = (result as { changes?: number }).changes
    return typeof changes === 'number' ? changes : 0
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
