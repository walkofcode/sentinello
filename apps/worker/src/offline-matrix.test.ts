import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getRegistryPackages, openDb, runMigrations, schema, upsertProject, upsertRegistryPackage, upsertRoot, type DrizzleDb, type SqliteDb } from '@sentinello/db'
import { buildAdvisoryMarkdown, parseFixCheck, type FixCheck, type Project } from '@sentinello/core'
import type { NpmPackageSummary } from '@sentinello/feeds'
import type { RawFinding, ScannerPlugin, ScanResult } from '@sentinello/scanners'
import { toExportFinding } from './notifier'
import { REGISTRY_FRESH_MS } from './registry-client'
import { runProjectScanners, type ProjectScanOutcome } from './runner'

// The offline matrix (plan → Verification → final milestone). The worker settles every npm finding
// against the registry after a scan; when the registry cannot answer, the finding must never become
// "no fix" and never carry an invented version. Each case drives the real runner with its real cache-first
// registry client over real HTTP — a refused port, a server answering 404, one answering 503 — and reads
// the persisted verification snapshot, which is what every surface renders from.

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'db', 'drizzle')
const REFUSED = 'http://127.0.0.1:9'
const DAY = 24 * 60 * 60 * 1000

let db: DrizzleDb
let sqlite: SqliteDb
let dir: string
let server: Server | null = null
const previousUrl = process.env.SENTINELLO_NPM_REGISTRY_URL

const project: Project = {
    id: 'project-1', rootId: 'root-1', relPath: 'app', name: 'app', alias: null, packageManager: 'npm', nvmrcVersion: null,
    gitBranch: null, ecosystems: ['npm'], muted: false, tags: [], createdAt: 0, updatedAt: 0
}

// braces as the request found it: every source says <=3.0.3, none states a fix.
const BRACES: RawFinding = {
    advisoryId: 'GHSA-vfj7-8cjw-p6xm', aliases: [], advisoryTitle: 'stack exhaustion', advisoryUrl: null, packageName: 'braces', ecosystem: 'npm',
    installedVersion: '3.0.3', vulnerableRange: '<=3.0.3', severity: 'high', fixAvailable: false, fixVersion: null,
    fixInputs: { source: 'osv', installed: ['3.0.3'], affected: { ranges: '<=3.0.3', exact: [], complete: true }, patched: null, statedFix: null, fixViaParent: false },
    depPath: ['braces'], isProd: true, isDev: false
}

const osv: ScannerPlugin = {
    name: 'osv',
    scan: async function scan(): Promise<ScanResult> {
        return { status: 'ok', reasonCode: 'ok', findings: [structuredClone(BRACES)], rawJson: '{}', errorText: null, durationMs: 1 }
    }
}

function summary(versions: string[]): NpmPackageSummary {
    const out: NpmPackageSummary['versions'] = {}
    for (const v of versions) out[v] = { publishedAt: Date.UTC(2024, 4, 21), deprecated: null, edges: null }
    return { v: 1, name: 'braces', latest: versions[versions.length - 1] ?? null, modified: 0, maintainers: 2, repository: null, versions: out, edges: [] }
}

// A registry that answers every request with one status.
async function registryAnswering(status: number): Promise<string> {
    server = createServer(function answer(_request, response) {
        response.writeHead(status, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: status === 404 ? 'Not found' : 'Service Unavailable' }))
    })
    await new Promise<void>(function listen(done) { (server as Server).listen(0, '127.0.0.1', done) })
    return 'http://127.0.0.1:' + (server.address() as AddressInfo).port
}

function cacheStale(versions: string[], age: number): number {
    const checkedAt = Date.now() - age
    upsertRegistryPackage(db, { ecosystem: 'npm', name: 'braces', status: 'ok', summaryJson: JSON.stringify(summary(versions)), checkedAt })
    return checkedAt
}

async function rescan(registryUrl: string): Promise<{ row: typeof schema.findings.$inferSelect; check: FixCheck; advisory: string; startedAt: number }> {
    process.env.SENTINELLO_NPM_REGISTRY_URL = registryUrl
    const startedAt = Date.now()
    const notified: ProjectScanOutcome[] = []
    await runProjectScanners({ db, scanners: [osv], project, notify: async function record(o) { notified.push(o) } })
    const row = db.select().from(schema.findings).all().find(function open(r) { return r.resolvedAt === null }) as typeof schema.findings.$inferSelect
    const findings = notified.flatMap(function f(o) { return o.findings })
    const advisory = buildAdvisoryMarkdown({ scope: { kind: 'project', projectName: 'app', projectPath: 'app', depType: 'all' }, prompt: '', findings: findings.map(toExportFinding), generatedAt: Date.now() })
    return { row, check: parseFixCheck(row.fixCheckJson) as FixCheck, advisory, startedAt }
}

function fixLine(advisory: string): string {
    return advisory.split('\n').find(function fix(l) { return l.startsWith('- **Fix:**') }) as string
}

beforeEach(async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-offline-'))
    const opened = openDb({ dbPath: join(dir, 'test.sqlite') })
    db = opened.db
    sqlite = opened.sqlite
    runMigrations(db, { migrationsFolder: MIGRATIONS })
    upsertRoot(db, { id: 'root-1', path: join(dir, 'repo'), label: null, createdAt: 0 })
    upsertProject(db, project)
})

afterEach(async function teardown() {
    process.env.SENTINELLO_NPM_REGISTRY_URL = previousUrl
    if (server) await new Promise<void>(function close(done) { (server as Server).close(function closed() { done() }) })
    server = null
    sqlite.close()
    await rm(dir, { recursive: true, force: true })
})

describe('the offline matrix', function () {
    it('registry unreachable, no cache → unverified, no data date, nothing cached', async function () {
        const { row, check, advisory, startedAt } = await rescan(REFUSED)
        expect(row).toMatchObject({ fixStatus: 'unverified', fixVersion: null, fixAvailable: false, severity: 'high' })
        expect(check).toMatchObject({ registry: 'error', packageDataAsOf: null })
        expect(check.checkedAt).toBeGreaterThanOrEqual(startedAt)
        expect(fixLine(advisory)).toContain('no fix stated by the advisory · not checked against the registry (registry not reachable)')
        expect(getRegistryPackages(db, 'npm', ['braces']).size).toBe(0)
    })

    it.each([
        ['unreachable', function refused() { return Promise.resolve(REFUSED) }],
        ['answering 5xx', function failing() { return registryAnswering(503) }]
    ])('registry %s but a stale cache → the cached verdict, marked stale with its data date', async function (_label, registry) {
        const dataDate = cacheStale(['3.0.2', '3.0.3'], REGISTRY_FRESH_MS + 3 * DAY)
        const { row, check, advisory } = await rescan(await registry())
        // The stale data says no published braces clears <=3.0.3: the verdict it supports, labelled as stale.
        expect(row).toMatchObject({ fixStatus: 'none_released', fixVersion: null })
        expect(check).toMatchObject({ registry: 'stale', packageDataAsOf: dataDate })
        expect(fixLine(advisory)).toContain('**No fixed version released**')
        expect(fixLine(advisory)).toContain('cached data from ' + new Date(dataDate).toISOString().slice(0, 10))
        // The failed refetch never replaced or deleted the row it fell back on.
        expect(getRegistryPackages(db, 'npm', ['braces']).get('braces')).toMatchObject({ status: 'ok', checkedAt: dataDate })
    })

    it('a stale cache that publishes a fix → that fix, still marked stale', async function () {
        const dataDate = cacheStale(['3.0.3', '3.0.4'], REGISTRY_FRESH_MS + DAY)
        const { row, check, advisory } = await rescan(REFUSED)
        expect(row).toMatchObject({ fixStatus: 'released', fixVersion: '3.0.4', fixAvailable: true })
        expect(check).toMatchObject({ registry: 'stale', packageDataAsOf: dataDate })
        expect(fixLine(advisory)).toContain('cached data from')
    })

    it('registry 404 for the package → unverified, not_found — never none_released', async function () {
        const { row, check, advisory, startedAt } = await rescan(await registryAnswering(404))
        expect(row).toMatchObject({ fixStatus: 'unverified', fixVersion: null })
        expect(check.registry).toBe('not_found')
        // The 404 is an answer: dated, and cached for the freshness window like any other.
        expect(check.packageDataAsOf).toBeGreaterThanOrEqual(startedAt)
        expect(fixLine(advisory)).toContain('not on the npm registry')
        expect(getRegistryPackages(db, 'npm', ['braces']).get('braces')).toMatchObject({ status: 'not_found', summaryJson: null })
    })

    it('registry 5xx, no cache → unverified, no data date, nothing cached', async function () {
        const { row, check, advisory } = await rescan(await registryAnswering(503))
        expect(row).toMatchObject({ fixStatus: 'unverified', fixVersion: null })
        expect(check).toMatchObject({ registry: 'error', packageDataAsOf: null })
        expect(fixLine(advisory)).toContain('not checked against the registry')
        expect(getRegistryPackages(db, 'npm', ['braces']).size).toBe(0)
    })
})
