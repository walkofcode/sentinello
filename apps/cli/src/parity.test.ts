import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { OSV_NORMALIZER_VERSION, type Remediation } from '@sentinello/core'
import { createOsvScanner, discoverProjectsInTree, type OsvAdvisory } from '@sentinello/scanners'
import { createNpmRegistryClient } from '@sentinello/fixes'
import { startStubRegistry, type StubRegistry } from '../../../tests/fixtures/registry-stub'
import { closeWorkerTestDb, openWorkerTestDb, seedProject, seedRoot, type WorkerTestDb } from '../../worker/src/worker-test-db.fixture'
import { runProjectScanners } from '../../worker/src/runner'
import { loadCacheForPackages } from './cache/lookup'
import { advisoryFilePath, writeCacheMeta } from './cache/meta'
import { loadRegistryStore } from './cache/registry'
import { createRowWriter } from './cache/store'
import { buildScanners, collectPackageNames, resolveProjects, scanProject, type ScanSetup } from './scan'

// One fix logic, one answer. The same fixture project, the same advisories and the same stub registry,
// scanned once by the worker's runner (SQLite, its registry_packages store) and once by the CLI's
// scanProject (its file cache): every finding must settle to the same status, version and registry
// outcome, with the same way out. Each side gets its own empty registry cache, so both fetch.

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')
const PROJECTS = join(REPO_ROOT, 'tests', 'fixtures', 'projects')
const ADVISORIES = join(REPO_ROOT, 'tests', 'fixtures', 'advisories', 'osv-npm.ndjson')
const REGISTRY_BASE = join(REPO_ROOT, 'apps', 'worker', 'test', 'fixtures', 'registry', 'base')
const PROJECT = 'npm-no-fix'
// One instant for both sides. The way out's health ages (daysSinceLastPublish) are derived from the run's
// clock, so two scans a moment apart can straddle a day boundary — braces' last publish turns 867 days old
// at 08:59:11.390Z — and differ for no reason in the logic. Only Date.now is pinned: it is the clock both
// runs read, and leaving the timers real keeps the HTTP to the stub working.
const INSTANT = Date.UTC(2026, 9, 1, 12, 0, 0)

type Settled = { fixStatus: string; fixVersion: string | null; registry: string | null; remediation: Omit<Remediation, 'checkedAt'> | null }

let stub: StubRegistry
let worker: WorkerTestDb
let cacheDir: string
const savedEnv = { registry: process.env.SENTINELLO_NPM_REGISTRY_URL, downloads: process.env.SENTINELLO_NPM_DOWNLOADS_URL }

function restore(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
}

// The way out is stamped with its run's instant; everything else must match.
function withoutInstant(remediation: Remediation | null): Omit<Remediation, 'checkedAt'> | null {
    if (remediation === null) return null
    const { checkedAt: _checkedAt, ...rest } = remediation
    return rest
}

async function advisoryRows(): Promise<(OsvAdvisory & { packageName: string })[]> {
    return (await readFile(ADVISORIES, 'utf8')).split('\n')
        .filter(function nonEmpty(line) { return line.trim().length > 0 })
        .map(function parse(line) { return JSON.parse(line) as OsvAdvisory & { packageName: string } })
}

async function scanWithWorker(): Promise<Map<string, Settled>> {
    const byPackage = new Map<string, OsvAdvisory[]>()
    for (const row of await advisoryRows()) byPackage.set(row.packageName, [...(byPackage.get(row.packageName) ?? []), row])
    const osv = createOsvScanner({
        isEnabled: function enabled() { return true },
        isSeeded: function seeded() { return true },
        lookup: function lookup(_ecosystem, names) {
            const out = new Map<string, OsvAdvisory[]>()
            for (const name of names) {
                const list = byPackage.get(name)
                if (list) out.set(name, list)
            }
            return out
        }
    })
    seedRoot(worker.db, PROJECTS)
    const project = seedProject(worker.db, { relPath: PROJECT, name: PROJECT })
    const outcomes = await runProjectScanners({ db: worker.db, scanners: [osv], project, notify: async function quiet() {} })
    const out = new Map<string, Settled>()
    for (const finding of outcomes.flatMap(function of(o) { return o.findings })) {
        out.set(finding.advisoryId + ' ' + finding.packageName, {
            fixStatus: finding.fixStatus,
            fixVersion: finding.fixVersion,
            registry: finding.fixCheck?.registry ?? null,
            remediation: withoutInstant(finding.remediation)
        })
    }
    return out
}

async function scanWithCli(): Promise<Map<string, Settled>> {
    const writer = createRowWriter(advisoryFilePath(cacheDir, 'osv', 'npm'))
    await writer.write(await advisoryRows() as never)
    const count = await writer.commit()
    await writeCacheMeta(cacheDir, { schemaVersion: 1, sources: { osv: { npm: { normalizerVersion: OSV_NORMALIZER_VERSION, recordCount: count, refreshedAt: Date.now() } }, gemnasium: {} } })
    const discovered = discoverProjectsInTree({ rootPath: join(PROJECTS, PROJECT), maxDepth: 0, excludes: [] })
    const resolved = await resolveProjects(discovered)
    const setup: ScanSetup = {
        cacheDir,
        sources: ['osv'],
        ecosystem: 'npm',
        includeNpmAudit: false,
        seeded: { osv: true, gemnasium: false },
        settledAt: Date.now(),
        registry: createNpmRegistryClient(await loadRegistryStore(cacheDir))
    }
    const scanners = buildScanners(setup, await loadCacheForPackages(cacheDir, 'npm', collectPackageNames(resolved), ['osv']))
    const out = new Map<string, Settled>()
    for (const entry of resolved) {
        const result = await scanProject(setup, entry, scanners)
        for (const finding of result.findings) {
            const fix = result.fixes.get(finding)
            out.set(finding.advisoryId + ' ' + finding.packageName, {
                fixStatus: fix?.fixStatus ?? 'missing',
                fixVersion: fix?.fixVersion ?? null,
                registry: fix?.fixCheck.registry ?? null,
                remediation: withoutInstant(result.remediations.get(finding) ?? null)
            })
        }
    }
    return out
}

beforeAll(async function setup() {
    vi.spyOn(Date, 'now').mockReturnValue(INSTANT)
    stub = await startStubRegistry([REGISTRY_BASE])
    process.env.SENTINELLO_NPM_REGISTRY_URL = stub.url
    process.env.SENTINELLO_NPM_DOWNLOADS_URL = stub.url
    worker = await openWorkerTestDb('parity')
    cacheDir = await mkdtemp(join(tmpdir(), 'sentinello-parity-'))
})

afterAll(async function teardown() {
    vi.restoreAllMocks()
    restore('SENTINELLO_NPM_REGISTRY_URL', savedEnv.registry)
    restore('SENTINELLO_NPM_DOWNLOADS_URL', savedEnv.downloads)
    await stub.close()
    await closeWorkerTestDb(worker)
    await rm(cacheDir, { recursive: true, force: true })
})

describe('worker / CLI parity', function () {
    it('settles every finding of the fixture project identically, way out included', async function () {
        const fromWorker = await scanWithWorker()
        const workerRequests = stub.requests.length
        const fromCli = await scanWithCli()
        // Both sides really asked the registry: neither answer is a shared cache.
        expect(workerRequests).toBeGreaterThan(0)
        expect(stub.requests.length).toBeGreaterThan(workerRequests)

        expect([...fromCli.keys()].sort()).toEqual([...fromWorker.keys()].sort())
        expect(fromCli).toEqual(fromWorker)
        // And the answer is the one the fixture pins, so the two sides cannot agree on a wrong one.
        const braces = fromCli.get('GHSA-vfj7-8cjw-p6xm braces')
        expect(braces).toMatchObject({ fixStatus: 'none_released', fixVersion: null, registry: 'ok' })
        expect(braces?.remediation?.chains.some(function blocked(c) { return c.verdict.kind === 'blocked' })).toBe(true)
        expect(fromCli.get('GHSA-86w9-cpqp-85rv node-forge')).toMatchObject({ fixStatus: 'none_released', fixVersion: null, registry: 'ok' })
        // The health ages come from the pinned instant, not from whenever the suite happened to run.
        expect(braces?.remediation?.health.daysSinceLastPublish).toBe(863)
    })
})
