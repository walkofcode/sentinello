import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NotificationTarget } from '@sentinello/core'
import { openDb } from '../client'
import type { DrizzleDb, SqliteDb } from '../client'
import { runMigrations } from '../migrate'
import { upsertRoot } from './config'
import { upsertProject } from './projects'
import { insertScan } from './scans'
import {
    deleteNotificationTarget,
    getNotificationTargetById,
    insertNotificationTarget,
    listEnabledNotificationTargets,
    listNotificationTargets,
    setNotificationTargetEnabled,
    updateNotificationTarget
} from './notifications'
import {
    getEventByIdentityKey,
    listEventsForProject,
    setFirstNotifiedAt,
    upsertFindingEvent,
    upsertScanFailureEvent
} from './notification-events'
import { listRootIdsForTargets, listTargetRootIds, setTargetRoots } from './notification-target-roots'
import {
    deleteTargetProjectsForProject,
    listProjectIdsForTargets,
    listTargetProjectIds,
    setTargetProjects
} from './notification-target-projects'

// Notification events are the dedupe layer: an event is created once per distinct identity and
// re-seen thereafter. Getting that wrong is what turns a scanner into a spam machine (re-notifying
// every scan) or into silence (never notifying at all), so isNew and firstNotifiedAt carry the weight.

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle')

const ROOT_ID = 'root-1'
const OTHER_ROOT_ID = 'root-2'
const PROJECT_ID = 'project-1'
const OTHER_PROJECT_ID = 'project-2'
const T0 = Date.UTC(2026, 0, 1)
const HOUR = 3600_000

let db: DrizzleDb
let sqlite: SqliteDb
let dir: string

function target(overrides: Partial<NotificationTarget> = {}): NotificationTarget {
    return {
        id: 'target-1',
        kind: 'slack',
        config: { webhookUrl: 'https://hooks.slack.com/services/T/B/X' },
        severityFilter: ['critical', 'high'],
        envFilter: 'all',
        enabled: true,
        createdAt: T0,
        rootIds: [],
        projectIds: [],
        sourceScope: { mode: 'all', cells: [] },
        ...overrides
    }
}

function findingEvent(overrides: Record<string, unknown> = {}) {
    return {
        projectId: PROJECT_ID,
        source: 'osv',
        ecosystem: 'npm',
        advisoryId: 'GHSA-1',
        packageName: 'lodash',
        severity: 'high' as const,
        firstScanId: 'scan-1',
        at: T0,
        ...overrides
    }
}

function failureEvent(overrides: Record<string, unknown> = {}) {
    return {
        projectId: PROJECT_ID,
        scanner: 'npm-audit',
        status: 'error',
        failureSignature: 'error:no_lockfile',
        firstScanId: 'scan-1',
        at: T0,
        ...overrides
    }
}

function addProject(id: string, rootId: string, relPath: string): void {
    upsertProject(db, {
        id,
        rootId,
        relPath,
        name: relPath,
        alias: null,
        packageManager: 'npm',
        nvmrcVersion: null,
        gitBranch: null,
        ecosystems: ['npm'],
        muted: false,
        tags: [],
        createdAt: T0,
        updatedAt: T0
    })
}

beforeEach(async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-notifications-'))
    const opened = openDb({ dbPath: join(dir, 'test.sqlite') })
    db = opened.db
    sqlite = opened.sqlite
    runMigrations(db, { migrationsFolder: MIGRATIONS })

    upsertRoot(db, { id: ROOT_ID, path: '/repo', label: null, createdAt: T0 })
    upsertRoot(db, { id: OTHER_ROOT_ID, path: '/other', label: null, createdAt: T0 })
    addProject(PROJECT_ID, ROOT_ID, 'app')
    addProject(OTHER_PROJECT_ID, OTHER_ROOT_ID, 'other-app')

    // notification_events.first_scan_id is a real foreign key, so events need a scan to point at.
    for (const projectId of [PROJECT_ID, OTHER_PROJECT_ID]) {
        insertScan(db, {
            id: projectId === PROJECT_ID ? 'scan-1' : 'scan-2',
            projectId,
            startedAt: T0 - 1000,
            finishedAt: T0,
            scanner: 'osv',
            source: 'osv',
            ecosystem: 'npm',
            status: 'ok',
            reasonCode: 'ok',
            durationMs: 1000,
            errorText: null,
            rawJson: ''
        })
    }
})

afterEach(async function teardown() {
    sqlite.close()
    await rm(dir, { recursive: true, force: true })
})

describe('notification targets', function () {
    it('round-trips a target', function () {
        insertNotificationTarget(db, target())
        expect(getNotificationTargetById(db, 'target-1')).toEqual(target())
    })

    it('returns null for an unknown id', function () {
        expect(getNotificationTargetById(db, 'nope')).toBeNull()
    })

    it('lists every target', function () {
        insertNotificationTarget(db, target({ id: 'a' }))
        insertNotificationTarget(db, target({ id: 'b', enabled: false }))
        expect(listNotificationTargets(db)).toHaveLength(2)
    })

    it('lists only enabled targets when asked', function () {
        insertNotificationTarget(db, target({ id: 'a' }))
        insertNotificationTarget(db, target({ id: 'b', enabled: false }))
        expect(listEnabledNotificationTargets(db).map(function id(t) { return t.id })).toEqual(['a'])
    })

    it('returns nothing when there are no targets', function () {
        expect(listNotificationTargets(db)).toEqual([])
    })

    it('toggles the enabled flag', function () {
        insertNotificationTarget(db, target())
        setNotificationTargetEnabled(db, 'target-1', false)
        expect(getNotificationTargetById(db, 'target-1')?.enabled).toBe(false)
    })

    it.each([
        ['telegram', { botToken: '123:abc', chatId: '-100' }],
        ['webhook', { url: 'https://example.com/hook', flavor: 'text' as const }]
    ] as Array<[NotificationTarget['kind'], NotificationTarget['config']]>)(
        'round-trips a %s config',
        function (kind, config) {
            insertNotificationTarget(db, target({ kind, config }))
            expect(getNotificationTargetById(db, 'target-1')?.config).toEqual(config)
        }
    )
})

describe('updateNotificationTarget', function () {
    it('patches only the fields supplied', function () {
        insertNotificationTarget(db, target())
        updateNotificationTarget(db, { id: 'target-1', severityFilter: ['low'] })
        const updated = getNotificationTargetById(db, 'target-1')
        expect(updated?.severityFilter).toEqual(['low'])
        expect(updated?.config).toEqual(target().config)
    })

    // The whole reason config is optional: the caller can flip a filter without re-supplying the
    // raw secret payload it may not even have.
    it('leaves the config untouched when it is not supplied', function () {
        insertNotificationTarget(db, target())
        updateNotificationTarget(db, { id: 'target-1', enabled: false })
        expect(getNotificationTargetById(db, 'target-1')?.config).toEqual(target().config)
    })

    it('is a no-op when nothing is supplied', function () {
        insertNotificationTarget(db, target())
        updateNotificationTarget(db, { id: 'target-1' })
        expect(getNotificationTargetById(db, 'target-1')).toEqual(target())
    })

    // createdAt anchors backfill semantics, so no update path may move it.
    it('never changes createdAt', function () {
        insertNotificationTarget(db, target())
        updateNotificationTarget(db, { id: 'target-1', enabled: false, severityFilter: ['low'] })
        expect(getNotificationTargetById(db, 'target-1')?.createdAt).toBe(T0)
    })

    it('updates the env filter and source scope', function () {
        insertNotificationTarget(db, target())
        updateNotificationTarget(db, {
            id: 'target-1',
            envFilter: 'prod',
            sourceScope: { mode: 'selected', cells: [{ source: 'osv', ecosystem: 'npm' }] }
        })
        const updated = getNotificationTargetById(db, 'target-1')
        expect(updated?.envFilter).toBe('prod')
        expect(updated?.sourceScope).toEqual({ mode: 'selected', cells: [{ source: 'osv', ecosystem: 'npm' }] })
    })
})

describe('deleteNotificationTarget', function () {
    it('removes the target', function () {
        insertNotificationTarget(db, target())
        deleteNotificationTarget(db, 'target-1')
        expect(getNotificationTargetById(db, 'target-1')).toBeNull()
    })

    // Three FK children point at the target and the client opens with foreign_keys = ON, so the
    // scope rows must be cleared child-first or the parent delete is rejected outright.
    it('cascades to the scope rows', function () {
        insertNotificationTarget(db, target())
        setTargetRoots(db, 'target-1', [ROOT_ID])
        setTargetProjects(db, 'target-1', [PROJECT_ID])
        deleteNotificationTarget(db, 'target-1')
        expect(listTargetRootIds(db, 'target-1')).toEqual([])
        expect(listTargetProjectIds(db, 'target-1')).toEqual([])
    })

    it('is a no-op for an unknown id', function () {
        insertNotificationTarget(db, target())
        deleteNotificationTarget(db, 'nope')
        expect(listNotificationTargets(db)).toHaveLength(1)
    })
})

describe('target scope rows', function () {
    it('stores and reads back root scope', function () {
        insertNotificationTarget(db, target())
        setTargetRoots(db, 'target-1', [ROOT_ID, OTHER_ROOT_ID])
        expect(listTargetRootIds(db, 'target-1').sort()).toEqual([ROOT_ID, OTHER_ROOT_ID].sort())
    })

    it('replaces the previous root scope rather than appending', function () {
        insertNotificationTarget(db, target())
        setTargetRoots(db, 'target-1', [ROOT_ID])
        setTargetRoots(db, 'target-1', [OTHER_ROOT_ID])
        expect(listTargetRootIds(db, 'target-1')).toEqual([OTHER_ROOT_ID])
    })

    // Empty scope means "everything", so clearing must actually leave zero rows.
    it('clears the scope when given an empty list', function () {
        insertNotificationTarget(db, target())
        setTargetRoots(db, 'target-1', [ROOT_ID])
        setTargetRoots(db, 'target-1', [])
        expect(listTargetRootIds(db, 'target-1')).toEqual([])
    })

    it('stores and reads back project scope', function () {
        insertNotificationTarget(db, target())
        setTargetProjects(db, 'target-1', [PROJECT_ID])
        expect(listTargetProjectIds(db, 'target-1')).toEqual([PROJECT_ID])
    })

    it('hydrates scope onto a listed target', function () {
        insertNotificationTarget(db, target())
        setTargetRoots(db, 'target-1', [ROOT_ID])
        setTargetProjects(db, 'target-1', [PROJECT_ID])
        const listed = listNotificationTargets(db)[0]
        expect(listed?.rootIds).toEqual([ROOT_ID])
        expect(listed?.projectIds).toEqual([PROJECT_ID])
    })

    it('batches scope lookups per target', function () {
        insertNotificationTarget(db, target({ id: 'a' }))
        insertNotificationTarget(db, target({ id: 'b' }))
        setTargetRoots(db, 'a', [ROOT_ID])
        setTargetProjects(db, 'b', [PROJECT_ID])
        expect(listRootIdsForTargets(db, ['a', 'b']).get('a')).toEqual([ROOT_ID])
        // Every requested id gets an entry, so an unscoped target reads as an empty list rather
        // than a missing key — callers can treat "no scope rows" as "everything" without a guard.
        expect(listRootIdsForTargets(db, ['a', 'b']).get('b')).toEqual([])
        expect(listProjectIdsForTargets(db, ['a', 'b']).get('b')).toEqual([PROJECT_ID])
    })

    it('returns an empty map for no target ids', function () {
        expect(listRootIdsForTargets(db, []).size).toBe(0)
        expect(listProjectIdsForTargets(db, []).size).toBe(0)
    })

    it('drops project scope rows when the project itself goes away', function () {
        insertNotificationTarget(db, target())
        setTargetProjects(db, 'target-1', [PROJECT_ID, OTHER_PROJECT_ID])
        deleteTargetProjectsForProject(db, PROJECT_ID)
        expect(listTargetProjectIds(db, 'target-1')).toEqual([OTHER_PROJECT_ID])
    })
})

describe('upsertFindingEvent', function () {
    it('reports the first sighting as new', function () {
        expect(upsertFindingEvent(db, findingEvent()).isNew).toBe(true)
    })

    // The dedupe contract: the same identity seen again is NOT new, so it never re-notifies.
    it('reports a repeat sighting as not new', function () {
        const first = upsertFindingEvent(db, findingEvent())
        const second = upsertFindingEvent(db, findingEvent({ at: T0 + HOUR }))
        expect(second.isNew).toBe(false)
        expect(second.eventId).toBe(first.eventId)
    })

    it('advances lastSeenAt but leaves firstSeenAt alone', function () {
        const { eventId } = upsertFindingEvent(db, findingEvent())
        upsertFindingEvent(db, findingEvent({ at: T0 + HOUR }))
        const event = listEventsForProject(db, PROJECT_ID).find(function byId(e) { return e.id === eventId })
        expect(event?.firstSeenAt).toBe(T0)
        expect(event?.lastSeenAt).toBe(T0 + HOUR)
    })

    it.each([
        ['projectId', { projectId: OTHER_PROJECT_ID }],
        ['source', { source: 'npm-audit' }],
        ['ecosystem', { ecosystem: 'PyPI' }],
        ['advisoryId', { advisoryId: 'GHSA-2' }],
        ['packageName', { packageName: 'express' }]
    ] as Array<[string, Record<string, unknown>]>)('treats a different %s as a new event', function (_f, override) {
        upsertFindingEvent(db, findingEvent())
        expect(upsertFindingEvent(db, findingEvent(override)).isNew).toBe(true)
    })

    // The `scanner` column carries the persisted SOURCE identity for finding events.
    it('stores the source identity in the scanner column', function () {
        upsertFindingEvent(db, findingEvent({ source: 'gemnasium' }))
        expect(listEventsForProject(db, PROJECT_ID)[0]?.scanner).toBe('gemnasium')
    })

    it('starts with no notification recorded', function () {
        upsertFindingEvent(db, findingEvent())
        expect(listEventsForProject(db, PROJECT_ID)[0]?.firstNotifiedAt).toBeNull()
    })

    it('can be found by its identity key', function () {
        upsertFindingEvent(db, findingEvent())
        const key = listEventsForProject(db, PROJECT_ID)[0]?.identityKey
        expect(key).toBeDefined()
        expect(getEventByIdentityKey(db, key ?? '')?.advisoryId).toBe('GHSA-1')
    })

    it('returns null for an unknown identity key', function () {
        expect(getEventByIdentityKey(db, 'nope')).toBeNull()
    })
})

describe('upsertScanFailureEvent', function () {
    it('reports the first failure as new', function () {
        expect(upsertScanFailureEvent(db, failureEvent()).isNew).toBe(true)
    })

    it('deduplicates a repeating failure', function () {
        upsertScanFailureEvent(db, failureEvent())
        expect(upsertScanFailureEvent(db, failureEvent({ at: T0 + HOUR })).isNew).toBe(false)
    })

    it('treats a different failure signature as a new event', function () {
        upsertScanFailureEvent(db, failureEvent())
        expect(upsertScanFailureEvent(db, failureEvent({ failureSignature: 'error:timeout' })).isNew).toBe(true)
    })

    // Scan failures are operational signals that bypass severity and ecosystem filtering entirely.
    it('carries no severity or ecosystem', function () {
        upsertScanFailureEvent(db, failureEvent())
        const event = listEventsForProject(db, PROJECT_ID)[0]
        expect(event?.eventType).toBe('scan_failure')
        expect(event?.severity).toBeNull()
        expect(event?.ecosystem).toBeNull()
    })

    it('keeps a failure event distinct from a finding event', function () {
        upsertFindingEvent(db, findingEvent())
        upsertScanFailureEvent(db, failureEvent())
        expect(listEventsForProject(db, PROJECT_ID)).toHaveLength(2)
    })
})

describe('listEventsForProject', function () {
    it('returns only that project events', function () {
        upsertFindingEvent(db, findingEvent({ projectId: PROJECT_ID }))
        upsertFindingEvent(db, findingEvent({ projectId: OTHER_PROJECT_ID }))
        expect(listEventsForProject(db, PROJECT_ID)).toHaveLength(1)
    })

    it('returns nothing for a project with no events', function () {
        expect(listEventsForProject(db, PROJECT_ID)).toEqual([])
    })
})

describe('setFirstNotifiedAt', function () {
    it('records when the event was first notified', function () {
        const { eventId } = upsertFindingEvent(db, findingEvent())
        setFirstNotifiedAt(db, eventId, T0 + HOUR)
        expect(listEventsForProject(db, PROJECT_ID)[0]?.firstNotifiedAt).toBe(T0 + HOUR)
    })

    // Write-once: a later notification must not move the anchor, or "when did we first tell you"
    // stops being answerable.
    it('never overwrites an existing value', function () {
        const { eventId } = upsertFindingEvent(db, findingEvent())
        setFirstNotifiedAt(db, eventId, T0 + HOUR)
        setFirstNotifiedAt(db, eventId, T0 + 2 * HOUR)
        expect(listEventsForProject(db, PROJECT_ID)[0]?.firstNotifiedAt).toBe(T0 + HOUR)
    })

    it('is a no-op for an unknown event id', function () {
        expect(function set() {
            setFirstNotifiedAt(db, 'nope', T0)
        }).not.toThrow()
    })
})
