import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DrizzleDb, SqliteDb } from '@sentinello/db'
import type { Finding, Project } from '@sentinello/core'
import type { NpmPackageSummary } from '@sentinello/feeds'
import type { ScannerPlugin } from '@sentinello/scanners'
import type { ProjectScanOutcome } from '../src/runner'
import type { RegistryClient, RegistryEntry } from '../src/registry-client'

// The one bootstrap every scratch tool goes through (the smoke scripts, and later print-advisory and the
// fleet rescan). A scratch run rescans real projects against a COPY of the live database; this file is
// what makes it impossible for that run to write the live database or to send a notification.
//
// In order:
//   1. refuse any database path that resolves to the live data directory;
//   2. point SENTINELLO_DB_PATH and its two feed-database siblings at the scratch files BEFORE anything
//      opens a database, so nothing can fall back to the live osv.db / gemnasium.db;
//   3. migrate the scratch database;
//   4. force notification delivery off three ways: dryRunNotify on, every target disabled, and a
//      recording notifier handed to runProjectScanners that never calls a sender;
//   5. never import src/index.ts or src/worker.ts — no scheduler, no feed sync, no MCP server.
//
// Only type imports at module level: everything that touches a database is imported after step 2.

// Where the live instance keeps its data (see the ~/Apps convention). Overridable only so the refusal
// itself can be tested against a temporary "live" directory.
export function liveDataDir(): string {
    const fromEnv = process.env.SENTINELLO_LIVE_DATA_DIR
    return fromEnv && fromEnv.trim().length > 0 ? fromEnv.trim() : join(homedir(), 'Apps', 'sentinello', 'data')
}

// The path as it really is on disk, so a symlink or a `..` cannot smuggle the live file past the check.
// A file that does not exist yet is judged by its directory.
function realPath(path: string): string {
    const absolute = resolve(path)
    if (existsSync(absolute)) return realpathSync(absolute)
    const parent = dirname(absolute)
    return join(existsSync(parent) ? realpathSync(parent) : parent, basename(absolute))
}

export function assertScratchPath(path: string): string {
    const real = realPath(path)
    const live = realPath(liveDataDir())
    if (real === live || real.startsWith(live + sep)) {
        throw new Error('refusing to use ' + path + ': it resolves to the live data directory (' + live + '). Copy it first: sqlite3 -readonly <live> ".backup <scratch>"')
    }
    return real
}

// How a registry answer reached the run, as the live invariants need it.
export type RegistryProvenance = 'fetched' | 'cache' | 'stale' | 'not_found' | 'error'

export type RegistrySnapshotEntry = {
    name: string
    provenance: RegistryProvenance
    // When the registry produced the served data; null for an error.
    checkedAt: number | null
    summary: NpmPackageSummary | null
    // For not_found: whether it was fetched this run or served from the cache.
    origin: 'fetched' | 'cache' | null
}

export type RecordedNotification = {
    outcome: { scanId: string; scanner: string; status: string }
    findings: Finding[]
    // What the webhook JSON flavor would have posted, finding by finding.
    vulnerabilities: Record<string, unknown>[]
    // What the webhook text flavor would have posted: the advisory export of these findings.
    advisoryText: string
}

export type ScratchEnv = {
    db: DrizzleDb
    sqlite: SqliteDb
    dbPath: string
    // Every registry answer served to the runs of this environment, in order.
    snapshot: RegistrySnapshotEntry[]
    notifications: RecordedNotification[]
    // Scans one project through the real runner with the recording registry and notifier. Returns the
    // time the run started (the invariants' freshness floor) and its outcomes.
    scan(project: Project, scanners: ScannerPlugin[]): Promise<{ startedAt: number; outcomes: ProjectScanOutcome[] }>
    // Deletes the scratch database's registry cache, for a cold-cache run. Never touches anything else.
    clearRegistryCache(): void
    close(): void
}

export type OpenScratchEnvOptions = {
    db: string
    // Default to the scratch database's siblings, exactly as the worker resolves them.
    osvDb?: string
    gemnasiumDb?: string
}

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'db', 'drizzle')

export async function openScratchEnv(options: OpenScratchEnvOptions): Promise<ScratchEnv> {
    // 1. Refuse the live paths, all three of them.
    const dbPath = assertScratchPath(options.db)
    const osvPath = assertScratchPath(options.osvDb ?? join(dirname(dbPath), 'osv.db'))
    const gemnasiumPath = assertScratchPath(options.gemnasiumDb ?? join(dirname(dbPath), 'gemnasium.db'))

    // 2. Before any database is opened.
    process.env.SENTINELLO_DB_PATH = dbPath
    process.env.SENTINELLO_OSV_DB_PATH = osvPath
    process.env.SENTINELLO_GEMNASIUM_DB_PATH = gemnasiumPath

    const dbModule = await import('@sentinello/db')
    const { openDb, runMigrations, setConfigValue, schema } = dbModule
    const { buildAdvisoryMarkdown } = await import('@sentinello/core')
    const { toWebhookVulnerability } = await import('@sentinello/notifications')
    const { runProjectScanners } = await import('../src/runner')
    const { createNpmRegistryClient } = await import('../src/registry-client')
    const { toExportFinding } = await import('../src/notifier')
    const { CONFIG_KEYS } = await import('../src/config-loader')

    // 3.
    const { db, sqlite } = openDb({ dbPath })
    runMigrations(db, { migrationsFolder: MIGRATIONS })

    // 4. Delivery off, three independent ways.
    setConfigValue(db, CONFIG_KEYS.dryRunNotify, true)
    db.update(schema.notificationTargets).set({ enabled: false }).run()

    const snapshot: RegistrySnapshotEntry[] = []
    const notifications: RecordedNotification[] = []
    const live = createNpmRegistryClient(db)
    const registry: RegistryClient = {
        lookup: async function recordedLookup(names, options) {
            const served = await live.lookup(names, options)
            for (const [name, entry] of served) snapshot.push(snapshotEntry(name, entry))
            return served
        },
        weeklyDownloads: function weeklyDownloads(names) {
            return live.weeklyDownloads(names)
        }
    }
    async function recordNotification(outcome: ProjectScanOutcome): Promise<void> {
        const findings = structuredClone(outcome.findings)
        notifications.push({
            outcome: { scanId: outcome.scan.id, scanner: outcome.scan.scanner, status: outcome.scan.status },
            findings,
            vulnerabilities: findings.map(toWebhookVulnerability),
            advisoryText: buildAdvisoryMarkdown({
                scope: { kind: 'project', projectName: outcome.project.name, projectPath: outcome.project.relPath, depType: 'all' },
                prompt: '',
                findings: findings.map(toExportFinding),
                generatedAt: outcome.scan.finishedAt ?? Date.now()
            })
        })
    }

    return {
        db,
        sqlite,
        dbPath,
        snapshot,
        notifications,
        scan: async function scan(project, scanners) {
            const startedAt = Date.now()
            const outcomes = await runProjectScanners({ db, scanners, project, registry, notify: recordNotification })
            return { startedAt, outcomes }
        },
        clearRegistryCache: function clearRegistryCache() {
            db.delete(schema.registryPackages).run()
        },
        close: function close() {
            sqlite.close()
        }
    }
}

function snapshotEntry(name: string, entry: RegistryEntry): RegistrySnapshotEntry {
    if (entry.status === 'ok') return { name, provenance: entry.origin, checkedAt: entry.checkedAt, summary: entry.summary, origin: entry.origin }
    if (entry.status === 'stale') return { name, provenance: 'stale', checkedAt: entry.checkedAt, summary: entry.summary, origin: 'cache' }
    if (entry.status === 'not_found') return { name, provenance: 'not_found', checkedAt: entry.checkedAt, summary: null, origin: entry.origin }
    return { name, provenance: 'error', checkedAt: null, summary: null, origin: null }
}
