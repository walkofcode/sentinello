import { readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import type { DepTypeFilter, Project } from '@sentinello/core'
import type { DrizzleDb } from '@sentinello/db'
import type { OsvAdvisory, ScannerPlugin } from '@sentinello/scanners'
import { checkInvariants, FRESH_WINDOW_MS, type InvariantInput, type InvariantRow } from './smoke-invariants'
import { openScratchEnv, type ScratchEnv } from './scratch-env'
import { startStubRegistry, type StubRegistry } from './stub-registry'

// Milestone 2's smoke: only released fixes. Exits non-zero on any failed assertion.
//
//   --fixture                       a fixture project against the deterministic stub registry: the
//                                   historical outcomes, a warm-cache run, a stale-cache run, the
//                                   braces-released variant and three negative variants.
//   --scratch <db> --project <id>   a real project on a scratch COPY of the live database, against the
//                                   live registry, invariants only. [--out <file>] records the outcome and
//                                   the registry snapshot; [--cold] clears the scratch registry cache first.
//
// See .woc-ide/plan/01-plan/README.md → "Smoke scripts" for what each set means.

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = resolve(HERE, '..', 'test', 'fixtures')
const REGISTRY_BASE = join(FIXTURES, 'registry', 'base')
const REGISTRY_BRACES_RELEASED = join(FIXTURES, 'registry', 'braces-released')
const EXPORT_MODULE = pathToFileURL(resolve(HERE, '..', '..', 'web', 'lib', 'project-advisory-export.ts')).href
const PRESENT = ['braces', 'node-forge']

type ExportModule = {
    buildProjectAdvisoryExport: (db: DrizzleDb, projectId: string, depType: DepTypeFilter, generatedAt: number) => { markdown: string } | null
}

let exportModule: ExportModule | null = null
async function loadExportBuilder(): Promise<ExportModule> {
    if (exportModule) return exportModule
    register('./web-alias-hooks.mjs', import.meta.url)
    exportModule = (await import(EXPORT_MODULE)) as ExportModule
    return exportModule
}

type Collected = InvariantInput & { projectId: string }

// Everything one run produced, read back the way each surface reads it.
async function collect(env: ScratchEnv, project: Project, run: { startedAt: number; outcomes: { findings: { id: string }[] }[] }, marks: { snapshot: number; notifications: number }): Promise<Collected> {
    const { schema, listCurrentFindingsForProject } = await import('@sentinello/db')
    const { parseFixCheck } = await import('@sentinello/core')
    const exporter = await loadExportBuilder()
    const ids = new Set(run.outcomes.flatMap(function idsOf(o) { return o.findings.map(function id(f) { return f.id }) }))
    const rows: InvariantRow[] = env.db.select().from(schema.findings).all()
        .filter(function inRun(r) { return ids.has(r.id) && r.resolvedAt === null })
        .map(function toRow(r) {
            return {
                id: r.id,
                source: r.source ?? r.scanner,
                ecosystem: r.ecosystem,
                advisoryId: r.advisoryId,
                packageName: r.packageName,
                installedVersion: r.installedVersion,
                severity: r.severity,
                fixStatus: r.fixStatus,
                fixVersion: r.fixVersion,
                fixAvailable: r.fixAvailable,
                fixCheck: parseFixCheck(r.fixCheckJson),
                remediationJson: r.remediationJson
            }
        })
    const now = Date.now()
    const exported = exporter.buildProjectAdvisoryExport(env.db, project.id, 'all', now)
    return {
        projectId: project.id,
        runStartedAt: run.startedAt,
        snapshot: env.snapshot.slice(marks.snapshot),
        rows,
        listFindings: listCurrentFindingsForProject(env.db, project.id, now, 'all').map(function listed(f) {
            return { id: f.id, fixStatus: f.fixStatus, fixVersion: f.fixVersion, fixAvailable: f.fixAvailable, isMuted: f.isMuted }
        }),
        exportMarkdown: exported ? exported.markdown : '',
        notifications: env.notifications.slice(marks.notifications),
        present: PRESENT
    }
}

async function scanAndCollect(env: ScratchEnv, project: Project, scanners: ScannerPlugin[]): Promise<Collected> {
    const marks = { snapshot: env.snapshot.length, notifications: env.notifications.length }
    const run = await env.scan(project, scanners)
    return await collect(env, project, run, marks)
}

// The exact outcomes recorded from the 2026-10-03 registry. Run only against the stub, which never moves.
function historicalFailures(input: Collected): string[] {
    const failures: string[] = []
    for (const [pkg, advisory] of [['braces', 'GHSA-vfj7-8cjw-p6xm'], ['node-forge', 'GHSA-86w9-cpqp-85rv']] as const) {
        const rows = input.rows.filter(function on(r) { return r.packageName === pkg && r.advisoryId === advisory })
        if (rows.length === 0) failures.push('historical: no ' + pkg + ' ' + advisory + ' row')
        for (const r of rows) {
            if (r.fixStatus !== 'none_released' || r.fixVersion !== null || r.severity !== 'high') {
                failures.push('historical: ' + pkg + ' is ' + r.fixStatus + ' ' + r.fixVersion + ' at ' + r.severity + ', expected none_released null at high')
            }
        }
    }
    const qs = input.rows.filter(function on(r) { return r.packageName === 'qs' })
    if (qs.length === 0 || !qs.every(function six(r) { return r.fixStatus === 'released' && r.fixVersion === '6.16.0' })) {
        failures.push('historical: qs >=6.14.2 <=6.15.3 is ' + qs.map(function s(r) { return r.fixStatus + ' ' + r.fixVersion }).join(', ') + ', expected released 6.16.0')
    }
    const braces = input.exportMarkdown.split('\n### ').find(function entry(e) { return e.includes('`braces@') }) ?? ''
    if (!braces.includes('- **Fix:** **No fixed version released**')) failures.push('historical: the export Fix line for braces does not say "No fixed version released"')
    return failures
}

// OSV over the fixture advisories, held in memory. Built after scratch-env has pinned the database paths.
async function osvFixtureScanner(): Promise<ScannerPlugin> {
    const { createOsvScanner } = await import('@sentinello/scanners')
    const byPackage = new Map<string, OsvAdvisory[]>()
    for (const line of readFileSync(join(FIXTURES, 'advisories', 'osv-npm.ndjson'), 'utf8').split('\n')) {
        if (line.trim().length === 0) continue
        const row = JSON.parse(line) as OsvAdvisory & { packageName: string }
        byPackage.set(row.packageName, [...(byPackage.get(row.packageName) ?? []), row])
    }
    return createOsvScanner({
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
}

async function seedFixtureProject(env: ScratchEnv): Promise<Project> {
    const { upsertRoot, upsertProject, setConfigValue } = await import('@sentinello/db')
    const { sourceEnabledKey } = await import('@sentinello/core')
    const at = Date.now()
    upsertRoot(env.db, { id: 'fixture-root', path: join(FIXTURES, 'projects'), label: 'fixtures', createdAt: at })
    const project: Project = {
        id: 'fixture-fix-status', rootId: 'fixture-root', relPath: 'fix-status', name: 'fix-status', alias: null, packageManager: 'npm',
        nvmrcVersion: null, gitBranch: null, ecosystems: ['npm'], muted: false, tags: [], createdAt: at, updatedAt: at
    }
    upsertProject(env.db, project)
    // The read model shows only enabled source cells; the fixture's findings come from OSV.
    setConfigValue(env.db, sourceEnabledKey('osv', 'npm'), true)
    return project
}

type Step = { name: string; failures: string[]; detail?: string }

// One line per row and per registry answer, so a passing run still shows what it passed on.
function describeRun(input: Collected): string {
    const rows = input.rows.map(function r(row) { return row.packageName + '@' + row.installedVersion + ' ' + row.advisoryId + ' → ' + row.fixStatus + ' ' + (row.fixVersion ?? '') }).join('; ')
    const answers = input.snapshot.map(function a(e) { return e.name + ':' + e.provenance }).join(', ')
    return rows + ' | registry ' + answers + ' | ' + input.notifications.length + ' notification(s) recorded'
}

function expectFailures(name: string, failures: string[]): Step {
    return { name, detail: 'rejected with: ' + failures.join(' / '), failures: failures.length > 0 ? [] : ['expected this variant to be rejected, but every check passed'] }
}

async function runFixture(): Promise<Step[]> {
    const steps: Step[] = []
    const dir = await mkdtemp(join(tmpdir(), 'sentinello-smoke-fix-'))
    let stub: StubRegistry | null = null
    try {
        stub = await startStubRegistry([REGISTRY_BASE])
        process.env.SENTINELLO_NPM_REGISTRY_URL = stub.url
        const env = await openScratchEnv({ db: join(dir, 'base.sqlite') })
        const project = await seedFixtureProject(env)
        const scanners = [await osvFixtureScanner()]

        // 1. Empty cache: historical and invariant sets, every answer fetched.
        const first = await scanAndCollect(env, project, scanners)
        const fetchedOnly = first.snapshot.every(function f(e) { return e.provenance === 'fetched' }) && first.snapshot.length > 0
        steps.push({ name: '1 empty cache', detail: describeRun(first), failures: [...checkInvariants(first), ...historicalFailures(first), ...(fetchedOnly ? [] : ['not every answer was fetched: ' + first.snapshot.map(function p(e) { return e.name + ':' + e.provenance }).join(', ')])] })

        // 2. Warm cache: nothing reaches the stub, every answer is the first run's data.
        const before = stub.requests.length
        const warm = await scanAndCollect(env, project, scanners)
        const warmFailures = checkInvariants(warm)
        if (stub.requests.length !== before) warmFailures.push((stub.requests.length - before) + ' packument request(s) reached the stub on a warm cache')
        for (const e of warm.snapshot) {
            const earlier = first.snapshot.find(function same(f) { return f.name === e.name })
            if (e.provenance !== 'cache' || e.checkedAt === null || e.checkedAt >= warm.runStartedAt) warmFailures.push(e.name + ' was not served from the earlier cache (' + e.provenance + ')')
            if (earlier && e.checkedAt !== earlier.checkedAt) warmFailures.push(e.name + ' data is not the first run’s fetch')
        }
        steps.push({ name: '2 warm cache', detail: describeRun(warm), failures: warmFailures })

        // 2b. Cache aged past the window and the registry down: the old data, marked stale.
        env.sqlite.prepare('UPDATE registry_packages SET checked_at = checked_at - ?').run(FRESH_WINDOW_MS + 3_600_000)
        stub.setFailing(true)
        const stale = await scanAndCollect(env, project, scanners)
        stub.setFailing(false)
        const staleFailures = checkInvariants(stale)
        if (!stale.snapshot.every(function s(e) { return e.provenance === 'stale' })) staleFailures.push('not every answer was served stale')
        if (!stale.rows.every(function s(r) { return r.fixCheck?.registry === 'stale' })) staleFailures.push('not every row was settled on stale data')
        steps.push({ name: '2b stale cache, registry down', detail: describeRun(stale), failures: [...staleFailures, ...historicalFailures(stale)] })

        // 4. Negative variants the invariant set must reject.
        const braces = first.rows.find(function b(r) { return r.packageName === 'braces' }) as InvariantRow
        function tamper(patch: (row: InvariantRow) => InvariantRow): Collected {
            return { ...first, rows: first.rows.map(function one(r) { return r.id === braces.id ? patch(structuredClone(r)) : r }) }
        }
        steps.push(expectFailures('4a negative: unpublished released fix', checkInvariants(tamper(function invented(r) {
            return { ...r, fixStatus: 'released', fixVersion: '3.0.4', fixAvailable: true }
        }))))
        steps.push(expectFailures('4b negative: settlement older than the run', checkInvariants(tamper(function old(r) {
            return { ...r, fixCheck: r.fixCheck && { ...r.fixCheck, checkedAt: first.runStartedAt - 1 } }
        }))))
        steps.push(expectFailures('4c negative: package data from nowhere', checkInvariants(tamper(function nowhere(r) {
            return { ...r, fixCheck: r.fixCheck && { ...r.fixCheck, packageDataAsOf: 12345 } }
        }))))
        env.close()
        await stub.close()
        stub = null

        // 3. braces 3.0.4 published: a correct changed outcome. The invariants accept it, the historical
        // set must not.
        stub = await startStubRegistry([REGISTRY_BASE, REGISTRY_BRACES_RELEASED])
        process.env.SENTINELLO_NPM_REGISTRY_URL = stub.url
        const variant = await openScratchEnv({ db: join(dir, 'braces-released.sqlite') })
        const variantProject = await seedFixtureProject(variant)
        const released = await scanAndCollect(variant, variantProject, scanners)
        const releasedFailures = checkInvariants(released)
        for (const r of released.rows.filter(function b(row) { return row.packageName === 'braces' })) {
            if (r.fixStatus !== 'released' || r.fixVersion !== '3.0.4') releasedFailures.push('braces is ' + r.fixStatus + ' ' + r.fixVersion + ', expected released 3.0.4')
            if (r.remediationJson !== null) releasedFailures.push('braces carries a way-out although it is released')
        }
        steps.push({ name: '3 braces-released: invariants accept it', detail: describeRun(released), failures: releasedFailures })
        steps.push(expectFailures('3 braces-released: historical set rejects it', historicalFailures(released)))
        variant.close()
        return steps
    } finally {
        if (stub) await stub.close()
        await rm(dir, { recursive: true, force: true })
    }
}

async function runScratch(dbPath: string, projectId: string, out: string | undefined, cold: boolean): Promise<Step[]> {
    const env = await openScratchEnv({ db: dbPath })
    try {
        const db = await import('@sentinello/db')
        const { npmAuditPlugin } = await import('@sentinello/scanners')
        const osv = await import('../src/osv-runtime')
        const gemnasium = await import('../src/gemnasium-runtime')
        const project = db.getProjectById(env.db, projectId)
        if (!project) return [{ name: 'scratch', failures: ['project ' + projectId + ' is not in ' + dbPath]}]
        if (cold) env.clearRegistryCache()
        // The worker's own scanner selection, over the scratch copies of the feed databases (opened at the
        // paths scratch-env pinned) and with no feed sync attached.
        const scanners = osv.selectScanners(env.db, npmAuditPlugin, [
            { scanner: osv.createOsvScannerFor(env.db, db.openOsvDb().db), isEnabled: osv.osvSourceEnabled },
            { scanner: gemnasium.createGemnasiumScannerFor(env.db, db.openGemnasiumDb().db), isEnabled: gemnasium.gemnasiumSourceEnabled }
        ])
        const input = await scanAndCollect(env, project, scanners)
        const failures = checkInvariants(input)
        const counts: Record<string, number> = {}
        for (const e of input.snapshot) counts[e.provenance] = (counts[e.provenance] ?? 0) + 1
        const record = {
            recordedAt: new Date().toISOString(),
            database: dbPath,
            project: { id: project.id, name: project.name },
            scanners: scanners.map(function n(s) { return s.name }),
            runStartedAt: input.runStartedAt,
            registryAnswers: counts,
            rows: input.rows.map(function r(row) {
                return { package: row.packageName + '@' + row.installedVersion, advisory: row.advisoryId, source: row.source, severity: row.severity, fixStatus: row.fixStatus, fixVersion: row.fixVersion, registry: row.fixCheck?.registry ?? null, packageDataAsOf: row.fixCheck?.packageDataAsOf ?? null }
            }),
            failures,
            snapshot: input.snapshot.map(function s(e) {
                return { name: e.name, provenance: e.provenance, checkedAt: e.checkedAt, latest: e.summary?.latest ?? null, versions: e.summary ? Object.keys(e.summary.versions) : null }
            })
        }
        console.log('[smoke-fix-status] scratch: ' + input.rows.length + ' rows settled; registry answers ' + JSON.stringify(counts))
        for (const row of record.rows.filter(function watched(r) { return PRESENT.some(function p(name) { return r.package.startsWith(name + '@') }) })) {
            console.log('  ' + row.package + ' ' + row.advisory + ' [' + row.source + '] ' + row.severity + ' → ' + row.fixStatus + ' ' + row.fixVersion + ' (registry ' + row.registry + ')')
        }
        if (out) writeFileSync(out, JSON.stringify(record, null, 2) + '\n')
        return [{ name: 'scratch invariants', failures }]
    } finally {
        env.close()
    }
}

async function main(): Promise<number> {
    const { values } = parseArgs({
        options: {
            fixture: { type: 'boolean' },
            scratch: { type: 'string' },
            project: { type: 'string' },
            out: { type: 'string' },
            cold: { type: 'boolean' }
        }
    })
    let steps: Step[]
    if (values.fixture) steps = await runFixture()
    else if (values.scratch && values.project) steps = await runScratch(values.scratch, values.project, values.out, values.cold === true)
    else {
        console.error('usage: smoke-fix-status.ts --fixture | --scratch <db> --project <id> [--out <file>] [--cold]')
        return 2
    }
    let failed = 0
    for (const step of steps) {
        console.log((step.failures.length === 0 ? 'PASS ' : 'FAIL ') + step.name)
        if (step.detail) console.log('    ' + step.detail)
        for (const f of step.failures) console.log('    ' + f)
        if (step.failures.length > 0) failed++
    }
    console.log(failed === 0 ? '[smoke-fix-status] all ' + steps.length + ' checks passed' : '[smoke-fix-status] ' + failed + ' of ' + steps.length + ' checks failed')
    return failed === 0 ? 0 : 1
}

main().then(function exit(code) {
    process.exit(code)
}, function crash(err: unknown) {
    console.error(err)
    process.exit(1)
})
