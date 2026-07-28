import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_ECOSYSTEM, LEGACY_SOURCE_CONFIG_KEYS, sourceEnabledKey, sourceStatusKey } from '@sentinello/core'
import { openDb } from '../client'
import type { DrizzleDb, SqliteDb } from '../client'
import { runMigrations } from '../migrate'
import { findingIdentityKey } from '../identity'
import { getConfigValue, setConfigValue, upsertRoot } from './config'
import { upsertProject } from './projects'
import { insertScan } from './scans'
import { getEventByIdentityKey, upsertFindingEvent } from './notification-events'
import { backfillEcosystemIdentity } from './ecosystem-backfill'

// A one-shot upgrade step, and the reason it exists in code rather than SQL is the interesting part.
// notification_events.identity_key is a SHA-256 of the identity tuple, and adding `ecosystem` to that
// tuple changes the hash. Backfilling only the columns would leave stored keys on the old shape while
// fresh upserts compute the new one — the dedupe key diverges and every current finding notifies
// again on the first post-upgrade scan. SQLite has no SHA-256, so the recompute happens here.
//
// Idempotency is the other requirement: the worker runs this on every boot, so a second pass must
// change nothing.

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle')

const ROOT_ID = 'root-1'
const PROJECT_ID = 'project-1'
const SCAN_ID = 'scan-1'
const T0 = Date.UTC(2026, 0, 1)

let db: DrizzleDb
let sqlite: SqliteDb
let dir: string

function seedEvent(): string {
    return upsertFindingEvent(db, {
        projectId: PROJECT_ID,
        source: 'osv',
        ecosystem: DEFAULT_ECOSYSTEM,
        advisoryId: 'CVE-2024-1',
        packageName: 'lodash',
        severity: 'high',
        firstScanId: SCAN_ID,
        at: T0
    }).eventId
}

// Rewrites a row into the pre-upgrade shape the backfill is meant to repair: null ecosystem/source
// columns and an identity_key hashed without the ecosystem axis.
function makeLegacy(eventId: string): string {
    const legacyKey = 'legacy-key-' + eventId
    db.run(sql`UPDATE notification_events SET ecosystem = NULL, identity_key = ${legacyKey} WHERE id = ${eventId}`)
    return legacyKey
}

beforeEach(async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-backfill-'))
    const opened = openDb({ dbPath: join(dir, 'test.sqlite') })
    db = opened.db
    sqlite = opened.sqlite
    runMigrations(db, { migrationsFolder: MIGRATIONS })
    upsertRoot(db, { id: ROOT_ID, path: '/repo', label: null, createdAt: T0 })
    upsertProject(db, {
        id: PROJECT_ID,
        rootId: ROOT_ID,
        relPath: 'app',
        name: 'app',
        alias: null,
        packageManager: 'npm',
        nvmrcVersion: null,
        gitBranch: null,
        ecosystems: ['npm'],
        muted: false,
        tags: [],
        createdAt: T0,
        updatedAt: T0
    })
    insertScan(db, {
        id: SCAN_ID,
        projectId: PROJECT_ID,
        startedAt: T0 - 1000,
        finishedAt: T0,
        scanner: 'osv',
        source: 'osv',
        ecosystem: 'npm',
        status: 'ok',
        reasonCode: 'ok',
        durationMs: 1000,
        errorText: null,
        rawJson: ''
    })
})

afterEach(async function teardown() {
    sqlite.close()
    await rm(dir, { recursive: true, force: true })
})

describe('backfillEcosystemIdentity — identity keys', function () {
    // The whole reason this is code and not SQL. A stale key means the next scan treats every
    // existing finding as new and notifies again.
    it('re-keys a legacy event to the ecosystem-aware hash', function () {
        const eventId = seedEvent()
        const legacyKey = makeLegacy(eventId)
        expect(getEventByIdentityKey(db, legacyKey)).not.toBeNull()

        expect(backfillEcosystemIdentity(db)).toBeGreaterThan(0)

        const expectedKey = findingIdentityKey({
            projectId: PROJECT_ID,
            source: 'osv',
            ecosystem: DEFAULT_ECOSYSTEM,
            advisoryId: 'CVE-2024-1',
            packageName: 'lodash'
        })
        expect(getEventByIdentityKey(db, expectedKey)?.id).toBe(eventId)
        expect(getEventByIdentityKey(db, legacyKey)).toBeNull()
    })

    // The worker runs this on every boot, so a second pass must be a no-op rather than churning rows.
    it('is idempotent', function () {
        const eventId = seedEvent()
        makeLegacy(eventId)
        backfillEcosystemIdentity(db)
        expect(backfillEcosystemIdentity(db)).toBe(0)
    })

    it('leaves an already-correct key alone', function () {
        seedEvent()
        expect(backfillEcosystemIdentity(db)).toBe(0)
    })

    it('backfills the npm ecosystem onto a legacy finding event', function () {
        const eventId = seedEvent()
        makeLegacy(eventId)
        backfillEcosystemIdentity(db)
        const row = db.get<{ ecosystem: string | null }>(
            sql`SELECT ecosystem FROM notification_events WHERE id = ${eventId}`
        )
        expect(row?.ecosystem).toBe(DEFAULT_ECOSYSTEM)
    })

    it('does nothing on an empty database', function () {
        expect(backfillEcosystemIdentity(db)).toBe(0)
    })
})

describe('backfillEcosystemIdentity — source columns', function () {
    it('copies the scanner name into a null findings source', function () {
        db.run(sql`
            INSERT INTO findings (id, scan_id, project_id, scanner, source, ecosystem, advisory_id, advisory_title,
                advisory_url, package_name, installed_version, vulnerable_range, severity, fix_available, fix_version,
                dep_path_json, is_prod, is_dev, first_detected_at, last_seen_at, resolved_at)
            VALUES ('f1', ${SCAN_ID}, ${PROJECT_ID}, 'npm-audit', NULL, 'npm', 'CVE-2024-1', NULL, NULL,
                'lodash', '4.17.11', '<4.17.21', 'high', 1, '4.17.21', '[]', 1, 0, ${T0}, ${T0}, NULL)
        `)
        expect(backfillEcosystemIdentity(db)).toBeGreaterThan(0)
        const row = db.get<{ source: string | null }>(sql`SELECT source FROM findings WHERE id = 'f1'`)
        expect(row?.source).toBe('npm-audit')
    })

    it('copies the scanner name into a null scans source', function () {
        db.run(sql`UPDATE scans SET source = NULL WHERE id = ${SCAN_ID}`)
        expect(backfillEcosystemIdentity(db)).toBeGreaterThan(0)
        const row = db.get<{ source: string | null }>(sql`SELECT source FROM scans WHERE id = ${SCAN_ID}`)
        expect(row?.source).toBe('osv')
    })

    it('leaves an already-populated source alone', function () {
        db.run(sql`UPDATE scans SET source = 'gemnasium' WHERE id = ${SCAN_ID}`)
        backfillEcosystemIdentity(db)
        const row = db.get<{ source: string | null }>(sql`SELECT source FROM scans WHERE id = ${SCAN_ID}`)
        expect(row?.source).toBe('gemnasium')
    })
})

describe('backfillEcosystemIdentity — legacy source config', function () {
    // Pre-Phase-2 the source toggles were flat keys. Migrating them to the per-cell npm keys is what
    // stops an upgrade from silently switching an operator's enabled source back off.
    it('migrates a legacy enabled flag to the npm cell key', function () {
        setConfigValue(db, LEGACY_SOURCE_CONFIG_KEYS.osvEnabled, true)
        backfillEcosystemIdentity(db)
        expect(getConfigValue(db, sourceEnabledKey('osv', DEFAULT_ECOSYSTEM))).toBe(true)
    })

    it('migrates a legacy disabled flag rather than treating false as absent', function () {
        setConfigValue(db, LEGACY_SOURCE_CONFIG_KEYS.gemnasiumEnabled, false)
        backfillEcosystemIdentity(db)
        expect(getConfigValue(db, sourceEnabledKey('gemnasium', DEFAULT_ECOSYSTEM))).toBe(false)
    })

    it('migrates legacy status keys too', function () {
        setConfigValue(db, LEGACY_SOURCE_CONFIG_KEYS.osvStatus, { seeded: true })
        backfillEcosystemIdentity(db)
        expect(getConfigValue(db, sourceStatusKey('osv', DEFAULT_ECOSYSTEM))).toEqual({ seeded: true })
    })

    // A value already written under the new key is the operator's current choice and outranks the
    // legacy one.
    it('does not overwrite an existing cell key', function () {
        setConfigValue(db, LEGACY_SOURCE_CONFIG_KEYS.osvEnabled, true)
        setConfigValue(db, sourceEnabledKey('osv', DEFAULT_ECOSYSTEM), false)
        backfillEcosystemIdentity(db)
        expect(getConfigValue(db, sourceEnabledKey('osv', DEFAULT_ECOSYSTEM))).toBe(false)
    })

    it('leaves the cell key unset when there is no legacy value', function () {
        backfillEcosystemIdentity(db)
        expect(getConfigValue(db, sourceEnabledKey('osv', DEFAULT_ECOSYSTEM))).toBeNull()
    })
})
