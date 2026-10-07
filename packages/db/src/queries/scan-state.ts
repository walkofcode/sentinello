import { sql, type SQL } from 'drizzle-orm'
import {
    DEFAULT_ECOSYSTEM,
    SOURCE_IDS,
    projectScanState,
    type FindingScanContext,
    type ScanState,
    type ScanStateInputs,
    type SourceCell
} from '@sentinello/core'
import type { DrizzleDb } from '../client'
import { parseEcosystems } from './projects'
import { getActiveSourceCells, getRunnableSourceCells } from './sources'

// A project's scan state, read in one place for every server-side caller — the project page, the projects
// list, the dashboard and MCP — so they cannot disagree about whether a project was scanned.

// A source's latest scan of a project, with the last time that source scanned it successfully.
export type LatestSourceScanRow = {
    id: string
    projectId: string
    // COALESCE(source, scanner): legacy rows carry only the plugin name.
    source: string
    ecosystem: string
    finishedAt: number
    status: string
    reasonCode: string | null
    errorText: string | null
    rawJson: string
    // Null when the source never scanned the project successfully.
    lastOkScanAt: number | null
}

// Display order (npm audit -> OSV -> gemnasium), derived from SOURCE_IDS so it cannot drift from the
// registry's dedup-priority order. An unknown/legacy source value sorts after all of them; the
// caller's second ORDER BY term makes that group alphabetical. Source ids are fixed registry
// constants, never user input, so the inlined literals carry no injection risk — same reasoning as
// activeSourceCellClause.
// A scan's source identity, COALESCE(source, scanner) — a legacy row is read by its scanner name. Spelled
// exactly as scans_latest_source_idx spells it (schema.ts says why it is a CASE), because SQLite uses an
// expression index only for a query that repeats its expression.
function scanSourceSql(alias: string): SQL {
    return sql.raw('(CASE WHEN ' + alias + '.source IS NULL THEN ' + alias + '.scanner ELSE ' + alias + '.source END)')
}

function sourceRankSql(expr: string): SQL {
    const whens = SOURCE_IDS.map(function when(id, index) {
        return "WHEN '" + id + "' THEN " + index
    }).join(' ')
    return sql.raw('CASE ' + expr + ' ' + whens + ' ELSE ' + SOURCE_IDS.length + ' END')
}

// Latest scan per (project, source), for one project or all of them, in source display order.
//
// One row per source, deliberately. A sweep writes one scans row PER SOURCE and they finish
// milliseconds apart, so "the project's latest scan" was whichever source finished last. Reading that
// as the project's verdict discarded npm audit's answer silently: on a real instance every project
// reported "OSV database not downloaded yet" while npm audit had scanned fine and produced findings.
// Sources disagree; the row has to carry all of them.
//
// Every lookup runs inside scans_latest_source_idx, which carries (project, source, finished_at, id,
// status): the (project, source) pairs come off it, and each pair's newest scan and newest ok scan are a
// seek into it. Only the winning rows are read from the table, joined back by id for their remaining
// columns. A window over the table instead (ROW_NUMBER partitioned by project and source) read source for
// every row — and source sits after raw_json, so that walked every row's raw_json: ~1.1 s of every
// home-page render on a real 109k-row table, against ~0.05 s for this.
//
// Retention never prunes a source's latest scan of a project (listPrunableScanIds), so a source drops out
// of this map only when it never scanned the project — which is why an absent source reads as "has not
// run", never as "is fine".
//
// Not filtered to the active source cells: callers that show sources filter (activeScanRows), and the
// scan state counts only expected sources, which are runnable cells by construction.
export function listLatestSourceScans(db: DrizzleDb, projectIds: readonly string[] | null = null): LatestSourceScanRow[] {
    if (projectIds !== null && projectIds.length === 0) return []
    const projectFilter = projectIds === null ? sql`` : sql`WHERE s.project_id IN (${sql.join(projectIds.map(function id(p) { return sql`${p}` }), sql`, `)})`
    const xSource = scanSourceSql('x')
    const rows = db.all<{
        id: string
        project_id: string
        source: string
        ecosystem: string
        finished_at: number
        status: string
        reason_code: string | null
        error_text: string | null
        raw_json: string
        last_ok_scan_at: number | null
    }>(sql`
        WITH pairs AS (
            SELECT DISTINCT s.project_id AS project_id, ${scanSourceSql('s')} AS source
            FROM scans s
            ${projectFilter}
        ),
        latest AS (
            SELECT p.project_id AS project_id,
                   p.source AS source,
                   -- id DESC breaks a finished_at tie deterministically: scan ids are ULIDs, so the
                   -- higher id is the later write.
                   (SELECT x.id FROM scans x
                     WHERE x.project_id = p.project_id AND ${xSource} = p.source
                     ORDER BY x.finished_at DESC, x.id DESC
                     LIMIT 1) AS id,
                   (SELECT MAX(x.finished_at) FROM scans x
                     WHERE x.project_id = p.project_id AND ${xSource} = p.source
                       AND x.status = 'ok') AS last_ok_scan_at
            FROM pairs p
        )
        SELECT l.id AS id,
               l.project_id AS project_id,
               l.source AS source,
               s2.ecosystem AS ecosystem,
               s2.finished_at AS finished_at,
               s2.status AS status,
               s2.reason_code AS reason_code,
               s2.error_text AS error_text,
               s2.raw_json AS raw_json,
               l.last_ok_scan_at AS last_ok_scan_at
        FROM latest l
        INNER JOIN scans s2 ON s2.id = l.id
        ORDER BY ${sourceRankSql('l.source')}, l.source
    `)
    return rows.map(function toRow(row): LatestSourceScanRow {
        return {
            id: row.id,
            projectId: row.project_id,
            source: row.source,
            ecosystem: row.ecosystem,
            finishedAt: row.finished_at,
            status: row.status,
            reasonCode: row.reason_code,
            errorText: row.error_text,
            rawJson: row.raw_json,
            lastOkScanAt: row.last_ok_scan_at
        }
    })
}

// The rows whose (source, ecosystem) cell is still active: a source the operator has since switched off
// leaves its scan rows behind, and they must not badge. Same cells activeSourceCellClause matches.
export function activeScanRows(db: DrizzleDb, rows: readonly LatestSourceScanRow[]): LatestSourceScanRow[] {
    const cells = getActiveSourceCells(db)
    return rows.filter(function active(row) {
        return cells.some(function matches(cell) {
            return cell.source === row.source && cell.ecosystem === row.ecosystem
        })
    })
}

// Per-ecosystem resolver coverage, as one scan recorded it in its rawJson. It is how the UI/API say "this
// Python scan was partial/unauditable" instead of reading a coverage gap as a clean bill of health.
export type EcosystemCoverageRow = {
    ecosystem: string
    status: 'ok' | 'partial' | 'unauditable'
    reasonCode: string | null
    details: string[]
}

// Null when the summary is not JSON or carries no coverage array: that scan says nothing about coverage.
// Unexpected entries are skipped rather than guessed at.
function coverageOf(rawJson: string): EcosystemCoverageRow[] | null {
    let parsed: unknown
    try {
        parsed = JSON.parse(rawJson)
    } catch {
        return null
    }
    const coverage = parsed !== null && typeof parsed === 'object' ? (parsed as { coverage?: unknown }).coverage : undefined
    if (!Array.isArray(coverage)) return null
    const out: EcosystemCoverageRow[] = []
    for (const entry of coverage) {
        if (!entry || typeof entry.ecosystem !== 'string') continue
        if (out.some(function seen(c) { return c.ecosystem === entry.ecosystem })) continue
        const status = entry.status === 'partial' || entry.status === 'unauditable' ? entry.status : 'ok'
        out.push({
            ecosystem: entry.ecosystem,
            status,
            reasonCode: typeof entry.reasonCode === 'string' ? entry.reasonCode : null,
            details: Array.isArray(entry.details) ? entry.details.filter(function isStr(d: unknown): d is string { return typeof d === 'string' }) : []
        })
    }
    return out
}

// The coverage of the project's LATEST scan: every scan row records the whole project's coverage (the
// runner writes it whatever the source and however the scan ended — a raw diagnostic is kept beside it, not
// instead of it), so the newest of the sources' latest rows is the project as its last scan saw it. Null
// when that row carries none — a row written before every scan recorded coverage, or one the runner could
// not resolve (a project whose root is gone): coverage is then unknown. Never borrowed from an older row of
// another source: it may predate the project's current state by any number of sweeps, or come from a source
// switched off since — a project that loses its lockfile must stop showing the "ok" an earlier scan recorded.
function latestCoverage(rows: readonly LatestSourceScanRow[]): EcosystemCoverageRow[] | null {
    let newest: LatestSourceScanRow | null = null
    for (const row of rows) {
        // Scan ids are ULIDs (uppercase Crockford base32), so on a tie the later write wins.
        if (newest === null || row.finishedAt > newest.finishedAt || row.finishedAt === newest.finishedAt && row.id > newest.id) newest = row
    }
    return newest === null ? null : coverageOf(newest.rawJson)
}

// The coverage list the project page and MCP get_project show. Unknown coverage lists nothing; whether the
// project could be fully read is the scan state's to say (getProjectScanState), which never reads unknown
// coverage as complete.
export function getProjectEcosystemCoverage(db: DrizzleDb, projectId: string): EcosystemCoverageRow[] {
    return latestCoverage(listLatestSourceScans(db, [projectId])) ?? []
}

// The ecosystems discovery detected in a project: what its coverage must answer for. A project row written
// before discovery recorded ecosystems carries none; it is read as npm, the only ecosystem such a row can
// have come from.
function detectedEcosystemsOf(ecosystems: readonly string[]): readonly string[] {
    return ecosystems.length > 0 ? ecosystems : [DEFAULT_ECOSYSTEM]
}

// The sources a project should have heard from: its runnable cells (enabled, stable ecosystem) restricted
// to the ecosystems detected in it.
function expectedSourcesFor(detected: readonly string[], runnable: readonly SourceCell[]): string[] {
    return SOURCE_IDS.filter(function expected(source) {
        return runnable.some(function cell(c) { return c.source === source && detected.includes(c.ecosystem) })
    })
}

type ProjectScanInputs = {
    inputs: ScanStateInputs
    latestBySource: Map<string, LatestSourceScanRow>
}

// `latest` is listLatestSourceScans(db, projectIds), when the caller has already read it for its own use:
// the read is the expensive part of the scan state, and the projects list needs it twice otherwise.
function readScanInputs(db: DrizzleDb, projectIds: readonly string[] | null, latest: readonly LatestSourceScanRow[] | null = null): Map<string, ProjectScanInputs> {
    const out = new Map<string, ProjectScanInputs>()
    if (projectIds !== null && projectIds.length === 0) return out
    const runnable = getRunnableSourceCells(db)
    const projectFilter = projectIds === null ? sql`` : sql`WHERE p.id IN (${sql.join(projectIds.map(function id(p) { return sql`${p}` }), sql`, `)})`
    const projects = db.all<{ id: string; ecosystems_json: string }>(sql`SELECT p.id AS id, p.ecosystems_json AS ecosystems_json FROM projects p ${projectFilter}`)
    const rowsByProject = new Map<string, LatestSourceScanRow[]>()
    for (const row of latest ?? listLatestSourceScans(db, projectIds)) {
        const list = rowsByProject.get(row.projectId) ?? []
        list.push(row)
        rowsByProject.set(row.projectId, list)
    }
    for (const project of projects) {
        const rows = rowsByProject.get(project.id) ?? []
        const latestBySource = new Map<string, LatestSourceScanRow>()
        for (const row of rows) latestBySource.set(row.source, row)
        const detected = detectedEcosystemsOf(parseEcosystems(project.ecosystems_json))
        const coverage = latestCoverage(rows)
        out.set(project.id, {
            inputs: {
                expectedSources: expectedSourcesFor(detected, runnable),
                latestScans: rows.map(function latest(row) {
                    return { source: row.source, status: row.status, reasonCode: row.reasonCode, finishedAt: row.finishedAt }
                }),
                detectedEcosystems: detected,
                coverage: coverage === null ? null : coverage.map(function cov(c) {
                    return { ecosystem: c.ecosystem, status: c.status, reasonCode: c.reasonCode }
                })
            },
            latestBySource
        })
    }
    return out
}

// The one normalizer: { expectedSources, latestScans, detectedEcosystems, coverage } per project, for one project or all.
export function expectedScanInputs(db: DrizzleDb, projectIds: readonly string[] | null = null): Map<string, ScanStateInputs> {
    const out = new Map<string, ScanStateInputs>()
    for (const [id, read] of readScanInputs(db, projectIds)) out.set(id, read.inputs)
    return out
}

// Every project's scan state. `latest` is the fleet-wide listLatestSourceScans(db), when the caller read it
// already.
export function listProjectScanStates(db: DrizzleDb, latest: readonly LatestSourceScanRow[] | null = null): Map<string, ScanState> {
    const out = new Map<string, ScanState>()
    for (const [id, read] of readScanInputs(db, null, latest)) out.set(id, projectScanState(read.inputs))
    return out
}

// The scan states of the named projects only — the ones an export covers. A project id that does not exist
// is absent from the map.
export function listScanStatesForProjects(db: DrizzleDb, projectIds: readonly string[]): Map<string, ScanState> {
    const out = new Map<string, ScanState>()
    for (const [id, read] of readScanInputs(db, projectIds)) out.set(id, projectScanState(read.inputs))
    return out
}

// The scan state of one project; `not_scanned_yet` for a project id that does not exist.
export function getProjectScanState(db: DrizzleDb, projectId: string): ScanState {
    const inputs = expectedScanInputs(db, [projectId]).get(projectId)
    return inputs ? projectScanState(inputs) : { state: 'not_scanned_yet', reasons: [] }
}

// For the findings queries: what each row's source last did on the row's project, and the project's state,
// so readFixFields can say a retained row was not re-checked. Null for a source with no scan of the project.
export type FindingScanContextLookup = (projectId: string, source: string) => FindingScanContext | null

// Read for the named projects only: a library page lists rows from a handful of projects, and a fleet-wide
// read costs a pass over every scan.
export function findingScanContexts(db: DrizzleDb, projectIds: readonly string[]): FindingScanContextLookup {
    const read = readScanInputs(db, projectIds)
    const states = new Map<string, ScanState>()
    return function lookup(id, source) {
        const project = read.get(id)
        const latest = project?.latestBySource.get(source)
        if (!project || !latest) return null
        let state = states.get(id)
        if (!state) {
            state = projectScanState(project.inputs)
            states.set(id, state)
        }
        return { latestStatus: latest.status, latestReasonCode: latest.reasonCode, lastOkScanAt: latest.lastOkScanAt, projectState: state.state }
    }
}
