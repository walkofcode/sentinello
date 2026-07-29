import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import {
    openDb,
    runMigrations,
    upsertProject,
    upsertRoot,
    type DrizzleDb,
    type SqliteDb
} from '@sentinello/db'
import type { Project } from '@sentinello/core'

// Shared harness for the worker's boot/scheduling shell — the scheduler, the scan-request poller, the
// lockfile watcher, discovery, and the two source runtimes. Every one of those modules already takes its
// database as an injected argument, so a temp-file database migrated exactly as the worker migrates at
// boot drives them against a real schema with nothing about the data layer mocked.
//
// What the suites DO stub is narrow and always for the same reason — the thing being replaced owns a
// process resource a test cannot own:
//   - node-cron, because a real schedule would never fire inside a test run;
//   - chokidar, because a real inotify watch is a race, not an assertion;
//   - @sentinello/feeds, because the alternative is downloading ~100 MB of advisories from the network.
// The database, the migrations, and every query underneath stay real.
//
// Several suites also need a directory tree on disk: discovery walks it, and the watcher resolves roots
// against existsSync. makeTree() builds those from an inline spec for the same reason the discovery suite
// does — a committed .gitignore fixture would apply to this repository, and a committed .git directory is
// impossible.

const MIGRATIONS = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..', '..', '..',
    'packages', 'db', 'drizzle'
)

// A fixed instant rather than Date.now(): sweep durations, heartbeat windows and mute expiry are all
// asserted relative to this, so the suite cannot drift with the wall clock.
export const T0 = Date.UTC(2026, 0, 1)
export const HOUR = 3600_000

export const ROOT_ID = 'root-1'

export type WorkerTestDb = {
    db: DrizzleDb
    sqlite: SqliteDb
    dir: string
}

export type OpenWorkerTestDbOptions = {
    // Turn `foreign_keys` back OFF once the schema is in place. Only one thing needs this: reaching the
    // poller's defensive "project not found" / "root not found" branches. scan_requests.project_id and
    // .root_id are foreign keys, so a connection with FKs enforced cannot enqueue a request pointing at
    // a row that does not exist — those branches are reachable only across processes, where the portal
    // deletes the target between the worker's claim and its lookup. Relaxing the constraint is how a
    // single-process test stands in for that race.
    //
    // It has to run AFTER runMigrations, not via openDb's applyPragmas flag: migration 0001 ends with a
    // literal `PRAGMA foreign_keys=ON`, so anything the client set beforehand is overwritten.
    relaxForeignKeys?: boolean
}

export async function openWorkerTestDb(prefix: string, options: OpenWorkerTestDbOptions = {}): Promise<WorkerTestDb> {
    const dir = await mkdtemp(join(tmpdir(), 'sentinello-' + prefix + '-'))
    const { db, sqlite } = openDb({ dbPath: join(dir, 'test.sqlite') })
    runMigrations(db, { migrationsFolder: MIGRATIONS })
    if (options.relaxForeignKeys) sqlite.pragma('foreign_keys = OFF')
    return { db, sqlite, dir }
}

export async function closeWorkerTestDb(handle: WorkerTestDb): Promise<void> {
    handle.sqlite.close()
    await rm(handle.dir, { recursive: true, force: true })
}

export function seedRoot(db: DrizzleDb, path: string, overrides: Record<string, unknown> = {}): string {
    const row = { id: ROOT_ID, path, label: null, createdAt: T0, ...overrides }
    upsertRoot(db, row as Parameters<typeof upsertRoot>[1])
    return row.id as string
}

export function project(overrides: Partial<Project> = {}): Project {
    return {
        id: 'project-1',
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
        updatedAt: T0,
        ...overrides
    }
}

export function seedProject(db: DrizzleDb, overrides: Partial<Project> = {}): Project {
    const row = project(overrides)
    upsertProject(db, row)
    return row
}

// Builds a directory tree from a { relativePath: contents } spec and returns its absolute root.
export async function makeTree(parent: string, name: string, spec: Record<string, string>): Promise<string> {
    const root = join(parent, name)
    await mkdir(root, { recursive: true })
    for (const [relPath, content] of Object.entries(spec)) {
        const full = join(root, relPath)
        await mkdir(dirname(full), { recursive: true })
        await writeFile(full, content)
    }
    return root
}

export const PKG_JSON = JSON.stringify({ name: 'fixture', version: '1.0.0' })
