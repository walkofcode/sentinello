import { and, eq, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { EcosystemId, GradeAnswers, NotificationEvent, Severity } from '@sentinello/core'
import type { DrizzleDb } from '../client'
import { notificationEvents } from '../schema'
import { findingIdentityKey, scanFailureIdentityKey } from '../identity'

type NotificationEventRow = typeof notificationEvents.$inferSelect

// Bumped by a release that corrects grades: every event behind it starts answering afresh. 1 is 3.8.2, which
// scored RUSTSEC and PYSEC vectors and stopped calling an ungraded advisory moderate.
export const EVENT_GRADE_VERSION = 1

export type EventGrade = {
    severity: Severity | null
    gradeVersion: number
    policySeverity: Severity | null
    gradeAnswers: GradeAnswers | null
}

// The corrected-grade rule: per event and per source, so a release that corrects grades sends no burst, and a
// later real re-grade still reaches a target it now qualifies for (SENTINEL-178, SENTINEL-188).
//
//   1. An event behind the version starts over: stored answers empty, a held grade kept.
//   2. An event with no stored answers (recorded at the current version) tracks nothing and behaves as always:
//      severity written, nothing held.
//   3. A severity change is real if and only if a source in both the stored answers and this sighting's answers
//      now answers differently. Anything else is a correction: a source's first answer, or one that fell silent
//      coming back. There is no event-level completion, and nothing waits for another source's cell, so a source
//      that keeps failing holds up nobody.
//   4. Real clears the held grade. A correction keeps the grade it replaced, unless one is already held.
//   5. The answers merge: a source not in this sighting keeps its stored answer. A hold equal to the new severity
//      says nothing, and is dropped.
//
// Accepted limit: on an event older than the version, a source's first answer reads as a correction even if it
// also carries a real re-grade (once per source per event); and a real change with another source's first
// answer in one sighting reads as real.
export function nextEventGrade(current: EventGrade, sighting: { severity: Severity; answers: GradeAnswers }): EventGrade {
    const stored = current.gradeVersion < EVENT_GRADE_VERSION ? {} : current.gradeAnswers
    if (stored === null) return { severity: sighting.severity, gradeVersion: EVENT_GRADE_VERSION, policySeverity: null, gradeAnswers: null }
    let policySeverity = current.policySeverity
    if (sighting.severity !== current.severity) {
        const real = Object.keys(stored).some(function answersDifferently(source) {
            return source in sighting.answers && sighting.answers[source] !== stored[source]
        })
        policySeverity = real ? null : policySeverity ?? current.severity
    }
    if (policySeverity === sighting.severity) policySeverity = null
    return { severity: sighting.severity, gradeVersion: EVENT_GRADE_VERSION, policySeverity, gradeAnswers: { ...stored, ...sighting.answers } }
}

// Degrades to no stored answers rather than throwing, like the other JSON readers of a row: a corrupted column
// costs one correction's silence, not every scan of the project.
function parseGradeAnswers(json: string | null): GradeAnswers | null {
    if (json === null) return null
    let parsed: unknown
    try {
        parsed = JSON.parse(json)
    } catch {
        return {}
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as GradeAnswers
}

export type UpsertFindingEventInput = {
    projectId: string
    // The persisted source identity (Finding.source), NOT the scanner plugin name. It is what the
    // dedupe identity_key hashes and what lands in the event's `scanner` column (which carries the
    // persisted source identity for finding events — see the NotificationEvent type in @sentinello/core).
    source: string
    // Required and explicit (SENTINEL-121): a finding identity never falls back to npm.
    ecosystem: EcosystemId
    advisoryId: string
    packageName: string
    severity: Severity
    // What each source answered about this finding in this sighting (GradeAnswers); empty when nothing is known.
    gradeAnswers: GradeAnswers
    firstScanId: string
    at: number
    // The capability whose silent baseline records this event (notification_events.baseline_of), or null.
    // Written when the event is first recorded and never afterwards: whether a finding was told in the
    // baseline summary or one by one is decided once, when it is first seen.
    baselineOf: string | null
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
        gradeAnswers: input.gradeAnswers,
        failureSignature: null,
        firstScanId: input.firstScanId,
        at: input.at,
        baselineOf: input.baselineOf
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
        gradeAnswers: null,
        failureSignature: input.failureSignature,
        firstScanId: input.firstScanId,
        at: input.at,
        // Scan failures always notify, during a baseline too.
        baselineOf: null
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
    gradeAnswers: GradeAnswers | null
    failureSignature: string | null
    firstScanId: string
    at: number
    baselineOf: string | null
}

function upsertByIdentityKey(db: DrizzleDb, input: UpsertInternalInput): UpsertResult {
    const existing = db
        .select({ id: notificationEvents.id, severity: notificationEvents.severity, gradeVersion: notificationEvents.gradeVersion, policySeverity: notificationEvents.policySeverity, gradeAnswersJson: notificationEvents.gradeAnswersJson })
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
        // them recording a critical as low/high/moderate. A scan_failure event has no grade, and nothing of
        // it is written. What the refresh means to a target's filter is nextEventGrade's to say.
        const values: { lastSeenAt: number; severity?: Severity; gradeVersion?: number; policySeverity?: Severity | null; gradeAnswersJson?: string | null } = { lastSeenAt: input.at }
        if (input.severity !== null && input.gradeAnswers !== null) {
            const next = nextEventGrade(
                { severity: existing.severity, gradeVersion: existing.gradeVersion, policySeverity: existing.policySeverity, gradeAnswers: parseGradeAnswers(existing.gradeAnswersJson) },
                { severity: input.severity, answers: input.gradeAnswers }
            )
            values.severity = input.severity
            values.gradeVersion = next.gradeVersion
            values.policySeverity = next.policySeverity
            values.gradeAnswersJson = next.gradeAnswers === null ? null : JSON.stringify(next.gradeAnswers)
        }
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
            // A new event is at the current version with no stored answers: it is news as it stands.
            gradeVersion: EVENT_GRADE_VERSION,
            policySeverity: null,
            gradeAnswersJson: null,
            failureSignature: input.failureSignature,
            firstScanId: input.firstScanId,
            firstSeenAt: input.at,
            firstNotifiedAt: null,
            lastSeenAt: input.at,
            baselineOf: input.baselineOf
        })
        .run()
    return { eventId: id, isNew: true }
}

export function rowToEvent(row: NotificationEventRow): NotificationEvent {
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
        gradeVersion: row.gradeVersion,
        policySeverity: row.policySeverity,
        gradeAnswers: parseGradeAnswers(row.gradeAnswersJson),
        failureSignature: row.failureSignature,
        firstScanId: row.firstScanId,
        firstSeenAt: row.firstSeenAt,
        firstNotifiedAt: row.firstNotifiedAt,
        lastSeenAt: row.lastSeenAt
    }
}
