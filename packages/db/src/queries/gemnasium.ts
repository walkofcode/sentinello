import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { GEMNASIUM_NORMALIZER_VERSION, type GemnasiumAdvisoryRow, type GemnasiumRange } from '@sentinello/core'
import { parseVersionRanges } from '@sentinello/versions'
import type { GemnasiumDrizzleDb } from '../gemnasium-client'
import { gemnasiumAdvisories, gemnasiumMeta } from '../gemnasium-schema'

// The row/range shapes moved to @sentinello/core so the feed normalizers can produce them without
// linking the SQLite layer (see packages/core/src/advisory-rows.ts). Re-exported here under their
// historical names — every `from '@sentinello/db'` import site is unchanged, and the column mapping
// below stays this module's business.
export type { GemnasiumAdvisoryRow, GemnasiumRange }

export function gemnasiumRowKeyFor(advisoryId: string, ecosystem: string, packageName: string): string {
    return advisoryId + '|' + ecosystem + '|' + packageName
}

type InsertRow = typeof gemnasiumAdvisories.$inferInsert

function toInsertRow(row: GemnasiumAdvisoryRow): InsertRow {
    return {
        rowKey: gemnasiumRowKeyFor(row.advisoryId, row.ecosystem, row.packageName),
        advisoryId: row.advisoryId,
        ecosystem: row.ecosystem,
        packageName: row.packageName,
        aliasesJson: JSON.stringify(row.aliases),
        rangesJson: JSON.stringify(row.ranges),
        versionsJson: JSON.stringify(row.versions),
        severity: row.severity,
        summary: row.summary,
        url: row.url,
        malicious: row.malicious,
        withdrawn: row.withdrawn
    }
}

type SelectRow = typeof gemnasiumAdvisories.$inferSelect

function fromSelectRow(row: SelectRow): GemnasiumAdvisoryRow {
    return {
        advisoryId: row.advisoryId,
        ecosystem: row.ecosystem,
        packageName: row.packageName,
        aliases: parseStringArray(row.aliasesJson),
        ranges: parseRanges(row.rangesJson),
        versions: parseStringArray(row.versionsJson),
        severity: row.severity,
        summary: row.summary,
        url: row.url,
        malicious: row.malicious,
        withdrawn: row.withdrawn
    }
}

// Upsert a batch of advisory→package rows. Idempotent on rowKey, so re-seeding the same advisory simply
// overwrites the prior copy. Wrapped in a single transaction for seed throughput.
export function upsertGemnasiumAdvisories(db: GemnasiumDrizzleDb, rows: GemnasiumAdvisoryRow[]): void {
    if (rows.length === 0) return
    db.transaction(function txn(tx) {
        for (const row of rows) {
            const values = toInsertRow(row)
            tx.insert(gemnasiumAdvisories)
                .values(values)
                .onConflictDoUpdate({
                    target: gemnasiumAdvisories.rowKey,
                    set: {
                        aliasesJson: values.aliasesJson,
                        rangesJson: values.rangesJson,
                        versionsJson: values.versionsJson,
                        severity: values.severity,
                        summary: values.summary,
                        url: values.url,
                        malicious: values.malicious,
                        withdrawn: values.withdrawn
                    }
                })
                .run()
        }
    })
}

// gemnasium-db ships no per-advisory delta feed, so each sync re-downloads the whole archive and
// upserts every advisory. This purges rows whose rowKey was NOT present in the freshly-seeded set, so
// advisories deleted upstream do not linger. Called only AFTER a successful full pass (the caller has
// collected every current rowKey), so a failed/partial download never empties the cache. The existing
// rowKeys are read and diffed in memory, then the stale ones deleted in chunks — avoiding a giant
// NOT IN (...) with tens of thousands of bind params.
export function deleteGemnasiumAdvisoriesExcept(db: GemnasiumDrizzleDb, keepRowKeys: Set<string>): number {
    const existing = db.select({ rowKey: gemnasiumAdvisories.rowKey }).from(gemnasiumAdvisories).all()
    const stale: string[] = []
    for (const row of existing) {
        if (!keepRowKeys.has(row.rowKey)) stale.push(row.rowKey)
    }
    if (stale.length === 0) return 0
    const CHUNK = 500
    db.transaction(function txn(tx) {
        for (let i = 0; i < stale.length; i += CHUNK) {
            const slice = stale.slice(i, i + CHUNK)
            tx.delete(gemnasiumAdvisories).where(inArray(gemnasiumAdvisories.rowKey, slice)).run()
        }
    })
    return stale.length
}

// Removes every row belonging to the given advisory ids, across all ecosystems. Used by the incremental
// sync: an advisory file that changed upstream has its rows cleared and rewritten from the new content, so
// a package dropped from the advisory's affected set does not linger. One advisory maps to 0..N rows (one
// per affected package), which is why this deletes by advisoryId rather than by rowKey.
export function deleteGemnasiumAdvisories(db: GemnasiumDrizzleDb, advisoryIds: string[]): number {
    if (advisoryIds.length === 0) return 0
    const CHUNK = 500
    let deleted = 0
    db.transaction(function txn(tx) {
        for (let i = 0; i < advisoryIds.length; i += CHUNK) {
            const slice = advisoryIds.slice(i, i + CHUNK)
            const result = tx.delete(gemnasiumAdvisories).where(inArray(gemnasiumAdvisories.advisoryId, slice)).run()
            deleted += result.changes
        }
    })
    return deleted
}

// Look up all advisories affecting any of the given package names in one ecosystem. Returns a Map
// keyed by package name so the scanner can join against its resolved-package list. The `withdrawn`
// filter is a structural mirror of the OSV lookup (gemnasium rows are always non-withdrawn).

export function lookupGemnasiumByPackages(
    db: GemnasiumDrizzleDb,
    ecosystem: string,
    packageNames: string[]
): Map<string, GemnasiumAdvisoryRow[]> {
    const out = new Map<string, GemnasiumAdvisoryRow[]>()
    if (packageNames.length === 0) return out
    const CHUNK = 500
    for (let i = 0; i < packageNames.length; i += CHUNK) {
        const slice = packageNames.slice(i, i + CHUNK)
        const rows = db
            .select()
            .from(gemnasiumAdvisories)
            .where(
                and(
                    eq(gemnasiumAdvisories.ecosystem, ecosystem),
                    inArray(gemnasiumAdvisories.packageName, slice),
                    isNull(gemnasiumAdvisories.withdrawn)
                )
            )
            .all()
        for (const row of rows) {
            const parsed = fromSelectRow(row)
            const list = out.get(parsed.packageName)
            if (list) {
                list.push(parsed)
            } else {
                out.set(parsed.packageName, [parsed])
            }
        }
    }
    return out
}

export function countGemnasiumAdvisories(db: GemnasiumDrizzleDb): number {
    const row = db.select({ count: sql<number>`count(*)` }).from(gemnasiumAdvisories).get()
    return row?.count ?? 0
}

// --- gemnasium_meta key/value helpers (sync cursor, seed flag, counts) ---

export function getGemnasiumMeta<T = unknown>(db: GemnasiumDrizzleDb, key: string): T | null {
    const row = db.select().from(gemnasiumMeta).where(eq(gemnasiumMeta.key, key)).get()
    if (!row) return null
    return JSON.parse(row.valueJson) as T
}

export function setGemnasiumMeta(db: GemnasiumDrizzleDb, key: string, value: unknown): void {
    const valueJson = JSON.stringify(value)
    db.insert(gemnasiumMeta)
        .values({ key, valueJson })
        .onConflictDoUpdate({ target: gemnasiumMeta.key, set: { valueJson } })
        .run()
}

export const GEMNASIUM_META_KEYS = {
    // Last-Modified header of the downloaded archive (informational; the daily sync re-seeds regardless).
    lastModified: 'lastModified',
    // Epoch ms of the last successful sync.
    refreshedAt: 'refreshedAt',
    // True once the initial full seed completed; gates the scanner (gemnasium_db_not_seeded until then).
    seedComplete: 'seedComplete',
    // Total advisory→package rows after the last sync.
    recordCount: 'recordCount',
    // Last sync error message, or null. Surfaced in the Settings → Sources panel.
    lastError: 'lastError',
    // Version of the normalizer that produced the cached rows. A mismatch forces a full re-seed.
    normalizerVersion: 'normalizerVersion',
    // Commit sha of gemnasium-db that the cache was built from. This is the freshness gate: gemnasium-db
    // is a git repo, so an unchanged HEAD proves the cache is current for the cost of one small API call,
    // and a changed HEAD lets us fetch only the advisory files that actually differ instead of the whole
    // 80 MB archive. Null means "provenance unknown" and forces a full archive rebuild.
    headSha: 'headSha'
} as const

// Defined in @sentinello/core beside the row shape it describes, so the portal's SQLite cache and the
// CLI's ndjson cache invalidate on the same signal. Re-exported here for the existing import sites.
export { GEMNASIUM_NORMALIZER_VERSION }

function parseStringArray(json: string): string[] {
    const parsed = JSON.parse(json) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(function isString(v): v is string {
        return typeof v === 'string'
    })
}

// Shared with the OSV cache — see parseVersionRanges for why this must not be rebuilt field by field.
function parseRanges(json: string): GemnasiumRange[] {
    return parseVersionRanges(json)
}
