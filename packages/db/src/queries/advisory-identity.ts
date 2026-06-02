import { sql, type SQL } from 'drizzle-orm'

// Cross-source identity of a vulnerability, mirroring apps/web/lib/merge-findings.ts:advisoryKey so
// SQL aggregate counts agree with the merged "by advisory" view. npm-audit and OSV assign different
// advisory ids to the same CVE but share the title, so the normalized title is the identity when
// present, else the raw advisory id. The 't:' / 'a:' prefixes match the JS so a title can never
// collide with an id. The alias points at whichever findings alias the caller used (defaults to 'f').
export function advisoryIdentitySql(alias: string = 'f'): SQL {
    return sql.raw(
        `CASE WHEN ${alias}.advisory_title IS NOT NULL AND trim(${alias}.advisory_title) <> '' ` +
        `THEN 't:' || lower(trim(${alias}.advisory_title)) ELSE 'a:' || ${alias}.advisory_id END`
    )
}

// Numeric severity rank mirroring merge-findings.ts:SEVERITY_RANK, so a merged group's severity is
// the worst (MAX) across its rows. Unknown severities sort to 0 (below 'info').
export function severityRankSql(alias: string = 'f'): SQL {
    return sql.raw(
        `CASE ${alias}.severity WHEN 'critical' THEN 5 WHEN 'high' THEN 4 WHEN 'moderate' THEN 3 ` +
        `WHEN 'low' THEN 2 WHEN 'info' THEN 1 ELSE 0 END`
    )
}

// The "this finding is not silenced" predicate, extracted from the copies in getDashboardSummary /
// listLibraries / listProjectCatalog so the deduped CTEs stay in sync with them. A finding is muted
// when an unexpired project-scope mute covers its project, or an unexpired finding-scope mute matches
// its (scanner, advisory_id, package_name). `at` stays a bound param; identifiers use sql.raw(alias).
export function findingMuteExclusionSql(at: number, alias: string = 'f'): SQL {
    const a = sql.raw(alias)
    return sql`AND NOT EXISTS (
        SELECT 1 FROM mutes m
        WHERE (m.expires_at IS NULL OR m.expires_at > ${at})
          AND (
            (m.scope = 'project' AND m.project_id = ${a}.project_id)
            OR (
              m.scope = 'finding'
              AND (m.project_id IS NULL OR m.project_id = ${a}.project_id)
              AND m.scanner = ${a}.scanner
              AND m.advisory_id = ${a}.advisory_id
              AND m.package_name = ${a}.package_name
            )
          )
      )`
}
