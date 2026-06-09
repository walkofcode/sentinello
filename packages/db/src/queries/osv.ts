import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { OsvDrizzleDb } from '../osv-client'
import { osvAdvisories, osvMeta } from '../osv-schema'

// A normalized OSV version range. `fixed` is null for an open-ended range (vulnerable from
// `introduced` onward with no known fix) — which is also how every MAL- (malicious) record is stored.
export type OsvRange = {
    introduced: string
    fixed: string | null
}

// One denormalized advisory→package row, the shape the scanner consumes. `rowKey` is synthesized by
// the writer; callers building rows for upsert pass everything except it (see toOsvRow).
export type OsvAdvisoryRow = {
    advisoryId: string
    ecosystem: string
    packageName: string
    aliases: string[]
    ranges: OsvRange[]
    // Enumerated affected versions (e.g. malware records list the exact compromised builds like ["4.4.2"]).
    // The matcher checks membership here in addition to `ranges`.
    versions: string[]
    severity: string | null
    summary: string | null
    url: string | null
    malicious: boolean
    withdrawn: number | null
}

function rowKeyFor(advisoryId: string, ecosystem: string, packageName: string): string {
    return advisoryId + '|' + ecosystem + '|' + packageName
}

type InsertRow = typeof osvAdvisories.$inferInsert

function toInsertRow(row: OsvAdvisoryRow): InsertRow {
    return {
        rowKey: rowKeyFor(row.advisoryId, row.ecosystem, row.packageName),
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

type SelectRow = typeof osvAdvisories.$inferSelect

function fromSelectRow(row: SelectRow): OsvAdvisoryRow {
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

// Upsert a batch of advisory→package rows. Idempotent on rowKey, so re-seeding or re-syncing the same
// advisory simply overwrites the prior copy. Wrapped in a single transaction for seed throughput.
export function upsertOsvAdvisories(db: OsvDrizzleDb, rows: OsvAdvisoryRow[]): void {
    if (rows.length === 0) return
    db.transaction(function txn(tx) {
        for (const row of rows) {
            const values = toInsertRow(row)
            tx.insert(osvAdvisories)
                .values(values)
                .onConflictDoUpdate({
                    target: osvAdvisories.rowKey,
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

// Remove every package-row belonging to the given advisory ids. Used by the incremental sync to clear
// an advisory before re-inserting its current package set (so a package dropped from an advisory's
// `affected` list does not linger), and to purge withdrawn advisories.
export function deleteOsvAdvisories(db: OsvDrizzleDb, advisoryIds: string[]): void {
    if (advisoryIds.length === 0) return
    const CHUNK = 500
    db.transaction(function txn(tx) {
        for (let i = 0; i < advisoryIds.length; i += CHUNK) {
            const slice = advisoryIds.slice(i, i + CHUNK)
            tx.delete(osvAdvisories).where(inArray(osvAdvisories.advisoryId, slice)).run()
        }
    })
}

// Look up all non-withdrawn advisories affecting any of the given package names in one ecosystem.
// Returns a Map keyed by package name so the scanner can join against its resolved-package list.
export function lookupOsvByPackages(
    db: OsvDrizzleDb,
    ecosystem: string,
    packageNames: string[]
): Map<string, OsvAdvisoryRow[]> {
    const out = new Map<string, OsvAdvisoryRow[]>()
    if (packageNames.length === 0) return out
    const CHUNK = 500
    for (let i = 0; i < packageNames.length; i += CHUNK) {
        const slice = packageNames.slice(i, i + CHUNK)
        const rows = db
            .select()
            .from(osvAdvisories)
            .where(
                and(
                    eq(osvAdvisories.ecosystem, ecosystem),
                    inArray(osvAdvisories.packageName, slice),
                    isNull(osvAdvisories.withdrawn)
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

export function countOsvAdvisories(db: OsvDrizzleDb): number {
    const row = db.select({ count: sql<number>`count(*)` }).from(osvAdvisories).get()
    return row?.count ?? 0
}

// --- osv_meta key/value helpers (sync cursor, seed flag, counts) ---

export function getOsvMeta<T = unknown>(db: OsvDrizzleDb, key: string): T | null {
    const row = db.select().from(osvMeta).where(eq(osvMeta.key, key)).get()
    if (!row) return null
    return JSON.parse(row.valueJson) as T
}

export function setOsvMeta(db: OsvDrizzleDb, key: string, value: unknown): void {
    const valueJson = JSON.stringify(value)
    db.insert(osvMeta)
        .values({ key, valueJson })
        .onConflictDoUpdate({ target: osvMeta.key, set: { valueJson } })
        .run()
}

export const OSV_META_KEYS = {
    // ISO string from the seed/zip Last-Modified, advanced on each incremental sync.
    lastModified: 'lastModified',
    // Epoch ms of the last successful sync (seed or incremental).
    refreshedAt: 'refreshedAt',
    // True once the initial full seed completed; gates the scanner (it returns osv_db_not_seeded until then).
    seedComplete: 'seedComplete',
    // Total advisory→package rows after the last sync (denormalized count for the Settings panel).
    recordCount: 'recordCount',
    // Last sync error message, or null. Surfaced in the Settings → Sources panel.
    lastError: 'lastError',
    // Version of the normalizer that produced the cached rows. Bumped when the row shape changes (e.g.
    // adding enumerated `versions`); a mismatch forces a full re-seed so stale rows are rebuilt.
    normalizerVersion: 'normalizerVersion'
} as const

// Bump whenever normalizeOsvRecord's output shape changes in a way that requires rebuilding the cache.
// v2: started capturing affected[].versions and real MAL- ranges (was: all-versions malware shortcut).
export const OSV_NORMALIZER_VERSION = 2

function parseStringArray(json: string): string[] {
    const parsed = JSON.parse(json) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(function isString(v): v is string {
        return typeof v === 'string'
    })
}

function parseRanges(json: string): OsvRange[] {
    const parsed = JSON.parse(json) as unknown
    if (!Array.isArray(parsed)) return []
    const out: OsvRange[] = []
    for (const entry of parsed) {
        if (entry && typeof entry === 'object' && typeof (entry as OsvRange).introduced === 'string') {
            const e = entry as OsvRange
            out.push({ introduced: e.introduced, fixed: typeof e.fixed === 'string' ? e.fixed : null })
        }
    }
    return out
}
