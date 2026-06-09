import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'

// Schema for the OSV advisory cache. This lives in a SEPARATE SQLite file (osv.db) from the main
// sentinello.sqlite — it is a large, fully rebuildable mirror of the OSV npm export, and keeping it
// out of the primary DB means operator backups of sentinello.sqlite stay small and the cache can be
// deleted and re-seeded at any time without touching findings/scans/config.
//
// One OSV record can affect multiple packages, and one package can carry multiple version ranges, so
// rows are denormalized to one per (advisoryId, ecosystem, packageName). The synthetic primary key is
// that triple joined by '|', which makes upserts idempotent across re-seeds and incremental syncs.

export const osvAdvisories = sqliteTable(
    'osv_advisories',
    {
        // `${advisoryId}|${ecosystem}|${packageName}` — stable across syncs so upserts are idempotent.
        rowKey: text('row_key').primaryKey(),
        // The OSV id: GHSA-xxxx (CVE-aliased advisory) or MAL-YYYY-NNNN (malicious package).
        advisoryId: text('advisory_id').notNull(),
        ecosystem: text('ecosystem').notNull(),
        packageName: text('package_name').notNull(),
        // JSON string[] of cross-references (e.g. ["CVE-2024-48913"]). Used to suppress OSV findings
        // that npm-audit already reported under the same GHSA/CVE for the same package.
        aliasesJson: text('aliases_json').notNull().default('[]'),
        // JSON of normalized SEMVER ranges: [{ introduced: string, fixed: string | null }], parsed from
        // the record's affected[].ranges (for MAL records too — they often carry a real fixable range).
        rangesJson: text('ranges_json').notNull().default('[]'),
        // JSON string[] of enumerated affected versions from affected[].versions, e.g. ["4.4.2"]. This is
        // how malware advisories pin the exact compromised builds; the matcher checks membership here so a
        // clean installed version of a once-compromised package is not flagged.
        versionsJson: text('versions_json').notNull().default('[]'),
        // OSV/GHSA severity bucket when present (critical/high/moderate/low). Null for MAL records and
        // advisories that ship no severity — the scanner maps null to a sensible default.
        severity: text('severity'),
        summary: text('summary'),
        url: text('url'),
        // Convenience flag derived from the MAL- id prefix so the scanner and UI can treat malicious
        // packages as a distinct threat class without re-parsing the id.
        malicious: integer('malicious', { mode: 'boolean' }).notNull().default(false),
        // Epoch ms of the advisory's `withdrawn` timestamp when set; null otherwise. Withdrawn advisories
        // are kept out of matching (a withdrawn record is no longer a real finding).
        withdrawn: integer('withdrawn')
    },
    function osvAdvisoriesIndexes(table) {
        return {
            // Primary matching path: "give me every advisory affecting these packages in this ecosystem".
            lookupIdx: index('osv_advisories_lookup_idx').on(table.ecosystem, table.packageName),
            // Incremental sync deletes/replaces all rows for a changed advisory id.
            advisoryIdIdx: index('osv_advisories_advisory_id_idx').on(table.advisoryId)
        }
    }
)

// Single-row-per-key metadata mirroring app_config's key/value shape. Holds the sync cursor
// (lastModified), record count, seed-complete flag, and last-refresh timestamp.
export const osvMeta = sqliteTable('osv_meta', {
    key: text('key').primaryKey(),
    valueJson: text('value_json').notNull()
})
