import { sql } from 'drizzle-orm'
import { DEFAULT_ECOSYSTEM, LEGACY_SOURCE_CONFIG_KEYS, sourceEnabledKey, sourceStatusKey } from '@sentinello/core'
import type { DrizzleDb } from '../client'
import { findingIdentityKey } from '../identity'
import { getConfigValue, setConfigValue } from './config'

// One-shot, idempotent Phase 2 (polyglot) migration backfill. Run from the worker boot AFTER the Drizzle
// schema migration adds the ecosystem/source columns. Every step is safe to re-run: the column copies use
// `IS NULL` guards, the identity_key recompute is deterministic (so a second run produces the same key and
// updates nothing), and the config-key copy skips keys that already exist. Pre-Phase-2 everything was npm,
// so the backfill value is always 'npm' / scanner.
//
// Why a code backfill and not pure SQL: the notification_events.identity_key is a SHA-256 of the identity
// tuple, and adding `ecosystem` to that tuple changes the hash. A column-only backfill would leave the
// stored key on the old (no-ecosystem) shape while fresh upserts compute the new shape — diverging the
// dedupe key and re-firing a notification for every current finding on the first post-upgrade scan. So we
// recompute the stored key here to keep the ledger aligned. SQLite has no SHA-256, hence JS.
export function backfillEcosystemIdentity(db: DrizzleDb): number {
    let changed = 0
    // 1. The persisted source identity === the scanner plugin name for every legacy row.
    changed += runCount(db, sql`UPDATE findings SET source = scanner WHERE source IS NULL`)
    changed += runCount(db, sql`UPDATE scans SET source = scanner WHERE source IS NULL`)
    // 2. Backfill 'npm' on the identity/audit tables whose ecosystem column has no DB default (the findings
    //    and scans columns default 'npm' via the schema, so they need no code backfill).
    db.run(sql`UPDATE mutes SET ecosystem = ${DEFAULT_ECOSYSTEM} WHERE scope = 'finding' AND ecosystem IS NULL`)
    db.run(sql`UPDATE mute_lifts SET ecosystem = ${DEFAULT_ECOSYSTEM} WHERE scope = 'finding' AND ecosystem IS NULL`)
    db.run(sql`UPDATE notification_events SET ecosystem = ${DEFAULT_ECOSYSTEM} WHERE event_type = 'finding' AND ecosystem IS NULL`)
    // 3. Re-key finding events so the stored identity_key matches the new (source, ecosystem) tuple hash.
    changed += recomputeFindingEventKeys(db)
    // 4. Migrate the legacy flat source-config keys to the per-cell npm-ecosystem keys.
    migrateLegacySourceConfig(db)
    return changed
}

function runCount(db: DrizzleDb, query: ReturnType<typeof sql>): number {
    return Number(db.run(query).changes) || 0
}

function recomputeFindingEventKeys(db: DrizzleDb): number {
    const rows = db.all<{
        id: string
        project_id: string
        scanner: string
        ecosystem: string | null
        advisory_id: string | null
        package_name: string | null
        identity_key: string
    }>(sql`
        SELECT id, project_id, scanner, ecosystem, advisory_id, package_name, identity_key
        FROM notification_events
        WHERE event_type = 'finding' AND advisory_id IS NOT NULL AND package_name IS NOT NULL
    `)
    let updated = 0
    for (const row of rows) {
        if (row.advisory_id === null || row.package_name === null) continue
        const newKey = findingIdentityKey({
            projectId: row.project_id,
            // The notification_events.scanner column carries the persisted source identity for finding
            // events; for legacy npm rows it equals the scanner name, so this recompute is source-correct.
            source: row.scanner,
            ecosystem: row.ecosystem ?? DEFAULT_ECOSYSTEM,
            advisoryId: row.advisory_id,
            packageName: row.package_name
        })
        if (newKey === row.identity_key) continue
        db.run(sql`UPDATE notification_events SET identity_key = ${newKey} WHERE id = ${row.id}`)
        updated += 1
    }
    return updated
}

function migrateLegacySourceConfig(db: DrizzleDb): void {
    copyConfigIfUnset(db, LEGACY_SOURCE_CONFIG_KEYS.osvEnabled, sourceEnabledKey('osv', DEFAULT_ECOSYSTEM))
    copyConfigIfUnset(db, LEGACY_SOURCE_CONFIG_KEYS.osvStatus, sourceStatusKey('osv', DEFAULT_ECOSYSTEM))
    copyConfigIfUnset(db, LEGACY_SOURCE_CONFIG_KEYS.gemnasiumEnabled, sourceEnabledKey('gemnasium', DEFAULT_ECOSYSTEM))
    copyConfigIfUnset(db, LEGACY_SOURCE_CONFIG_KEYS.gemnasiumStatus, sourceStatusKey('gemnasium', DEFAULT_ECOSYSTEM))
}

function copyConfigIfUnset(db: DrizzleDb, fromKey: string, toKey: string): void {
    if (getConfigValue(db, toKey) !== null) return
    const legacy = getConfigValue(db, fromKey)
    if (legacy === null) return
    setConfigValue(db, toKey, legacy)
}
