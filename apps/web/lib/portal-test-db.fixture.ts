import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import {
    insertScan,
    mergeFindingsForScan,
    openDb,
    runMigrations,
    upsertProject,
    upsertRoot,
    type DrizzleDb,
    type IncomingFinding,
    type SqliteDb
} from '@sentinello/db'

// Shared harness for everything in apps/web that reaches the database — the server actions and the
// MCP tools. Both reach it the same way: `@/lib/db` caches its handle on `globalThis.__sentinelloDb`,
// so seeding that global with a temp-file database points the modules under test at a real schema
// with no mocking of the data layer at all. Only `next/cache` (revalidatePath) and the outbound
// notification sender get stubbed, and those are stubbed per test file where they matter.
//
// The portal never migrates — apps/web/lib/db.ts states the worker owns the DB lifecycle — so the
// harness migrates, exactly as the worker would at boot.

const MIGRATIONS = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..', '..', '..',
    'packages', 'db', 'drizzle'
)

type GlobalWithDb = typeof globalThis & {
    __sentinelloDb?: { db: DrizzleDb; sqlite: SqliteDb }
}

export type PortalTestDb = {
    db: DrizzleDb
    sqlite: SqliteDb
    dir: string
}

// A fixed instant rather than Date.now(): every assertion about ordering, mute expiry, or
// "in flight" windows is relative to this, so the suite cannot drift with the wall clock.
export const T0 = Date.UTC(2026, 0, 1)
export const HOUR = 3600_000
export const DAY = 24 * HOUR

export const ROOT_ID = 'root-1'
export const ROOT_PATH = '/srv/code'

export async function openPortalTestDb(prefix: string): Promise<PortalTestDb> {
    const dir = await mkdtemp(join(tmpdir(), 'sentinello-' + prefix + '-'))
    const { db, sqlite } = openDb({ dbPath: join(dir, 'test.sqlite') })
    runMigrations(db, { migrationsFolder: MIGRATIONS })
    ;(globalThis as GlobalWithDb).__sentinelloDb = { db, sqlite }
    return { db, sqlite, dir }
}

export async function closePortalTestDb(handle: PortalTestDb): Promise<void> {
    delete (globalThis as GlobalWithDb).__sentinelloDb
    handle.sqlite.close()
    await rm(handle.dir, { recursive: true, force: true })
}

export function seedRoot(db: DrizzleDb, overrides: Record<string, unknown> = {}): string {
    const row = { id: ROOT_ID, path: ROOT_PATH, label: 'Code', createdAt: T0, ...overrides }
    upsertRoot(db, row as Parameters<typeof upsertRoot>[1])
    return row.id as string
}

export function seedProject(db: DrizzleDb, id: string, overrides: Record<string, unknown> = {}): string {
    upsertProject(db, {
        id,
        rootId: ROOT_ID,
        relPath: id,
        name: id,
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
    } as Parameters<typeof upsertProject>[1])
    return id
}

export function finding(overrides: Partial<IncomingFinding> = {}): IncomingFinding {
    return {
        projectId: 'project-1',
        scanner: 'npm-audit',
        source: 'npm-audit',
        ecosystem: 'npm',
        advisoryId: 'CVE-2024-1',
        advisoryTitle: 'Prototype pollution',
        advisoryUrl: 'https://example.test/CVE-2024-1',
        packageName: 'lodash',
        installedVersion: '4.17.11',
        vulnerableRange: '<4.17.21',
        severity: 'high',
        fixAvailable: true,
        fixVersion: '4.17.21',
        depPath: ['lodash'],
        isProd: true,
        isDev: false,
        ...overrides
    }
}

let scanCounter = 0

export type ScanOpts = {
    at?: number
    startedAt?: number
    scanner?: string
    ecosystem?: string
    status?: string
    reasonCode?: string
    errorText?: string | null
    finishedAt?: number | null
}

// Records a scan and merges its findings, mirroring what the worker's runner does. A finding's own
// `source` must agree with its scan's `scanner` — the source-cell filters in the read paths judge a
// finding under the cell its scan belongs to, so a mismatched fixture disappears from every query.
export function scanProject(
    db: DrizzleDb,
    projectId: string,
    incoming: IncomingFinding[],
    opts: ScanOpts = {}
): string {
    scanCounter += 1
    const scanId = 'scan-' + scanCounter
    const scanner = opts.scanner || 'npm-audit'
    const finishedAt = opts.finishedAt === null ? null : (opts.at ?? T0 + scanCounter * 1000)
    insertScan(db, {
        id: scanId,
        projectId,
        startedAt: opts.startedAt ?? (finishedAt ?? T0) - 1000,
        finishedAt,
        scanner,
        source: scanner,
        ecosystem: opts.ecosystem || 'npm',
        status: (opts.status || 'ok') as never,
        reasonCode: (opts.reasonCode || 'ok') as never,
        durationMs: 1000,
        errorText: opts.errorText ?? null,
        rawJson: ''
    } as Parameters<typeof insertScan>[1])
    if ((opts.status || 'ok') === 'ok' && finishedAt !== null) {
        mergeFindingsForScan(db, {
            projectId,
            scanner,
            scanId,
            scanFinishedAt: finishedAt,
            incoming: incoming.map(function scoped(f) {
                return { ...f, projectId, scanner, source: scanner }
            })
        })
    }
    return scanId
}
