import { sql, type SQL } from 'drizzle-orm'
import { NPM_AUDIT_SCANNER_NAME, OSV_SCANNER_NAME, SOURCE_CONFIG_KEYS } from '@sentinello/core'
import type { DrizzleDb } from '../client'
import { getConfigValue } from './config'

// The set of vulnerability sources whose findings are currently visible in the portal. npm-audit is
// the always-on built-in source; OSV is opt-in (Settings → Sources) and only contributes once the
// operator enables it. Disabling a source does NOT delete its finding rows — they simply fall out of
// this set so every current-findings read path hides them, and re-enabling brings them back intact
// (original firstDetectedAt preserved; the next scan for that source refreshes / resolves them).
export function getActiveScanners(db: DrizzleDb): string[] {
    const active = [NPM_AUDIT_SCANNER_NAME]
    if (getConfigValue<boolean>(db, SOURCE_CONFIG_KEYS.osvEnabled) === true) active.push(OSV_SCANNER_NAME)
    return active
}

// Append-only WHERE fragment restricting a findings row to the currently-active sources, mirroring
// depTypeClause so callers interpolate it without restructuring their query. The alias points at
// whichever findings alias the caller already used (defaults to 'f'). Scanner names are fixed
// constants — never user input — and the set is never empty (npm-audit is always present), so the
// inlined IN-list carries no injection risk and never degenerates to an empty `IN ()`.
export function activeScannerClause(db: DrizzleDb, alias: string = 'f'): SQL {
    const list = getActiveScanners(db).map(function quote(s) { return `'${s}'` }).join(', ')
    return sql.raw(`AND ${alias}.scanner IN (${list})`)
}
