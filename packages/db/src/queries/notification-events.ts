import { and, eq, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { NotificationEvent, Severity } from '@sentinello/core'
import type { DrizzleDb } from '../client'
import { notificationEvents } from '../schema'
import { findingIdentityKey, scanFailureIdentityKey } from '../identity'

type NotificationEventRow = typeof notificationEvents.$inferSelect

export type UpsertFindingEventInput = {
    projectId: string
    scanner: string
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
// On existing key: UPDATE last_seen_at = at (other fields untouched).
export function upsertFindingEvent(db: DrizzleDb, input: UpsertFindingEventInput): UpsertResult {
    const identityKey = findingIdentityKey({
        projectId: input.projectId,
        scanner: input.scanner,
        advisoryId: input.advisoryId,
        packageName: input.packageName
    })
    return upsertByIdentityKey(db, {
        identityKey,
        eventType: 'finding',
        projectId: input.projectId,
        scanner: input.scanner,
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
        db.update(notificationEvents)
            .set({ lastSeenAt: input.at })
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
