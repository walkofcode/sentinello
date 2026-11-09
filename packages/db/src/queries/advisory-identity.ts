import { sql, type SQL } from 'drizzle-orm'

// Cross-source identity of a vulnerability: the key refreshAdvisoryKeys wrote, mirroring advisoryIdentity in
// apps/web/lib/merge-findings.ts so SQL aggregate counts agree with the merged "by advisory" view. Keep the two
// in lockstep. The fallback covers only an old resolved row and the moment between migration and boot: a row's
// own source and id, never its title, since a generic title merges different vulnerabilities (SENTINEL-174). The
// alias points at whichever findings alias the caller used (defaults to 'f').
export function advisoryIdentitySql(alias: string = 'f'): SQL {
    return sql.raw(`COALESCE(${alias}.advisory_key, COALESCE(${alias}.source, ${alias}.scanner) || ':' || ${alias}.advisory_id)`)
}

// The rows severity counts stand on: a notice (RUSTSEC's unmaintained, unsound) stays a finding row, listed and
// mutable, and is not a vulnerability. The one statement of that, for every aggregate.
export function notNoticeSql(alias: string = 'f'): SQL {
    return sql.raw(`AND ${alias}.notice_kind IS NULL`)
}

// Numeric severity weight mirroring severityWeight in @sentinello/core, so a merged group's severity is
// the worst (MAX) across its rows and the SQL aggregates always agree with the JS merge. Keep the two
// in lockstep: the weights, the case/whitespace normalization, and the unknown fallback all match.
//
// An unrecognized severity ranks as 'moderate' (3), NOT as its own out-of-band value. Callers bucket
// ranks 5..1 into critical/high/moderate-or-unrated/low/info and sum them; a rank outside that range would put a
// group in the deduped set while adding to no bucket, so the severity counts would silently undercount
// and a project whose only finding had a bad severity string would render as clean. Moderate matches
// the deliberate fallback in scanners/engine/matcher.ts:mapSeverity — an unknown advisory is never
// silently downgraded. findings.severity is `text NOT NULL` with no CHECK constraint (the enum is
// compile-time only in the Drizzle type), so this is a real if currently unreachable input.
export function severityRankSql(alias: string = 'f'): SQL {
    return sql.raw(
        `CASE lower(trim(${alias}.severity)) WHEN 'critical' THEN 5 WHEN 'high' THEN 4 WHEN 'moderate' THEN 3 ` +
        `WHEN 'unrated' THEN 3 WHEN 'low' THEN 2 WHEN 'info' THEN 1 ELSE 3 END`
    )
}

// 1 for a rank-3 row that states a grade, 0 for anything else. Moderate and unrated share rank 3, so the
// buckets split it with a MAX of this: a merged group counts as unrated only when no row of it states
// moderate, as in the JS merge (maxSeverity). An unrecognized severity ranks 3 and is in the moderate bucket.
export function statesModerateSql(alias: string = 'f'): SQL {
    return sql.raw(
        `CASE WHEN lower(trim(${alias}.severity)) IN ('critical', 'high', 'unrated', 'low', 'info') THEN 0 ELSE 1 END`
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
