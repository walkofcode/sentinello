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
    deleteScansByIds,
    getLastScanFinishedAt,
    getLatestScanForProject,
    getProjectEcosystemCoverage,
    hasStaleSourceUnavailableScans,
    insertScan,
    listPrunableScanIds,
    listScansForProject,
    RAW_JSON_MAX_BYTES
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

// Raw inserts rather than the findings/notification query helpers: these tests are about which rows
// PIN a scan against deletion, so the FK columns have to be set precisely and visibly, including the
// NULL cases that the helpers would never produce on their own.
function pinWithFinding(id: string, scanId: string, resolvedScanId: string | null): void {
    sqlite
        .prepare(
            'INSERT INTO findings (id, scan_id, project_id, scanner, source, ecosystem, advisory_id,' +
                ' package_name, installed_version, vulnerable_range, severity, resolved_scan_id)' +
                " VALUES (?, ?, ?, 'osv', 'osv', 'npm', 'GHSA-x', 'lodash', '4.17.20', '<4.17.21', 'high', ?)"
        )
        .run(id, scanId, PROJECT_ID, resolvedScanId)
}

function pinWithNotificationEvent(id: string, scanId: string): void {
    sqlite
        .prepare(
            'INSERT INTO notification_events (id, identity_key, project_id, event_type, scanner,' +
                " first_scan_id, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'finding', 'osv', ?, ?, ?)"
        )
        .run(id, 'key-' + id, PROJECT_ID, scanId, T0, T0)
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

    // The persistence choke point every writer goes through. npm-audit reached 2.1 GB of unread raw
    // audit output here before anyone noticed, because no single insert looked unreasonable — the cap
    // is what makes that impossible to repeat regardless of which scanner misbehaves.
    it('caps an oversized rawJson at the ceiling', function () {
        insertScan(db, scan({ id: 'huge', rawJson: 'x'.repeat(RAW_JSON_MAX_BYTES * 2) }))

        const stored = getLatestScanForProject(db, PROJECT_ID)?.rawJson || ''

        expect(stored).toHaveLength(RAW_JSON_MAX_BYTES)
        expect(stored.endsWith('…[truncated]')).toBe(true)
    })

    it('leaves a rawJson within the ceiling exactly as written', function () {
        const summary = JSON.stringify({ source: 'npm-audit', packageCount: 12, findingCount: 3 })
        insertScan(db, scan({ id: 'small', rawJson: summary }))

        expect(getLatestScanForProject(db, PROJECT_ID)?.rawJson).toBe(summary)
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

// Retention. The rule is deliberately conservative — three independent conditions, each of which can
// only ever SAVE a row — because deleting scan history is irreversible and the sweep runs unattended.
describe('listPrunableScanIds', function () {
    const CUTOFF = T0 + 100 * HOUR

    function oldScan(id: string, projectId = PROJECT_ID): void {
        insertScan(db, scan({ id, projectId, finishedAt: T0 }))
    }

    it('offers an old, unreferenced scan', function () {
        oldScan('old')
        expect(listPrunableScanIds(db, CUTOFF, 0, 100)).toEqual(['old'])
    })

    it('spares a scan newer than the cutoff', function () {
        insertScan(db, scan({ id: 'fresh', finishedAt: CUTOFF + HOUR }))
        expect(listPrunableScanIds(db, CUTOFF, 0, 100)).toEqual([])
    })

    // The floor that keeps getProjectEcosystemCoverage (last 100 per project) whole no matter how far
    // back the cutoff reaches.
    it('spares the newest K per project however old they are', function () {
        oldScan('oldest')
        insertScan(db, scan({ id: 'middle', finishedAt: T0 + HOUR }))
        insertScan(db, scan({ id: 'newest', finishedAt: T0 + 2 * HOUR }))

        expect(listPrunableScanIds(db, CUTOFF, 2, 100)).toEqual(['oldest'])
    })

    it('applies K per project rather than across the table', function () {
        oldScan('a1')
        insertScan(db, scan({ id: 'a2', finishedAt: T0 + HOUR }))
        oldScan('b1', OTHER_PROJECT_ID)

        // K=1 keeps a2 for project-1 and b1 for project-2; only a1 is surplus.
        expect(listPrunableScanIds(db, CUTOFF, 1, 100)).toEqual(['a1'])
    })

    it('spares a scan pinned as a finding first-detection', function () {
        oldScan('pinned')
        pinWithFinding('f1', 'pinned', null)
        expect(listPrunableScanIds(db, CUTOFF, 0, 100)).toEqual([])
    })

    it('spares a scan pinned as the resolving scan', function () {
        oldScan('detected')
        oldScan('resolver')
        pinWithFinding('f1', 'detected', 'resolver')
        expect(listPrunableScanIds(db, CUTOFF, 0, 100)).toEqual([])
    })

    it('spares a scan pinned by a notification event', function () {
        oldScan('pinned')
        pinWithNotificationEvent('e1', 'pinned')
        expect(listPrunableScanIds(db, CUTOFF, 0, 100)).toEqual([])
    })

    // THE regression that matters. `NOT IN` against a list containing NULL evaluates to NULL for every
    // row, so dropping the IS NOT NULL guard on resolved_scan_id does not error — it silently makes
    // this sweep return nothing forever, which is indistinguishable from "retention is working, there
    // was just nothing to prune". An open finding (resolved_scan_id NULL) is the overwhelmingly common
    // case, so the bug would be live from the first install.
    it('still finds prunable scans while an unresolved finding holds a NULL resolved_scan_id', function () {
        oldScan('pinned')
        oldScan('prunable')
        pinWithFinding('open', 'pinned', null)

        expect(listPrunableScanIds(db, CUTOFF, 0, 100)).toEqual(['prunable'])
    })

    it('honours the batch size', function () {
        oldScan('a')
        insertScan(db, scan({ id: 'b', finishedAt: T0 + HOUR }))
        insertScan(db, scan({ id: 'c', finishedAt: T0 + 2 * HOUR }))

        expect(listPrunableScanIds(db, CUTOFF, 0, 2)).toHaveLength(2)
    })

    it('finds nothing in an empty table', function () {
        expect(listPrunableScanIds(db, CUTOFF, 0, 100)).toEqual([])
    })
})

describe('deleteScansByIds', function () {
    it('removes the named scans and reports the count', function () {
        insertScan(db, scan({ id: 'a', finishedAt: T0 }))
        insertScan(db, scan({ id: 'b', finishedAt: T0 + HOUR }))

        expect(deleteScansByIds(db, ['a'])).toBe(1)
        expect(listScansForProject(db, PROJECT_ID).map(function id(s) { return s.id })).toEqual(['b'])
    })

    it('does nothing when given no ids', function () {
        insertScan(db, scan({ id: 'a' }))
        expect(deleteScansByIds(db, [])).toBe(0)
        expect(countScansForProject(db, PROJECT_ID)).toBe(1)
    })

    // The database is the backstop, not the predicate. If listPrunableScanIds ever regresses, this is
    // what turns a silent history-corrupting delete into a loud failure.
    it('throws rather than orphaning a referenced finding', function () {
        insertScan(db, scan({ id: 'pinned' }))
        pinWithFinding('f1', 'pinned', null)

        expect(function deletePinned() { deleteScansByIds(db, ['pinned']) }).toThrow(/FOREIGN KEY/i)
    })
})

// The whole point of K: whatever retention deletes, the coverage read must answer identically.
describe('retention leaves the coverage read intact', function () {
    it('reports the same coverage before and after a sweep', function () {
        insertScan(db, {
            ...scan({ id: 'ancient', finishedAt: T0 }),
            rawJson: JSON.stringify({ coverage: [{ ecosystem: 'PyPI', status: 'partial' }] })
        })
        insertScan(db, {
            ...scan({ id: 'recent', finishedAt: T0 + 10 * HOUR }),
            rawJson: JSON.stringify({ coverage: [{ ecosystem: 'PyPI', status: 'partial' }] })
        })
        const before = getProjectEcosystemCoverage(db, PROJECT_ID)

        deleteScansByIds(db, listPrunableScanIds(db, T0 + 100 * HOUR, 1, 100))

        expect(getProjectEcosystemCoverage(db, PROJECT_ID)).toEqual(before)
    })
})

// The boot-time reconciliation the worker uses to notice that a cache is fine while the projects still
// say it was not — a transition that happened while nobody was watching (an upgrade, a restart, a crash)
// leaves verdicts nothing else will ever clear.
describe('hasStaleSourceUnavailableScans', function () {
    it('is false when nothing has ever scanned', function () {
        expect(hasStaleSourceUnavailableScans(db, 'osv')).toBe(false)
    })

    it('is true when a project\'s latest scan for the source says the cache was missing', function () {
        insertScan(db, scan({ id: 's1', status: 'unauditable', reasonCode: 'osv_db_not_seeded' }))
        expect(hasStaleSourceUnavailableScans(db, 'osv')).toBe(true)
    })

    it('is false once that project has been scanned again successfully', function () {
        insertScan(db, scan({ id: 's1', status: 'unauditable', reasonCode: 'osv_db_not_seeded' }))
        insertScan(db, scan({ id: 's2', finishedAt: T0 + HOUR }))
        expect(hasStaleSourceUnavailableScans(db, 'osv')).toBe(false)
    })

    // Per project, not newest-row-wins: one project scanned since the cache came back does not speak
    // for the rest, and the whole point is to catch the ones still holding the old verdict.
    it('is true when only one of several projects is still stale', function () {
        insertScan(db, scan({ id: 's1', finishedAt: T0 + HOUR }))
        insertScan(db, scan({ id: 's2', projectId: OTHER_PROJECT_ID, status: 'unauditable', reasonCode: 'osv_db_not_seeded' }))
        expect(hasStaleSourceUnavailableScans(db, 'osv')).toBe(true)
    })

    it('ignores a stale verdict belonging to a different source', function () {
        insertScan(db, scan({ id: 's1', status: 'unauditable', reasonCode: 'osv_db_not_seeded' }))
        expect(hasStaleSourceUnavailableScans(db, 'gemnasium')).toBe(false)
    })

    // A project with no lockfile is not waiting on a cache — re-scanning it would change nothing.
    it('ignores an unauditable verdict that is not about the cache', function () {
        insertScan(db, scan({ id: 's1', status: 'unauditable', reasonCode: 'no_lockfile' }))
        expect(hasStaleSourceUnavailableScans(db, 'osv')).toBe(false)
    })

    // Pre-migration rows carry a null source; the backfill runs at worker boot, and this check runs
    // during that same boot.
    it('falls back to the scanner name for a row written before source was backfilled', function () {
        insertScan(db, scan({ id: 's1', status: 'unauditable', reasonCode: 'osv_db_not_seeded' }))
        sqlite.prepare('UPDATE scans SET source = NULL').run()
        expect(hasStaleSourceUnavailableScans(db, 'osv')).toBe(true)
    })
})
