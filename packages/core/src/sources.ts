// Vulnerability source configuration shared by the portal (apps/web) and the worker (apps/worker).
// A (source, ecosystem) cell is enabled/disabled and carries a sync-status snapshot independently, so
// `osv` for Python can be off while `osv` for JavaScript is on. Keys are plain app_config keys (same
// store as `update_checks_enabled`); centralized here so both apps construct the identical string rather
// than re-typing literals that could silently drift.
//
// Convention: `sources.<source>.<ecosystem>.enabled` / `.status`, where <ecosystem> is the canonical
// registry id (EcosystemId — 'npm', 'PyPI', 'Go', 'crates.io'). npm-audit's JS cell defaults ON (so
// existing installs with no key keep npm-audit running); osv/gemnasium cells default OFF (opt-in, they
// download a sizable advisory dump). The "always a source on" invariant (validated on every toggle
// write) is what lets npm-audit's cell be disabled without ever leaving the system source-blind.

import type { EcosystemId, SourceCell, SourceId } from './ecosystems'

export function sourceEnabledKey(source: SourceId, ecosystem: EcosystemId): string {
    return 'sources.' + source + '.' + ecosystem + '.enabled'
}

export function sourceStatusKey(source: SourceId, ecosystem: EcosystemId): string {
    return 'sources.' + source + '.' + ecosystem + '.status'
}

// Pre-Phase-2 flat keys. Kept ONLY so the per-cell readers can fall back to them and the worker boot can
// migrate them to the npm-cell keys above. Never written going forward.
export const LEGACY_SOURCE_CONFIG_KEYS = {
    osvEnabled: 'sources.osv.enabled',
    osvStatus: 'sources.osv.status',
    gemnasiumEnabled: 'sources.gemnasium.enabled',
    gemnasiumStatus: 'sources.gemnasium.status'
} as const

// Notification-target source/ecosystem scope (Betty: "select all or select which ones we want"). The
// data contract lives here in Phase 2; Phase 5 builds the Settings UI + wires dispatch filtering to it.
export type NotificationSourceScope = {
    // 'all' fires for every (source, ecosystem) cell; 'selected' restricts to the listed cells.
    mode: 'all' | 'selected'
    cells: SourceCell[]
}

// Compact sync-status snapshot the worker mirrors into the main app_config for the portal to read.
// Shared by every cache-backed source (OSV today, gemnasium added in Phase 1).
export type SourceStatus = {
    // True once the initial full seed completed.
    seedComplete: boolean
    // Advisory→package row count after the last sync.
    recordCount: number
    // Epoch ms of the last successful sync, or null if never.
    refreshedAt: number | null
    // Last sync error message, or null.
    lastError: string | null
    // Free bytes on the cache volume at the last sync (for the provisioning hint), or null if unknown.
    freeBytes: number | null
}

// Back-compat alias: OSV's status type is the shared SourceStatus shape.
export type OsvSourceStatus = SourceStatus

// The scanner name OSV findings are recorded under (the `scanner` column on findings/scans). Must match
// the `name` field of the OSV scanner plugin so per-scanner merge scoping lines up across the codebase.
export const OSV_SCANNER_NAME = 'osv'
export const NPM_AUDIT_SCANNER_NAME = 'npm-audit'
// The scanner name gemnasium findings are recorded under. Must match the gemnasium scanner plugin name.
export const GEMNASIUM_SCANNER_NAME = 'gemnasium'

// Approximate on-disk footprint of the OSV npm export, shown to the operator before they enable the
// source so they can provision the data volume. Measured against the live OSV bucket (May 2026):
// all.zip ≈ 196 MB; the normalized osv.db cache lands far smaller (~40–80 MB) because we keep only the
// matchable fields. We pre-flight free space against the seed download plus headroom.
export const OSV_SEED_DOWNLOAD_BYTES = 196 * 1024 * 1024
// Free-space floor required before the seed download is attempted: the zip on disk + the unpacked
// cache + working headroom. Conservative so a near-full volume fails fast instead of mid-write.
export const OSV_REQUIRED_FREE_BYTES = 600 * 1024 * 1024

// Approximate on-disk footprint of the gemnasium-db archive, shown to the operator before they enable
// the source. The GitLab archive zip is far smaller than the OSV export (tens of MB) and the normalized
// gemnasium.db cache lands smaller still.
export const GEMNASIUM_SEED_DOWNLOAD_BYTES = 80 * 1024 * 1024
// Free-space floor required before the gemnasium seed download is attempted: archive on disk + the
// unpacked cache + working headroom.
export const GEMNASIUM_REQUIRED_FREE_BYTES = 300 * 1024 * 1024
