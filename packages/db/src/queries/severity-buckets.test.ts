import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ulid } from 'ulid'
import { openDb } from '../client'
import type { DrizzleDb, SqliteDb } from '../client'
import { runMigrations } from '../migrate'
import { upsertRoot } from './config'
import { upsertProject } from './projects'
import { insertScan } from './scans'
import { mergeFindingsForScan } from './findings'
import { getDashboardSummary, listProjectCatalog } from './dashboard'

// The severity counts are how an operator decides a project is safe to ignore, so every finding that
// survives dedup MUST land in exactly one bucket. severityRankSql ranks 5..1 and the callers sum those
// five; anything ranking outside that range would be counted as a finding and bucketed nowhere, so the
// buckets would undercount and a project whose only finding had an unrecognized severity would render
// as clean. findings.severity is `text NOT NULL` with no CHECK constraint — the enum lives only in the
// Drizzle TS type — so an out-of-enum value is a real possibility for legacy rows, hand-edited data, or
// a future source that forgets to normalize.

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle')

const ROOT_ID = 'root-1'
const PROJECT_ID = 'project-1'
const T0 = Date.UTC(2026, 0, 1)

let db: DrizzleDb
let sqlite: SqliteDb
let dir: string

// Bypasses the scanners deliberately: both of today's write paths normalize severity, so the only way
// to exercise the bucketing contract is to write the row the way a legacy or third-party writer would.
// Everything goes in one scan — the lifecycle merge resolves any open finding absent from the newest
// scan of the same scanner, so seeding across two scans would silently close the first row.
function seedFindings(specs: { severity: string; advisoryId: string }[]): void {
    const scanId = ulid()
    insertScan(db, {
        id: scanId,
        projectId: PROJECT_ID,
        startedAt: T0,
        finishedAt: T0,
        scanner: 'npm-audit',
        source: 'npm-audit',
        ecosystem: 'npm',
        status: 'ok',
        reasonCode: null,
        durationMs: 1,
        errorText: null,
        rawJson: '{}'
    })
    mergeFindingsForScan(db, {
        projectId: PROJECT_ID,
        scanner: 'npm-audit',
        scanId,
        scanFinishedAt: T0,
        incoming: specs.map(function toIncoming(spec) {
            return {
                projectId: PROJECT_ID,
                scanner: 'npm-audit',
                source: 'npm-audit',
                ecosystem: 'npm',
                advisoryId: spec.advisoryId,
                advisoryTitle: 'Vulnerability ' + spec.advisoryId,
                advisoryUrl: null,
                packageName: 'pkg-' + spec.advisoryId,
                installedVersion: '1.0.0',
                vulnerableRange: '<2.0.0',
                severity: spec.severity as 'high',
                fixAvailable: false,
                fixVersion: null,
                depPath: [],
                isProd: true,
                isDev: false
            }
        })
    })
}

function seedFinding(severity: string, advisoryId: string): void {
    seedFindings([{ severity, advisoryId }])
}

function catalogCounts() {
    const row = listProjectCatalog(db, T0, 'all').find(function mine(p) {
        return p.id === PROJECT_ID
    })
    if (!row) throw new Error('project missing from catalog')
    return row.severityCounts
}

function bucketTotal(counts: { critical: number; high: number; moderate: number; low: number; info: number }): number {
    return counts.critical + counts.high + counts.moderate + counts.low + counts.info
}

beforeEach(async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-sev-'))
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

describe('severity bucketing', function () {
    it.each([
        ['critical', 'critical'],
        ['high', 'high'],
        ['moderate', 'moderate'],
        ['low', 'low'],
        ['info', 'info']
    ])('counts a %s finding in its own bucket', function (severity, bucket) {
        seedFinding(severity, 'GHSA-1')
        const counts = catalogCounts()
        expect(counts[bucket as 'high']).toBe(1)
        expect(bucketTotal(counts)).toBe(1)
    })

    // The hole this test exists for: an unrecognized severity used to rank 0 and land in no bucket at
    // all, so this project reported 0/0/0/0/0 — indistinguishable from having nothing wrong with it.
    it('never drops a finding whose severity is unrecognized', function () {
        seedFinding('bogus', 'GHSA-1')
        expect(bucketTotal(catalogCounts())).toBe(1)
    })

    it('treats an unrecognized severity as moderate rather than downgrading it', function () {
        seedFinding('bogus', 'GHSA-1')
        expect(catalogCounts().moderate).toBe(1)
    })

    // Casing is the most plausible route in: severity is compared against lower-case literals, so an
    // upper-case value from a new source would otherwise vanish from the counts.
    it.each(['HIGH', 'High', ' high '])('normalizes %j to the high bucket', function (severity) {
        seedFinding(severity, 'GHSA-1')
        expect(catalogCounts().high).toBe(1)
    })

    it('keeps the dashboard totals reconciled with the per-project buckets', function () {
        seedFindings([
            { severity: 'critical', advisoryId: 'GHSA-1' },
            { severity: 'bogus', advisoryId: 'GHSA-2' }
        ])
        const summary = getDashboardSummary(db, T0, 'all')
        expect(bucketTotal(summary.severityCounts)).toBe(2)
        expect(bucketTotal(catalogCounts())).toBe(2)
    })
})
