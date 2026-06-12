import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { OsvDrizzleDb } from '../osv-client'
import { osvAdvisories, osvMeta } from '../osv-schema'

// A normalized OSV version range. `fixed` is null when there is no clean fix boundary; in that case
// `lastAffected` (OSV `last_affected`), when set, is an INCLUSIVE upper bound, and when both are null the
// range is open-ended (vulnerable from `introduced` onward, as every MAL- malicious record is stored).
// `type` is OSV's `range.type` ('SEMVER' | 'ECOSYSTEM' | 'GIT') — preserved so non-SEMVER ecosystems
// (PyPI/Go/Rust) keep enough semantics for their comparator to evaluate the range correctly.
export type OsvRange = {
    type: string
    introduced: string
    fixed: string | null
    lastAffected: string | null
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

// Remove package-rows belonging to the given advisory ids. Used by the incremental sync to clear an
// advisory before re-inserting its current package set (so a package dropped from an advisory's `affected`
// list does not linger), and to purge withdrawn advisories. When `ecosystem` is given the delete is scoped
// to that ecosystem only — each ecosystem syncs independently from its own per-ecosystem feed, so a PyPI
// sync must not wipe an advisory's npm rows (one OSV record can affect several ecosystems).
export function deleteOsvAdvisories(db: OsvDrizzleDb, advisoryIds: string[], ecosystem?: string): void {
    if (advisoryIds.length === 0) return
    const CHUNK = 500
    db.transaction(function txn(tx) {
        for (let i = 0; i < advisoryIds.length; i += CHUNK) {
            const slice = advisoryIds.slice(i, i + CHUNK)
            const idMatch = inArray(osvAdvisories.advisoryId, slice)
            const where = ecosystem ? and(idMatch, eq(osvAdvisories.ecosystem, ecosystem)) : idMatch
            tx.delete(osvAdvisories).where(where).run()
        }
    })
}

// Remove ALL cached rows for one ecosystem. Used by the full seed/re-seed to discard the prior derived
// cache before streaming the current export, so an advisory or affected-package that disappeared upstream
// (or an old-shape row from a previous normalizer version) can never remain matchable. Scoped to the one
// ecosystem because each syncs independently from its own export — clearing npm must not touch PyPI rows.
export function deleteOsvAdvisoriesForEcosystem(db: OsvDrizzleDb, ecosystem: string): void {
    db.delete(osvAdvisories).where(eq(osvAdvisories.ecosystem, ecosystem)).run()
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

// Total cached advisory→package rows, optionally scoped to one ecosystem (for the per-cell recordCount the
// portal shows per (osv, ecosystem) source row).
export function countOsvAdvisories(db: OsvDrizzleDb, ecosystem?: string): number {
    const base = db.select({ count: sql<number>`count(*)` }).from(osvAdvisories)
    const row = ecosystem
        ? base.where(eq(osvAdvisories.ecosystem, ecosystem)).get()
        : base.get()
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

// Base meta key names. ALL state is per-ecosystem, stored under `<base>.<ecosystem>` via osvMetaKeyFor,
// because each ecosystem syncs from its own OSV export with its own cursor, seed lifecycle, AND its own
// normalizer-version stamp. normalizerVersion is per-ecosystem (not global) so a multi-ecosystem rebuild can
// never briefly mark a not-yet-rebuilt ecosystem as current: an ecosystem is only auditable once ITS rows
// have been re-seeded at the current version (see seedOsv + the scanner's isSeeded gate). A normalizer bump
// still re-seeds every ecosystem — each one's stamp simply mismatches until its own re-seed lands.
export const OSV_META_KEYS = {
    // ISO string from the seed/zip Last-Modified, advanced on each incremental sync. Per-ecosystem.
    lastModified: 'lastModified',
    // Epoch ms of the last successful sync (seed or incremental). Per-ecosystem.
    refreshedAt: 'refreshedAt',
    // True once the ecosystem's initial full seed completed; gates the scanner for that ecosystem
    // (it returns osv_db_not_seeded until then). Set false before a destructive re-seed and true only after
    // it succeeds, so a failed rebuild stays unauditable rather than matching partial rows. Per-ecosystem.
    seedComplete: 'seedComplete',
    // Total advisory→package rows for the ecosystem after the last sync (for the Settings panel). Per-ecosystem.
    recordCount: 'recordCount',
    // Last sync error message for the ecosystem, or null. Surfaced in the Settings → Sources panel. Per-ecosystem.
    lastError: 'lastError',
    // Version of the normalizer that produced the ecosystem's cached rows. Per-ecosystem (via osvMetaKeyFor).
    // Bumped when the row shape changes; a mismatch forces a full re-seed of that ecosystem so stale rows are
    // rebuilt, and the scanner treats the ecosystem as unseeded until the re-seed completes.
    normalizerVersion: 'normalizerVersion'
} as const

// Build a per-ecosystem osv_meta key, e.g. osvMetaKeyFor('seedComplete', 'PyPI') === 'seedComplete.PyPI'.
// The ecosystem is the canonical OSV id from the central registry (never user input).
export function osvMetaKeyFor(base: string, ecosystem: string): string {
    return base + '.' + ecosystem
}

// Bump whenever normalizeOsvRecord's output shape changes in a way that requires rebuilding the cache.
// v2: started capturing affected[].versions and real MAL- ranges (was: all-versions malware shortcut).
// v3: per-ecosystem rows (dropped the npm/SEMVER-only filters) + richer range shape (range.type +
//     last_affected) + per-ecosystem meta keys. Forces a full re-seed off the prior flat-key npm cache.
export const OSV_NORMALIZER_VERSION = 3

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
            out.push({
                // Default the new fields for any row written by an older normalizer (a normalizer-version
                // bump forces a full re-seed, so this only guards a transient mid-rebuild read).
                type: typeof e.type === 'string' ? e.type : 'SEMVER',
                introduced: e.introduced,
                fixed: typeof e.fixed === 'string' ? e.fixed : null,
                lastAffected: typeof e.lastAffected === 'string' ? e.lastAffected : null
            })
        }
    }
    return out
}
