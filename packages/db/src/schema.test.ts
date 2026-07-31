import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { getTableConfig } from 'drizzle-orm/sqlite-core'
import type { SQLiteTable } from 'drizzle-orm/sqlite-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDb } from './client'
import type { SqliteDb } from './client'
import { runMigrations } from './migrate'
import * as schema from './schema'

// schema.ts is the literal contract between apps/web and apps/worker, and nothing tested it directly —
// every other db suite exercises it only through the queries that happen to touch a given column.
//
// Two properties are worth asserting, and neither is checkable by reading the file:
//
//  1. Each `.references()` points at the table its column name implies. Those are lazy thunks (drizzle
//     only calls them when it builds the constraint), so a mis-aimed one — `resolvedScanId` pointing at
//     `projects`, say — typechecks, imports, and stays invisible until drizzle-kit next generates SQL.
//  2. The model has not drifted from the migrations. Migrations are generated (never hand-written) and
//     applied by the worker at boot, while the portal opens the same file WITHOUT migrating. So a
//     column added to this file but never generated into a migration produces "no such column" in the
//     portal at runtime rather than a build failure anywhere.
//
// The drift check reads the real migrated database through PRAGMA rather than re-parsing the migration
// SQL, so it covers the end state after every migration has replayed in order.

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle')

type PragmaColumn = { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }
type PragmaForeignKey = { table: string; from: string; to: string | null; on_delete: string }
type PragmaIndex = { name: string; unique: number }

let sqlite: SqliteDb
let dir: string

// One migrated database for the whole file: every test here reads schema metadata and writes nothing,
// so per-test isolation would only pay to replay the same migrations.
beforeAll(async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-schema-'))
    const opened = openDb({ dbPath: join(dir, 'test.sqlite') })
    sqlite = opened.sqlite
    runMigrations(opened.db, { migrationsFolder: MIGRATIONS })
})

afterAll(async function teardown() {
    sqlite.close()
    await rm(dir, { recursive: true, force: true })
})

// Every table the schema exports, by its export name. Iterating the module rather than listing them
// means a table added to schema.ts without a migration fails here instead of being skipped silently.
const TABLES = Object.entries(schema) as Array<[string, SQLiteTable]>

describe('exported tables', function () {
    it('exports every table the rest of the package imports', function () {
        expect(TABLES.map(function name(entry) { return entry[0] })).toEqual([
            'roots',
            'projects',
            'scans',
            'findings',
            'mutes',
            'notificationTargets',
            'notificationTargetRoots',
            'notificationTargetProjects',
            'scanRequests',
            'appConfig',
            'workerSignals',
            'notificationEvents',
            'muteLifts',
            'notificationDeliveries'
        ])
    })

    it('names every table in snake_case', function () {
        for (const [, table] of TABLES) {
            expect(getTableConfig(table).name).toMatch(/^[a-z][a-z0-9_]*$/)
        }
    })
})

describe('foreign keys', function () {
    // Calling fk.reference() is what invokes the `.references(function ref() { … })` thunk, so this
    // table is both the assertion and the only thing that executes those closures at all.
    function referencesOf(table: SQLiteTable): string[] {
        return getTableConfig(table).foreignKeys.map(function describe(fk) {
            const ref = fk.reference()
            const from = ref.columns.map(function n(c) { return c.name }).join(',')
            const to = getTableConfig(ref.foreignTable).name + '.' + ref.foreignColumns.map(function n(c) { return c.name }).join(',')
            return from + ' -> ' + to
        })
    }

    // Stated as a full expected set per table rather than per-key assertions: a FK REMOVED from the
    // schema is as much a regression as one re-pointed, and only an exact-match catches that.
    it.each([
        ['projects', schema.projects, ['root_id -> roots.id']],
        ['scans', schema.scans, ['project_id -> projects.id']],
        // resolved_scan_id is the interesting one — two of findings' three FKs land on scans, and the
        // pair is easy to transpose. scan_id is the scan that FIRST detected the episode;
        // resolved_scan_id is the one that observed it gone.
        ['findings', schema.findings, ['scan_id -> scans.id', 'project_id -> projects.id', 'resolved_scan_id -> scans.id']],
        ['mutes', schema.mutes, ['project_id -> projects.id']],
        ['notification_target_roots', schema.notificationTargetRoots, ['target_id -> notification_targets.id', 'root_id -> roots.id']],
        ['notification_target_projects', schema.notificationTargetProjects, ['target_id -> notification_targets.id', 'project_id -> projects.id']],
        ['scan_requests', schema.scanRequests, ['project_id -> projects.id', 'root_id -> roots.id']],
        ['notification_events', schema.notificationEvents, ['project_id -> projects.id', 'first_scan_id -> scans.id']],
        ['notification_deliveries', schema.notificationDeliveries, ['event_id -> notification_events.id', 'target_id -> notification_targets.id']]
    ])('%s points at the tables its column names imply', function (_label, table, expected) {
        expect(referencesOf(table as SQLiteTable)).toEqual(expected)
    })

    it.each([
        ['roots', schema.roots],
        ['notification_targets', schema.notificationTargets],
        ['app_config', schema.appConfig],
        ['worker_signals', schema.workerSignals],
        // mute_lifts deliberately carries no FK: it is an audit journal of mutes that were auto-lifted,
        // and the mute row it describes is gone by the time the entry is written.
        ['mute_lifts', schema.muteLifts]
    ])('%s declares no foreign key', function (_label, table) {
        expect(referencesOf(table as SQLiteTable)).toEqual([])
    })

    // The only non-default FK action in the schema, and it encodes a deliberate retention decision:
    // deleting a notification target must not delete the audit trail of what was already sent to it.
    // Every other FK relies on the default NO ACTION, which with foreign_keys=ON BLOCKS a parent
    // delete — that is what forces deleteNotificationTarget to clear its scope rows child-first.
    it('sets null on notification_deliveries.target_id so audit rows survive a target delete', function () {
        const fks = getTableConfig(schema.notificationDeliveries).foreignKeys
        const byColumn = new Map(fks.map(function pair(fk) {
            return [fk.reference().columns[0]?.name, fk.onDelete]
        }))
        expect(byColumn.get('target_id')).toBe('set null')
        expect(byColumn.get('event_id')).toBeUndefined()
    })

    it('leaves every other foreign key on the default action', function () {
        for (const [, table] of TABLES) {
            for (const fk of getTableConfig(table).foreignKeys) {
                const column = fk.reference().columns[0]?.name
                if (getTableConfig(table).name === 'notification_deliveries' && column === 'target_id') continue
                expect(fk.onDelete).toBeUndefined()
                expect(fk.onUpdate).toBeUndefined()
            }
        }
    })
})

describe('the migrated database matches the model', function () {
    function columnsIn(tableName: string): Map<string, PragmaColumn> {
        const rows = sqlite.prepare('PRAGMA table_info(' + tableName + ')').all() as PragmaColumn[]
        return new Map(rows.map(function pair(r) { return [r.name, r] }))
    }

    it.each(TABLES.map(function name(entry) { return [getTableConfig(entry[1]).name, entry[1]] as const }))(
        '%s exists with every column the model declares',
        function (tableName, table) {
            const actual = columnsIn(tableName)
            expect(actual.size).toBeGreaterThan(0)
            for (const column of getTableConfig(table as SQLiteTable).columns) {
                const found = actual.get(column.name)
                expect(found, tableName + '.' + column.name + ' is missing from the migrations').toBeDefined()
                // notNull is asserted rather than just presence: relaxing a column in the model without
                // a migration is the drift that surfaces as a constraint failure on the first write.
                expect(Boolean(found?.notnull), tableName + '.' + column.name + ' nullability').toBe(column.notNull)
            }
        }
    )

    it.each(TABLES.map(function name(entry) { return [getTableConfig(entry[1]).name, entry[1]] as const }))(
        '%s carries the foreign keys the model declares',
        function (tableName, table) {
            const rows = sqlite.prepare('PRAGMA foreign_key_list(' + tableName + ')').all() as PragmaForeignKey[]
            const actual = new Set(rows.map(function key(r) { return r.from + ' -> ' + r.table }))
            for (const fk of getTableConfig(table as SQLiteTable).foreignKeys) {
                const ref = fk.reference()
                const from = ref.columns[0]?.name
                const to = getTableConfig(ref.foreignTable).name
                expect(actual, tableName + '.' + from).toContain(from + ' -> ' + to)
            }
            expect(actual.size).toBe(getTableConfig(table as SQLiteTable).foreignKeys.length)
        }
    )

    it.each(TABLES.map(function name(entry) { return [getTableConfig(entry[1]).name, entry[1]] as const }))(
        '%s carries the indexes the model declares',
        function (tableName, table) {
            const rows = sqlite.prepare('PRAGMA index_list(' + tableName + ')').all() as PragmaIndex[]
            const actual = new Map(rows.map(function pair(r) { return [r.name, Boolean(r.unique)] }))
            for (const index of getTableConfig(table as SQLiteTable).indexes) {
                const name = index.config.name
                expect(actual.has(name), name + ' is missing from the migrations').toBe(true)
                expect(actual.get(name), name + ' uniqueness').toBe(Boolean(index.config.unique))
            }
        }
    )
})

describe('the indexes the query layer depends on', function () {
    function indexNames(table: SQLiteTable): string[] {
        return getTableConfig(table).indexes.map(function name(i) { return i.config.name })
    }

    // Named individually because each one backs a specific measured access path, and dropping one is
    // silent — the query still returns the right answer, just slowly enough to matter.
    it('keeps the composite index that makes "latest scan per project" fast', function () {
        // Without this, SQLite finds every scan for a project then sorts them in a TEMP B-TREE on
        // finished_at, per row of a full scans scan. The single-column indexes below do not substitute.
        const columns = getTableConfig(schema.scans).indexes.find(function find(i) {
            return i.config.name === 'scans_project_finished_idx'
        })
        expect(columns).toBeDefined()
        expect(indexNames(schema.scans)).toEqual([
            'scans_project_id_idx',
            'scans_finished_at_idx',
            'scans_project_finished_idx'
        ])
    })

    // The findings identity index must cover `source` (the persisted source identity), NOT `scanner`
    // (the plugin/provenance name). Indexing scanner would still look plausible and would still be
    // used — for the wrong tuple, on the axis the merge does not dedupe by.
    it('indexes findings on the source-keyed identity tuple', function () {
        const identity = getTableConfig(schema.findings).indexes.find(function find(i) {
            return i.config.name === 'findings_identity_idx'
        })
        const columns = identity?.config.columns.map(function n(c) { return 'name' in c ? c.name : String(c) })
        expect(columns).toEqual(['project_id', 'source', 'ecosystem', 'advisory_id', 'package_name'])
    })

    // Deliberately absent, and worth pinning: the pre-lifecycle snapshot model allowed several rows per
    // identity (one per dep path), so a unique index here would fail the migration on existing data.
    // mergeFindingsForScan enforces "one open episode per identity" in code instead.
    it('declares no unique index on findings', function () {
        const unique = getTableConfig(schema.findings).indexes.filter(function isUnique(i) { return i.config.unique })
        expect(unique).toEqual([])
    })

    it('makes the notification identity key and the delivery pair unique', function () {
        const events = getTableConfig(schema.notificationEvents).indexes.find(function find(i) {
            return i.config.name === 'notification_events_identity_key_uidx'
        })
        expect(events?.config.unique).toBe(true)
        const deliveries = getTableConfig(schema.notificationDeliveries).indexes.find(function find(i) {
            return i.config.name === 'notification_deliveries_pair_uidx'
        })
        expect(deliveries?.config.unique).toBe(true)
    })
})

describe('column defaults that keep pre-migration rows readable', function () {
    // Each of these defaults exists so rows written before a column arrived stay usable rather than
    // reading as null. Removing one is silent until an old row is read.
    it.each([
        ['scans.ecosystem', schema.scans, 'ecosystem', 'npm'],
        ['findings.ecosystem', schema.findings, 'ecosystem', 'npm'],
        ['findings.dep_path_json', schema.findings, 'depPathJson', '[]'],
        ['projects.tags_json', schema.projects, 'tagsJson', '[]'],
        ['projects.ecosystems_json', schema.projects, 'ecosystemsJson', '[]'],
        ['notification_targets.env_filter', schema.notificationTargets, 'envFilter', 'all'],
        ['notification_targets.source_scope_json', schema.notificationTargets, 'sourceScopeJson', '{"mode":"all","cells":[]}']
    ])('%s defaults so legacy rows stay readable', function (_label, table, property, expected) {
        const columns = getTableConfig(table as SQLiteTable).columns
        const column = columns.find(function find(c) { return c.name === snake(property as string) })
        expect(column?.default).toBe(expected)
    })

    // findings.ecosystem is NOT NULL with a default, which is why the `?? 'npm'` fallbacks and the
    // SQL COALESCE(f.ecosystem, 'npm') elsewhere in the package are unreachable defensive code.
    // `source` is the one that is genuinely nullable, for the pre-backfill window.
    it('makes findings.ecosystem not-null but leaves source nullable', function () {
        const columns = new Map(getTableConfig(schema.findings).columns.map(function pair(c) { return [c.name, c] }))
        expect(columns.get('ecosystem')?.notNull).toBe(true)
        expect(columns.get('source')?.notNull).toBe(false)
    })
})

function snake(camel: string): string {
    return camel.replace(/[A-Z]/g, function lower(c) { return '_' + c.toLowerCase() })
}
