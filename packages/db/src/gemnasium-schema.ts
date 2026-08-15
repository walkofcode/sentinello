import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'

// Schema for the GitLab gemnasium advisory cache. Like the OSV cache, this lives in a SEPARATE SQLite
// file (gemnasium.db) from the main sentinello.sqlite — it is a large, fully rebuildable mirror of the
// gemnasium-db export, so keeping it out of the primary DB means operator backups stay small and the
// cache can be deleted and re-seeded at any time without touching findings/scans/config.
//
// The row shape is deliberately identical to osv_advisories so the lookup/scanner code is a tight
// mirror of the OSV path and both feed the same CanonicalAdvisory target. gemnasium has no malware
// (MAL-) or withdrawn concept, so `malicious` is always false and `withdrawn` always null here; the
// columns are kept for structural parity (the lookup query filters on `withdrawn` identically).
//
// One advisory affects one package (gemnasium files are per package_slug), but a package can carry
// multiple version ranges, so rows are one per (advisoryId, ecosystem, packageName). The synthetic
// primary key is that triple joined by '|', which makes upserts idempotent across re-seeds.

export const gemnasiumAdvisories = sqliteTable(
    'gemnasium_advisories',
    {
        // `${advisoryId}|${ecosystem}|${packageName}` — stable across syncs so upserts are idempotent.
        rowKey: text('row_key').primaryKey(),
        // The gemnasium primary identifier: a CVE id when one exists, otherwise the internal GMS-YYYY-NNNN.
        advisoryId: text('advisory_id').notNull(),
        ecosystem: text('ecosystem').notNull(),
        packageName: text('package_name').notNull(),
        // JSON string[] of cross-references (e.g. ["CVE-2019-10744","GHSA-jf85-cpcp-j695"]) from the
        // advisory's `identifiers`. Used by reconcile to collapse gemnasium findings that npm-audit or OSV
        // already reported under the same CVE/GHSA for the same package.
        aliasesJson: text('aliases_json').notNull().default('[]'),
        // JSON of normalized ranges [{ introduced: string, fixed: string | null }] parsed from the
        // advisory's `affected_range` + `fixed_versions`.
        rangesJson: text('ranges_json').notNull().default('[]'),
        // JSON string[] of enumerated affected versions. gemnasium expresses affected sets as ranges, so
        // this is normally empty; kept for parity with the OSV row shape and the shared matcher.
        versionsJson: text('versions_json').notNull().default('[]'),
        // Severity bucket (critical/high/moderate/low) computed from the advisory's CVSS vector
        // (cvss_v3 preferred, else cvss_v2). Null when the advisory ships no CVSS vector.
        severity: text('severity'),
        summary: text('summary'),
        url: text('url'),
        // Always false for gemnasium (no malware class); kept for parity with osv_advisories.
        malicious: integer('malicious', { mode: 'boolean' }).notNull().default(false),
        // Always null for gemnasium (no withdrawn class); kept for parity so the lookup filter matches OSV.
        withdrawn: integer('withdrawn')
    },
    function gemnasiumAdvisoriesIndexes(table) {
        return {
            // Primary matching path: "give me every advisory affecting these packages in this ecosystem".
            lookupIdx: index('gemnasium_advisories_lookup_idx').on(table.ecosystem, table.packageName),
            // Incremental sync deletes/replaces all rows for a changed advisory id.
            advisoryIdIdx: index('gemnasium_advisories_advisory_id_idx').on(table.advisoryId)
        }
    }
)

// Single-row-per-key metadata mirroring app_config's key/value shape. Holds the sync cursor
// (lastCommit), record count, seed-complete flag, and last-refresh timestamp.
export const gemnasiumMeta = sqliteTable('gemnasium_meta', {
    key: text('key').primaryKey(),
    valueJson: text('value_json').notNull()
})
