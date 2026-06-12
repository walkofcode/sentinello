import { sql } from 'drizzle-orm'
import type { DepTypeFilter } from '@sentinello/core'
import type { DrizzleDb } from '../client'
import { depTypeClause } from './dep-type'
import { activeSourceCellClause } from './sources'
import { advisoryIdentitySql } from './advisory-identity'

// The library pivot is a SQL aggregation over findings, restricted to the same blast-radius the
// rest of the portal honors: open lifecycle episodes only (resolved_at IS NULL), no missing
// projects, no findings silenced by an active mute (project-scope or matching finding-scope, with
// expires_at semantics). Without these restrictions the pivot would show a vulnerability that has
// been fixed in a subsequent scan, muted by the operator, or belongs to a missing project — the
// opposite of what the operator needs from a triage view.

export type LibrarySummary = {
    // A library is identified by (ecosystem, packageName) — the same package name can exist in npm and
    // PyPI as two unrelated libraries, so the aggregation groups and the UI keys/links by both.
    ecosystem: string
    packageName: string
    distinctAdvisories: number
    distinctProjects: number
    severities: string[]
}

export type LibraryProjectUsage = {
    projectId: string
    projectName: string
    scanner: string
    // Persisted source identity (finding.source) + ecosystem, with the same legacy fallbacks as
    // CurrentFindingRow. Used to create mutes with the durable (source, ecosystem) identity — `scanner`
    // stays provenance-only. See issue-016.
    source: string
    ecosystem: string
    installedVersion: string
    vulnerableRange: string
    advisoryId: string
    advisoryTitle: string | null
    advisoryUrl: string | null
    severity: string
    isProd: boolean
    isDev: boolean
    firstDetectedAt: number | null
    lastSeenAt: number | null
}

export function listLibraries(db: DrizzleDb, at: number, depType: DepTypeFilter = 'all'): LibrarySummary[] {
    const depFilter = depTypeClause(depType)
    const sourceFilter = activeSourceCellClause(db)
    const rows = db
        .all<{
            ecosystem: string | null
            package_name: string
            distinct_advisories: number
            distinct_projects: number
            severities: string
        }>(
            sql`
            SELECT
                COALESCE(f.ecosystem, 'npm') AS ecosystem,
                f.package_name AS package_name,
                COUNT(DISTINCT ${advisoryIdentitySql('f')}) AS distinct_advisories,
                COUNT(DISTINCT f.project_id) AS distinct_projects,
                GROUP_CONCAT(DISTINCT f.severity) AS severities
            FROM findings f
            INNER JOIN projects p ON p.id = f.project_id
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
            GROUP BY f.ecosystem, f.package_name
            ORDER BY distinct_projects DESC, package_name ASC
        `
        )
    return rows.map(function toSummary(row) {
        return {
            ecosystem: row.ecosystem ?? 'npm',
            packageName: row.package_name,
            distinctAdvisories: row.distinct_advisories,
            distinctProjects: row.distinct_projects,
            severities: (row.severities || '').split(',').filter(Boolean)
        }
    })
}

export function listLibraryUsage(
    db: DrizzleDb,
    packageName: string,
    at: number,
    depType: DepTypeFilter = 'all',
    ecosystem?: string
): LibraryProjectUsage[] {
    const depFilter = depTypeClause(depType)
    const sourceFilter = activeSourceCellClause(db)
    // A library is (ecosystem, packageName); when the detail page passes the ecosystem we scope to that
    // cell so a same-named package in another ecosystem never bleeds into this view. COALESCE keeps
    // un-backfilled legacy rows (ecosystem NULL) reachable under 'npm'.
    const ecosystemFilter = ecosystem ? sql`AND COALESCE(f.ecosystem, 'npm') = ${ecosystem}` : sql``
    const rows = db.all<{
        project_id: string
        project_name: string
        scanner: string
        source: string | null
        ecosystem: string | null
        installed_version: string
        vulnerable_range: string
        advisory_id: string
        advisory_title: string | null
        advisory_url: string | null
        severity: string
        is_prod: number
        is_dev: number
        first_detected_at: number | null
        last_seen_at: number | null
    }>(sql`
        SELECT
            f.project_id AS project_id,
            p.name AS project_name,
            f.scanner AS scanner,
            COALESCE(f.source, f.scanner) AS source,
            COALESCE(f.ecosystem, 'npm') AS ecosystem,
            f.installed_version AS installed_version,
            f.vulnerable_range AS vulnerable_range,
            f.advisory_id AS advisory_id,
            f.advisory_title AS advisory_title,
            f.advisory_url AS advisory_url,
            f.severity AS severity,
            f.is_prod AS is_prod,
            f.is_dev AS is_dev,
            f.first_detected_at AS first_detected_at,
            f.last_seen_at AS last_seen_at
        FROM findings f
        INNER JOIN projects p ON p.id = f.project_id
        WHERE f.package_name = ${packageName}
          AND f.resolved_at IS NULL
          ${ecosystemFilter}
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
        ORDER BY p.name ASC, f.advisory_id ASC
    `)
    return rows.map(function toUsage(row) {
        return {
            projectId: row.project_id,
            projectName: row.project_name,
            scanner: row.scanner,
            source: row.source ?? row.scanner,
            ecosystem: row.ecosystem ?? 'npm',
            installedVersion: row.installed_version,
            vulnerableRange: row.vulnerable_range,
            advisoryId: row.advisory_id,
            advisoryTitle: row.advisory_title,
            advisoryUrl: row.advisory_url,
            severity: row.severity,
            isProd: row.is_prod === 1,
            isDev: row.is_dev === 1,
            firstDetectedAt: row.first_detected_at,
            lastSeenAt: row.last_seen_at
        }
    })
}
