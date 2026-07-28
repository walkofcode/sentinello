import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Scan } from '@sentinello/core'
import { openDb } from '../client'
import type { DrizzleDb, SqliteDb } from '../client'
import { runMigrations } from '../migrate'
import { upsertRoot } from './config'
import { upsertProject } from './projects'
import {
    countScansForProject,
    getLastScanFinishedAt,
    getLatestScanForProject,
    getProjectEcosystemCoverage,
    insertScan,
    listScansForProject
} from './scans'

// Ordering is what most of this module is for: "the latest scan" drives the project page header and
// the scheduler's idea of when anything last ran, so newest-first has to hold regardless of insert
// order.
//
// getProjectEcosystemCoverage is the part with real judgement in it. Feed scanners serialise their
// per-ecosystem coverage into rawJson, and this reconstructs the latest state per ecosystem. Its
// defaults all lean the same way on purpose: unreadable or unexpected input is skipped rather than
// guessed at, because reading a coverage gap as a clean bill of health would tell an operator a
// language was audited when it was not.

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle')

const ROOT_ID = 'root-1'
const PROJECT_ID = 'project-1'
const OTHER_PROJECT_ID = 'project-2'
const T0 = Date.UTC(2026, 0, 1)
const HOUR = 3600_000

let db: DrizzleDb
let sqlite: SqliteDb
let dir: string

function scan(overrides: Partial<Scan> = {}): Scan {
    return {
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
        rawJson: '',
        ...overrides
    } as Scan
}

function addProject(id: string, relPath: string): void {
    upsertProject(db, {
        id,
        rootId: ROOT_ID,
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
    dir = await mkdtemp(join(tmpdir(), 'sentinello-scans-'))
    const opened = openDb({ dbPath: join(dir, 'test.sqlite') })
    db = opened.db
    sqlite = opened.sqlite
    runMigrations(db, { migrationsFolder: MIGRATIONS })
    upsertRoot(db, { id: ROOT_ID, path: '/repo', label: null, createdAt: T0 })
    addProject(PROJECT_ID, 'app')
    addProject(OTHER_PROJECT_ID, 'other')
})

afterEach(async function teardown() {
    sqlite.close()
    await rm(dir, { recursive: true, force: true })
})

describe('insertScan and reads', function () {
    it('round-trips a scan', function () {
        insertScan(db, scan({ errorText: 'boom', status: 'error', reasonCode: 'audit_spawn_error' }))
        expect(getLatestScanForProject(db, PROJECT_ID)).toMatchObject({
            id: 'scan-1',
            status: 'error',
            reasonCode: 'audit_spawn_error',
            errorText: 'boom'
        })
    })

    it('reports no latest scan for a project that never ran', function () {
        expect(getLatestScanForProject(db, PROJECT_ID)).toBeNull()
    })

    // Insert order must not decide which scan is "latest" — the timestamp does.
    it('returns the newest scan regardless of insert order', function () {
        insertScan(db, scan({ id: 'newest', finishedAt: T0 + 5 * HOUR }))
        insertScan(db, scan({ id: 'oldest', finishedAt: T0 }))
        insertScan(db, scan({ id: 'middle', finishedAt: T0 + HOUR }))
        expect(getLatestScanForProject(db, PROJECT_ID)?.id).toBe('newest')
    })

    it('scopes the latest scan to its project', function () {
        insertScan(db, scan({ id: 'ours', finishedAt: T0 }))
        insertScan(db, scan({ id: 'theirs', projectId: OTHER_PROJECT_ID, finishedAt: T0 + 5 * HOUR }))
        expect(getLatestScanForProject(db, PROJECT_ID)?.id).toBe('ours')
    })

    // Drives the "last scanned" indicator across the whole portal, so it is deliberately global.
    it('reports the newest finish across every project', function () {
        insertScan(db, scan({ id: 'a', finishedAt: T0 }))
        insertScan(db, scan({ id: 'b', projectId: OTHER_PROJECT_ID, finishedAt: T0 + 5 * HOUR }))
        expect(getLastScanFinishedAt(db)).toBe(T0 + 5 * HOUR)
    })

    it('reports no last finish on an empty database', function () {
        expect(getLastScanFinishedAt(db)).toBeNull()
    })

    // scans.source is nullable for rows written before the column existed, so the read falls back to
    // the scanner name rather than surfacing null into the UI. (scans.ecosystem is NOT NULL, so its
    // matching fallback in rowToScan is unreachable and deliberately not exercised here.)
    it('falls back to the scanner name when source is absent', function () {
        insertScan(db, scan({ source: null as unknown as string }))
        expect(getLatestScanForProject(db, PROJECT_ID)?.source).toBe('osv')
    })
})

describe('listScansForProject', function () {
    function seedHistory(count: number): void {
        for (let i = 0; i < count; i++) {
            insertScan(db, scan({ id: 'scan-' + i, finishedAt: T0 + i * HOUR }))
        }
    }

    it('lists newest first', function () {
        seedHistory(3)
        expect(listScansForProject(db, PROJECT_ID).map(function id(s) { return s.id })).toEqual([
            'scan-2', 'scan-1', 'scan-0'
        ])
    })

    it('applies a limit', function () {
        seedHistory(5)
        expect(listScansForProject(db, PROJECT_ID, 2).map(function id(s) { return s.id })).toEqual(['scan-4', 'scan-3'])
    })

    it('applies an offset for paging', function () {
        seedHistory(5)
        expect(listScansForProject(db, PROJECT_ID, 2, 2).map(function id(s) { return s.id })).toEqual(['scan-2', 'scan-1'])
    })

    it('returns an empty page past the end', function () {
        seedHistory(2)
        expect(listScansForProject(db, PROJECT_ID, 10, 50)).toEqual([])
    })

    it('excludes another project history', function () {
        seedHistory(2)
        insertScan(db, scan({ id: 'theirs', projectId: OTHER_PROJECT_ID }))
        expect(listScansForProject(db, PROJECT_ID)).toHaveLength(2)
    })

    it('counts the full history rather than the current page', function () {
        seedHistory(5)
        expect(countScansForProject(db, PROJECT_ID)).toBe(5)
        expect(listScansForProject(db, PROJECT_ID, 2)).toHaveLength(2)
    })

    it('counts zero for a project that never ran', function () {
        expect(countScansForProject(db, PROJECT_ID)).toBe(0)
    })
})

describe('getProjectEcosystemCoverage', function () {
    function coverageScan(id: string, finishedAt: number, coverage: unknown): void {
        insertScan(db, { ...scan({ id, finishedAt }), rawJson: JSON.stringify({ coverage }) })
    }

    it('reports nothing when no scan recorded coverage', function () {
        insertScan(db, scan())
        expect(getProjectEcosystemCoverage(db, PROJECT_ID)).toEqual([])
    })

    it('reads coverage out of a scan rawJson', function () {
        coverageScan('s1', T0, [{ ecosystem: 'npm', status: 'ok' }])
        expect(getProjectEcosystemCoverage(db, PROJECT_ID)).toEqual([
            { ecosystem: 'npm', status: 'ok', reasonCode: null, details: [] }
        ])
    })

    it('carries the reason and details for a degraded ecosystem', function () {
        coverageScan('s1', T0, [
            { ecosystem: 'PyPI', status: 'unauditable', reasonCode: 'no_lockfile', details: ['no poetry.lock'] }
        ])
        expect(getProjectEcosystemCoverage(db, PROJECT_ID)).toEqual([
            { ecosystem: 'PyPI', status: 'unauditable', reasonCode: 'no_lockfile', details: ['no poetry.lock'] }
        ])
    })

    // Walks newest-first and keeps the first entry per ecosystem, so a stale earlier scan cannot
    // overwrite the current state with an out-of-date one.
    it('keeps the newest entry per ecosystem', function () {
        coverageScan('older', T0, [{ ecosystem: 'npm', status: 'unauditable', reasonCode: 'no_lockfile' }])
        coverageScan('newer', T0 + HOUR, [{ ecosystem: 'npm', status: 'ok' }])
        expect(getProjectEcosystemCoverage(db, PROJECT_ID)).toEqual([
            { ecosystem: 'npm', status: 'ok', reasonCode: null, details: [] }
        ])
    })

    it('merges coverage across ecosystems from different scans', function () {
        coverageScan('npm-scan', T0, [{ ecosystem: 'npm', status: 'ok' }])
        coverageScan('py-scan', T0 + HOUR, [{ ecosystem: 'PyPI', status: 'partial' }])
        const found = getProjectEcosystemCoverage(db, PROJECT_ID)
        expect(found.map(function e(c) { return c.ecosystem }).sort()).toEqual(['PyPI', 'npm'])
    })

    it('skips a scan whose rawJson is not valid JSON', function () {
        insertScan(db, { ...scan({ id: 'broken', finishedAt: T0 + HOUR }), rawJson: '{not json' })
        coverageScan('good', T0, [{ ecosystem: 'npm', status: 'ok' }])
        expect(getProjectEcosystemCoverage(db, PROJECT_ID)).toHaveLength(1)
    })

    it('skips a scan whose coverage is not an array', function () {
        coverageScan('weird', T0 + HOUR, { ecosystem: 'npm' })
        coverageScan('good', T0, [{ ecosystem: 'npm', status: 'ok' }])
        expect(getProjectEcosystemCoverage(db, PROJECT_ID)).toHaveLength(1)
    })

    it('skips entries with no ecosystem name', function () {
        coverageScan('s1', T0, [{ status: 'ok' }, { ecosystem: 'npm', status: 'ok' }])
        expect(getProjectEcosystemCoverage(db, PROJECT_ID).map(function e(c) { return c.ecosystem })).toEqual(['npm'])
    })

    // An unrecognised status becomes 'ok' rather than being dropped, so the ecosystem still appears
    // in the list rather than vanishing from the coverage report entirely.
    it('normalises an unrecognised status to ok', function () {
        coverageScan('s1', T0, [{ ecosystem: 'npm', status: 'weird' }])
        expect(getProjectEcosystemCoverage(db, PROJECT_ID)[0]?.status).toBe('ok')
    })

    it('nulls a non-string reason code', function () {
        coverageScan('s1', T0, [{ ecosystem: 'npm', status: 'partial', reasonCode: 42 }])
        expect(getProjectEcosystemCoverage(db, PROJECT_ID)[0]?.reasonCode).toBeNull()
    })

    it('keeps only string details', function () {
        coverageScan('s1', T0, [{ ecosystem: 'npm', status: 'partial', details: ['ok', 7, null] }])
        expect(getProjectEcosystemCoverage(db, PROJECT_ID)[0]?.details).toEqual(['ok'])
    })

    it('defaults absent details to an empty list', function () {
        coverageScan('s1', T0, [{ ecosystem: 'npm', status: 'partial', details: 'not-an-array' }])
        expect(getProjectEcosystemCoverage(db, PROJECT_ID)[0]?.details).toEqual([])
    })

    it('does not read another project coverage', function () {
        insertScan(db, {
            ...scan({ id: 'theirs', projectId: OTHER_PROJECT_ID }),
            rawJson: JSON.stringify({ coverage: [{ ecosystem: 'Go', status: 'ok' }] })
        })
        expect(getProjectEcosystemCoverage(db, PROJECT_ID)).toEqual([])
    })
})
