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

// Numeric severity weight mirroring severityWeight in @sentinello/core, so a merged group's severity is
// the worst (MAX) across its rows and the SQL aggregates always agree with the JS merge. Keep the two
// in lockstep: the weights, the case/whitespace normalization, and the unknown fallback all match.
//
// An unrecognized severity ranks as 'moderate' (3), NOT as its own out-of-band value. Callers bucket
// ranks 5..1 into critical/high/moderate/low/info and sum them; a rank outside that range would put a
// group in the deduped set while adding to no bucket, so the severity counts would silently undercount
// and a project whose only finding had a bad severity string would render as clean. Moderate matches
// the deliberate fallback in scanners/engine/matcher.ts:mapSeverity — an unknown advisory is never
// silently downgraded. findings.severity is `text NOT NULL` with no CHECK constraint (the enum is
// compile-time only in the Drizzle type), so this is a real if currently unreachable input.
export function severityRankSql(alias: string = 'f'): SQL {
    return sql.raw(
        `CASE lower(trim(${alias}.severity)) WHEN 'critical' THEN 5 WHEN 'high' THEN 4 WHEN 'moderate' THEN 3 ` +
        `WHEN 'low' THEN 2 WHEN 'info' THEN 1 ELSE 3 END`
    )
}

// The "this finding is not silenced" predicate, extracted from the copies in getDashboardSummary /
// listLibraries / listProjectCatalog so the deduped CTEs stay in sync with them. A finding is muted
// when an unexpired project-scope mute covers its project, or an unexpired finding-scope mute matches
// its (source, ecosystem, advisory_id, package_name). mutes.scanner is the back-compat column that holds
// the persisted source identity, so it matches the finding's source (COALESCE(source, scanner) for
// un-backfilled legacy rows where the plugin name was the source identity) — never the plugin/provenance
// field. A NULL mute.ecosystem is a legacy (pre-polyglot) finding-scope row that matches any ecosystem
// until backfilled to 'npm'. `at` stays a bound param; identifiers use sql.raw(alias).
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
              AND m.scanner = COALESCE(${a}.source, ${a}.scanner)
              AND (m.ecosystem IS NULL OR m.ecosystem = ${a}.ecosystem)
              AND m.advisory_id = ${a}.advisory_id
              AND m.package_name = ${a}.package_name
            )
          )
      )`
}
