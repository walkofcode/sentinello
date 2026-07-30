import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OSV_NORMALIZER_VERSION } from '../../../packages/core/src/advisory-rows'
import { openOsvDb, runOsvMigrations } from '../../../packages/db/src/osv-client'
import {
    OSV_META_KEYS,
    countOsvAdvisories,
    osvMetaKeyFor,
    setOsvMeta,
    upsertOsvAdvisories
} from '../../../packages/db/src/queries/osv'
import { E2E_OSV_DB_PATH } from './paths'
import type { OsvAdvisoryRow } from '../../../packages/core/src/advisory-rows'

// Hand-seeds the OSV advisory cache so scans run entirely offline.
//
// This is what lets a REAL worker run in the suite. npm audit spawns the package manager and needs
// the registry; the OSV path reads a package-lock.json and this local SQLite cache and nothing else —
// packages/scanners/src/osv.ts ignores the project path entirely and works off the resolved graph, so
// there is no node_modules to install either.
//
// tests/fixtures/advisories/osv-npm.ndjson is already exactly OsvAdvisoryRow[], the shape
// upsertOsvAdvisories takes, and is the same file the CLI e2e suite seeds its cache from.

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = resolve(HERE, '..', '..', 'fixtures', 'advisories', 'osv-npm.ndjson')

// Fixed rather than Date.now(): it is displayed in Settings → Sources as "last refreshed", and a
// moving value would make that panel unassertable.
const REFRESHED_AT = Date.UTC(2026, 0, 1)

export function seedOsvCache(): { path: string; count: number } {
    const { db, sqlite, dbPath } = openOsvDb(E2E_OSV_DB_PATH)
    runOsvMigrations(db)

    const rows = readFileSync(FIXTURE, 'utf8')
        .split('\n')
        .filter(function nonEmpty(line) { return line.trim().length > 0 })
        .map(function parse(line) { return JSON.parse(line) as OsvAdvisoryRow })
    upsertOsvAdvisories(db, rows)

    const count = countOsvAdvisories(db, 'npm')

    // BOTH stamps, and the second one is load-bearing rather than cosmetic. The scanner's isSeeded
    // gate (apps/worker/src/osv-runtime.ts) requires seedComplete === true AND normalizerVersion ===
    // OSV_NORMALIZER_VERSION. Set only the first and every scan returns unauditable/osv_db_not_seeded
    // — which reads as "no vulnerabilities found" in the portal rather than as an error.
    setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.seedComplete, 'npm'), true)
    setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.normalizerVersion, 'npm'), OSV_NORMALIZER_VERSION)
    setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.recordCount, 'npm'), count)
    setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.refreshedAt, 'npm'), REFRESHED_AT)
    setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.lastError, 'npm'), null)

    sqlite.close()
    return { path: dbPath, count }
}
