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
    listFindingsForScan,
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
