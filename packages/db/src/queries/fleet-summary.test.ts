import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NotificationTarget } from '@sentinello/core'
import { openDb, type DrizzleDb, type SqliteDb } from '../client'
import { runMigrations } from '../migrate'
import { findings, runSummaryResolvedTold, runSummaryUnscannableTold } from '../schema'
import { upsertRoot } from './config'
import { deleteNotificationTarget, getNotificationTargetById, insertNotificationTarget } from './notifications'
import { selectPendingEventsForTarget } from './notification-deliveries'
import { setTargetProjects } from './notification-target-projects'
import { setTargetRoots } from './notification-target-roots'
import { upsertProject } from './projects'
import { insertScan } from './scans'
import { listOwedResolvedFindings, listUnscannableTold, observeScanRecoveries, outstandingForTarget, recordRunSummaryDelivered, setNotificationTargetDelivery, unscannableForTarget } from './fleet-summary'

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle')
const T0 = Date.UTC(2026, 0, 1)

let db: DrizzleDb
let sqlite: SqliteDb
let dir: string

function target(overrides: Partial<NotificationTarget> = {}): NotificationTarget {
    insertNotificationTarget(db, {
        id: 't', kind: 'slack', config: { webhookUrl: 'https://hooks.example/' }, severityFilter: ['critical', 'high', 'moderate'], envFilter: 'all', enabled: true, createdAt: T0,
        rootIds: [], projectIds: [], sourceScope: { mode: 'all', cells: [] }, delivery: 'per_project', weeklyDigest: true, digestEligibleSinceAt: null, ...overrides
    })
    return getNotificationTargetById(db, overrides.id ?? 't') as NotificationTarget
}

function project(id: string, rootId: string, alias: string | null = null): void {
    upsertProject(db, { id, rootId, relPath: id, name: id, alias, packageManager: 'npm', nvmrcVersion: null, gitBranch: null, ecosystems: ['npm'], manifests: [], muted: false, tags: [], createdAt: T0, updatedAt: T0 })
}

function failing(id: string): void {
    insertScan(db, { id: 'scan-' + id, projectId: id, startedAt: T0, finishedAt: T0, scanner: 'npm-audit', source: 'npm-audit', ecosystem: 'npm', status: 'error', reasonCode: 'audit_spawn_error', durationMs: 1, errorText: null, rawJson: '{}' })
}

function resolvedRow(id: string, projectId: string, overrides: Partial<typeof findings.$inferInsert> = {}): void {
    db.insert(findings).values({ id, scanId: 'scan-' + projectId, projectId, scanner: 'npm-audit', source: 'npm-audit', ecosystem: 'npm', advisoryId: 'GHSA-' + id, packageName: id, installedVersion: '1', vulnerableRange: '<2', severity: 'high', resolvedAt: T0 + 10, ...overrides }).run()
}

beforeEach(async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-fleet-summary-'))
    const opened = openDb({ dbPath: join(dir, 'test.sqlite') })
    db = opened.db
    sqlite = opened.sqlite
    runMigrations(db, { migrationsFolder: MIGRATIONS })
    upsertRoot(db, { id: 'r1', path: '/r1', label: null, createdAt: T0 })
    upsertRoot(db, { id: 'r2', path: '/r2', label: null, createdAt: T0 })
    project('a', 'r1', 'Alias A')
    project('b', 'r2')
    failing('a')
    failing('b')
})

afterEach(async function teardown() {
    sqlite.close()
    await rm(dir, { recursive: true, force: true })
})

describe('unscannableForTarget', function () {
    it('reads the target\'s scope, the run\'s scope, and a project\'s alias', function () {
        expect(unscannableForTarget(db, target(), T0).map(function name(p) { return p.projectName }).sort()).toEqual(['Alias A', 'b'])
        const scoped = target({ id: 'by-root' })
        setTargetRoots(db, 'by-root', ['r2'])
        expect(unscannableForTarget(db, getNotificationTargetById(db, 'by-root') as NotificationTarget, T0).map(function id(p) { return p.projectId })).toEqual(['b'])
        target({ id: 'by-project' })
        setTargetProjects(db, 'by-project', ['a'])
        expect(unscannableForTarget(db, getNotificationTargetById(db, 'by-project') as NotificationTarget, T0).map(function id(p) { return p.projectId })).toEqual(['a'])
        expect(unscannableForTarget(db, scoped, T0, ['b']).map(function id(p) { return p.projectId })).toEqual(['b'])
        expect(unscannableForTarget(db, scoped, T0, [])).toEqual([])
    })

    it('does not read a project with only a reason that says nothing answered yet as unscannable', function () {
        insertScan(db, { id: 'scan-a2', projectId: 'a', startedAt: T0 + 1, finishedAt: T0 + 1, scanner: 'npm-audit', source: 'npm-audit', ecosystem: 'npm', status: 'unauditable', reasonCode: 'osv_db_not_seeded', durationMs: 1, errorText: null, rawJson: '{}' })
        expect(unscannableForTarget(db, target(), T0, ['a'])).toEqual([])
    })
})

describe('opting in and out', function () {
    it('seeds what already fails, is a no-op when nothing changes, and clears both ledgers on the way out', function () {
        const t = target()
        setNotificationTargetDelivery(db, t, 'per_project', T0)
        expect(listUnscannableTold(db, 't').size).toBe(0)
        setNotificationTargetDelivery(db, t, 'run_summary', T0)
        const optedIn = getNotificationTargetById(db, 't') as NotificationTarget
        expect(optedIn.delivery).toBe('run_summary')
        expect(Array.from(listUnscannableTold(db, 't')).sort()).toEqual(['a', 'b'])
        // Choosing it again must not forget what is owed.
        db.delete(runSummaryUnscannableTold).run()
        setNotificationTargetDelivery(db, optedIn, 'run_summary', T0 + 5)
        expect(listUnscannableTold(db, 't').size).toBe(0)
        resolvedRow('x', 'a')
        recordRunSummaryDelivered(db, { targetId: 't', events: [], resolvedFindingIds: ['x', 'x'], unscannableProjectIds: ['a', 'a'], at: T0 + 20 })
        expect(db.select().from(runSummaryResolvedTold).all()).toHaveLength(1)
        setNotificationTargetDelivery(db, optedIn, 'per_project', T0 + 30)
        expect(db.select().from(runSummaryResolvedTold).all()).toEqual([])
        expect(listUnscannableTold(db, 't').size).toBe(0)
    })

    it('goes with its target, and with its finding or project', function () {
        const t = target()
        setNotificationTargetDelivery(db, t, 'run_summary', T0)
        deleteNotificationTarget(db, 't')
        expect(db.select().from(runSummaryUnscannableTold).all()).toEqual([])
    })
})

describe('observeScanRecoveries', function () {
    it('deletes the told row of a project fully scanned now, for every target, and only in the run\'s scope', function () {
        const t = target()
        setNotificationTargetDelivery(db, t, 'run_summary', T0)
        function recovered(id: string): void {
            insertScan(db, { id: 'ok-' + id, projectId: id, startedAt: T0 + 1, finishedAt: T0 + 1, scanner: 'npm-audit', source: 'npm-audit', ecosystem: 'npm', status: 'ok', reasonCode: 'ok', durationMs: 1, errorText: null, rawJson: JSON.stringify({ coverage: [{ ecosystem: 'npm', status: 'ok', reasonCode: null, manifestPath: 'package-lock.json' }] }) })
        }
        recovered('a')
        recovered('b')
        observeScanRecoveries(db, ['a'])
        expect(Array.from(listUnscannableTold(db, 't'))).toEqual(['b'])
        observeScanRecoveries(db, null)
        expect(listUnscannableTold(db, 't').size).toBe(0)
        observeScanRecoveries(db, null)
    })

    it('keeps it while the project still fails', function () {
        setNotificationTargetDelivery(db, target(), 'run_summary', T0)
        observeScanRecoveries(db, null)
        expect(listUnscannableTold(db, 't').size).toBe(2)
    })
})

describe('listOwedResolvedFindings', function () {
    it('admits a row no scan closed, keeps to the run\'s scope, and honors the severity filter', function () {
        setNotificationTargetDelivery(db, target(), 'run_summary', T0)
        resolvedRow('closed', 'a', { resolvedScanId: null })
        resolvedRow('elsewhere', 'b')
        resolvedRow('too-low', 'a', { severity: 'low' })
        resolvedRow('open', 'a', { resolvedAt: null })
        resolvedRow('before', 'a', { resolvedAt: T0 - 1 })
        resolvedRow('notice', 'a', { noticeKind: 'unmaintained' })
        resolvedRow('unrated', 'a', { severity: 'unrated' })
        const ids = function ids(scope: readonly string[] | null) { return listOwedResolvedFindings(db, 't', T0, scope).map(function id(c) { return c.finding.id }).sort() }
        expect(ids(null)).toEqual(['closed', 'elsewhere', 'unrated'])
        expect(ids(['a'])).toEqual(['closed', 'unrated'])
        expect(ids([])).toEqual([])
        expect(listOwedResolvedFindings(db, 't', T0, ['a'])[0]?.projectName).toBe('Alias A')
        recordRunSummaryDelivered(db, { targetId: 't', events: [], resolvedFindingIds: ['closed'], unscannableProjectIds: [], at: T0 })
        expect(ids(['a'])).toEqual(['unrated'])
    })

    it('owes nothing to a target that never opted in', function () {
        target()
        resolvedRow('closed', 'a')
        expect(listOwedResolvedFindings(db, 't', T0, null)).toEqual([])
    })
})

describe('selectPendingEventsForTarget', function () {
    it('selects nothing for an empty scope', function () {
        target()
        expect(selectPendingEventsForTarget(db, 't', T0, [])).toEqual([])
        expect(selectPendingEventsForTarget(db, 't', T0, null)).toEqual([])
    })
})

describe('outstandingForTarget', function () {
    it('reads nothing outstanding as zeros, not nulls', function () {
        expect(outstandingForTarget(db, target(), T0)).toEqual({ counts: { critical: 0, high: 0, moderate: 0, unrated: 0, low: 0, info: 0 }, severe: [] })
    })

    it('judges a group on its one grade', function () {
        const t = target({ severityFilter: ['high'] })
        resolvedRow('mixed-1', 'a', { resolvedAt: null, advisoryKey: 'K', severity: 'critical' })
        resolvedRow('mixed-2', 'a', { resolvedAt: null, advisoryKey: 'K', source: 'osv', severity: 'high', packageName: 'mixed-1' })
        const out = outstandingForTarget(db, t, T0)
        expect(out.severe).toEqual([])
        expect(out.counts.critical).toBe(0)
        expect(out.counts.high).toBe(0)
    })
})
