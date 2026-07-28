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
import { mergeFindingsForScan, type IncomingFinding } from './findings'
import { insertMute } from './mutes'
import { insertNotificationTarget } from './notifications'
import { upsertFindingEvent, upsertScanFailureEvent } from './notification-events'
import { setTargetRoots } from './notification-target-roots'
import { setTargetProjects } from './notification-target-projects'
import {
    backfillForNewTarget,
    getDelivery,
    recordAttempt,
    recordFailure,
    recordSuccess,
    selectDispatchablePairs
} from './notification-deliveries'

// selectDispatchablePairs is the dispatch decision, and every filter in it is enforced in SQL
// precisely so a caller cannot forge its way past one. Both directions of failure are real: an
// over-permissive predicate pages people about findings they muted or filtered out, and an
// over-restrictive one silently never notifies at all.
//
// Two rules carry most of the weight. Operational events (scan_failure) deliberately bypass the
// severity, environment and source-scope filters, because they have no underlying finding to
// classify — but they do NOT bypass project-scope mutes. And a newly created target must not be
// back-flooded with the entire history, unless an operator explicitly asked for it, which is what
// the placeholder rows written by backfillForNewTarget mean.

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle')

const ROOT_ID = 'root-1'
const OTHER_ROOT_ID = 'root-2'
const PROJECT_ID = 'project-1'
const OTHER_PROJECT_ID = 'project-2'
const TARGET_ID = 'target-1'
const T0 = Date.UTC(2026, 0, 1)
const HOUR = 3600_000

let db: DrizzleDb
let sqlite: SqliteDb
let dir: string

function target(overrides: Partial<NotificationTarget> = {}): NotificationTarget {
    return {
        id: TARGET_ID,
        kind: 'webhook',
        config: { url: 'https://hooks.example.test/incoming' },
        severityFilter: ['critical', 'high'],
        envFilter: 'all',
        enabled: true,
        // Created before every event in this suite, so the no-backflood gate passes by default.
        createdAt: T0 - HOUR,
        rootIds: [],
        projectIds: [],
        sourceScope: { mode: 'all', cells: [] },
        ...overrides
    }
}

function addTarget(overrides: Partial<NotificationTarget> = {}): NotificationTarget {
    const t = target(overrides)
    insertNotificationTarget(db, t)
    return t
}

function addFindingEvent(overrides: Record<string, unknown> = {}): string {
    return upsertFindingEvent(db, {
        projectId: PROJECT_ID,
        source: 'osv',
        ecosystem: 'npm',
        advisoryId: 'CVE-2024-1',
        packageName: 'lodash',
        severity: 'high',
        firstScanId: 'scan-1',
        at: T0,
        ...overrides
    } as Parameters<typeof upsertFindingEvent>[1]).eventId
}

function addFailureEvent(overrides: Record<string, unknown> = {}): string {
    return upsertScanFailureEvent(db, {
        projectId: PROJECT_ID,
        scanner: 'npm-audit',
        status: 'error',
        failureSignature: 'error:no_lockfile',
        firstScanId: 'scan-1',
        at: T0,
        ...overrides
    } as Parameters<typeof upsertScanFailureEvent>[1]).eventId
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

// Writes a real finding row matching a finding event's identity tuple, which is what the
// environment filter EXISTS-joins against.
function addFinding(overrides: Partial<IncomingFinding> = {}): void {
    mergeFindingsForScan(db, {
        projectId: PROJECT_ID,
        scanner: 'osv',
        scanId: 'scan-1',
        scanFinishedAt: T0,
        incoming: [{
            projectId: PROJECT_ID,
            scanner: 'osv',
            source: 'osv',
            ecosystem: 'npm',
            advisoryId: 'CVE-2024-1',
            advisoryTitle: 'Prototype pollution',
            advisoryUrl: null,
            packageName: 'lodash',
            installedVersion: '4.17.11',
            vulnerableRange: '<4.17.21',
            severity: 'high',
            fixAvailable: true,
            fixVersion: '4.17.21',
            depPath: ['lodash'],
            isProd: true,
            isDev: false,
            ...overrides
        }]
    })
}

function dispatchable(at = T0 + HOUR) {
    return selectDispatchablePairs(db, PROJECT_ID, at)
}

beforeEach(async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-deliveries-'))
    const opened = openDb({ dbPath: join(dir, 'test.sqlite') })
    db = opened.db
    sqlite = opened.sqlite
    runMigrations(db, { migrationsFolder: MIGRATIONS })
    upsertRoot(db, { id: ROOT_ID, path: '/repo', label: null, createdAt: T0 })
    upsertRoot(db, { id: OTHER_ROOT_ID, path: '/other', label: null, createdAt: T0 })
    addProject(PROJECT_ID, ROOT_ID, 'app')
    addProject(OTHER_PROJECT_ID, OTHER_ROOT_ID, 'other')
    // Every event references a first_scan_id by foreign key, so the scan has to exist before any
    // event is written — regardless of whether the test also needs a finding row.
    insertScan(db, {
        id: 'scan-1',
        projectId: PROJECT_ID,
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
})

afterEach(async function teardown() {
    sqlite.close()
    await rm(dir, { recursive: true, force: true })
})

describe('selectDispatchablePairs — basics', function () {
    it('pairs an event with an eligible target', function () {
        addTarget()
        addFindingEvent()
        const pairs = dispatchable()
        expect(pairs).toHaveLength(1)
        expect(pairs[0]?.target.id).toBe(TARGET_ID)
    })

    it('returns nothing when there are no targets', function () {
        addFindingEvent()
        expect(dispatchable()).toEqual([])
    })

    it('skips a disabled target', function () {
        addTarget({ enabled: false })
        addFindingEvent()
        expect(dispatchable()).toEqual([])
    })

    it('only considers events for the requested project', function () {
        addTarget()
        addFindingEvent({ projectId: OTHER_PROJECT_ID })
        expect(dispatchable()).toEqual([])
    })

    it('pairs one event with every eligible target', function () {
        addTarget({ id: 'a' })
        addTarget({ id: 'b' })
        addFindingEvent()
        expect(dispatchable()).toHaveLength(2)
    })

    it('hydrates the target scope onto the returned object', function () {
        addTarget()
        setTargetRoots(db, TARGET_ID, [ROOT_ID])
        setTargetProjects(db, TARGET_ID, [PROJECT_ID])
        addFindingEvent()
        const pair = dispatchable()[0]
        expect(pair?.target.rootIds).toEqual([ROOT_ID])
        expect(pair?.target.projectIds).toEqual([PROJECT_ID])
    })
})

describe('selectDispatchablePairs — no back-flooding a new target', function () {
    // A target created today must not immediately fire for every historical finding.
    it('skips an event first seen before the target existed', function () {
        addTarget({ createdAt: T0 + HOUR })
        addFindingEvent({ at: T0 })
        expect(dispatchable(T0 + 2 * HOUR)).toEqual([])
    })

    it('includes an event first seen exactly at the target creation instant', function () {
        addTarget({ createdAt: T0 })
        addFindingEvent({ at: T0 })
        expect(dispatchable()).toHaveLength(1)
    })

    // The operator's explicit opt-in: a placeholder row with first_attempted_at NULL lets the event
    // through the gate it would otherwise fail.
    it('lets an operator-requested backfill bypass the gate', function () {
        addTarget({ createdAt: T0 + HOUR })
        addFindingEvent({ at: T0 })
        expect(dispatchable(T0 + 2 * HOUR)).toEqual([])

        expect(backfillForNewTarget(db, TARGET_ID, T0 + 2 * HOUR)).toBe(1)
        expect(dispatchable(T0 + 2 * HOUR)).toHaveLength(1)
    })
})

describe('selectDispatchablePairs — delivery state', function () {
    it('stops offering a pair once it has succeeded', function () {
        addTarget()
        const eventId = addFindingEvent()
        recordAttempt(db, eventId, TARGET_ID, T0 + HOUR)
        recordSuccess(db, eventId, TARGET_ID, T0 + HOUR)
        expect(dispatchable()).toEqual([])
    })

    // A failed delivery must stay dispatchable, otherwise a transient webhook outage silently drops
    // the notification forever.
    it('keeps offering a pair that has only failed', function () {
        addTarget()
        const eventId = addFindingEvent()
        recordAttempt(db, eventId, TARGET_ID, T0 + HOUR)
        recordFailure(db, eventId, TARGET_ID, T0 + HOUR, 'connect ECONNREFUSED')
        expect(dispatchable()).toHaveLength(1)
    })

    it('does not let one target success suppress another target', function () {
        addTarget({ id: 'a' })
        addTarget({ id: 'b' })
        const eventId = addFindingEvent()
        recordAttempt(db, eventId, 'a', T0 + HOUR)
        recordSuccess(db, eventId, 'a', T0 + HOUR)
        const pairs = dispatchable()
        expect(pairs).toHaveLength(1)
        expect(pairs[0]?.target.id).toBe('b')
    })
})

describe('selectDispatchablePairs — severity filter', function () {
    it('skips a finding below the target severity filter', function () {
        addTarget({ severityFilter: ['critical'] })
        addFindingEvent({ severity: 'high' })
        expect(dispatchable()).toEqual([])
    })

    it('includes a finding at a listed severity', function () {
        addTarget({ severityFilter: ['critical', 'high'] })
        addFindingEvent({ severity: 'high' })
        expect(dispatchable()).toHaveLength(1)
    })

    // Operational signals always pass: a scan failure has no severity to filter on, and silently
    // dropping it would hide that scanning stopped working.
    it('lets a scan failure bypass the severity filter', function () {
        addTarget({ severityFilter: ['critical'] })
        addFailureEvent()
        expect(dispatchable()).toHaveLength(1)
    })

    it('skips everything when the severity filter is empty', function () {
        addTarget({ severityFilter: [] })
        addFindingEvent()
        expect(dispatchable()).toEqual([])
    })
})

describe('selectDispatchablePairs — environment filter', function () {
    it('passes everything for an all-environment target', function () {
        addTarget({ envFilter: 'all' })
        addFinding({ isProd: false, isDev: true })
        addFindingEvent()
        expect(dispatchable()).toHaveLength(1)
    })

    it('includes a production finding for a prod target', function () {
        addTarget({ envFilter: 'prod' })
        addFinding({ isProd: true, isDev: false })
        addFindingEvent()
        expect(dispatchable()).toHaveLength(1)
    })

    it('skips a dev-only finding for a prod target', function () {
        addTarget({ envFilter: 'prod' })
        addFinding({ isProd: false, isDev: true })
        addFindingEvent()
        expect(dispatchable()).toEqual([])
    })

    // "dev" means reachable ONLY from devDependencies — a package that is also production is not a
    // dev finding, matching dep-type.ts.
    it('skips a finding that is both prod and dev for a dev target', function () {
        addTarget({ envFilter: 'dev' })
        addFinding({ isProd: true, isDev: true })
        addFindingEvent()
        expect(dispatchable()).toEqual([])
    })

    it('includes a dev-only finding for a dev target', function () {
        addTarget({ envFilter: 'dev' })
        addFinding({ isProd: false, isDev: true })
        addFindingEvent()
        expect(dispatchable()).toHaveLength(1)
    })

    it('lets a scan failure bypass the environment filter', function () {
        addTarget({ envFilter: 'prod' })
        addFailureEvent()
        expect(dispatchable()).toHaveLength(1)
    })
})

describe('selectDispatchablePairs — source scope', function () {
    it('passes every cell for a mode-all target', function () {
        addTarget({ sourceScope: { mode: 'all', cells: [] } })
        addFindingEvent({ source: 'osv', ecosystem: 'npm' })
        expect(dispatchable()).toHaveLength(1)
    })

    it('includes an event whose cell is selected', function () {
        addTarget({ sourceScope: { mode: 'selected', cells: [{ source: 'osv', ecosystem: 'npm' }] } })
        addFindingEvent({ source: 'osv', ecosystem: 'npm' })
        expect(dispatchable()).toHaveLength(1)
    })

    it('skips an event whose source is not selected', function () {
        addTarget({ sourceScope: { mode: 'selected', cells: [{ source: 'gemnasium', ecosystem: 'npm' }] } })
        addFindingEvent({ source: 'osv', ecosystem: 'npm' })
        expect(dispatchable()).toEqual([])
    })

    // The cell is a (source, ecosystem) pair — matching the source alone is not enough.
    it('skips an event whose ecosystem is not selected', function () {
        addTarget({ sourceScope: { mode: 'selected', cells: [{ source: 'osv', ecosystem: 'PyPI' }] } })
        addFindingEvent({ source: 'osv', ecosystem: 'npm' })
        expect(dispatchable()).toEqual([])
    })

    it('lets a scan failure bypass source scope', function () {
        addTarget({ sourceScope: { mode: 'selected', cells: [{ source: 'gemnasium', ecosystem: 'npm' }] } })
        addFailureEvent()
        expect(dispatchable()).toHaveLength(1)
    })
})

describe('selectDispatchablePairs — target scope', function () {
    it('treats a target with no scope rows as covering everything', function () {
        addTarget()
        addFindingEvent()
        expect(dispatchable()).toHaveLength(1)
    })

    it('includes a project under an assigned root', function () {
        addTarget()
        setTargetRoots(db, TARGET_ID, [ROOT_ID])
        addFindingEvent()
        expect(dispatchable()).toHaveLength(1)
    })

    it('excludes a project under a root the target was not assigned', function () {
        addTarget()
        setTargetRoots(db, TARGET_ID, [OTHER_ROOT_ID])
        addFindingEvent()
        expect(dispatchable()).toEqual([])
    })

    it('includes an explicitly listed project', function () {
        addTarget()
        setTargetProjects(db, TARGET_ID, [PROJECT_ID])
        addFindingEvent()
        expect(dispatchable()).toHaveLength(1)
    })

    // Root and project scope are additive, not intersecting: a project listed explicitly passes even
    // though its root belongs to someone else.
    it('treats root and project scope as an additive allow-list', function () {
        addTarget()
        setTargetRoots(db, TARGET_ID, [OTHER_ROOT_ID])
        setTargetProjects(db, TARGET_ID, [PROJECT_ID])
        addFindingEvent()
        expect(dispatchable()).toHaveLength(1)
    })

    it('excludes a project in neither scope list', function () {
        addTarget()
        setTargetRoots(db, TARGET_ID, [OTHER_ROOT_ID])
        setTargetProjects(db, TARGET_ID, [OTHER_PROJECT_ID])
        addFindingEvent()
        expect(dispatchable()).toEqual([])
    })
})

describe('selectDispatchablePairs — mutes', function () {
    function mute(overrides: Record<string, unknown> = {}): void {
        insertMute(db, {
            id: 'mute-1',
            scope: 'finding',
            projectId: PROJECT_ID,
            scanner: 'osv',
            ecosystem: 'npm',
            advisoryId: 'CVE-2024-1',
            packageName: 'lodash',
            reason: 'accepted risk',
            author: 'betty',
            createdAt: T0,
            expiresAt: null,
            ...overrides
        } as Parameters<typeof insertMute>[1])
    }

    it('suppresses a muted finding', function () {
        addTarget()
        addFindingEvent()
        mute()
        expect(dispatchable()).toEqual([])
    })

    it('stops suppressing once the mute expires', function () {
        addTarget()
        addFindingEvent()
        mute({ expiresAt: T0 + HOUR })
        expect(dispatchable(T0 + 2 * HOUR)).toHaveLength(1)
    })

    it('still suppresses before the mute expires', function () {
        addTarget()
        addFindingEvent()
        mute({ expiresAt: T0 + 10 * HOUR })
        expect(dispatchable(T0 + 2 * HOUR)).toEqual([])
    })

    // A project-scope mute silences the project's operational signals too — muting a project means
    // "stop telling me about this", including that its scans are failing.
    it('lets a project mute suppress a scan failure as well as findings', function () {
        addTarget()
        addFindingEvent()
        addFailureEvent()
        expect(dispatchable()).toHaveLength(2)

        mute({ scope: 'project', scanner: null, ecosystem: null, advisoryId: null, packageName: null })
        expect(dispatchable()).toEqual([])
    })

    // A finding-scope mute must not silence operational signals: scan failures carry no advisory or
    // package identity, so they structurally cannot match one.
    it('does not let a finding mute suppress a scan failure', function () {
        addTarget()
        addFailureEvent()
        mute()
        expect(dispatchable()).toHaveLength(1)
    })

    it('does not let a mute for another package suppress this finding', function () {
        addTarget()
        addFindingEvent()
        mute({ packageName: 'express' })
        expect(dispatchable()).toHaveLength(1)
    })

    // Ecosystem is part of the mute identity so an npm mute cannot silence a same-named PyPI package.
    it('does not let an npm mute suppress a PyPI finding', function () {
        addTarget()
        addFindingEvent({ ecosystem: 'PyPI', packageName: 'requests' })
        mute({ ecosystem: 'npm', packageName: 'requests' })
        expect(dispatchable()).toHaveLength(1)
    })

    // A legacy row written before the ecosystem column existed still matches any ecosystem.
    it('treats a null-ecosystem mute as matching any ecosystem', function () {
        addTarget()
        addFindingEvent({ ecosystem: 'PyPI', packageName: 'requests' })
        mute({ ecosystem: null, packageName: 'requests' })
        expect(dispatchable()).toEqual([])
    })

    it('applies a global finding mute across projects', function () {
        addTarget()
        addFindingEvent()
        mute({ projectId: null })
        expect(dispatchable()).toEqual([])
    })
})

describe('delivery records', function () {
    it('reports no delivery before the first attempt', function () {
        addTarget()
        const eventId = addFindingEvent()
        expect(getDelivery(db, eventId, TARGET_ID)).toBeNull()
    })

    it('creates a row on the first attempt', function () {
        addTarget()
        const eventId = addFindingEvent()
        recordAttempt(db, eventId, TARGET_ID, T0 + HOUR)
        const delivery = getDelivery(db, eventId, TARGET_ID)
        expect(delivery?.firstAttemptedAt).toBe(T0 + HOUR)
        expect(delivery?.lastAttemptedAt).toBe(T0 + HOUR)
        expect(delivery?.firstSucceededAt).toBeNull()
    })

    // first_attempted_at is the original attempt, so retries move only last_attempted_at.
    it('advances only the last attempt on a retry', function () {
        addTarget()
        const eventId = addFindingEvent()
        recordAttempt(db, eventId, TARGET_ID, T0 + HOUR)
        recordAttempt(db, eventId, TARGET_ID, T0 + 2 * HOUR)
        const delivery = getDelivery(db, eventId, TARGET_ID)
        expect(delivery?.firstAttemptedAt).toBe(T0 + HOUR)
        expect(delivery?.lastAttemptedAt).toBe(T0 + 2 * HOUR)
    })

    it('records a failure with its error text', function () {
        addTarget()
        const eventId = addFindingEvent()
        recordAttempt(db, eventId, TARGET_ID, T0 + HOUR)
        recordFailure(db, eventId, TARGET_ID, T0 + 2 * HOUR, 'HTTP 500')
        const delivery = getDelivery(db, eventId, TARGET_ID)
        expect(delivery?.lastErrorText).toBe('HTTP 500')
        expect(delivery?.firstSucceededAt).toBeNull()
    })

    it('clears the error text on a later success', function () {
        addTarget()
        const eventId = addFindingEvent()
        recordAttempt(db, eventId, TARGET_ID, T0 + HOUR)
        recordFailure(db, eventId, TARGET_ID, T0 + HOUR, 'HTTP 500')
        recordSuccess(db, eventId, TARGET_ID, T0 + 2 * HOUR)
        const delivery = getDelivery(db, eventId, TARGET_ID)
        expect(delivery?.lastErrorText).toBeNull()
        expect(delivery?.firstSucceededAt).toBe(T0 + 2 * HOUR)
    })

    // first_succeeded_at is when it first worked, so a repeat success must not move it.
    it('keeps the original success instant across later successes', function () {
        addTarget()
        const eventId = addFindingEvent()
        recordAttempt(db, eventId, TARGET_ID, T0 + HOUR)
        recordSuccess(db, eventId, TARGET_ID, T0 + HOUR)
        recordSuccess(db, eventId, TARGET_ID, T0 + 5 * HOUR)
        const delivery = getDelivery(db, eventId, TARGET_ID)
        expect(delivery?.firstSucceededAt).toBe(T0 + HOUR)
        expect(delivery?.lastAttemptedAt).toBe(T0 + 5 * HOUR)
    })

    it('keeps deliveries for different targets separate', function () {
        addTarget({ id: 'a' })
        addTarget({ id: 'b' })
        const eventId = addFindingEvent()
        recordAttempt(db, eventId, 'a', T0 + HOUR)
        expect(getDelivery(db, eventId, 'a')).not.toBeNull()
        expect(getDelivery(db, eventId, 'b')).toBeNull()
    })
})

describe('backfillForNewTarget', function () {
    it('inserts a placeholder for an eligible historical event', function () {
        addTarget({ createdAt: T0 + HOUR })
        const eventId = addFindingEvent({ at: T0 })
        expect(backfillForNewTarget(db, TARGET_ID, T0 + 2 * HOUR)).toBe(1)
        const delivery = getDelivery(db, eventId, TARGET_ID)
        expect(delivery?.firstAttemptedAt).toBeNull()
        expect(delivery?.firstSucceededAt).toBeNull()
    })

    it('does not duplicate a delivery that already exists', function () {
        addTarget({ createdAt: T0 + HOUR })
        const eventId = addFindingEvent({ at: T0 })
        recordAttempt(db, eventId, TARGET_ID, T0 + HOUR)
        expect(backfillForNewTarget(db, TARGET_ID, T0 + 2 * HOUR)).toBe(0)
    })

    it('is idempotent across repeated runs', function () {
        addTarget({ createdAt: T0 + HOUR })
        addFindingEvent({ at: T0 })
        expect(backfillForNewTarget(db, TARGET_ID, T0 + 2 * HOUR)).toBe(1)
        expect(backfillForNewTarget(db, TARGET_ID, T0 + 2 * HOUR)).toBe(0)
    })

    // Backfill applies the same filters as live dispatch, so an operator opting into history does
    // not receive things they had filtered or muted.
    it('skips events below the target severity filter', function () {
        addTarget({ createdAt: T0 + HOUR, severityFilter: ['critical'] })
        addFindingEvent({ at: T0, severity: 'high' })
        expect(backfillForNewTarget(db, TARGET_ID, T0 + 2 * HOUR)).toBe(0)
    })

    it('skips muted events', function () {
        addTarget({ createdAt: T0 + HOUR })
        addFindingEvent({ at: T0 })
        insertMute(db, {
            id: 'mute-1',
            scope: 'finding',
            projectId: PROJECT_ID,
            scanner: 'osv',
            ecosystem: 'npm',
            advisoryId: 'CVE-2024-1',
            packageName: 'lodash',
            reason: 'accepted risk',
            author: 'betty',
            createdAt: T0,
            expiresAt: null
        })
        expect(backfillForNewTarget(db, TARGET_ID, T0 + 2 * HOUR)).toBe(0)
    })

    it('backfills scan failures regardless of severity filter', function () {
        addTarget({ createdAt: T0 + HOUR, severityFilter: [] })
        addFailureEvent({ at: T0 })
        expect(backfillForNewTarget(db, TARGET_ID, T0 + 2 * HOUR)).toBe(1)
    })

    it('reports zero when there is nothing to backfill', function () {
        addTarget({ createdAt: T0 + HOUR })
        expect(backfillForNewTarget(db, TARGET_ID, T0 + 2 * HOUR)).toBe(0)
    })

    it('skips events outside the target source scope', function () {
        addTarget({
            createdAt: T0 + HOUR,
            sourceScope: { mode: 'selected', cells: [{ source: 'gemnasium', ecosystem: 'npm' }] }
        })
        addFindingEvent({ at: T0, source: 'osv' })
        expect(backfillForNewTarget(db, TARGET_ID, T0 + 2 * HOUR)).toBe(0)
    })
})
