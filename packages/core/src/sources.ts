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

import { GEMNASIUM_NORMALIZER_VERSION, OSV_NORMALIZER_VERSION } from './advisory-rows'
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
    // The normalizer version the CACHED ROWS were built under, or null if never seeded. Mirrored raw
    // rather than pre-compared: the comparison is only ever true against the constant the READING
    // process is compiled with, so a boolean frozen into an app_config row goes stale exactly the way
    // seedComplete did. The scanner gates on seedComplete AND this === CURRENT, so the portal has to
    // read the same pair or it reports a cache the scanner refuses as "Up to date".
    normalizerVersion: number | null
    // Advisory→package row count as of the last SUCCESSFUL sync. Deliberately not recomputed during a
    // rebuild: this is the count the operator had, and the count they will have again.
    recordCount: number
    // Epoch ms of the last successful sync, or null if never.
    refreshedAt: number | null
    // Epoch ms the in-flight sync started, or null when nothing is running. Stamped when the sync
    // BEGINS, not only when it ends, so the portal can say so across a page reload — and so a rebuild
    // that stopped can be told from one still going. Held as a worker-process local rather than a
    // cache meta key, so a SIGKILL mid-rebuild self-heals on the next boot mirror instead of pinning
    // the row to "Rebuilding…" forever.
    syncStartedAt: number | null
    // Last sync error message, or null.
    lastError: string | null
}

// The normalizer version a cache-backed source's rows are currently expected to carry, or null for a
// source that keeps no cache and therefore has no snapshot to compare (npm-audit runs live). Lives
// here rather than in the Settings component so every reader of a mirrored SourceStatus compares
// against one table instead of restating the mapping.
export function sourceNormalizerVersion(source: SourceId): number | null {
    if (source === 'osv') return OSV_NORMALIZER_VERSION
    if (source === 'gemnasium') return GEMNASIUM_NORMALIZER_VERSION
    return null
}

// The scanner name OSV findings are recorded under (the `scanner` column on findings/scans). Must match
// the `name` field of the OSV scanner plugin so per-scanner merge scoping lines up across the codebase.
export const OSV_SCANNER_NAME = 'osv'
export const NPM_AUDIT_SCANNER_NAME = 'npm-audit'
// The scanner name gemnasium findings are recorded under. Must match the gemnasium scanner plugin name.
export const GEMNASIUM_SCANNER_NAME = 'gemnasium'

// Approximate on-disk footprint of the OSV npm export, shown to the operator before they enable the
// source so they can provision the data volume. Measured against the live OSV bucket (August 2026):
// all.zip ≈ 203.5 MB, rounded up; the normalized osv.db cache lands far smaller (~40–80 MB) because we
// keep only the matchable fields. We pre-flight free space against the seed download plus headroom.
// The corpus only grows, so re-measure when this drifts — the CLI HEADs for the real length and needs no
// constant, but the portal quotes this figure and pre-flights free space against it.
export const OSV_SEED_DOWNLOAD_BYTES = 204 * 1024 * 1024
// Free-space floor required before the seed download is attempted: the zip on disk + the unpacked
// cache + working headroom. Conservative so a near-full volume fails fast instead of mid-write.
export const OSV_REQUIRED_FREE_BYTES = 600 * 1024 * 1024

// Approximate on-disk footprint of the gemnasium-db archive, shown to the operator before they enable
// the source, and quoted by the CLI's consent prompt as an estimate. GitLab advertises no Content-Length
// on the archive route, so unlike OSV this can only ever be measured: a full download on 2026-08-03
// transferred 53,425,203 bytes (~51 MiB), against the 80 MiB this used to claim. The normalized
// gemnasium.db cache lands smaller still.
export const GEMNASIUM_SEED_DOWNLOAD_BYTES = 52 * 1024 * 1024
// Free-space floor required before the gemnasium seed download is attempted: archive on disk + the
// unpacked cache + working headroom.
export const GEMNASIUM_REQUIRED_FREE_BYTES = 300 * 1024 * 1024
