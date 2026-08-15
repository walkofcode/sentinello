import { and, eq, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { NotificationEvent, Severity } from '@sentinello/core'
import type { DrizzleDb } from '../client'
import { notificationEvents } from '../schema'
import { findingIdentityKey, scanFailureIdentityKey } from '../identity'

type NotificationEventRow = typeof notificationEvents.$inferSelect

export type UpsertFindingEventInput = {
    projectId: string
    // The persisted source identity (Finding.source), NOT the scanner plugin name. It is what the
    // dedupe identity_key hashes and what lands in the event's `scanner` column (which carries the
    // persisted source identity for finding events — see the NotificationEvent type in @sentinello/core).
    source: string
    ecosystem: string
    advisoryId: string
    packageName: string
    severity: Severity
    firstScanId: string
    at: number
}

export type UpsertScanFailureEventInput = {
    projectId: string
    scanner: string
    status: string
    failureSignature: string
    firstScanId: string
    at: number
}

export type UpsertResult = {
    eventId: string
    isNew: boolean
}

// On new key: INSERT with first_seen_at = at, first_notified_at = null.
// On existing key: UPDATE last_seen_at = at AND severity (see upsertByIdentityKey for why severity
// specifically must be refreshed).
export function upsertFindingEvent(db: DrizzleDb, input: UpsertFindingEventInput): UpsertResult {
    const identityKey = findingIdentityKey({
        projectId: input.projectId,
        source: input.source,
        ecosystem: input.ecosystem,
        advisoryId: input.advisoryId,
        packageName: input.packageName
    })
    return upsertByIdentityKey(db, {
        identityKey,
        eventType: 'finding',
        projectId: input.projectId,
        // The `scanner` column carries the persisted source identity for finding events.
        scanner: input.source,
        ecosystem: input.ecosystem,
        advisoryId: input.advisoryId,
        packageName: input.packageName,
        severity: input.severity,
        failureSignature: null,
        firstScanId: input.firstScanId,
        at: input.at
    })
}

export function upsertScanFailureEvent(db: DrizzleDb, input: UpsertScanFailureEventInput): UpsertResult {
    const identityKey = scanFailureIdentityKey({
        projectId: input.projectId,
        scanner: input.scanner,
        status: input.status,
        failureSignature: input.failureSignature
    })
    return upsertByIdentityKey(db, {
        identityKey,
        eventType: 'scan_failure',
        projectId: input.projectId,
        scanner: input.scanner,
        ecosystem: null,
        advisoryId: null,
        packageName: null,
        severity: null,
        failureSignature: input.failureSignature,
        firstScanId: input.firstScanId,
        at: input.at
    })
}

export function getEventByIdentityKey(db: DrizzleDb, identityKey: string): NotificationEvent | null {
    const row = db.select().from(notificationEvents).where(eq(notificationEvents.identityKey, identityKey)).get()
    if (!row) return null
    return rowToEvent(row)
}

export function listEventsForProject(db: DrizzleDb, projectId: string): NotificationEvent[] {
    const rows = db.select().from(notificationEvents).where(eq(notificationEvents.projectId, projectId)).all()
    return rows.map(rowToEvent)
}

export function setFirstNotifiedAt(db: DrizzleDb, eventId: string, at: number): void {
    // Only set if currently null — never overwrite.
    db.update(notificationEvents)
        .set({ firstNotifiedAt: at })
        .where(and(eq(notificationEvents.id, eventId), sql`${notificationEvents.firstNotifiedAt} IS NULL`))
        .run()
}

type UpsertInternalInput = {
    identityKey: string
    eventType: 'finding' | 'scan_failure'
    projectId: string
    scanner: string
    ecosystem: string | null
    advisoryId: string | null
    packageName: string | null
    severity: Severity | null
    failureSignature: string | null
    firstScanId: string
    at: number
}

function upsertByIdentityKey(db: DrizzleDb, input: UpsertInternalInput): UpsertResult {
    const existing = db
        .select({ id: notificationEvents.id })
        .from(notificationEvents)
        .where(eq(notificationEvents.identityKey, input.identityKey))
        .get()
    if (existing) {
        // `severity` is refreshed, not left at whatever the first sighting wrote. It is not a
        // descriptive field: selectDispatchablePairs applies the target's severity_filter against THIS
        // column, so a stale value decides whether an alert is sent at all. A finding re-graded between
        // scans — most often by cross-source escalation to the worst grade any source gave it — was
        // otherwise frozen at its first grade forever, because nothing else ever wrote this column
        // again. On a real instance that left 135 events below the finding's actual severity, 41 of
        // them recording a critical as low/high/moderate. A null severity (scan_failure events) is not
        // written, so it can never overwrite a finding event's grade.
        const values: { lastSeenAt: number; severity?: Severity } = { lastSeenAt: input.at }
        if (input.severity !== null) values.severity = input.severity
        db.update(notificationEvents)
            .set(values)
            .where(eq(notificationEvents.id, existing.id))
            .run()
        return { eventId: existing.id, isNew: false }
    }
    const id = ulid()
    db.insert(notificationEvents)
        .values({
            id,
            eventType: input.eventType,
            identityKey: input.identityKey,
            projectId: input.projectId,
            scanner: input.scanner,
            ecosystem: input.ecosystem,
            advisoryId: input.advisoryId,
            packageName: input.packageName,
            severity: input.severity,
            failureSignature: input.failureSignature,
            firstScanId: input.firstScanId,
            firstSeenAt: input.at,
            firstNotifiedAt: null,
            lastSeenAt: input.at
        })
        .run()
    return { eventId: id, isNew: true }
}

function rowToEvent(row: NotificationEventRow): NotificationEvent {
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
