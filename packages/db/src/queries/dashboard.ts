import { sql } from 'drizzle-orm'
import { SCAN_HEARTBEAT_STALE_MS, type DepTypeFilter } from '@sentinello/core'
import type { DrizzleDb } from '../client'
import { depTypeClause } from './dep-type'
import { activeSourceCellClause } from './sources'
import { advisoryIdentitySql, severityRankSql, findingMuteExclusionSql } from './advisory-identity'

// Aggregate queries that power the Dashboard. Each is a single SQL statement returning a small
// fixed-shape row so the dashboard renders with one DB hit per tile (no N+1).

export type SeverityCounts = {
    critical: number
    high: number
    moderate: number
    low: number
    info: number
}

export type DashboardSummary = {
    totalActiveProjects: number
    projectsWithFindings: number
    severityCounts: SeverityCounts
    findingsLast24h: number
    lastScanFinishedAt: number | null
}

const DAY_MS = 24 * 60 * 60 * 1000

export function getDashboardSummary(db: DrizzleDb, at: number, depType: DepTypeFilter = 'all'): DashboardSummary {
    const depFilter = depTypeClause(depType)
    const sourceFilter = activeSourceCellClause(db)
    const total = db
        .get<{ n: number }>(sql`
            SELECT COUNT(*) AS n
            FROM projects
        `)
    const withFindings = db
        .get<{ n: number }>(sql`
            SELECT COUNT(DISTINCT p.id) AS n
            FROM projects p
            INNER JOIN findings f ON f.project_id = p.id
            WHERE f.resolved_at IS NULL
              ${depFilter}
              ${sourceFilter}
              AND NOT EXISTS (
                SELECT 1 FROM mutes m
                WHERE (m.expires_at IS NULL OR m.expires_at > ${at})
                  AND (
                    (m.scope = 'project' AND m.project_id = p.id)
                    OR (
                      m.scope = 'finding'
                      AND (m.project_id IS NULL OR m.project_id = p.id)
                      AND m.scanner = COALESCE(f.source, f.scanner)
                      AND (m.ecosystem IS NULL OR m.ecosystem = f.ecosystem)
                      AND m.advisory_id = f.advisory_id
                      AND m.package_name = f.package_name
                    )
                  )
              )
        `)
    const sevRow = db
        .get<{
            critical: number
            high: number
            moderate: number
            low: number
            info: number
        }>(sql`
            WITH deduped AS (
                SELECT MAX(${severityRankSql('f')}) AS sev_rank
                FROM findings f
                WHERE f.resolved_at IS NULL
                  ${depFilter}
                  ${sourceFilter}
                  ${findingMuteExclusionSql(at, 'f')}
                GROUP BY f.project_id, f.ecosystem, f.package_name, ${advisoryIdentitySql('f')}
            )
            SELECT
                SUM(CASE WHEN sev_rank = 5 THEN 1 ELSE 0 END) AS critical,
                SUM(CASE WHEN sev_rank = 4 THEN 1 ELSE 0 END) AS high,
                SUM(CASE WHEN sev_rank = 3 THEN 1 ELSE 0 END) AS moderate,
                SUM(CASE WHEN sev_rank = 2 THEN 1 ELSE 0 END) AS low,
                SUM(CASE WHEN sev_rank = 1 THEN 1 ELSE 0 END) AS info
            FROM deduped
        `)
    const cutoff = at - DAY_MS
    const last24 = db
        .get<{ n: number }>(sql`
            SELECT COUNT(*) AS n
            FROM notification_events e
            WHERE e.event_type = 'finding'
              AND e.first_seen_at >= ${cutoff}
              AND NOT EXISTS (
                SELECT 1 FROM mutes m
                WHERE (m.expires_at IS NULL OR m.expires_at > ${at})
                  AND (
                    (m.scope = 'project' AND m.project_id = e.project_id)
                    OR (
                      m.scope = 'finding'
                      AND (m.project_id IS NULL OR m.project_id = e.project_id)
                      AND m.scanner = e.scanner
                      AND (m.ecosystem IS NULL OR m.ecosystem = e.ecosystem)
                      AND m.advisory_id = e.advisory_id
                      AND m.package_name = e.package_name
                    )
                  )
              )
        `)
    // While a user-triggered scan is in flight, individual project scans complete one-by-one and
    // each updates MAX(scans.finished_at), so "Last scan" would tick during the sweep. Freeze it
    // at the most recent scan that finished BEFORE the earliest in-flight request was queued.
    // No in-flight request → normal MAX. Scheduled (non-request) sweeps are not frozen because
    // they don't write to scan_requests; that's intentional — the user isn't actively waiting.
    const freshAfter = at - SCAN_HEARTBEAT_STALE_MS
    const inFlightCutoff = db
        .get<{ at: number | null }>(sql`
            SELECT MIN(requested_at) AS at FROM scan_requests
            WHERE status = 'pending'
               OR (status = 'running' AND heartbeat_at >= ${freshAfter})
        `)
    const cutoffAt = inFlightCutoff?.at || null
    let lastScan: { finished_at: number | null } | undefined
    if (cutoffAt === null) {
        lastScan = db.get<{ finished_at: number | null }>(sql`SELECT MAX(s.finished_at) AS finished_at FROM scans s`)
    } else {
        lastScan = db.get<{ finished_at: number | null }>(sql`SELECT MAX(s.finished_at) AS finished_at FROM scans s WHERE s.finished_at < ${cutoffAt}`)
    }
    return {
        totalActiveProjects: total?.n || 0,
        projectsWithFindings: withFindings?.n || 0,
        severityCounts: {
            critical: sevRow?.critical || 0,
            high: sevRow?.high || 0,
            moderate: sevRow?.moderate || 0,
            low: sevRow?.low || 0,
            info: sevRow?.info || 0
        },
        findingsLast24h: last24?.n || 0,
        lastScanFinishedAt: lastScan?.finished_at || null
    }
}

export type ProjectCatalogRow = {
    id: string
    name: string
    alias: string | null
    rootLabel: string | null
    rootPath: string
    packageManager: string
    nvmrcVersion: string | null
    muted: boolean
    tagsJson: string
    lastScanFinishedAt: number | null
    lastScanStatus: string | null
    lastScanReasonCode: string | null
    lastScanErrorText: string | null
    severityCounts: SeverityCounts
}

export function listProjectCatalog(db: DrizzleDb, at: number, depType: DepTypeFilter = 'all'): ProjectCatalogRow[] {
    const depFilter = depTypeClause(depType)
    const sourceFilter = activeSourceCellClause(db)
    const rows = db.all<{
        id: string
        name: string
        alias: string | null
        root_label: string | null
        root_path: string
        package_manager: string
        nvmrc_version: string | null
        muted: number
        tags_json: string
        last_scan_finished_at: number | null
        last_scan_status: string | null
        last_scan_reason_code: string | null
        last_scan_error_text: string | null
        critical: number
        high: number
        moderate: number
        low: number
        info: number
    }>(sql`
        WITH latest_scan AS (
            SELECT s.project_id,
                   s.id AS scan_id,
                   s.finished_at,
                   s.status,
                   s.reason_code,
                   s.error_text
            FROM scans s
            WHERE s.id = (
                SELECT s2.id FROM scans s2
                WHERE s2.project_id = s.project_id
                ORDER BY s2.finished_at DESC
                LIMIT 1
            )
        ),
        deduped AS (
            SELECT f.project_id AS project_id, MAX(${severityRankSql('f')}) AS sev_rank
            FROM findings f
            WHERE f.resolved_at IS NULL
              ${depFilter}
              ${sourceFilter}
              ${findingMuteExclusionSql(at, 'f')}
            GROUP BY f.project_id, f.ecosystem, f.package_name, ${advisoryIdentitySql('f')}
        ),
        project_sev AS (
            SELECT project_id,
                SUM(CASE WHEN sev_rank = 5 THEN 1 ELSE 0 END) AS critical,
                SUM(CASE WHEN sev_rank = 4 THEN 1 ELSE 0 END) AS high,
                SUM(CASE WHEN sev_rank = 3 THEN 1 ELSE 0 END) AS moderate,
                SUM(CASE WHEN sev_rank = 2 THEN 1 ELSE 0 END) AS low,
                SUM(CASE WHEN sev_rank = 1 THEN 1 ELSE 0 END) AS info
            FROM deduped
            GROUP BY project_id
        )
        SELECT
            p.id AS id,
            p.name AS name,
            p.alias AS alias,
            r.label AS root_label,
            r.path AS root_path,
            p.package_manager AS package_manager,
            p.nvmrc_version AS nvmrc_version,
            -- Compute project-scope muted state from the mutes table (with expiry semantics) so the
            -- portal's muteAction (which writes to mutes) is the single source of truth. The legacy
            -- projects.muted column is intentionally ignored here.
            (CASE WHEN EXISTS (
                SELECT 1 FROM mutes m
                WHERE m.scope = 'project'
                  AND m.project_id = p.id
                  AND (m.expires_at IS NULL OR m.expires_at > ${at})
            ) THEN 1 ELSE 0 END) AS muted,
            p.tags_json AS tags_json,
            ls.finished_at AS last_scan_finished_at,
            ls.status AS last_scan_status,
            ls.reason_code AS last_scan_reason_code,
            ls.error_text AS last_scan_error_text,
            COALESCE(ps.critical, 0) AS critical,
            COALESCE(ps.high, 0) AS high,
            COALESCE(ps.moderate, 0) AS moderate,
            COALESCE(ps.low, 0) AS low,
            COALESCE(ps.info, 0) AS info
        FROM projects p
        INNER JOIN roots r ON r.id = p.root_id
        LEFT JOIN latest_scan ls ON ls.project_id = p.id
        LEFT JOIN project_sev ps ON ps.project_id = p.id
        ORDER BY p.name ASC
    `)
    return rows.map(function toRow(row): ProjectCatalogRow {
        return {
            id: row.id,
            name: row.name,
            alias: row.alias,
            rootLabel: row.root_label,
            rootPath: row.root_path,
            packageManager: row.package_manager,
            nvmrcVersion: row.nvmrc_version,
            muted: row.muted === 1,
            tagsJson: row.tags_json,
            lastScanFinishedAt: row.last_scan_finished_at,
            lastScanStatus: row.last_scan_status,
            lastScanReasonCode: row.last_scan_reason_code,
            lastScanErrorText: row.last_scan_error_text,
            severityCounts: {
                critical: row.critical,
                high: row.high,
                moderate: row.moderate,
                low: row.low,
                info: row.info
            }
        }
    })
}

export type CurrentFindingRow = {
    id: string
    scanId: string
    projectId: string
    scanner: string
    source: string
    ecosystem: string
    advisoryId: string
    advisoryTitle: string | null
    advisoryUrl: string | null
    packageName: string
    installedVersion: string
    vulnerableRange: string
    severity: string
    fixAvailable: boolean
    fixVersion: string | null
    depPathJson: string
    isMuted: boolean
    isProd: boolean
    isDev: boolean
    firstDetectedAt: number | null
    lastSeenAt: number | null
}

export function listCurrentFindingsForProject(
    db: DrizzleDb,
    projectId: string,
    at: number,
    depType: DepTypeFilter = 'all'
): CurrentFindingRow[] {
    const depFilter = depTypeClause(depType)
    const sourceFilter = activeSourceCellClause(db)
    const rows = db.all<{
        id: string
        scan_id: string
        project_id: string
        scanner: string
        source: string | null
        ecosystem: string | null
        advisory_id: string
        advisory_title: string | null
        advisory_url: string | null
        package_name: string
        installed_version: string
        vulnerable_range: string
        severity: string
        fix_available: number
        fix_version: string | null
        dep_path_json: string
        muted: number | null
        is_prod: number
        is_dev: number
        first_detected_at: number | null
        last_seen_at: number | null
    }>(sql`
        SELECT
            f.id, f.scan_id, f.project_id, f.scanner, f.source, f.ecosystem, f.advisory_id, f.advisory_title, f.advisory_url,
            f.package_name, f.installed_version, f.vulnerable_range, f.severity, f.fix_available,
            f.fix_version, f.dep_path_json, f.is_prod, f.is_dev,
            f.first_detected_at, f.last_seen_at,
            (SELECT 1 FROM mutes m
                WHERE (m.expires_at IS NULL OR m.expires_at > ${at})
                  AND (
                    (m.scope = 'project' AND m.project_id = f.project_id)
                    OR (
                      m.scope = 'finding'
                      AND (m.project_id IS NULL OR m.project_id = f.project_id)
                      AND m.scanner = COALESCE(f.source, f.scanner)
                      AND (m.ecosystem IS NULL OR m.ecosystem = f.ecosystem)
                      AND m.advisory_id = f.advisory_id
                      AND m.package_name = f.package_name
                    )
                  )
                LIMIT 1
            ) AS muted
        FROM findings f
        WHERE f.project_id = ${projectId}
          AND f.resolved_at IS NULL
          ${depFilter}
          ${sourceFilter}
        ORDER BY
            CASE f.severity
                WHEN 'critical' THEN 0
                WHEN 'high' THEN 1
                WHEN 'moderate' THEN 2
                WHEN 'low' THEN 3
                ELSE 4
            END,
            f.package_name ASC
    `)
    return rows.map(function toRow(row): CurrentFindingRow {
        return {
            id: row.id,
            scanId: row.scan_id,
            projectId: row.project_id,
            scanner: row.scanner,
            source: row.source ?? row.scanner,
            ecosystem: row.ecosystem ?? 'npm',
            advisoryId: row.advisory_id,
            advisoryTitle: row.advisory_title,
            advisoryUrl: row.advisory_url,
            packageName: row.package_name,
            installedVersion: row.installed_version,
            vulnerableRange: row.vulnerable_range,
            severity: row.severity,
            fixAvailable: row.fix_available === 1,
            fixVersion: row.fix_version,
            depPathJson: row.dep_path_json,
            isMuted: row.muted === 1,
            isProd: row.is_prod === 1,
            isDev: row.is_dev === 1,
            firstDetectedAt: row.first_detected_at,
            lastSeenAt: row.last_seen_at
        }
    })
}

export type VulnTrendPoint = {
    scanFinishedAt: number
    findingCount: number
}

export function listVulnTrendForProject(db: DrizzleDb, projectId: string, limit = 30): VulnTrendPoint[] {
    // Under the lifecycle model the trend is "how many findings were open as of each scan."
    // A finding row counts toward a scan if it was first detected at or before the scan's
    // finished_at and was either still open at that time or resolved strictly after it.
    const rows = db.all<{ finished_at: number; finding_count: number }>(sql`
        SELECT s.finished_at AS finished_at,
               (SELECT COUNT(*)
                FROM findings f
                WHERE f.project_id = s.project_id
                  AND f.first_detected_at IS NOT NULL
                  AND f.first_detected_at <= s.finished_at
                  AND (f.resolved_at IS NULL OR f.resolved_at > s.finished_at)
               ) AS finding_count
        FROM scans s
        WHERE s.project_id = ${projectId} AND s.status = 'ok'
        ORDER BY s.finished_at DESC
        LIMIT ${limit}
    `)
    return rows.map(function toPoint(row): VulnTrendPoint {
        return { scanFinishedAt: row.finished_at, findingCount: row.finding_count }
    }).reverse()
}
