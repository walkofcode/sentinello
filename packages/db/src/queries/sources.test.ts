import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LEGACY_SOURCE_CONFIG_KEYS, sourceEnabledKey } from '@sentinello/core'
import { openDb } from '../client'
import type { DrizzleDb, SqliteDb } from '../client'
import { runMigrations } from '../migrate'
import { setConfigValue, upsertRoot } from './config'
import { upsertProject } from './projects'
import { insertScan } from './scans'
import { mergeFindingsForScan } from './findings'
import { listCurrentFindingsForProject } from './dashboard'
import { activeSourceCellClause, getActiveSourceCells, getActiveSources, getSourceEnabled } from './sources'

// A (source, ecosystem) cell decides whether findings from that source are visible at all, so a bug
// here either hides real vulnerabilities or shows ones the operator switched off. The default state
// matters just as much as the toggles: a fresh install must scan with npm-audit and must NOT have
// silently opted into downloading advisory dumps.

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle')

const ROOT_ID = 'root-1'
const PROJECT_ID = 'project-1'
const T0 = Date.UTC(2026, 0, 1)

let db: DrizzleDb
let sqlite: SqliteDb
let dir: string

beforeEach(async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-sources-'))
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

describe('getSourceEnabled defaults', function () {
    // npm-audit runs live and is the built-in source, so it is on out of the box; osv and gemnasium
    // download a sizable advisory dump, so they stay opt-in.
    it('enables npm-audit for npm by default', function () {
        expect(getSourceEnabled(db, 'npm-audit')).toBe(true)
    })

    it.each(['osv', 'gemnasium'] as Array<'osv' | 'gemnasium'>)('leaves %s off by default', function (source) {
        expect(getSourceEnabled(db, source)).toBe(false)
    })

    it('defaults to the npm ecosystem when none is given', function () {
        setConfigValue(db, sourceEnabledKey('osv', 'npm'), true)
        expect(getSourceEnabled(db, 'osv')).toBe(true)
    })

    it('keeps ecosystems independent', function () {
        setConfigValue(db, sourceEnabledKey('osv', 'PyPI'), true)
        expect(getSourceEnabled(db, 'osv', 'PyPI')).toBe(true)
        expect(getSourceEnabled(db, 'osv', 'npm')).toBe(false)
    })
})

describe('getSourceEnabled explicit values', function () {
    it('honours an explicit enable', function () {
        setConfigValue(db, sourceEnabledKey('osv', 'npm'), true)
        expect(getSourceEnabled(db, 'osv', 'npm')).toBe(true)
    })

    // npm-audit is disableable now, so an explicit false must actually win over the default.
    it('honours an explicit disable of the default-on source', function () {
        setConfigValue(db, sourceEnabledKey('npm-audit', 'npm'), false)
        expect(getSourceEnabled(db, 'npm-audit', 'npm')).toBe(false)
    })
})

describe('getSourceEnabled legacy key fallback', function () {
    // An upgrade must preserve the operator's prior choice until the worker migrates the flat key.
    it('falls back to the legacy flat key for the npm cell', function () {
        setConfigValue(db, LEGACY_SOURCE_CONFIG_KEYS.osvEnabled, true)
        expect(getSourceEnabled(db, 'osv', 'npm')).toBe(true)
    })

    it('lets the per-cell key win over the legacy key', function () {
        setConfigValue(db, LEGACY_SOURCE_CONFIG_KEYS.osvEnabled, true)
        setConfigValue(db, sourceEnabledKey('osv', 'npm'), false)
        expect(getSourceEnabled(db, 'osv', 'npm')).toBe(false)
    })

    // The legacy key predates ecosystems, so it only ever described the npm cell.
    it('does not apply the legacy key to a non-npm ecosystem', function () {
        setConfigValue(db, LEGACY_SOURCE_CONFIG_KEYS.osvEnabled, true)
        expect(getSourceEnabled(db, 'osv', 'PyPI')).toBe(false)
    })

    it('has no legacy key for npm-audit', function () {
        setConfigValue(db, sourceEnabledKey('npm-audit', 'npm'), false)
        expect(getSourceEnabled(db, 'npm-audit', 'npm')).toBe(false)
    })
})

describe('getActiveSourceCells', function () {
    it('starts with only the npm-audit npm cell', function () {
        expect(getActiveSourceCells(db)).toEqual([{ source: 'npm-audit', ecosystem: 'npm' }])
    })

    // npm-audit shells out to a JavaScript package manager, so it never answers for another ecosystem
    // even if a cell key were somehow written for one.
    it('never lists npm-audit for a non-npm ecosystem', function () {
        setConfigValue(db, sourceEnabledKey('npm-audit', 'PyPI'), true)
        const cells = getActiveSourceCells(db)
        expect(cells.filter(function isNpmAudit(c) { return c.source === 'npm-audit' })).toEqual([
            { source: 'npm-audit', ecosystem: 'npm' }
        ])
    })

    it('lists an enabled osv cell for its ecosystem only', function () {
        setConfigValue(db, sourceEnabledKey('osv', 'PyPI'), true)
        expect(getActiveSourceCells(db)).toContainEqual({ source: 'osv', ecosystem: 'PyPI' })
        expect(getActiveSourceCells(db)).not.toContainEqual({ source: 'osv', ecosystem: 'npm' })
    })

    it('can end up empty when every cell is disabled', function () {
        setConfigValue(db, sourceEnabledKey('npm-audit', 'npm'), false)
        expect(getActiveSourceCells(db)).toEqual([])
    })
})

describe('getActiveSources', function () {
    it('starts with npm-audit alone', function () {
        expect(getActiveSources(db)).toEqual(['npm-audit'])
    })

    // A source appears once no matter how many of its ecosystems are on.
    it('deduplicates a source enabled for several ecosystems', function () {
        setConfigValue(db, sourceEnabledKey('osv', 'npm'), true)
        setConfigValue(db, sourceEnabledKey('osv', 'PyPI'), true)
        expect(getActiveSources(db).sort()).toEqual(['npm-audit', 'osv'])
    })

    it('is empty when no cell is enabled', function () {
        setConfigValue(db, sourceEnabledKey('npm-audit', 'npm'), false)
        expect(getActiveSources(db)).toEqual([])
    })
})

// Asserted through a real query rather than by matching SQL text: what matters is which findings the
// operator can see, and a substring check would pass even if the clause were wired in wrong.
describe('activeSourceCellClause', function () {
    function seedFinding(scanId: string, source: string, ecosystem: string, advisoryId: string): void {
        insertScan(db, {
            id: scanId,
            projectId: PROJECT_ID,
            startedAt: T0 - 1000,
            finishedAt: T0,
            scanner: source,
            source,
            ecosystem,
            status: 'ok',
            reasonCode: 'ok',
            durationMs: 1000,
            errorText: null,
            rawJson: ''
        })
        mergeFindingsForScan(db, {
            projectId: PROJECT_ID,
            scanner: source,
            scanId,
            scanFinishedAt: T0,
            incoming: [
                {
                    projectId: PROJECT_ID,
                    scanner: source,
                    source,
                    ecosystem,
                    advisoryId,
                    advisoryTitle: null,
                    advisoryUrl: null,
                    packageName: 'lodash',
                    installedVersion: '4.17.11',
                    vulnerableRange: '<4.17.21',
                    severity: 'high',
                    fixAvailable: true,
                    fixVersion: '4.17.21',
                    depPath: ['lodash'],
                    isProd: true,
                    isDev: false
                }
            ]
        })
    }

    function visibleAdvisoryIds(): string[] {
        return listCurrentFindingsForProject(db, PROJECT_ID, T0)
            .map(function id(row) {
                return row.advisoryId
            })
            .sort()
    }

    it('shows a finding from an enabled cell', function () {
        seedFinding('scan-1', 'npm-audit', 'npm', 'GHSA-audit')
        expect(visibleAdvisoryIds()).toEqual(['GHSA-audit'])
    })

    it('hides a finding whose source cell is disabled', function () {
        seedFinding('scan-1', 'osv', 'npm', 'GHSA-osv')
        expect(visibleAdvisoryIds()).toEqual([])
    })

    // Disabling a cell does NOT delete its rows — re-enabling brings them back intact.
    it('brings a hidden finding back when its cell is re-enabled', function () {
        seedFinding('scan-1', 'osv', 'npm', 'GHSA-osv')
        expect(visibleAdvisoryIds()).toEqual([])
        setConfigValue(db, sourceEnabledKey('osv', 'npm'), true)
        expect(visibleAdvisoryIds()).toEqual(['GHSA-osv'])
    })

    // The cell is (source, ecosystem), not just source: enabling osv for PyPI must not reveal osv's
    // npm findings.
    it('matches on the ecosystem as well as the source', function () {
        seedFinding('scan-1', 'osv', 'npm', 'GHSA-osv-npm')
        setConfigValue(db, sourceEnabledKey('osv', 'PyPI'), true)
        expect(visibleAdvisoryIds()).toEqual([])
        setConfigValue(db, sourceEnabledKey('osv', 'npm'), true)
        expect(visibleAdvisoryIds()).toEqual(['GHSA-osv-npm'])
    })

    it('shows findings from several enabled cells at once', function () {
        seedFinding('scan-1', 'npm-audit', 'npm', 'GHSA-audit')
        seedFinding('scan-2', 'osv', 'npm', 'GHSA-osv')
        setConfigValue(db, sourceEnabledKey('osv', 'npm'), true)
        expect(visibleAdvisoryIds()).toEqual(['GHSA-audit', 'GHSA-osv'])
    })

    // Only reachable if the "always a source on" invariant is bypassed. Showing nothing is correct;
    // emitting invalid SQL would throw instead.
    it('shows nothing rather than throwing when every cell is disabled', function () {
        seedFinding('scan-1', 'npm-audit', 'npm', 'GHSA-audit')
        setConfigValue(db, sourceEnabledKey('npm-audit', 'npm'), false)
        expect(visibleAdvisoryIds()).toEqual([])
    })

    it('accepts a caller-supplied table alias', function () {
        expect(function build() {
            activeSourceCellClause(db, 'x')
        }).not.toThrow()
    })
})
