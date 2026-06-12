import { sql, type SQL } from 'drizzle-orm'
import {
    DEFAULT_ECOSYSTEM,
    ECOSYSTEMS,
    LEGACY_SOURCE_CONFIG_KEYS,
    SOURCE_IDS,
    sourceEnabledKey,
    type EcosystemId,
    type SourceCell,
    type SourceId
} from '@sentinello/core'
import type { DrizzleDb } from '../client'
import { getConfigValue } from './config'

// Default enablement per source cell. npm-audit's JS cell is ON out of the box (so existing installs keep
// scanning); osv/gemnasium are opt-in (off until the operator enables them — they download a sizable
// advisory dump). The "always a source on" invariant (enforced on every toggle write in apps/web) is what
// makes npm-audit's cell safely disableable without ever leaving the system source-blind.
const SOURCE_DEFAULT_ENABLED: Record<SourceId, boolean> = {
    'npm-audit': true,
    osv: false,
    gemnasium: false
}

function legacyEnabledKey(source: SourceId): string | null {
    if (source === 'osv') return LEGACY_SOURCE_CONFIG_KEYS.osvEnabled
    if (source === 'gemnasium') return LEGACY_SOURCE_CONFIG_KEYS.gemnasiumEnabled
    return null
}

// Reads a (source, ecosystem) cell's enabled flag. Falls back to the pre-Phase-2 flat key for the npm
// cell so an upgrade preserves the operator's prior osv/gemnasium choice until the worker boot migrates
// the key to the per-cell scheme; then to the per-source default. Shared by the portal and worker so the
// live flag is read identically everywhere.
export function getSourceEnabled(db: DrizzleDb, source: SourceId, ecosystem: EcosystemId = DEFAULT_ECOSYSTEM): boolean {
    const v = getConfigValue<boolean>(db, sourceEnabledKey(source, ecosystem))
    if (typeof v === 'boolean') return v
    if (ecosystem === DEFAULT_ECOSYSTEM) {
        const legacy = legacyEnabledKey(source)
        if (legacy) {
            const lv = getConfigValue<boolean>(db, legacy)
            if (typeof lv === 'boolean') return lv
        }
    }
    return SOURCE_DEFAULT_ENABLED[source]
}

// The set of active (source, ecosystem) cells whose findings are currently visible in the portal. A cell
// is one advisory source answering for one ecosystem. npm-audit is the built-in source (default on, now
// disableable) and only answers for the npm ecosystem; OSV and gemnasium are opt-in per ecosystem
// (Settings → Sources) and only contribute once the operator enables their cell. Disabling a cell does NOT
// delete its finding rows — they simply fall out of this set so every current-findings read path hides
// them, and re-enabling brings them back intact (original firstDetectedAt preserved; the next scan
// refreshes / resolves them). Today only the npm cells exist; the same selection lights up the non-npm
// cells unchanged once Phases 3–4 write them.
export function getActiveSourceCells(db: DrizzleDb): SourceCell[] {
    const cells: SourceCell[] = []
    for (const source of SOURCE_IDS) {
        for (const eco of ECOSYSTEMS) {
            // npm-audit is JavaScript's native source — it never answers for a non-npm ecosystem.
            if (source === 'npm-audit' && eco.id !== DEFAULT_ECOSYSTEM) continue
            if (getSourceEnabled(db, source, eco.id)) cells.push({ source, ecosystem: eco.id })
        }
    }
    return cells
}

// The distinct active source ids (deduped across ecosystems), derived from getActiveSourceCells so it can
// never reintroduce the old scanner-only / npm-only semantics. Today's UI source-filter chips still present
// a flat source list (the full Languages × Sources matrix is Phase 5); this gives them a source-cell-backed
// list without exposing the per-ecosystem axis yet. A source appears once if any of its cells is enabled.
export function getActiveSources(db: DrizzleDb): SourceId[] {
    const seen = new Set<SourceId>()
    for (const cell of getActiveSourceCells(db)) seen.add(cell.source)
    return Array.from(seen)
}

// Append-only WHERE fragment restricting a findings row to the currently-active (source, ecosystem) cells,
// mirroring depTypeClause so callers interpolate it without restructuring their query. The alias points at
// whichever findings alias the caller already used (defaults to 'f'). Each cell matches on BOTH the
// persisted source identity (COALESCE(source, scanner) for un-backfilled legacy rows) AND the ecosystem
// (COALESCE to 'npm' for legacy rows) — so enabling osv for one ecosystem shows only that ecosystem's osv
// findings, not every ecosystem's. Source/ecosystem values come from the central registry (fixed
// constants, never user input), so the inlined literals carry no injection risk. When zero cells are
// active (only reachable if the "always a source on" invariant is bypassed) the clause matches nothing
// rather than emitting invalid SQL, so the portal correctly shows no findings instead of throwing.
export function activeSourceCellClause(db: DrizzleDb, alias: string = 'f'): SQL {
    const cells = getActiveSourceCells(db)
    if (cells.length === 0) return sql.raw(`AND 1 = 0`)
    const predicate = cells
        .map(function cellPred(cell) {
            return `(COALESCE(${alias}.source, ${alias}.scanner) = '${cell.source}' AND COALESCE(${alias}.ecosystem, '${DEFAULT_ECOSYSTEM}') = '${cell.ecosystem}')`
        })
        .join(' OR ')
    return sql.raw(`AND (${predicate})`)
}
