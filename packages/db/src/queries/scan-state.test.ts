import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sourceEnabledKey, type EcosystemId, type Scan } from '@sentinello/core'
import { openDb } from '../client'
import type { DrizzleDb, SqliteDb } from '../client'
import { runMigrations } from '../migrate'
import { setConfigValue, upsertRoot } from './config'
import { getDashboardSummary, listCurrentFindingsForProject, listProjectCatalog } from './dashboard'
import { insertMute } from './mutes'
import { listLibraryUsage } from './libraries'
import { upsertProject } from './projects'
import {
    activeScanRows,
    expectedScanInputs,
    findingScanContexts,
    getProjectEcosystemCoverage,
    getProjectScanState,
    listLatestSourceScans,
    listProjectScanStates
} from './scan-state'
import { deleteScansByIds, insertScan, listPrunableScanIds } from './scans'

// The scan state every surface reads. Its inputs are the part with judgement in them: the expected
// sources are passed in from configuration, never inferred from the scans that exist, because an absent
// scan means "has not run", never "is fine"; and coverage is read from the latest scan only, so a project
// that loses its lockfile stops showing the "ok" an earlier scan recorded.

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle')

const ROOT_ID = 'root-1'
const PROJECT_ID = 'project-1'
const OTHER_PROJECT_ID = 'project-2'
const T0 = Date.UTC(2026, 0, 1)
const HOUR = 3600_000

let db: DrizzleDb
let sqlite: SqliteDb
let dir: string
let scanSeq = 0

function addProject(id: string, ecosystems: EcosystemId[] = ['npm']): void {
    upsertProject(db, {
        id,
        rootId: ROOT_ID,
        relPath: id,
        name: id,
        alias: null,
        packageManager: 'npm',
        nvmrcVersion: null,
        gitBranch: null,
        ecosystems,
        muted: false,
        tags: [],
        createdAt: T0,
        updatedAt: T0
    })
}

function enable(source: 'npm-audit' | 'osv' | 'gemnasium', on = true): void {
    setConfigValue(db, sourceEnabledKey(source, 'npm'), on)
}

// ULID-shaped ids that sort in insertion order, so a finished_at tie still has a defined winner.
function record(overrides: Partial<Scan> & { coverage?: unknown } = {}): Scan {
    scanSeq += 1
    const { coverage, ...rest } = overrides
    const scan: Scan = {
        id: 'scan-' + String(scanSeq).padStart(4, '0'),
        projectId: PROJECT_ID,
        startedAt: T0 - 1000,
        finishedAt: T0,
        scanner: 'npm-audit',
        source: 'npm-audit',
        ecosystem: 'npm',
        status: 'ok',
        reasonCode: 'ok',
        durationMs: 1000,
        errorText: null,
        rawJson: coverage === undefined ? '' : JSON.stringify({ coverage }),
        ...rest
    }
    insertScan(db, scan)
    return scan
}

function failed(source: string, at: number, reasonCode: Scan['reasonCode'] = 'no_lockfile', overrides: Partial<Scan> = {}): Scan {
    return record({ source, scanner: source, finishedAt: at, status: 'unauditable', reasonCode, ...overrides })
}

function ok(source: string, at: number, overrides: Partial<Scan> & { coverage?: unknown } = {}): Scan {
    return record({ source, scanner: source, finishedAt: at, ...overrides })
}

// A finding row exactly as a scan left it: settled (fix_status + fix_check_json) or legacy (neither).
function finding(id: string, scanId: string, settled: boolean, overrides: { source?: string; projectId?: string } = {}): void {
    const source = overrides.source ?? 'npm-audit'
    const check = JSON.stringify({ v: 1, checkedAt: T0, registry: 'ok', packageDataAsOf: T0, unevaluable: null, sources: [] })
    sqlite
        .prepare(
            'INSERT INTO findings (id, scan_id, project_id, scanner, source, ecosystem, advisory_id, package_name,' +
                ' installed_version, vulnerable_range, severity, fix_available, fix_version, fix_status, fix_check_json,' +
                ' first_detected_at, last_seen_at)' +
                " VALUES (?, ?, ?, ?, ?, 'npm', ?, 'lodash', '4.17.11', '<4.17.21', 'high', 1, '4.17.21', ?, ?, ?, ?)"
        )
        .run(id, scanId, overrides.projectId ?? PROJECT_ID, source, source, 'GHSA-' + id, settled ? 'released' : null, settled ? check : null, T0, T0)
}

beforeEach(async function setup() {
    scanSeq = 0
    dir = await mkdtemp(join(tmpdir(), 'sentinello-scan-state-'))
    const opened = openDb({ dbPath: join(dir, 'test.sqlite') })
    db = opened.db
    sqlite = opened.sqlite
    runMigrations(db, { migrationsFolder: MIGRATIONS })
    upsertRoot(db, { id: ROOT_ID, path: '/repo', label: null, createdAt: T0 })
    addProject(PROJECT_ID)
    addProject(OTHER_PROJECT_ID)
})

afterEach(async function teardown() {
    sqlite.close()
    await rm(dir, { recursive: true, force: true })
})

describe('scan state — listLatestSourceScans', function () {
    it('returns the latest scan of each source with the last ok one', function () {
        ok('npm-audit', T0)
        failed('npm-audit', T0 + HOUR)
        const rows = listLatestSourceScans(db, [PROJECT_ID])
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({ projectId: PROJECT_ID, source: 'npm-audit', status: 'unauditable', reasonCode: 'no_lockfile', finishedAt: T0 + HOUR, lastOkScanAt: T0 })
    })

    it('has no last ok scan for a source that never succeeded', function () {
        failed('npm-audit', T0)
        expect(listLatestSourceScans(db, [PROJECT_ID])[0]?.lastOkScanAt).toBeNull()
    })

    it('breaks a finished_at tie on the later id', function () {
        ok('npm-audit', T0)
        failed('npm-audit', T0)
        expect(listLatestSourceScans(db, [PROJECT_ID])[0]?.status).toBe('unauditable')
    })

    it('reads every project when none is named, in source display order', function () {
        ok('gemnasium', T0)
        ok('osv', T0)
        ok('npm-audit', T0)
        ok('npm-audit', T0, { projectId: OTHER_PROJECT_ID })
        expect(listLatestSourceScans(db).map(function s(r) { return r.projectId + ':' + r.source })).toEqual([
            'project-1:npm-audit',
            'project-2:npm-audit',
            'project-1:osv',
            'project-1:gemnasium'
        ])
    })

    it('reads nothing for an empty project list', function () {
        ok('npm-audit', T0)
        expect(listLatestSourceScans(db, [])).toEqual([])
        expect(expectedScanInputs(db, []).size).toBe(0)
    })

    it('reads a legacy row by its scanner name', function () {
        sqlite.prepare("INSERT INTO scans (id, project_id, started_at, finished_at, scanner, source, status, reason_code, duration_ms, raw_json) VALUES ('legacy', ?, ?, ?, 'npm-audit', NULL, 'ok', 'ok', 0, '')").run(PROJECT_ID, T0, T0)
        expect(listLatestSourceScans(db, [PROJECT_ID])[0]?.source).toBe('npm-audit')
    })

    it('sorts an unknown source after the known ones', function () {
        ok('zeta', T0)
        ok('npm-audit', T0)
        expect(listLatestSourceScans(db, [PROJECT_ID]).map(function s(r) { return r.source })).toEqual(['npm-audit', 'zeta'])
    })
})

describe('scan state — activeScanRows', function () {
    it('drops the rows of a source the operator switched off', function () {
        ok('npm-audit', T0)
        ok('osv', T0)
        expect(activeScanRows(db, listLatestSourceScans(db, [PROJECT_ID])).map(function s(r) { return r.source })).toEqual(['npm-audit'])
        enable('osv')
        expect(activeScanRows(db, listLatestSourceScans(db, [PROJECT_ID])).map(function s(r) { return r.source })).toEqual(['npm-audit', 'osv'])
    })
})

describe('scan state — getProjectEcosystemCoverage', function () {
    it('reports nothing when no scan recorded coverage', function () {
        ok('npm-audit', T0)
        expect(getProjectEcosystemCoverage(db, PROJECT_ID)).toEqual([])
    })

    it('reads coverage out of the latest scan', function () {
        ok('npm-audit', T0, { coverage: [{ ecosystem: 'npm', status: 'ok' }] })
        expect(getProjectEcosystemCoverage(db, PROJECT_ID)).toEqual([{ ecosystem: 'npm', status: 'ok', reasonCode: null, details: [] }])
    })

    it('carries the reason and details for a degraded ecosystem', function () {
        failed('npm-audit', T0, 'no_lockfile', { rawJson: JSON.stringify({ coverage: [{ ecosystem: 'npm', status: 'unauditable', reasonCode: 'no_lockfile', details: ['no lockfile'] }] }) })
        expect(getProjectEcosystemCoverage(db, PROJECT_ID)).toEqual([{ ecosystem: 'npm', status: 'unauditable', reasonCode: 'no_lockfile', details: ['no lockfile'] }])
    })

    // The lockfile-loss case: the newer scan's unauditable coverage wins, and the older "ok" is gone.
    it('stops showing an older ok once the latest scan says otherwise', function () {
        ok('npm-audit', T0, { coverage: [{ ecosystem: 'npm', status: 'ok' }] })
        failed('npm-audit', T0 + HOUR, 'no_lockfile', { rawJson: JSON.stringify({ coverage: [{ ecosystem: 'npm', status: 'unauditable', reasonCode: 'no_lockfile' }] }) })
        expect(getProjectEcosystemCoverage(db, PROJECT_ID)).toEqual([{ ecosystem: 'npm', status: 'unauditable', reasonCode: 'no_lockfile', details: [] }])
    })

    // Never merged across scans: an ecosystem the latest scan did not record is not borrowed from an older one.
    it('does not merge ecosystems from older scans', function () {
        ok('npm-audit', T0, { coverage: [{ ecosystem: 'PyPI', status: 'ok' }] })
        ok('npm-audit', T0 + HOUR, { coverage: [{ ecosystem: 'npm', status: 'ok' }] })
        expect(getProjectEcosystemCoverage(db, PROJECT_ID).map(function e(c) { return c.ecosystem })).toEqual(['npm'])
    })

    // Another source's older coverage is not the project as it is now: it may predate this scan by any number
    // of sweeps, or come from a source switched off since. A newest row with none means unknown.
    it('does not borrow an older source coverage when the newest scan carries none', function () {
        ok('osv', T0, { coverage: [{ ecosystem: 'npm', status: 'ok' }] })
        failed('npm-audit', T0 + HOUR, 'timeout', { status: 'timeout', rawJson: 'raw audit text' })
        expect(getProjectEcosystemCoverage(db, PROJECT_ID)).toEqual([])
        expect(expectedScanInputs(db, [PROJECT_ID]).get(PROJECT_ID)?.coverage).toBeNull()
    })

    it('reads coverage kept beside a raw diagnostic', function () {
        ok('osv', T0, { coverage: [{ ecosystem: 'npm', status: 'ok' }] })
        failed('npm-audit', T0 + HOUR, 'audit_parse_error', { rawJson: JSON.stringify({ coverage: [{ ecosystem: 'npm', status: 'unauditable', reasonCode: 'unsupported_lockfile' }], raw: 'raw audit text' }) })
        expect(getProjectEcosystemCoverage(db, PROJECT_ID)).toEqual([{ ecosystem: 'npm', status: 'unauditable', reasonCode: 'unsupported_lockfile', details: [] }])
    })

    it('reads a latest scan whose coverage is not an array, or whose summary is not an object, as unknown', function () {
        ok('osv', T0, { coverage: [{ ecosystem: 'npm', status: 'ok' }] })
        ok('gemnasium', T0 + HOUR, { rawJson: 'null' })
        expect(expectedScanInputs(db, [PROJECT_ID]).get(PROJECT_ID)?.coverage).toBeNull()
        ok('npm-audit', T0 + 2 * HOUR, { coverage: { ecosystem: 'npm' } })
        expect(expectedScanInputs(db, [PROJECT_ID]).get(PROJECT_ID)?.coverage).toBeNull()
        expect(getProjectEcosystemCoverage(db, PROJECT_ID)).toEqual([])
    })

    it('breaks a finished_at tie between sources on the later id', function () {
        ok('npm-audit', T0, { coverage: [{ ecosystem: 'npm', status: 'ok' }] })
        ok('osv', T0, { coverage: [{ ecosystem: 'npm', status: 'partial' }] })
        expect(getProjectEcosystemCoverage(db, PROJECT_ID)[0]?.status).toBe('partial')
        ok('gemnasium', T0, { coverage: [{ ecosystem: 'npm', status: 'unauditable' }] })
        expect(getProjectEcosystemCoverage(db, PROJECT_ID)[0]?.status).toBe('unauditable')
    })

    it('skips entries with no ecosystem name, and a repeated ecosystem', function () {
        ok('npm-audit', T0, { coverage: [{ status: 'ok' }, null, { ecosystem: 'npm', status: 'ok' }, { ecosystem: 'npm', status: 'partial' }] })
        expect(getProjectEcosystemCoverage(db, PROJECT_ID)).toEqual([{ ecosystem: 'npm', status: 'ok', reasonCode: null, details: [] }])
    })

    it('normalises an unrecognised status to ok', function () {
        ok('npm-audit', T0, { coverage: [{ ecosystem: 'npm', status: 'weird' }] })
        expect(getProjectEcosystemCoverage(db, PROJECT_ID)[0]?.status).toBe('ok')
    })

    it('nulls a non-string reason code and keeps only string details', function () {
        ok('npm-audit', T0, { coverage: [{ ecosystem: 'npm', status: 'partial', reasonCode: 42, details: ['ok', 7, null] }] })
        expect(getProjectEcosystemCoverage(db, PROJECT_ID)[0]).toMatchObject({ reasonCode: null, details: ['ok'] })
    })

    it('defaults absent details to an empty list', function () {
        ok('npm-audit', T0, { coverage: [{ ecosystem: 'npm', status: 'partial', details: 'not-an-array' }] })
        expect(getProjectEcosystemCoverage(db, PROJECT_ID)[0]?.details).toEqual([])
    })

    it('does not read another project coverage', function () {
        ok('npm-audit', T0, { projectId: OTHER_PROJECT_ID, coverage: [{ ecosystem: 'Go', status: 'ok' }] })
        expect(getProjectEcosystemCoverage(db, PROJECT_ID)).toEqual([])
    })
})

describe('scan state — expected sources', function () {
    it('expects the runnable sources of the project ecosystems, in source order', function () {
        enable('gemnasium')
        enable('osv')
        expect(expectedScanInputs(db, [PROJECT_ID]).get(PROJECT_ID)?.expectedSources).toEqual(['npm-audit', 'osv', 'gemnasium'])
    })

    it('expects nothing from a source enabled only for an ecosystem the project does not have', function () {
        addProject('py-only', ['PyPI'])
        expect(expectedScanInputs(db, ['py-only']).get('py-only')?.expectedSources).toEqual([])
    })

    it('reads a project with no recorded ecosystems as npm', function () {
        addProject('legacy', [])
        expect(expectedScanInputs(db, ['legacy']).get('legacy')?.expectedSources).toEqual(['npm-audit'])
    })

    it('normalizes every project when none is named', function () {
        expect(Array.from(expectedScanInputs(db).keys()).sort()).toEqual([PROJECT_ID, OTHER_PROJECT_ID])
    })

    it('reads a project with no scan history as not scanned yet, never scanned', function () {
        expect(getProjectScanState(db, PROJECT_ID)).toEqual({ state: 'not_scanned_yet', reasons: [] })
    })

    it('reads an unknown project as not scanned yet', function () {
        expect(getProjectScanState(db, 'nope')).toEqual({ state: 'not_scanned_yet', reasons: [] })
    })

    it('reads a newly enabled source with no scan as not yet run, never scanned', function () {
        ok('npm-audit', T0, { coverage: [{ ecosystem: 'npm', status: 'ok' }] })
        enable('osv')
        expect(getProjectScanState(db, PROJECT_ID)).toEqual({
            state: 'partial',
            reasons: [{ source: 'osv', ecosystem: null, reasonCode: 'not_yet_run', side: null }]
        })
    })

    it('ignores the old failed scan of a source since disabled', function () {
        enable('osv')
        failed('osv', T0, 'osv_db_not_seeded')
        enable('osv', false)
        ok('npm-audit', T0 + HOUR, { coverage: [{ ecosystem: 'npm', status: 'ok' }] })
        expect(getProjectScanState(db, PROJECT_ID)).toEqual({ state: 'scanned', reasons: [] })
    })

    it('reads a project that lost its lockfile as cannot be scanned, on the project side', function () {
        ok('npm-audit', T0)
        failed('npm-audit', T0 + HOUR, 'no_lockfile', { rawJson: JSON.stringify({ coverage: [{ ecosystem: 'npm', status: 'unauditable', reasonCode: 'no_lockfile' }] }) })
        expect(getProjectScanState(db, PROJECT_ID)).toEqual({
            state: 'cannot_scan',
            reasons: [
                { source: 'npm-audit', ecosystem: null, reasonCode: 'no_lockfile', side: 'project' },
                { source: null, ecosystem: 'npm', reasonCode: 'no_lockfile', side: 'project' }
            ]
        })
    })

    // A successful npm-audit summary written before every scan recorded coverage proves the source answered,
    // not that the shared resolver could read the graph (native Yarn audit succeeds on a yarn.lock it cannot).
    it('reads a pre-coverage successful scan as partial, not yet run for its ecosystem, never scanned', function () {
        ok('npm-audit', T0, { rawJson: JSON.stringify({ source: 'npm-audit', packageCount: null, findingCount: 0 }) })
        expect(expectedScanInputs(db, [PROJECT_ID]).get(PROJECT_ID)).toMatchObject({ detectedEcosystems: ['npm'], coverage: null })
        expect(getProjectScanState(db, PROJECT_ID)).toEqual({
            state: 'partial',
            reasons: [{ source: null, ecosystem: 'npm', reasonCode: 'not_yet_run', side: null }]
        })
        ok('npm-audit', T0 + HOUR, { coverage: [{ ecosystem: 'npm', status: 'ok' }] })
        expect(getProjectScanState(db, PROJECT_ID)).toEqual({ state: 'scanned', reasons: [] })
    })

    it('reads an ecosystem detected since the latest scan as not yet run', function () {
        addProject('polyglot', ['npm', 'PyPI'])
        ok('npm-audit', T0, { projectId: 'polyglot', coverage: [{ ecosystem: 'npm', status: 'ok' }] })
        expect(getProjectScanState(db, 'polyglot')).toEqual({
            state: 'partial',
            reasons: [{ source: null, ecosystem: 'PyPI', reasonCode: 'not_yet_run', side: null }]
        })
    })

    it('lists the state of every project', function () {
        ok('npm-audit', T0, { coverage: [{ ecosystem: 'npm', status: 'ok' }] })
        failed('npm-audit', T0, 'pm_missing', { projectId: OTHER_PROJECT_ID, rawJson: JSON.stringify({ coverage: [{ ecosystem: 'npm', status: 'ok' }] }) })
        const states = listProjectScanStates(db)
        expect(states.get(PROJECT_ID)?.state).toBe('scanned')
        expect(states.get(OTHER_PROJECT_ID)).toEqual({
            state: 'cannot_scan',
            reasons: [{ source: 'npm-audit', ecosystem: null, reasonCode: 'pm_missing', side: 'environment' }]
        })
    })
})

describe('scan state — project cannot be scanned in the catalog and the dashboard', function () {
    it('reads the same states from rows the caller already read', function () {
        failed('npm-audit', T0, 'no_lockfile', { rawJson: JSON.stringify({ coverage: [{ ecosystem: 'npm', status: 'unauditable', reasonCode: 'no_lockfile' }] }) })
        expect(listProjectScanStates(db, listLatestSourceScans(db))).toEqual(listProjectScanStates(db))
    })

    it('gives every catalog row its project scan state', function () {
        failed('npm-audit', T0, 'no_lockfile', { rawJson: JSON.stringify({ coverage: [{ ecosystem: 'npm', status: 'unauditable', reasonCode: 'no_lockfile' }] }) })
        const rows = listProjectCatalog(db, T0)
        expect(rows.find(function mine(r) { return r.id === PROJECT_ID })?.scanState).toEqual({
            state: 'cannot_scan',
            reasons: [
                { source: 'npm-audit', ecosystem: null, reasonCode: 'no_lockfile', side: 'project' },
                { source: null, ecosystem: 'npm', reasonCode: 'no_lockfile', side: 'project' }
            ]
        })
        expect(rows.find(function other(r) { return r.id === OTHER_PROJECT_ID })?.scanState).toEqual({ state: 'not_scanned_yet', reasons: [] })
    })

    it('counts the projects that cannot be scanned, and cannot be fully scanned, leaving project-muted ones out', function () {
        addProject('partial-project')
        addProject('muted-project')
        enable('osv')
        failed('npm-audit', T0, 'no_lockfile', { rawJson: JSON.stringify({ coverage: [{ ecosystem: 'npm', status: 'unauditable', reasonCode: 'no_lockfile' }] }) })
        ok('npm-audit', T0, { projectId: 'partial-project', coverage: [{ ecosystem: 'npm', status: 'ok' }] })
        failed('npm-audit', T0, 'no_lockfile', { projectId: 'muted-project' })
        insertMute(db, { id: 'mute-1', scope: 'project', projectId: 'muted-project', scanner: null, ecosystem: null, advisoryId: null, packageName: null, reason: 'retired', author: 'betty', createdAt: T0, expiresAt: null })
        const summary = getDashboardSummary(db, T0)
        expect(summary.projectsCannotBeScanned).toBe(1)
        expect(summary.projectsCannotBeFullyScanned).toBe(1)
        const given = new Map(listProjectCatalog(db, T0).map(function stateOf(r) { return [r.id, r.scanState] }))
        expect(getDashboardSummary(db, T0, 'all', given)).toEqual(summary)
    })
})

describe('scan state — not re-checked findings', function () {
    it('has no context for a source that never scanned the project', function () {
        expect(findingScanContexts(db, [PROJECT_ID])(PROJECT_ID, 'npm-audit')).toBeNull()
        expect(findingScanContexts(db, [PROJECT_ID])('nope', 'npm-audit')).toBeNull()
    })

    it('gives the source latest scan, its last ok scan and the project state', function () {
        ok('npm-audit', T0)
        failed('npm-audit', T0 + HOUR)
        const lookup = findingScanContexts(db, [PROJECT_ID])
        const expected = { latestStatus: 'unauditable', latestReasonCode: 'no_lockfile', lastOkScanAt: T0, projectState: 'cannot_scan' }
        expect(lookup(PROJECT_ID, 'npm-audit')).toEqual(expected)
        // The project state is computed once and reused for the project's other rows.
        expect(lookup(PROJECT_ID, 'npm-audit')).toEqual(expected)
    })

    it('marks both a settled and a legacy row retained after a failed scan', function () {
        const first = ok('npm-audit', T0)
        finding('settled', first.id, true)
        finding('legacy', first.id, false)
        failed('npm-audit', T0 + HOUR)
        const rows = listCurrentFindingsForProject(db, PROJECT_ID, T0 + 2 * HOUR)
        const byId = new Map(rows.map(function r(row) { return [row.id, row] }))
        const annotation = { reasonCode: 'no_lockfile', side: 'project', projectState: 'cannot_scan', lastOkScanAt: T0 }
        expect(byId.get('settled')).toMatchObject({ fixStatus: 'released', fixVersion: '4.17.21', notRecheckedBecause: annotation })
        expect(byId.get('legacy')).toMatchObject({ fixStatus: 'unverified', fixCheck: null, notRecheckedBecause: annotation })
    })

    it('marks nothing once the source scans successfully again', function () {
        const first = ok('npm-audit', T0)
        finding('settled', first.id, true)
        failed('npm-audit', T0 + HOUR)
        ok('npm-audit', T0 + 2 * HOUR)
        expect(listCurrentFindingsForProject(db, PROJECT_ID, T0 + 3 * HOUR)[0]?.notRecheckedBecause).toBeNull()
    })

    it('marks a row whose source never scanned the project successfully', function () {
        const first = failed('npm-audit', T0)
        finding('legacy', first.id, false)
        expect(listCurrentFindingsForProject(db, PROJECT_ID, T0 + HOUR)[0]?.notRecheckedBecause).toMatchObject({ lastOkScanAt: null })
    })

    it('marks the retained rows a library page lists, per project', function () {
        const mine = ok('npm-audit', T0)
        finding('mine', mine.id, true)
        failed('npm-audit', T0 + HOUR)
        const theirs = ok('npm-audit', T0, { projectId: OTHER_PROJECT_ID })
        finding('theirs', theirs.id, true, { projectId: OTHER_PROJECT_ID })
        const usage = listLibraryUsage(db, 'lodash', T0 + 2 * HOUR)
        const byProject = new Map(usage.map(function u(row) { return [row.projectId, row] }))
        expect(byProject.get(PROJECT_ID)?.notRecheckedBecause).toMatchObject({ reasonCode: 'no_lockfile', projectState: 'cannot_scan' })
        expect(byProject.get(OTHER_PROJECT_ID)?.notRecheckedBecause).toBeNull()
    })
})

// Retention keeps the newest 100 scans per project. A source switched off for a while is out-scanned by the
// others; its latest failure must survive anyway, or the state would read its older ok as current.
describe('scan state — retention', function () {
    it('reads the same state and recheck context after pruning, with no successful recheck', function () {
        enable('osv')
        const osvOk = ok('osv', T0, { coverage: [{ ecosystem: 'npm', status: 'ok' }] })
        finding('osv-row', osvOk.id, true, { source: 'osv' })
        const osvFailed = failed('osv', T0 + HOUR, 'osv_db_unavailable', { status: 'error', rawJson: JSON.stringify({ coverage: [{ ecosystem: 'npm', status: 'ok' }] }) })
        const audits: Scan[] = []
        for (let n = 0; n < 101; n++) audits.push(ok('npm-audit', T0 + (2 + n) * HOUR, { coverage: [{ ecosystem: 'npm', status: 'ok' }] }))
        const at = T0 + 200 * HOUR
        function read(): unknown {
            return {
                state: getProjectScanState(db, PROJECT_ID),
                context: findingScanContexts(db, [PROJECT_ID])(PROJECT_ID, 'osv'),
                annotation: listCurrentFindingsForProject(db, PROJECT_ID, at).find(function osv(row) { return row.id === 'osv-row' })?.notRecheckedBecause
            }
        }
        const before = read()
        expect(before).toEqual({
            state: { state: 'partial', reasons: [{ source: 'osv', ecosystem: null, reasonCode: 'osv_db_unavailable', side: 'environment' }] },
            context: { latestStatus: 'error', latestReasonCode: 'osv_db_unavailable', lastOkScanAt: T0, projectState: 'partial' },
            annotation: { reasonCode: 'osv_db_unavailable', side: 'environment', projectState: 'partial', lastOkScanAt: T0 }
        })
        const prunable = listPrunableScanIds(db, at, 100, 1000)
        // Only the oldest npm-audit scan falls outside the newest 100; the OSV failure is OSV's latest scan.
        expect(prunable).toEqual([audits[0]?.id])
        expect(prunable).not.toContain(osvFailed.id)
        deleteScansByIds(db, prunable)
        expect(read()).toEqual(before)
    })
})
