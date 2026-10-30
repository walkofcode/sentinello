import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb, type DrizzleDb, type SqliteDb } from './client'
import { runMigrations } from './migrate'
import { backfillEcosystemIdentity } from './queries/ecosystem-backfill'

// The 3.8 upgrade, run against a database at the 3.7 schema holding the rows an ordinary install has
// (SENTINEL-121). The 3.8 migrations rebuild `scans` and `findings` (their `npm` default goes away) while
// other tables reference them, and leave `mutes`, `mute_lifts` and `notification_events.ecosystem`
// nullable because NULL is meaningful there: a project mute, its lift and a scan-failure event have no
// ecosystem. Migrations run before the boot backfill, so a NOT NULL rebuild would have failed the boot on
// any of them.

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle')
// The last migration of the 3.7 schema.
const LAST_PRE_3_8 = 12

let dir: string
let db: DrizzleDb
let sqlite: SqliteDb

// A copy of the migrations folder that stops at the 3.7 schema: the SQL files and a journal cut there.
async function preUpgradeMigrations(): Promise<string> {
    const out = join(dir, 'drizzle-3.7')
    await mkdir(join(out, 'meta'), { recursive: true })
    const journal = JSON.parse(await readFile(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as { entries: { idx: number; tag: string }[] }
    journal.entries = journal.entries.filter(function upTo(entry) { return entry.idx <= LAST_PRE_3_8 })
    await writeFile(join(out, 'meta', '_journal.json'), JSON.stringify(journal))
    const keep = new Set(journal.entries.map(function file(entry) { return entry.tag + '.sql' }))
    for (const name of await readdir(MIGRATIONS)) {
        if (keep.has(name)) await copyFile(join(MIGRATIONS, name), join(out, name))
    }
    return out
}

const TABLES = ['roots', 'projects', 'scans', 'findings', 'mutes', 'mute_lifts', 'notification_targets', 'notification_events', 'notification_deliveries']

function counts(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const table of TABLES) out[table] = (sqlite.prepare('SELECT COUNT(*) AS n FROM ' + table).get() as { n: number }).n
    return out
}

// The rows an ordinary 3.7 install holds, written in the 3.7 shape: scans and findings without an
// ecosystem (the column default supplied 'npm'), a project mute, a finding mute with its ecosystem, a legacy
// finding mute without one, lifts of both scopes, a scan-failure event and a finding event with deliveries.
function seed3_7(): void {
    sqlite.exec(`
        INSERT INTO roots (id, path, label, created_at) VALUES ('r1', '/roots/a', NULL, 1);
        INSERT INTO projects (id, root_id, rel_path, name, package_manager, created_at, updated_at)
            VALUES ('p1', 'r1', 'app', 'app', 'pnpm', 1, 1);
        INSERT INTO scans (id, project_id, started_at, finished_at, scanner, source, status, reason_code, duration_ms, raw_json)
            VALUES ('s1', 'p1', 1, 2, 'npm-audit', 'npm-audit', 'ok', 'ok', 1, '{}'),
                   ('s2', 'p1', 1, 3, 'osv', 'osv', 'unauditable', 'osv_db_not_seeded', 1, '');
        INSERT INTO findings (id, scan_id, project_id, scanner, source, advisory_id, package_name, installed_version, vulnerable_range, severity, first_detected_at, last_seen_at)
            VALUES ('f1', 's1', 'p1', 'npm-audit', 'npm-audit', 'GHSA-1', 'lodash', '4.17.20', '<4.17.21', 'high', 2, 2),
                   ('f2', 's1', 'p1', 'npm-audit', 'npm-audit', 'GHSA-2', 'minimist', '1.2.0', '<1.2.6', 'critical', 2, 2);
        INSERT INTO mutes (id, scope, project_id, scanner, ecosystem, advisory_id, package_name, reason, author, created_at)
            VALUES ('m-project', 'project', 'p1', NULL, NULL, NULL, NULL, 'archived', 'ops', 1),
                   ('m-finding', 'finding', 'p1', 'npm-audit', 'npm', 'GHSA-1', 'lodash', 'accepted', 'ops', 1),
                   ('m-legacy', 'finding', NULL, 'npm-audit', NULL, 'GHSA-2', 'minimist', 'accepted', 'ops', 1);
        INSERT INTO mute_lifts (id, mute_id, lifted_at, scope, project_id, scanner, ecosystem, advisory_id, package_name, reason, author)
            VALUES ('l-project', 'm-old-project', 5, 'project', 'p1', NULL, NULL, NULL, NULL, 'expired', 'ops'),
                   ('l-legacy', 'm-old-finding', 5, 'finding', 'p1', 'npm-audit', NULL, 'GHSA-1', 'lodash', 'expired', 'ops');
        INSERT INTO notification_targets (id, kind, config_json, created_at) VALUES ('t1', 'slack', '{}', 1);
        INSERT INTO notification_events (id, event_type, identity_key, project_id, scanner, ecosystem, advisory_id, package_name, severity, failure_signature, first_scan_id, first_seen_at, last_seen_at)
            VALUES ('e-failure', 'scan_failure', 'k-failure', 'p1', 'osv', NULL, NULL, NULL, NULL, 'osv_db_not_seeded', 's2', 3, 3),
                   ('e-finding', 'finding', 'k-finding', 'p1', 'npm-audit', 'npm', 'GHSA-1', 'lodash', 'high', NULL, 's1', 2, 2);
        INSERT INTO notification_deliveries (id, event_id, target_id, first_attempted_at, first_succeeded_at, last_attempted_at)
            VALUES ('d1', 'e-finding', 't1', 2, 2, 2),
                   ('d2', 'e-failure', 't1', 3, NULL, 3);
    `)
}

beforeEach(async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-migration-3-8-'))
    ;({ db, sqlite } = openDb({ dbPath: join(dir, 'sentinello.sqlite') }))
    runMigrations(db, { migrationsFolder: await preUpgradeMigrations() })
    seed3_7()
})

afterEach(async function teardown() {
    sqlite.close()
    await rm(dir, { recursive: true, force: true })
})

function column(table: string, id: string, name: string): unknown {
    return (sqlite.prepare('SELECT ' + name + ' AS v FROM ' + table + ' WHERE id = ?').get(id) as { v: unknown }).v
}

describe('the 3.8 upgrade of a 3.7 database', function () {
    it('keeps every row, keeps semantic NULLs, and leaves no foreign key broken', function () {
        const before = counts()
        runMigrations(db, { migrationsFolder: MIGRATIONS })
        backfillEcosystemIdentity(db)
        expect(counts()).toEqual(before)
        // NULL is what a project mute, its lift and a scan-failure event ARE: nothing invents npm for them.
        expect(column('mutes', 'm-project', 'ecosystem')).toBeNull()
        expect(column('mute_lifts', 'l-project', 'ecosystem')).toBeNull()
        expect(column('notification_events', 'e-failure', 'ecosystem')).toBeNull()
        // Finding-scope rows carry their ecosystem: kept where it was written, filled by the boot backfill
        // where a pre-polyglot row had none.
        expect(column('mutes', 'm-finding', 'ecosystem')).toBe('npm')
        expect(column('mutes', 'm-legacy', 'ecosystem')).toBe('npm')
        expect(column('mute_lifts', 'l-legacy', 'ecosystem')).toBe('npm')
        expect(column('notification_events', 'e-finding', 'ecosystem')).toBe('npm')
        // The rebuilt tables kept the values the old column default had supplied.
        expect(column('scans', 's1', 'ecosystem')).toBe('npm')
        expect(column('findings', 'f1', 'ecosystem')).toBe('npm')
        // New columns read as "recorded nothing yet".
        expect(column('findings', 'f1', 'installations_json')).toBe('[]')
        expect(column('projects', 'p1', 'manifests_json')).toBe('[]')
        expect(column('notification_events', 'e-finding', 'baseline_of')).toBeNull()
        expect(sqlite.pragma('foreign_key_check')).toEqual([])
        expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1)
    })

    it('no longer lets a scan or a finding be written without an ecosystem', function () {
        runMigrations(db, { migrationsFolder: MIGRATIONS })
        expect(function scanWithoutEcosystem() {
            sqlite.exec(`INSERT INTO scans (id, project_id, started_at, finished_at, scanner, source, status, reason_code, duration_ms, raw_json)
                VALUES ('s3', 'p1', 1, 4, 'osv', 'osv', 'ok', 'ok', 1, '{}')`)
        }).toThrow(/NOT NULL constraint failed: scans.ecosystem/)
        expect(function findingWithoutEcosystem() {
            sqlite.exec(`INSERT INTO findings (id, scan_id, project_id, scanner, source, advisory_id, package_name, installed_version, vulnerable_range, severity)
                VALUES ('f3', 's1', 'p1', 'osv', 'osv', 'GHSA-3', 'rack', '2.0.0', '<2.1.0', 'low')`)
        }).toThrow(/NOT NULL constraint failed: findings.ecosystem/)
    })
})

// drizzle-kit's rebuilds switch foreign keys off inside the migrator's transaction, where SQLite ignores it;
// runMigrations does it outside instead, and checks the keys before switching enforcement back on.
describe('runMigrations and foreign keys', function () {
    it('fails loudly when the database is left with a dangling reference', function () {
        runMigrations(db, { migrationsFolder: MIGRATIONS })
        sqlite.pragma('foreign_keys = OFF')
        sqlite.exec(`INSERT INTO findings (id, scan_id, project_id, scanner, source, ecosystem, advisory_id, package_name, installed_version, vulnerable_range, severity)
            VALUES ('dangling', 'no-such-scan', 'p1', 'osv', 'osv', 'npm', 'GHSA-9', 'x', '1.0.0', '<2.0.0', 'low')`)
        sqlite.pragma('foreign_keys = ON')
        expect(function rerun() { runMigrations(db, { migrationsFolder: MIGRATIONS }) }).toThrow(/migration left 1 foreign key violation/)
        expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1)
    })

    it('leaves enforcement off on a connection that never had it on', function () {
        sqlite.pragma('foreign_keys = OFF')
        runMigrations(db, { migrationsFolder: MIGRATIONS })
        expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(0)
    })
})
