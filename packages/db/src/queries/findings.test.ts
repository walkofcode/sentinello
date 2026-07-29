import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../client'
import type { DrizzleDb, SqliteDb } from '../client'
import { runMigrations } from '../migrate'
import { upsertRoot } from './config'
import { upsertProject } from './projects'
import { insertScan } from './scans'
import {
    backfillFindingsLifecycle,
    countResolvedFindingsForProject,
    findFindingByIdentity,
    listFindingsForProject,
    listFindingsForScan,
    listFindingsResolvedInScan,
    listResolvedFindingsForLibrary,
    listResolvedFindingsForProject,
    mergeFindingsForScan
} from './findings'
import type { IncomingFinding } from './findings'

// Runs against a real SQLite file rather than ':memory:'. The client applies WAL pragmas and the
// worker's own flow opens the database by path, so a file exercises the same configuration
// production uses; an in-memory database would quietly skip WAL and cannot be reopened.
const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle')

const ROOT_ID = 'root-1'
const PROJECT_ID = 'project-1'
const T0 = Date.UTC(2026, 0, 1)
const HOUR = 3600_000

let db: DrizzleDb
let sqlite: SqliteDb
let dir: string

beforeEach(async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-db-'))
    const opened = openDb({ dbPath: join(dir, 'test.sqlite') })
    db = opened.db
    sqlite = opened.sqlite
    runMigrations(db, { migrationsFolder: MIGRATIONS })

    upsertRoot(db, { id: ROOT_ID, path: '/repo', label: null, createdAt: T0 })
    upsertProject(db, {
        id: PROJECT_ID,
        rootId: ROOT_ID,
        relPath: 'app',
        name: 'app',
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
})

afterEach(async function teardown() {
    sqlite.close()
    await rm(dir, { recursive: true, force: true })
})

function scan(id: string, finishedAt: number, scanner = 'osv'): void {
    insertScan(db, {
        id,
        projectId: PROJECT_ID,
        startedAt: finishedAt - 1000,
        finishedAt,
        scanner,
        source: scanner,
        ecosystem: 'npm',
        status: 'ok',
        reasonCode: 'ok',
        durationMs: 1000,
        errorText: null,
        rawJson: ''
    })
}

function incoming(advisoryId: string, overrides: Partial<IncomingFinding> = {}): IncomingFinding {
    return {
        projectId: PROJECT_ID,
        scanner: 'osv',
        source: 'osv',
        ecosystem: 'npm',
        advisoryId,
        advisoryTitle: 'Some advisory',
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

function merge(scanId: string, finishedAt: number, findings: IncomingFinding[], scanner = 'osv') {
    scan(scanId, finishedAt, scanner)
    return mergeFindingsForScan(db, {
        projectId: PROJECT_ID,
        scanner,
        scanId,
        scanFinishedAt: finishedAt,
        incoming: findings
    })
}

describe('mergeFindingsForScan — opening an episode', function () {
    it('inserts a new finding and reports it active', function () {
        const result = merge('scan-1', T0, [incoming('GHSA-1')])

        expect(result.active).toHaveLength(1)
        expect(result.resolved).toEqual([])
        expect(result.active[0]?.advisoryId).toBe('GHSA-1')
        expect(result.active[0]?.firstDetectedAt).toBe(T0)
        expect(result.active[0]?.lastSeenAt).toBe(T0)
        expect(result.active[0]?.resolvedAt).toBeNull()
    })

    it('persists the finding against the scan', function () {
        merge('scan-1', T0, [incoming('GHSA-1')])
        expect(listFindingsForScan(db, 'scan-1')).toHaveLength(1)
    })

    it('opens one episode per distinct advisory', function () {
        const result = merge('scan-1', T0, [incoming('GHSA-1'), incoming('GHSA-2')])
        expect(result.active).toHaveLength(2)
    })

    it('treats the same advisory on a different package as a separate episode', function () {
        const result = merge('scan-1', T0, [incoming('GHSA-1'), incoming('GHSA-1', { packageName: 'axios' })])
        expect(result.active).toHaveLength(2)
    })
})

describe('mergeFindingsForScan — continuing an episode', function () {
    // The episode must keep its original firstDetectedAt: that timestamp is the exposure window the
    // portal reports, so restarting it on every scan would make every finding look brand new.
    it('refreshes lastSeenAt but preserves firstDetectedAt', function () {
        merge('scan-1', T0, [incoming('GHSA-1')])
        const result = merge('scan-2', T0 + HOUR, [incoming('GHSA-1')])

        expect(result.active).toHaveLength(1)
        expect(result.active[0]?.firstDetectedAt).toBe(T0)
        expect(result.active[0]?.lastSeenAt).toBe(T0 + HOUR)
    })

    it('keeps the same finding row rather than inserting a duplicate', function () {
        const first = merge('scan-1', T0, [incoming('GHSA-1')])
        const second = merge('scan-2', T0 + HOUR, [incoming('GHSA-1')])
        expect(second.active[0]?.id).toBe(first.active[0]?.id)
    })

    it('updates mutable detail such as the installed version and severity', function () {
        merge('scan-1', T0, [incoming('GHSA-1', { installedVersion: '4.17.11', severity: 'high' })])
        const result = merge('scan-2', T0 + HOUR, [incoming('GHSA-1', { installedVersion: '4.17.15', severity: 'critical' })])

        expect(result.active[0]?.installedVersion).toBe('4.17.15')
        expect(result.active[0]?.severity).toBe('critical')
    })
})

describe('mergeFindingsForScan — resolving an episode', function () {
    it('closes an episode absent from a later scan', function () {
        merge('scan-1', T0, [incoming('GHSA-1')])
        const result = merge('scan-2', T0 + HOUR, [])

        expect(result.active).toEqual([])
        expect(result.resolved).toHaveLength(1)
        expect(result.resolved[0]?.advisoryId).toBe('GHSA-1')
        expect(result.resolved[0]?.resolvedAt).toBe(T0 + HOUR)
        expect(result.resolved[0]?.resolvedScanId).toBe('scan-2')
    })

    it('resolves only the findings that disappeared', function () {
        merge('scan-1', T0, [incoming('GHSA-1'), incoming('GHSA-2')])
        const result = merge('scan-2', T0 + HOUR, [incoming('GHSA-1')])

        expect(result.active.map(function id(f) { return f.advisoryId })).toEqual(['GHSA-1'])
        expect(result.resolved.map(function id(f) { return f.advisoryId })).toEqual(['GHSA-2'])
    })

    it('lists a resolved finding in the project history', function () {
        merge('scan-1', T0, [incoming('GHSA-1')])
        merge('scan-2', T0 + HOUR, [])
        expect(listResolvedFindingsForProject(db, PROJECT_ID)).toHaveLength(1)
    })

    it('does not resolve the same episode twice', function () {
        merge('scan-1', T0, [incoming('GHSA-1')])
        merge('scan-2', T0 + HOUR, [])
        const third = merge('scan-3', T0 + 2 * HOUR, [])
        expect(third.resolved).toEqual([])
    })

    // A finding that comes back after being fixed is a NEW episode, not a reopening of the old one —
    // otherwise the exposure window would silently span the period when it was actually fixed.
    it('opens a fresh episode when a resolved finding reappears', function () {
        const first = merge('scan-1', T0, [incoming('GHSA-1')])
        merge('scan-2', T0 + HOUR, [])
        const third = merge('scan-3', T0 + 2 * HOUR, [incoming('GHSA-1')])

        expect(third.active).toHaveLength(1)
        expect(third.active[0]?.id).not.toBe(first.active[0]?.id)
        expect(third.active[0]?.firstDetectedAt).toBe(T0 + 2 * HOUR)
        expect(listResolvedFindingsForProject(db, PROJECT_ID)).toHaveLength(1)
    })
})

describe('mergeFindingsForScan — scanner scoping', function () {
    // The merge is scoped to (projectId, scanner) so running several scanners against one project
    // stays independent. An osv scan reporting nothing must NOT resolve npm-audit's findings.
    it('does not resolve another scanner findings', function () {
        merge('scan-1', T0, [incoming('GHSA-1', { scanner: 'npm-audit', source: 'npm-audit' })], 'npm-audit')
        const result = merge('scan-2', T0 + HOUR, [], 'osv')

        expect(result.resolved).toEqual([])
        expect(listResolvedFindingsForProject(db, PROJECT_ID)).toEqual([])
    })

    it('keeps the same advisory from two scanners as two episodes', function () {
        merge('scan-1', T0, [incoming('GHSA-1', { scanner: 'npm-audit', source: 'npm-audit' })], 'npm-audit')
        const result = merge('scan-2', T0 + HOUR, [incoming('GHSA-1')], 'osv')

        expect(result.active).toHaveLength(1)
        expect(listFindingsForScan(db, 'scan-1')).toHaveLength(1)
        expect(listFindingsForScan(db, 'scan-2')).toHaveLength(1)
    })

    it('resolves within its own scanner scope only', function () {
        merge('scan-1', T0, [incoming('GHSA-1', { scanner: 'npm-audit', source: 'npm-audit' })], 'npm-audit')
        merge('scan-2', T0, [incoming('GHSA-1')], 'osv')
        const result = merge('scan-3', T0 + HOUR, [], 'osv')

        expect(result.resolved).toHaveLength(1)
        expect(result.resolved[0]?.scanner).toBe('osv')
    })
})

describe('mergeFindingsForScan — empty and idempotent cases', function () {
    it('does nothing for an empty scan against an empty project', function () {
        const result = merge('scan-1', T0, [])
        expect(result.active).toEqual([])
        expect(result.resolved).toEqual([])
    })

    it('is stable when the same scan content is merged repeatedly', function () {
        merge('scan-1', T0, [incoming('GHSA-1')])
        merge('scan-2', T0 + HOUR, [incoming('GHSA-1')])
        const third = merge('scan-3', T0 + 2 * HOUR, [incoming('GHSA-1')])

        expect(third.active).toHaveLength(1)
        expect(third.active[0]?.firstDetectedAt).toBe(T0)
        expect(listResolvedFindingsForProject(db, PROJECT_ID)).toEqual([])
    })
})

// Rows that predate the lifecycle and polyglot migrations. Written with raw SQL on purpose: the typed
// insert path cannot produce them (it always stamps source and the lifecycle timestamps), and they are
// exactly the rows whose fallbacks the code below is full of. A backfill runs on every worker boot, but
// there is a window before it lands, and these rows must read correctly during it.
//
// Note `source` is the only genuinely nullable half of the pair. Migration 0004 added `source text`
// (nullable) but `ecosystem text DEFAULT 'npm' NOT NULL`, so a null ecosystem is impossible in this
// table — which makes rowToFinding's `row.ecosystem ?? 'npm'` and the SQL `COALESCE(f.ecosystem, 'npm')`
// unreachable defensive code rather than live fallbacks. Only the source arm is tested below, because
// only the source arm can happen.
function insertLegacyRow(overrides: Record<string, unknown> = {}): string {
    // findings.scan_id is a real foreign key, so the originating scan has to exist. Created on demand
    // (and only once) so each test can state just the finding it cares about.
    const existing = sqlite.prepare('SELECT 1 FROM scans WHERE id = ?').get('scan-legacy')
    if (!existing) scan('scan-legacy', T0)
    const row = {
        id: 'legacy-1',
        scan_id: 'scan-legacy',
        project_id: PROJECT_ID,
        scanner: 'npm-audit',
        source: null,
        ecosystem: 'npm',
        advisory_id: 'GHSA-legacy',
        advisory_title: 'Legacy advisory',
        advisory_url: null,
        package_name: 'lodash',
        installed_version: '4.17.11',
        vulnerable_range: '<4.17.21',
        severity: 'high',
        fix_available: 1,
        fix_version: '4.17.21',
        dep_path_json: '["lodash"]',
        is_prod: 1,
        is_dev: 0,
        first_detected_at: null,
        last_seen_at: null,
        resolved_at: null,
        resolved_scan_id: null,
        ...overrides
    }
    const columns = Object.keys(row).join(', ')
    const placeholders = Object.keys(row).map(function q() { return '?' }).join(', ')
    sqlite.prepare('INSERT INTO findings (' + columns + ') VALUES (' + placeholders + ')').run(...Object.values(row))
    return String(row.id)
}

describe('mergeFindingsForScan — collapsing duplicates', function () {
    // Duplicates should never have coexisted, but rows written before the identity was enforced can.
    // The merge keeps ONE as the continuing episode and closes the rest, so the duplication heals rather
    // than persisting forever.
    it('keeps one row per identity and resolves the others', function () {
        insertLegacyRow({ id: 'dup-a', first_detected_at: T0 - HOUR })
        insertLegacyRow({ id: 'dup-b', first_detected_at: T0 })

        const result = merge('scan-1', T0 + HOUR, [incoming('GHSA-legacy', { scanner: 'npm-audit', source: 'npm-audit' })], 'npm-audit')

        expect(result.active).toHaveLength(1)
        expect(result.resolved.map(function id(f) { return f.id })).toEqual(['dup-b'])
    })

    // The earliest-detected row survives, so the finding's age is not reset by the collapse.
    it('keeps the earliest-detected row so firstDetectedAt survives', function () {
        insertLegacyRow({ id: 'dup-newer', first_detected_at: T0 })
        insertLegacyRow({ id: 'dup-older', first_detected_at: T0 - HOUR })

        const result = merge('scan-1', T0 + HOUR, [incoming('GHSA-legacy', { scanner: 'npm-audit', source: 'npm-audit' })], 'npm-audit')

        expect(result.active[0]?.id).toBe('dup-older')
        expect(result.active[0]?.firstDetectedAt).toBe(T0 - HOUR)
    })

    // A null firstDetectedAt is treated as POSITIVE_INFINITY — "newest" — so a row that carries a real
    // date always wins. Reading null as 0 would have had exactly the opposite effect.
    it('prefers a dated row over one with no firstDetectedAt', function () {
        insertLegacyRow({ id: 'dup-undated', first_detected_at: null })
        insertLegacyRow({ id: 'dup-dated', first_detected_at: T0 })

        const result = merge('scan-1', T0 + HOUR, [incoming('GHSA-legacy', { scanner: 'npm-audit', source: 'npm-audit' })], 'npm-audit')

        expect(result.active[0]?.id).toBe('dup-dated')
    })

    // The mirror of the case above, with the undated row arriving second. Both orderings have to reach
    // the same winner: the comparison reads a null date as "newest", so whichever side it lands on it
    // must lose to a real date. Only testing one order would pass with the fallback applied to just one
    // operand, which is the shape the bug would actually take.
    it('prefers a dated row when the undated one arrives second', function () {
        insertLegacyRow({ id: 'dup-dated', first_detected_at: T0 })
        insertLegacyRow({ id: 'dup-undated', first_detected_at: null })

        const result = merge('scan-1', T0 + HOUR, [incoming('GHSA-legacy', { scanner: 'npm-audit', source: 'npm-audit' })], 'npm-audit')

        expect(result.active[0]?.id).toBe('dup-dated')
    })

    // ULIDs are chronological, so the smaller id is the older row.
    it('breaks a firstDetectedAt tie on the id', function () {
        insertLegacyRow({ id: 'bbbb', first_detected_at: T0 })
        insertLegacyRow({ id: 'aaaa', first_detected_at: T0 })

        const result = merge('scan-1', T0 + HOUR, [incoming('GHSA-legacy', { scanner: 'npm-audit', source: 'npm-audit' })], 'npm-audit')

        expect(result.active[0]?.id).toBe('aaaa')
    })

    it('resolves every row of an identity the scan no longer reports', function () {
        insertLegacyRow({ id: 'dup-a', first_detected_at: T0 - HOUR })
        insertLegacyRow({ id: 'dup-b', first_detected_at: T0 })

        const result = merge('scan-1', T0 + HOUR, [], 'npm-audit')

        expect(result.active).toEqual([])
        expect(result.resolved.map(function id(f) { return f.id }).sort()).toEqual(['dup-a', 'dup-b'])
    })
})

describe('legacy row fallbacks', function () {
    // source is NULL on a pre-polyglot row, so identity falls back to the scanner name. Without this the
    // row would never match its own incoming finding and would resolve-and-reinsert on every scan,
    // resetting firstDetectedAt each time.
    it('identifies a source-less row by its scanner and continues the episode', function () {
        insertLegacyRow({ first_detected_at: T0 - HOUR })

        const result = merge('scan-1', T0, [incoming('GHSA-legacy', { scanner: 'npm-audit', source: 'npm-audit' })], 'npm-audit')

        expect(result.active).toHaveLength(1)
        expect(result.active[0]?.id).toBe('legacy-1')
        expect(result.resolved).toEqual([])
    })

    it('reads a null source as the scanner', function () {
        insertLegacyRow()
        const rows = listFindingsForProject(db, PROJECT_ID)
        expect(rows[0]).toMatchObject({ scanner: 'npm-audit', source: 'npm-audit', ecosystem: 'npm' })
    })

    it('finds a source-less row by identity through the COALESCE', function () {
        insertLegacyRow()
        const found = findFindingByIdentity(db, {
            projectId: PROJECT_ID,
            source: 'npm-audit',
            ecosystem: 'npm',
            advisoryId: 'GHSA-legacy',
            packageName: 'lodash'
        })
        expect(found?.id).toBe('legacy-1')
    })
})

describe('backfillFindingsLifecycle', function () {
    it('seeds both timestamps from the originating scan', function () {
        insertLegacyRow()

        expect(backfillFindingsLifecycle(db)).toBe(1)
        const row = listFindingsForProject(db, PROJECT_ID)[0]
        expect(row?.firstDetectedAt).toBe(T0)
        expect(row?.lastSeenAt).toBe(T0)
    })

    // Runs on every worker boot, so re-running it must be free and must not touch healed rows.
    it('is idempotent and leaves already-stamped rows alone', function () {
        insertLegacyRow({ first_detected_at: T0 - HOUR, last_seen_at: T0 - HOUR })

        expect(backfillFindingsLifecycle(db)).toBe(0)
        expect(listFindingsForProject(db, PROJECT_ID)[0]?.firstDetectedAt).toBe(T0 - HOUR)
    })

    it('fills only the missing half when one timestamp is already set', function () {
        insertLegacyRow({ first_detected_at: T0 - HOUR, last_seen_at: null })

        expect(backfillFindingsLifecycle(db)).toBe(1)
        const row = listFindingsForProject(db, PROJECT_ID)[0]
        expect(row?.firstDetectedAt).toBe(T0 - HOUR)
        expect(row?.lastSeenAt).toBe(T0)
    })

    it('reports nothing changed on an empty table', function () {
        expect(backfillFindingsLifecycle(db)).toBe(0)
    })
})

describe('list queries', function () {
    it('returns the episodes a scan first detected', function () {
        merge('scan-1', T0, [incoming('GHSA-1'), incoming('GHSA-2')])
        expect(listFindingsForScan(db, 'scan-1')).toHaveLength(2)
    })

    // Pairs with listFindingsForScan so a historical scan can show what it discovered AND what it closed.
    it('returns the episodes a scan closed, attributed to the closing scan', function () {
        merge('scan-1', T0, [incoming('GHSA-1')])
        merge('scan-2', T0 + HOUR, [])

        expect(listFindingsResolvedInScan(db, 'scan-2').map(function id(f) { return f.advisoryId })).toEqual(['GHSA-1'])
        expect(listFindingsResolvedInScan(db, 'scan-1')).toEqual([])
    })

    it('returns every finding of a project, open or resolved', function () {
        merge('scan-1', T0, [incoming('GHSA-1'), incoming('GHSA-2')])
        merge('scan-2', T0 + HOUR, [incoming('GHSA-1')])
        expect(listFindingsForProject(db, PROJECT_ID)).toHaveLength(2)
    })

    it('orders resolved findings newest-first and counts them', function () {
        merge('scan-1', T0, [incoming('GHSA-1'), incoming('GHSA-2')])
        merge('scan-2', T0 + HOUR, [incoming('GHSA-2')])
        merge('scan-3', T0 + 2 * HOUR, [])

        expect(listResolvedFindingsForProject(db, PROJECT_ID).map(function id(f) { return f.advisoryId }))
            .toEqual(['GHSA-2', 'GHSA-1'])
        expect(countResolvedFindingsForProject(db, PROJECT_ID)).toBe(2)
    })

    it('pages resolved findings through limit and offset', function () {
        merge('scan-1', T0, [incoming('GHSA-1'), incoming('GHSA-2')])
        merge('scan-2', T0 + HOUR, [incoming('GHSA-2')])
        merge('scan-3', T0 + 2 * HOUR, [])

        expect(listResolvedFindingsForProject(db, PROJECT_ID, 1)).toHaveLength(1)
        expect(listResolvedFindingsForProject(db, PROJECT_ID, 1, 1).map(function id(f) { return f.advisoryId }))
            .toEqual(['GHSA-1'])
        expect(listResolvedFindingsForProject(db, PROJECT_ID, 10, 5)).toEqual([])
    })

    it('counts zero for a project with nothing resolved', function () {
        merge('scan-1', T0, [incoming('GHSA-1')])
        expect(countResolvedFindingsForProject(db, PROJECT_ID)).toBe(0)
    })

    it('returns null from findFindingByIdentity when nothing matches', function () {
        expect(findFindingByIdentity(db, {
            projectId: PROJECT_ID,
            source: 'osv',
            ecosystem: 'npm',
            advisoryId: 'GHSA-nope',
            packageName: 'lodash'
        })).toBeNull()
    })

    // Only OPEN episodes have an identity to find; a resolved one must not be returned or the next scan
    // would continue an episode the previous scan deliberately closed.
    it('does not find a resolved episode by identity', function () {
        merge('scan-1', T0, [incoming('GHSA-1')])
        merge('scan-2', T0 + HOUR, [])

        expect(findFindingByIdentity(db, {
            projectId: PROJECT_ID,
            source: 'osv',
            ecosystem: 'npm',
            advisoryId: 'GHSA-1',
            packageName: 'lodash'
        })).toBeNull()
    })
})

describe('listResolvedFindingsForLibrary', function () {
    it('returns resolved findings for a package with the project name attached', function () {
        merge('scan-1', T0, [incoming('GHSA-1')])
        merge('scan-2', T0 + HOUR, [])

        const rows = listResolvedFindingsForLibrary(db, 'lodash')
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({ advisoryId: 'GHSA-1', packageName: 'lodash', projectName: 'app' })
    })

    it('excludes findings that are still open', function () {
        merge('scan-1', T0, [incoming('GHSA-1')])
        expect(listResolvedFindingsForLibrary(db, 'lodash')).toEqual([])
    })

    it('scopes to one package', function () {
        merge('scan-1', T0, [incoming('GHSA-1'), incoming('GHSA-2', { packageName: 'express' })])
        merge('scan-2', T0 + HOUR, [])
        expect(listResolvedFindingsForLibrary(db, 'express').map(function id(f) { return f.advisoryId }))
            .toEqual(['GHSA-2'])
    })

    // The ecosystem filter is an optional SQL fragment: supplied it scopes to the cell, omitted it
    // matches every ecosystem. Both arms are real query text, so both are worth executing.
    it('scopes to an ecosystem when one is given', function () {
        merge('scan-1', T0, [
            incoming('GHSA-1'),
            incoming('GHSA-py', { ecosystem: 'PyPI', packageName: 'lodash' })
        ])
        merge('scan-2', T0 + HOUR, [])

        expect(listResolvedFindingsForLibrary(db, 'lodash', 50, 'npm').map(function id(f) { return f.advisoryId }))
            .toEqual(['GHSA-1'])
        expect(listResolvedFindingsForLibrary(db, 'lodash', 50, 'PyPI').map(function id(f) { return f.advisoryId }))
            .toEqual(['GHSA-py'])
        expect(listResolvedFindingsForLibrary(db, 'lodash')).toHaveLength(2)
    })

    // The COALESCE around f.ecosystem is a no-op given the NOT NULL column, but a source-less row still
    // has to come back through the npm filter and report its scanner as its source.
    it('returns a source-less legacy row through the npm filter', function () {
        insertLegacyRow({ resolved_at: T0, resolved_scan_id: 'scan-legacy' })

        const rows = listResolvedFindingsForLibrary(db, 'lodash', 50, 'npm')
        expect(rows.map(function id(f) { return f.advisoryId })).toEqual(['GHSA-legacy'])
        expect(rows[0]?.source).toBe('npm-audit')
    })

    it('honours the limit', function () {
        merge('scan-1', T0, [incoming('GHSA-1'), incoming('GHSA-2')])
        merge('scan-2', T0 + HOUR, [])
        expect(listResolvedFindingsForLibrary(db, 'lodash', 1)).toHaveLength(1)
    })

    it('returns nothing for a package with no findings', function () {
        expect(listResolvedFindingsForLibrary(db, 'never-seen')).toEqual([])
    })
})

describe('depPath decoding', function () {
    it('round-trips a nested dependency path', function () {
        merge('scan-1', T0, [incoming('GHSA-1', { depPath: ['a', 'b', 'lodash'] })])
        expect(listFindingsForProject(db, PROJECT_ID)[0]?.depPath).toEqual(['a', 'b', 'lodash'])
    })

    it('degrades a non-array payload to an empty path', function () {
        insertLegacyRow({ dep_path_json: '{"not":"an array"}' })
        expect(listFindingsForProject(db, PROJECT_ID)[0]?.depPath).toEqual([])
    })

    it('drops non-string elements rather than passing them through', function () {
        insertLegacyRow({ dep_path_json: '["a", 42, null, "b"]' })
        expect(listFindingsForProject(db, PROJECT_ID)[0]?.depPath).toEqual(['a', 'b'])
    })

    // Regression guard. parseDepPath used to call JSON.parse unguarded, so a corrupted dep_path_json
    // threw out of what is otherwise a pure read — taking down the whole query, and with it any page
    // listing the project's findings, over a display-only column. It now degrades like the two cases
    // above it. Asserted on the row rather than just the absence of a throw, so a "fix" that swallowed
    // the finding entirely would still fail here.
    it('degrades invalid JSON to an empty path instead of throwing', function () {
        insertLegacyRow({ dep_path_json: '{not json' })
        const rows = listFindingsForProject(db, PROJECT_ID)
        expect(rows).toHaveLength(1)
        expect(rows[0]?.depPath).toEqual([])
        expect(rows[0]?.packageName).toBe('lodash')
    })

    // The second decode path: listFindingsForProject reads a raw SQL row, findFindingByIdentity goes
    // through rowToFinding. Both call parseDepPath, and only one of them was reachable from the test
    // above — a try/catch added to just one call site would pass that test and still crash here.
    it('degrades invalid JSON on the rowToFinding path too', function () {
        insertLegacyRow({ dep_path_json: 'undefined' })
        const found = findFindingByIdentity(db, {
            projectId: PROJECT_ID,
            source: 'npm-audit',
            ecosystem: 'npm',
            advisoryId: 'GHSA-legacy',
            packageName: 'lodash'
        })
        expect(found?.depPath).toEqual([])
    })
})
