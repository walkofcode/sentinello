// Vulnerability source configuration shared by the portal (apps/web) and the worker (apps/worker).
// npm-audit is always on and needs no config. Additional sources (today: OSV) are OPT-IN: the operator
// enables them in Settings → Sources, off by default, because they download a sizable advisory dump.
//
// Keys are plain app_config keys (same store as `update_checks_enabled`); centralized here so both
// apps reference the identical string rather than re-typing literals that could silently drift.

export const SOURCE_CONFIG_KEYS = {
    // boolean — operator enabled the OSV source. Default false (treated as off when unset).
    osvEnabled: 'sources.osv.enabled',
    // OsvSourceStatus snapshot — mirrored from osv.db by the worker after each sync so the portal can
    // render sync status reading ONLY the main DB (it never opens osv.db). Absent until the first sync.
    osvStatus: 'sources.osv.status'
} as const

// Compact sync-status snapshot the worker mirrors into the main app_config for the portal to read.
export type OsvSourceStatus = {
    // True once the initial full seed completed.
    seedComplete: boolean
    // Advisory→package row count after the last sync.
    recordCount: number
    // Epoch ms of the last successful sync, or null if never.
    refreshedAt: number | null
    // Last sync error message, or null.
    lastError: string | null
    // Free bytes on the osv.db volume at the last sync (for the provisioning hint), or null if unknown.
    freeBytes: number | null
}

// The scanner name OSV findings are recorded under (the `scanner` column on findings/scans). Must match
// the `name` field of the OSV scanner plugin so per-scanner merge scoping lines up across the codebase.
export const OSV_SCANNER_NAME = 'osv'
export const NPM_AUDIT_SCANNER_NAME = 'npm-audit'

// Approximate on-disk footprint of the OSV npm export, shown to the operator before they enable the
// source so they can provision the data volume. Measured against the live OSV bucket (May 2026):
// all.zip ≈ 196 MB; the normalized osv.db cache lands far smaller (~40–80 MB) because we keep only the
// matchable fields. We pre-flight free space against the seed download plus headroom.
export const OSV_SEED_DOWNLOAD_BYTES = 196 * 1024 * 1024
// Free-space floor required before the seed download is attempted: the zip on disk + the unpacked
// cache + working headroom. Conservative so a near-full volume fails fast instead of mid-write.
export const OSV_REQUIRED_FREE_BYTES = 600 * 1024 * 1024
