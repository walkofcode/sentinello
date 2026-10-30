import { getConfigValue, type DrizzleDb } from '@sentinello/db'
import {
    DEFAULT_ECOSYSTEM,
    LEGACY_SOURCE_CONFIG_KEYS,
    getSource,
    sourceCellStatusKey,
    type EcosystemId,
    type SourceId,
    type SourceStatus
} from '@sentinello/core'

// A cache-backed cell's last sync-status snapshot, as the Settings → Sources matrix shows it; null for a
// source with no cache (npm audit) or one never mirrored yet. Read from where the worker writes it
// (sourceCellStatusKey): per cell for OSV, gemnasium's one status for every gemnasium cell. A status the
// cell's key does not hold yet falls back, for the npm cell only, to the legacy flat key, for the brief
// window before the worker boot migrates it.
//
// Lives here rather than in the page because .tsx is outside the coverage globs.
export function readSourceCellStatus(db: DrizzleDb, source: SourceId, ecosystem: EcosystemId): SourceStatus | null {
    if (!getSource(source)?.cacheBacked) return null
    const status = getConfigValue<SourceStatus>(db, sourceCellStatusKey(source, ecosystem))
    if (status || ecosystem !== DEFAULT_ECOSYSTEM) return status
    const legacyKey = source === 'osv' ? LEGACY_SOURCE_CONFIG_KEYS.osvStatus : LEGACY_SOURCE_CONFIG_KEYS.gemnasiumStatus
    return getConfigValue<SourceStatus>(db, legacyKey)
}
