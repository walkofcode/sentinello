import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { sourceEnabledKey } from '@sentinello/core'
import { openDb } from '../client'
import type { DrizzleDb, SqliteDb } from '../client'
import { runMigrations } from '../migrate'
import { setConfigValue, upsertRoot } from './config'
import { setProjectAlias, setProjectTags, upsertProject } from './projects'
import { insertScan } from './scans'
import { mergeFindingsForScan, type IncomingFinding } from './findings'
import { insertMute } from './mutes'
import { upsertFindingEvent } from './notification-events'
import { enqueueScanRequest } from './scan-requests'
import {
    getDashboardSummary,
    listCurrentFindingsForProject,
    listProjectCatalog,
    listVulnTrendForProject
} from './dashboard'

// These are the portal's headline numbers, so wrongness here is wrongness an operator acts on: a
// severity tile that counts muted findings makes accepted risk look unresolved, and one that misses
// active findings reports a clean estate that is not clean.
//
// The trend query has the least obvious definition and the most room to be subtly wrong. Under the
// lifecycle model a point is "how many findings were open as of that scan", reconstructed from
// first_detected_at and resolved_at rather than from what that scan happened to report — so history
// stays accurate even for findings discovered by a different scanner run.

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle')

const ROOT_ID = 'root-1'
const T0 = Date.UTC(2026, 0, 1)
const HOUR = 3600_000
const DAY = 24 * HOUR

let db: DrizzleDb
let sqlite: SqliteDb
let dir: string
let scanCounter = 0

function addProject(id: string, overrides: Record<string, unknown> = {}): void {
    upsertProject(db, {
        id,
        rootId: ROOT_ID,
        relPath: id,
        name: id,
        alias: null,
        packageManager: 'npm',
        nvmrcVersion: null,
        gitBranch: null,
        ecosystems: ['npm'],
        muted: false,
        tags: [],
        createdAt: T0,
        updatedAt: T0,
        ...overrides
    })
}

function finding(overrides: Partial<IncomingFinding> = {}): IncomingFinding {
    return {
        projectId: 'project-1',
        scanner: 'npm-audit',
        source: 'npm-audit',
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
    }
}

function scanProject(
    projectId: string,
    incoming: IncomingFinding[],
    opts: { at?: number; scanner?: string; status?: string; reasonCode?: string; errorText?: string | null } = {}
): string {
    scanCounter += 1
    const scanId = 'scan-' + scanCounter
    const scanner = opts.scanner || 'npm-audit'
    const finishedAt = opts.at ?? T0 + scanCounter
    insertScan(db, {
        id: scanId,
        projectId,
        startedAt: finishedAt - 1000,
        finishedAt,
        scanner,
        source: scanner,
        ecosystem: 'npm',
        status: (opts.status || 'ok') as never,
        reasonCode: (opts.reasonCode || 'ok') as never,
        durationMs: 1000,
        errorText: opts.errorText ?? null,
        rawJson: ''
    })
    if ((opts.status || 'ok') === 'ok') {
        mergeFindingsForScan(db, {
            projectId,
            scanner,
            scanId,
            scanFinishedAt: finishedAt,
            incoming: incoming.map(function scoped(f) { return { ...f, projectId, scanner, source: scanner } })
        })
    }
    return scanId
}

function mute(overrides: Record<string, unknown> = {}): void {
    insertMute(db, {
        id: 'mute-' + scanCounter + '-' + Object.keys(overrides).join('-'),
        scope: 'finding',
        projectId: 'project-1',
        scanner: 'npm-audit',
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

beforeEach(async function setup() {
    scanCounter = 0
    dir = await mkdtemp(join(tmpdir(), 'sentinello-dashboard-'))
    const opened = openDb({ dbPath: join(dir, 'test.sqlite') })
    db = opened.db
    sqlite = opened.sqlite
    runMigrations(db, { migrationsFolder: MIGRATIONS })
    upsertRoot(db, { id: ROOT_ID, path: '/repo', label: 'Repos', createdAt: T0 })
    addProject('project-1')
    addProject('project-2')
    setConfigValue(db, sourceEnabledKey('osv', 'npm'), true)
})

afterEach(async function teardown() {
    sqlite.close()
    await rm(dir, { recursive: true, force: true })
})

describe('getDashboardSummary', function () {
    it('reports zeroes on an empty estate', function () {
        const summary = getDashboardSummary(db, T0 + DAY)
        expect(summary.projectsWithFindings).toBe(0)
        expect(summary.severityCounts).toEqual({ critical: 0, high: 0, moderate: 0, low: 0, info: 0 })
        expect(summary.lastScanFinishedAt).toBeNull()
    })

    it('counts every project whether or not it has findings', function () {
        expect(getDashboardSummary(db, T0 + DAY).totalActiveProjects).toBe(2)
    })

    // These two are read together as "N of M projects have findings". projectsWithFindings has always
    // excluded project-muted projects, so counting them in the total made the ratio compare two
    // different populations — and the muted project could never appear in the numerator.
    it('excludes project-muted projects from the total', function () {
        mute({ id: 'proj-mute', scope: 'project', scanner: null, ecosystem: null, advisoryId: null, packageName: null })
        expect(getDashboardSummary(db, T0 + DAY).totalActiveProjects).toBe(1)
    })

    it('counts a project again once its project mute expires', function () {
        mute({
            id: 'proj-mute',
            scope: 'project',
            scanner: null,
            ecosystem: null,
            advisoryId: null,
            packageName: null,
            expiresAt: T0 + DAY
        })
        expect(getDashboardSummary(db, T0).totalActiveProjects).toBe(1)
        expect(getDashboardSummary(db, T0 + DAY + 1).totalActiveProjects).toBe(2)
    })

    it('counts only the projects that currently have findings', function () {
        scanProject('project-1', [finding()])
        expect(getDashboardSummary(db, T0 + DAY).projectsWithFindings).toBe(1)
    })

    it('tallies findings by severity', function () {
        scanProject('project-1', [
            finding({ severity: 'critical', advisoryId: 'C1' }),
            finding({ severity: 'critical', advisoryId: 'C2', packageName: 'express' }),
            finding({ severity: 'low', advisoryId: 'L1', packageName: 'axios' })
        ])
        const counts = getDashboardSummary(db, T0 + DAY).severityCounts
        expect(counts.critical).toBe(2)
        expect(counts.low).toBe(1)
        expect(counts.high).toBe(0)
    })

    // Counting a muted finding would make accepted risk look unresolved on the headline tile.
    it('excludes muted findings from the severity tally', function () {
        scanProject('project-1', [finding()])
        expect(getDashboardSummary(db, T0 + DAY).severityCounts.high).toBe(1)
        mute()
        expect(getDashboardSummary(db, T0 + DAY).severityCounts.high).toBe(0)
    })

    it('excludes resolved findings', function () {
        scanProject('project-1', [finding()])
        scanProject('project-1', [])
        expect(getDashboardSummary(db, T0 + DAY).severityCounts.high).toBe(0)
        expect(getDashboardSummary(db, T0 + DAY).projectsWithFindings).toBe(0)
    })

    it('excludes findings from a disabled source cell', function () {
        scanProject('project-1', [finding()], { scanner: 'osv' })
        expect(getDashboardSummary(db, T0 + DAY).severityCounts.high).toBe(1)
        setConfigValue(db, sourceEnabledKey('osv', 'npm'), false)
        expect(getDashboardSummary(db, T0 + DAY).severityCounts.high).toBe(0)
    })

    it('reports the newest scan finish across the estate', function () {
        scanProject('project-1', [], { at: T0 + HOUR })
        scanProject('project-2', [], { at: T0 + 5 * HOUR })
        expect(getDashboardSummary(db, T0 + DAY).lastScanFinishedAt).toBe(T0 + 5 * HOUR)
    })

    // This tile counts notification EVENTS rather than finding rows — the discovery ledger, whose
    // first_seen_at is set once per distinct identity. A finding merely re-seen by a later scan
    // therefore stops counting as new, which finding rows alone could not express.
    it('counts discovery events from the last day, not finding rows', function () {
        const scanId = scanProject('project-1', [finding()], { at: T0 })
        // No event yet: the finding exists but nothing has been discovered-and-recorded.
        expect(getDashboardSummary(db, T0 + HOUR).findingsLast24h).toBe(0)

        upsertFindingEvent(db, {
            projectId: 'project-1',
            source: 'npm-audit',
            ecosystem: 'npm',
            advisoryId: 'CVE-2024-1',
            packageName: 'lodash',
            severity: 'high',
            firstScanId: scanId,
            at: T0
        })
        expect(getDashboardSummary(db, T0 + HOUR).findingsLast24h).toBe(1)
    })

    it('drops an event out of the window once it ages past a day', function () {
        const scanId = scanProject('project-1', [finding()], { at: T0 })
        upsertFindingEvent(db, {
            projectId: 'project-1',
            source: 'npm-audit',
            ecosystem: 'npm',
            advisoryId: 'CVE-2024-1',
            packageName: 'lodash',
            severity: 'high',
            firstScanId: scanId,
            at: T0
        })
        expect(getDashboardSummary(db, T0 + 2 * DAY).findingsLast24h).toBe(0)
    })

    it('excludes a muted discovery event', function () {
        const scanId = scanProject('project-1', [finding()], { at: T0 })
        upsertFindingEvent(db, {
            projectId: 'project-1',
            source: 'npm-audit',
            ecosystem: 'npm',
            advisoryId: 'CVE-2024-1',
            packageName: 'lodash',
            severity: 'high',
            firstScanId: scanId,
            at: T0
        })
        mute()
        expect(getDashboardSummary(db, T0 + HOUR).findingsLast24h).toBe(0)
    })

    it('honours the production dependency filter', function () {
        scanProject('project-1', [
            finding({ isProd: true, isDev: false, advisoryId: 'P1' }),
            finding({ isProd: false, isDev: true, advisoryId: 'D1', packageName: 'eslint' })
        ])
        expect(getDashboardSummary(db, T0 + DAY, 'prod').severityCounts.high).toBe(1)
        expect(getDashboardSummary(db, T0 + DAY, 'all').severityCounts.high).toBe(2)
    })
})

describe('listProjectCatalog', function () {
    it('lists every project even with no scans', function () {
        expect(listProjectCatalog(db, T0 + DAY)).toHaveLength(2)
    })

    it('carries the root and project identity', function () {
        const row = listProjectCatalog(db, T0 + DAY).find(function p(r) { return r.id === 'project-1' })
        expect(row).toMatchObject({ name: 'project-1', rootLabel: 'Repos', rootPath: '/repo', packageManager: 'npm' })
    })

    it('reports no scan state for a project that never ran', function () {
        const row = listProjectCatalog(db, T0 + DAY).find(function p(r) { return r.id === 'project-1' })
        expect(row?.lastScanFinishedAt).toBeNull()
        expect(row?.lastScanStatus).toBeNull()
    })

    it('reports the latest scan state', function () {
        scanProject('project-1', [], { at: T0 + HOUR })
        scanProject('project-1', [], {
            at: T0 + 5 * HOUR,
            status: 'error',
            reasonCode: 'audit_spawn_error',
            errorText: 'spawn failed'
        })
        const row = listProjectCatalog(db, T0 + DAY).find(function p(r) { return r.id === 'project-1' })
        expect(row).toMatchObject({
            lastScanFinishedAt: T0 + 5 * HOUR,
            lastScanStatus: 'error',
            lastScanReasonCode: 'audit_spawn_error',
            lastScanErrorText: 'spawn failed'
        })
    })

    it('tallies per-project severity counts', function () {
        scanProject('project-1', [finding({ severity: 'critical' })])
        scanProject('project-2', [finding({ severity: 'low' })])
        const rows = listProjectCatalog(db, T0 + DAY)
        const p1 = rows.find(function p(r) { return r.id === 'project-1' })
        const p2 = rows.find(function p(r) { return r.id === 'project-2' })
        expect(p1?.severityCounts.critical).toBe(1)
        expect(p2?.severityCounts.low).toBe(1)
        expect(p2?.severityCounts.critical).toBe(0)
    })

    it('excludes muted findings from the per-project counts', function () {
        scanProject('project-1', [finding()])
        mute()
        const row = listProjectCatalog(db, T0 + DAY).find(function p(r) { return r.id === 'project-1' })
        expect(row?.severityCounts.high).toBe(0)
    })

    // The list offers unmute inline, so it needs the active mute's id without a second query.
    it('surfaces the active project mute and its id', function () {
        mute({ id: 'project-mute', scope: 'project', scanner: null, ecosystem: null, advisoryId: null, packageName: null })
        const row = listProjectCatalog(db, T0 + DAY).find(function p(r) { return r.id === 'project-1' })
        expect(row?.muted).toBe(true)
        expect(row?.muteId).toBe('project-mute')
    })

    it('reports an unmuted project with no mute id', function () {
        const row = listProjectCatalog(db, T0 + DAY).find(function p(r) { return r.id === 'project-1' })
        expect(row?.muted).toBe(false)
        expect(row?.muteId).toBeNull()
    })

    it('stops reporting a project as muted once the mute expires', function () {
        mute({ id: 'expiring', scope: 'project', scanner: null, ecosystem: null, advisoryId: null, packageName: null, expiresAt: T0 + HOUR })
        expect(listProjectCatalog(db, T0)[0]?.muted).toBe(true)
        expect(listProjectCatalog(db, T0 + 2 * HOUR)[0]?.muted).toBe(false)
    })

    // alias goes through its dedicated setter: upsertProject deliberately leaves it out of the
    // conflict set so a rediscovery cannot rename what the operator titled.
    it('carries the operator alias and tags', function () {
        setProjectAlias(db, 'project-1', 'Billing API', T0)
        setProjectTags(db, 'project-1', ['backend', 'critical'], T0)
        const row = listProjectCatalog(db, T0 + DAY).find(function p(r) { return r.id === 'project-1' })
        expect(row?.alias).toBe('Billing API')
        expect(JSON.parse(row?.tagsJson || '[]')).toEqual(['backend', 'critical'])
    })

    it('honours the dependency type filter', function () {
        scanProject('project-1', [finding({ isProd: false, isDev: true })])
        const prod = listProjectCatalog(db, T0 + DAY, 'prod').find(function p(r) { return r.id === 'project-1' })
        const all = listProjectCatalog(db, T0 + DAY, 'all').find(function p(r) { return r.id === 'project-1' })
        expect(prod?.severityCounts.high).toBe(0)
        expect(all?.severityCounts.high).toBe(1)
    })
})

describe('listVulnTrendForProject', function () {
    it('reports nothing for a project that never scanned', function () {
        expect(listVulnTrendForProject(db, 'project-1')).toEqual([])
    })

    it('returns oldest-first so a chart reads left to right', function () {
        scanProject('project-1', [finding()], { at: T0 + HOUR })
        scanProject('project-1', [finding()], { at: T0 + 2 * HOUR })
        scanProject('project-1', [finding()], { at: T0 + 3 * HOUR })
        const trend = listVulnTrendForProject(db, 'project-1')
        expect(trend.map(function t(p) { return p.scanFinishedAt })).toEqual([
            T0 + HOUR, T0 + 2 * HOUR, T0 + 3 * HOUR
        ])
    })

    it('counts the findings open as of each scan', function () {
        scanProject('project-1', [finding()], { at: T0 + HOUR })
        scanProject('project-1', [
            finding(),
            finding({ advisoryId: 'CVE-2', packageName: 'express' })
        ], { at: T0 + 2 * HOUR })
        expect(listVulnTrendForProject(db, 'project-1').map(function c(p) { return p.findingCount })).toEqual([1, 2])
    })

    // The count is reconstructed from lifecycle timestamps, not from what each scan reported, so a
    // resolved finding stops counting from the point it was resolved — and still counts before it.
    it('drops a finding from later points once it is resolved', function () {
        scanProject('project-1', [finding()], { at: T0 + HOUR })
        scanProject('project-1', [], { at: T0 + 2 * HOUR })
        expect(listVulnTrendForProject(db, 'project-1').map(function c(p) { return p.findingCount })).toEqual([1, 0])
    })

    // A failed scan has no reliable finding set, so plotting it would draw a false dip to zero.
    it('ignores scans that did not succeed', function () {
        scanProject('project-1', [finding()], { at: T0 + HOUR })
        scanProject('project-1', [], { at: T0 + 2 * HOUR, status: 'error', reasonCode: 'audit_spawn_error' })
        const trend = listVulnTrendForProject(db, 'project-1')
        expect(trend).toHaveLength(1)
        expect(trend[0]?.scanFinishedAt).toBe(T0 + HOUR)
    })

    it('keeps the most recent points when limited', function () {
        for (let i = 1; i <= 5; i++) scanProject('project-1', [finding()], { at: T0 + i * HOUR })
        const trend = listVulnTrendForProject(db, 'project-1', 2)
        expect(trend.map(function t(p) { return p.scanFinishedAt })).toEqual([T0 + 4 * HOUR, T0 + 5 * HOUR])
    })

    it('does not mix in another project history', function () {
        scanProject('project-1', [finding()], { at: T0 + HOUR })
        scanProject('project-2', [finding()], { at: T0 + 2 * HOUR })
        expect(listVulnTrendForProject(db, 'project-1')).toHaveLength(1)
    })
})

// "Last scan" must not tick upward while a user-triggered sweep is running: the projects finish
// one-by-one, so an unfrozen MAX(finished_at) would advance several times during a single sweep and
// read as several separate scans. The freeze applies only to request-driven sweeps — a scheduled one
// writes no scan_requests row, and nobody is watching the number for it.
describe('getDashboardSummary — the in-flight scan freeze', function () {
    it('reports the newest scan when nothing is in flight', function () {
        scanProject('project-1', [finding()], { at: T0 + HOUR })
        scanProject('project-1', [finding()], { at: T0 + 2 * HOUR })

        expect(getDashboardSummary(db, T0 + DAY).lastScanFinishedAt).toBe(T0 + 2 * HOUR)
    })

    it('freezes at the last scan that finished before a pending request was queued', function () {
        scanProject('project-1', [finding()], { at: T0 + HOUR })
        enqueueScanRequest(db, { projectId: 'project-1' }, T0 + 90 * 60_000)
        // Finished after the request was queued: part of the sweep the operator is waiting on.
        scanProject('project-1', [finding()], { at: T0 + 2 * HOUR })

        expect(getDashboardSummary(db, T0 + DAY).lastScanFinishedAt).toBe(T0 + HOUR)
    })

    // A 'running' request only freezes the number while its heartbeat is fresh. A worker that died
    // mid-sweep leaves the row behind forever, and honouring it would pin "Last scan" to a stale
    // timestamp until someone noticed.
    it('ignores a running request whose heartbeat has gone stale', function () {
        scanProject('project-1', [finding()], { at: T0 + HOUR })
        const request = enqueueScanRequest(db, { projectId: 'project-1' }, T0 + 90 * 60_000)
        db.run(sql`UPDATE scan_requests SET status = 'running', heartbeat_at = ${T0} WHERE id = ${request.id}`)
        scanProject('project-1', [finding()], { at: T0 + 2 * HOUR })

        expect(getDashboardSummary(db, T0 + DAY).lastScanFinishedAt).toBe(T0 + 2 * HOUR)
    })
})

describe('listCurrentFindingsForProject', function () {
    // Same pre-backfill window as the library pivot: findings.source is null between the Phase 2 schema
    // migration and the boot backfill, and the project page must still name a source in that window.
    it('falls back to the scanner name when a legacy row has no source', function () {
        scanProject('project-1', [finding()])
        db.run(sql`UPDATE findings SET source = NULL`)

        const rows = listCurrentFindingsForProject(db, 'project-1', T0 + DAY)
        expect(rows).toHaveLength(1)
        expect(rows[0]?.source).toBe('npm-audit')
    })
})
