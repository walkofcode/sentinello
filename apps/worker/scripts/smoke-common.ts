import { readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import type { DepTypeFilter, Project } from '@sentinello/core'
import type { DrizzleDb } from '@sentinello/db'
import type { FixEvidence, OsvAdvisory, RawFinding, ScannerPlugin, ScanResult } from '@sentinello/scanners'
import { checkInvariants, FRESH_WINDOW_MS, type InvariantInput, type InvariantRow } from './smoke-invariants'
import { openScratchEnv, type ScratchEnv } from './scratch-env'
import { startStubRegistry, type StubRegistry } from './stub-registry'

// The machinery both milestone smokes share — smoke-fix-status.ts (only released fixes) and
// smoke-remediation.ts (the way out). Each script brings its own historical assertion set; the run order,
// the fixture project, the stub registry, the invariant set and the scratch mode are the same.
//
//   --fixture                       the fixture project against the deterministic stub registry:
//     1  empty cache             historical + invariants, every answer fetched in this run
//     2  warm cache              invariants, no packument request reaches the stub, data from run 1
//     2b stale cache, outage     invariants, every answer stale, historical still holds
//     3a braces-released         invariants accept braces released 3.0.4 with no way-out; history rejects it
//     3b nodemon-escape          invariants accept "upgrade nodemon"; each script says whether its history moved
//     4  negatives               the invariant set must reject each tampered or stale outcome
//   --scratch <db> --project <id>   a real project on a scratch COPY of the live database, against the live
//                                   registry, invariants only. [--out <file>] records the outcome and the
//                                   registry snapshot; [--cold] clears the scratch registry cache first.
//
// See .woc-ide/plan/01-plan/README.md → "Smoke scripts" for what each set means.

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = resolve(HERE, '..', 'test', 'fixtures')
const REGISTRY = join(FIXTURES, 'registry')
const EXPORT_MODULE = pathToFileURL(resolve(HERE, '..', '..', 'web', 'lib', 'project-advisory-export.ts')).href
const PRESENT = ['braces', 'node-forge']

export type Collected = InvariantInput & { projectId: string }
export type Step = { name: string; failures: string[]; detail?: string }
export type HistoricalSet = (input: Collected) => string[]

export type SmokeDefinition = {
    name: string
    historical: HistoricalSet
    // Whether the nodemon-escape variant changes one of this script's pinned outcomes.
    nodemonEscapeChangesHistory: boolean
}

type ExportModule = {
    buildProjectAdvisoryExport: (db: DrizzleDb, projectId: string, depType: DepTypeFilter, generatedAt: number) => { markdown: string } | null
}

let exportModule: ExportModule | null = null
// The portal's own advisory export builder (apps/web), so the scratch tools render exactly what
// get_project_advisory and the Download .md button would.
export async function loadExportBuilder(): Promise<ExportModule> {
    if (exportModule) return exportModule
    register('./web-alias-hooks.mjs', import.meta.url)
    exportModule = (await import(EXPORT_MODULE)) as ExportModule
    return exportModule
}

// Everything one run produced, read back the way each surface reads it. The rows are EVERY active row of
// the project that list_findings would return — not only the ones this run's scanners handed back — so a
// row preserved by a source that failed this run is judged too, and fails the freshness check.
export async function collect(env: ScratchEnv, project: Project, run: { startedAt: number }, marks: { snapshot: number; notifications: number }): Promise<Collected> {
    const { schema, listCurrentFindingsForProject } = await import('@sentinello/db')
    const { parseFixCheck } = await import('@sentinello/core')
    const exporter = await loadExportBuilder()
    const now = Date.now()
    const listed = listCurrentFindingsForProject(env.db, project.id, now, 'all')
    const visible = new Set(listed.map(function id(f) { return f.id }))
    const rows: InvariantRow[] = env.db.select().from(schema.findings).all()
        .filter(function active(r) { return r.projectId === project.id && r.resolvedAt === null && visible.has(r.id) })
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
    const exported = exporter.buildProjectAdvisoryExport(env.db, project.id, 'all', now)
    return {
        projectId: project.id,
        runStartedAt: run.startedAt,
        snapshot: env.snapshot.slice(marks.snapshot),
        rows,
        listFindings: listed.map(function listedRow(f) {
            return { id: f.id, fixStatus: f.fixStatus, fixVersion: f.fixVersion, fixAvailable: f.fixAvailable, isMuted: f.isMuted, remediation: f.remediation }
        }),
        exportMarkdown: exported ? exported.markdown : '',
        notifications: env.notifications.slice(marks.notifications),
        present: PRESENT
    }
}

export async function scanAndCollect(env: ScratchEnv, project: Project, scanners: ScannerPlugin[]): Promise<Collected> {
    const marks = { snapshot: env.snapshot.length, notifications: env.notifications.length }
    const run = await env.scan(project, scanners)
    return await collect(env, project, run, marks)
}

// The rows for one advisory, and the way-out each carries.
export function rowsFor(input: Collected, pkg: string, advisory?: string): InvariantRow[] {
    return input.rows.filter(function on(r) { return r.packageName === pkg && (advisory === undefined || r.advisoryId === advisory) })
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

// A second source that reports one extra qs advisory, and can be told to fail: the shape of a source that
// succeeded last scan and errored this one, whose rows the runner deliberately preserves.
function failingSecondSource(): ScannerPlugin & { failing: boolean } {
    const affected = { ranges: '>=6.14.2 <=6.15.3', exact: [], complete: true }
    const evidence: FixEvidence = { source: 'gemnasium', installed: ['6.15.0'], affected, patched: null, statedFix: null, fixViaParent: false }
    const finding: RawFinding = {
        advisoryId: 'GMS-fixture-qs-extra', aliases: [], advisoryTitle: 'Fixture: an extra qs advisory from a second source', advisoryUrl: null,
        packageName: 'qs', ecosystem: 'npm', installedVersion: '6.15.0', vulnerableRange: affected.ranges, severity: 'moderate',
        fixAvailable: false, fixVersion: null, fixInputs: evidence, depPath: ['qs'], isProd: true, isDev: false
    }
    const source = {
        name: 'gemnasium',
        failing: false,
        scan: async function scan(): Promise<ScanResult> {
            if (source.failing) return { status: 'error', reasonCode: 'audit_unknown_failure', findings: [], rawJson: '', errorText: 'fixture: failing on purpose', durationMs: 1 }
            return { status: 'ok', reasonCode: 'ok', findings: [finding], rawJson: '{}', errorText: null, durationMs: 1 }
        }
    }
    return source
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
    // The read model shows only enabled source cells; the fixture's findings come from OSV (and, in the
    // preserved-row negative, a second source).
    setConfigValue(env.db, sourceEnabledKey('osv', 'npm'), true)
    setConfigValue(env.db, sourceEnabledKey('gemnasium', 'npm'), true)
    return project
}

// One line per row and per registry answer, so a passing run still shows what it passed on.
function describeRun(input: Collected): string {
    const rows = input.rows.map(function r(row) { return row.packageName + '@' + row.installedVersion + ' ' + row.advisoryId + ' → ' + row.fixStatus + ' ' + (row.fixVersion ?? '') + (row.remediationJson ? ' +way-out' : '') }).join('; ')
    const counts: Record<string, number> = {}
    for (const e of input.snapshot) counts[e.provenance] = (counts[e.provenance] ?? 0) + 1
    return rows + ' | registry ' + JSON.stringify(counts) + ' | ' + input.notifications.length + ' notification(s) recorded'
}

function expectFailures(name: string, failures: string[]): Step {
    return { name, detail: 'rejected with: ' + failures.slice(0, 3).join(' / '), failures: failures.length > 0 ? [] : ['expected this to be rejected, but every check passed'] }
}

function useStub(stub: StubRegistry): void {
    process.env.SENTINELLO_NPM_REGISTRY_URL = stub.url
    process.env.SENTINELLO_NPM_DOWNLOADS_URL = stub.url
}

// A fresh scratch environment over the given registry layers, with the fixture project seeded.
async function fixtureEnv(dir: string, file: string, layers: string[]): Promise<{ stub: StubRegistry; env: ScratchEnv; project: Project }> {
    const stub = await startStubRegistry(layers.map(function at(l) { return join(REGISTRY, l) }))
    useStub(stub)
    const env = await openScratchEnv({ db: join(dir, file) })
    return { stub, env, project: await seedFixtureProject(env) }
}

function wayOutOf(row: InvariantRow): { chains: { path: string[]; verdict: Record<string, unknown> }[] } | null {
    return row.remediationJson === null ? null : JSON.parse(row.remediationJson) as { chains: { path: string[]; verdict: Record<string, unknown> }[] }
}

async function runFixture(def: SmokeDefinition): Promise<Step[]> {
    const steps: Step[] = []
    const dir = await mkdtemp(join(tmpdir(), 'sentinello-smoke-'))
    const stubs: StubRegistry[] = []
    try {
        const base = await fixtureEnv(dir, 'base.sqlite', ['base'])
        stubs.push(base.stub)
        const { env, project, stub } = base
        const osv = await osvFixtureScanner()
        const second = failingSecondSource()
        const scanners = [osv, second]

        // 1. Empty cache: every answer fetched in this run (a second ask for a package fetched minutes
        // earlier in the same run is served from that fresh row).
        const first = await scanAndCollect(env, project, scanners)
        const stale = first.snapshot.filter(function notThisRun(e) { return !(e.provenance === 'fetched' || (e.provenance === 'cache' && e.checkedAt !== null && e.checkedAt >= first.runStartedAt)) })
        steps.push({ name: '1 empty cache', detail: describeRun(first), failures: [...checkInvariants(first), ...def.historical(first), ...(first.snapshot.length > 0 && stale.length === 0 ? [] : ['answers not fetched in this run: ' + stale.map(function p(e) { return e.name + ':' + e.provenance }).join(', ')])] })

        // 2. Warm cache: no packument request reaches the stub, every answer is the first run's data.
        const before = stub.requests.length
        const warm = await scanAndCollect(env, project, scanners)
        const warmFailures = checkInvariants(warm)
        if (stub.requests.length !== before) warmFailures.push((stub.requests.length - before) + ' packument request(s) reached the stub on a warm cache')
        for (const e of warm.snapshot) {
            const earlier = first.snapshot.find(function same(f) { return f.name === e.name })
            if (e.provenance !== 'cache' || e.checkedAt === null || e.checkedAt >= warm.runStartedAt) warmFailures.push(e.name + ' was not served from the earlier cache (' + e.provenance + ')')
            if (earlier && e.checkedAt !== earlier.checkedAt) warmFailures.push(e.name + ' data is not the first run’s fetch')
        }
        steps.push({ name: '2 warm cache', detail: describeRun(warm), failures: [...warmFailures, ...def.historical(warm)] })

        // 2b. Cache aged past the window and the registry down: the old data, marked stale.
        env.sqlite.prepare('UPDATE registry_packages SET checked_at = checked_at - ?').run(FRESH_WINDOW_MS + 3_600_000)
        stub.setFailing(true)
        const staleRun = await scanAndCollect(env, project, scanners)
        stub.setFailing(false)
        const staleFailures = checkInvariants(staleRun)
        if (!staleRun.snapshot.every(function s(e) { return e.provenance === 'stale' })) staleFailures.push('not every answer was served stale')
        if (!staleRun.rows.filter(function npm(r) { return r.ecosystem === 'npm' }).every(function s(r) { return r.fixCheck?.registry === 'stale' })) staleFailures.push('not every row was settled on stale data')
        steps.push({ name: '2b stale cache, registry down', detail: describeRun(staleRun), failures: [...staleFailures, ...def.historical(staleRun)] })

        // 4. Negatives the invariant set must reject, built from run 1's real outcome.
        const braces = rowsFor(first, 'braces')[0] as InvariantRow
        function tamper(patch: (row: InvariantRow) => InvariantRow): Collected {
            return { ...first, rows: first.rows.map(function one(r) { return r.id === braces.id ? patch(structuredClone(r)) : r }) }
        }
        function tamperWayOut(patch: (way: { chains: { path: string[]; verdict: Record<string, unknown> }[] }) => void): Collected {
            return tamper(function edit(r) {
                const way = wayOutOf(r) as { chains: { path: string[]; verdict: Record<string, unknown> }[] }
                patch(way)
                return { ...r, remediationJson: JSON.stringify(way) }
            })
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
        steps.push(expectFailures('4e negative: none_released without its way-out', checkInvariants(tamper(function dropped(r) {
            return { ...r, remediationJson: null }
        }))))
        steps.push(expectFailures('4f negative: an escape to an unpublished release', checkInvariants(tamperWayOut(function inventEscape(way) {
            const blocked = way.chains.find(function b(c) { return c.verdict.kind === 'blocked' }) as { verdict: Record<string, unknown> }
            blocked.verdict.proof = { release: 'chokidar@9.9.9', closureSize: 1 }
        }))))
        steps.push(expectFailures('4g negative: an upgrade whose closure still reaches braces', checkInvariants(tamperWayOut(function reaches(way) {
            const chain = way.chains.find(function n(c) { return c.verdict.kind === 'blocked' }) as { verdict: Record<string, unknown> }
            chain.verdict = { kind: 'upgrade', package: 'chokidar', toAtLeast: '3.6.0', proof: { release: 'chokidar@3.6.0', closureSize: 3 } }
        }))))
        steps.push(expectFailures('4h negative: noEscape over a package that has an escaping release', checkInvariants(tamperWayOut(function falseNoEscape(way) {
            const chain = way.chains.find(function n(c) { return c.verdict.kind === 'blocked' }) as { verdict: Record<string, unknown> }
            chain.verdict = { kind: 'noEscape', packages: ['chokidar'] }
        }))))

        // 4d. A source that succeeded on run 1 fails now: its qs row is preserved, not re-settled by this
        // run, and must fail the freshness check even though braces and node-forge settle fine.
        second.failing = true
        const preserved = await scanAndCollect(env, project, scanners)
        second.failing = false
        const preservedRow = rowsFor(preserved, 'qs', 'GMS-fixture-qs-extra')
        steps.push(preservedRow.length === 1
            ? expectFailures('4d negative: a row preserved by a failed source', checkInvariants(preserved))
            : { name: '4d negative: a row preserved by a failed source', failures: ['the failed source\'s row was not preserved (' + preservedRow.length + ' rows)'] })
        env.close()

        // 3a. braces 3.0.4 published: a correct changed outcome.
        const released = await fixtureEnv(dir, 'braces-released.sqlite', ['base', 'braces-released'])
        stubs.push(released.stub)
        const releasedRun = await scanAndCollect(released.env, released.project, [osv])
        const releasedFailures = checkInvariants(releasedRun)
        for (const r of rowsFor(releasedRun, 'braces')) {
            if (r.fixStatus !== 'released' || r.fixVersion !== '3.0.4') releasedFailures.push('braces is ' + r.fixStatus + ' ' + r.fixVersion + ', expected released 3.0.4')
            if (r.remediationJson !== null) releasedFailures.push('braces carries a way-out although it is released')
        }
        steps.push({ name: '3a braces-released: invariants accept it', detail: describeRun(releasedRun), failures: releasedFailures })
        steps.push(expectFailures('3a braces-released: the historical set rejects it', def.historical(releasedRun)))
        released.env.close()

        // 3b. A nodemon release that admits chokidar 4 and whose whole closure is braces-free.
        const escape = await fixtureEnv(dir, 'nodemon-escape.sqlite', ['base', 'nodemon-escape'])
        stubs.push(escape.stub)
        const escapeRun = await scanAndCollect(escape.env, escape.project, [osv])
        const escapeFailures = checkInvariants(escapeRun)
        for (const r of rowsFor(escapeRun, 'braces')) {
            if (r.fixStatus !== 'none_released') escapeFailures.push('braces is ' + r.fixStatus + ', expected none_released')
            const nodemon = wayOutOf(r)?.chains.find(function n(c) { return c.path[0]?.startsWith('nodemon@') })
            const v = nodemon?.verdict as { kind?: string; package?: string; toAtLeast?: string; proof?: unknown } | undefined
            if (v?.kind !== 'upgrade' || v.package !== 'nodemon' || v.toAtLeast !== '3.2.0' || !v.proof) escapeFailures.push('the nodemon chain is ' + JSON.stringify(v) + ', expected upgrade nodemon to ≥ 3.2.0 with its proof')
        }
        steps.push({ name: '3b nodemon-escape: invariants accept it', detail: describeRun(escapeRun), failures: escapeFailures })
        const history = def.historical(escapeRun)
        steps.push(def.nodemonEscapeChangesHistory
            ? expectFailures('3b nodemon-escape: the historical set rejects it', history)
            : { name: '3b nodemon-escape: the historical set still holds', failures: history })
        escape.env.close()
        return steps
    } finally {
        for (const s of stubs) await s.close()
        await rm(dir, { recursive: true, force: true })
    }
}

async function runScratch(def: SmokeDefinition, dbPath: string, projectId: string, out: string | undefined, cold: boolean): Promise<Step[]> {
    const env = await openScratchEnv({ db: dbPath })
    try {
        const { getProjectById } = await import('@sentinello/db')
        const project = getProjectById(env.db, projectId)
        if (!project) return [{ name: 'scratch', failures: ['project ' + projectId + ' is not in ' + dbPath] }]
        if (cold) env.clearRegistryCache()
        const scanners = await liveScanners(env)
        const input = await scanAndCollect(env, project, scanners)
        const failures = checkInvariants(input)
        const counts: Record<string, number> = {}
        for (const e of input.snapshot) counts[e.provenance] = (counts[e.provenance] ?? 0) + 1
        const record = {
            recordedAt: new Date().toISOString(),
            smoke: def.name,
            database: dbPath,
            project: { id: project.id, name: project.name },
            scanners: scanners.map(function n(s) { return s.name }),
            runStartedAt: input.runStartedAt,
            registryAnswers: counts,
            rows: input.rows.map(function r(row) {
                return {
                    package: row.packageName + '@' + row.installedVersion, advisory: row.advisoryId, source: row.source, severity: row.severity,
                    fixStatus: row.fixStatus, fixVersion: row.fixVersion, registry: row.fixCheck?.registry ?? null, packageDataAsOf: row.fixCheck?.packageDataAsOf ?? null,
                    remediation: row.remediationJson === null ? null : JSON.parse(row.remediationJson)
                }
            }),
            exportWayOut: input.exportMarkdown.split('\n### ').slice(1).filter(function w(e) { return e.includes('- **Way out:**') }),
            failures,
            snapshot: input.snapshot.map(function s(e) {
                return { name: e.name, provenance: e.provenance, checkedAt: e.checkedAt, latest: e.summary?.latest ?? null, versions: e.summary ? Object.keys(e.summary.versions).length : null }
            })
        }
        console.log('[' + def.name + '] scratch: ' + input.rows.length + ' rows settled; registry answers ' + JSON.stringify(counts))
        for (const row of record.rows.filter(function watched(r) { return PRESENT.some(function p(name) { return r.package.startsWith(name + '@') }) })) {
            const way = row.remediation as { chains: { verdict: { kind: string } }[]; partial: boolean } | null
            const verdicts = way ? ' way-out: ' + way.chains.map(function k(c) { return c.verdict.kind }).join(', ') + (way.partial ? ' (partial)' : '') : ''
            console.log('  ' + row.package + ' ' + row.advisory + ' [' + row.source + '] ' + row.severity + ' → ' + row.fixStatus + ' ' + row.fixVersion + ' (registry ' + row.registry + ')' + verdicts)
        }
        if (out) writeFileSync(out, JSON.stringify(record, null, 2) + '\n')
        return [{ name: 'scratch invariants', failures }]
    } finally {
        env.close()
    }
}

// The worker's own scanner selection, over the scratch copies of the feed databases (opened at the paths
// scratch-env pinned) and with no feed sync attached.
export async function liveScanners(env: ScratchEnv): Promise<ScannerPlugin[]> {
    const db = await import('@sentinello/db')
    const { npmAuditPlugin } = await import('@sentinello/scanners')
    const osv = await import('../src/osv-runtime')
    const gemnasium = await import('../src/gemnasium-runtime')
    return osv.selectScanners(env.db, npmAuditPlugin, [
        { scanner: osv.createOsvScannerFor(env.db, db.openOsvDb().db), isEnabled: osv.osvSourceEnabled },
        { scanner: gemnasium.createGemnasiumScannerFor(env.db, db.openGemnasiumDb().db), isEnabled: gemnasium.gemnasiumSourceEnabled }
    ])
}

export function runSmoke(def: SmokeDefinition): void {
    main(def).then(function exit(code) {
        process.exit(code)
    }, function crash(err: unknown) {
        console.error(err)
        process.exit(1)
    })
}

async function main(def: SmokeDefinition): Promise<number> {
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
    if (values.fixture) steps = await runFixture(def)
    else if (values.scratch && values.project) steps = await runScratch(def, values.scratch, values.project, values.out, values.cold === true)
    else {
        console.error('usage: ' + def.name + '.ts --fixture | --scratch <db> --project <id> [--out <file>] [--cold]')
        return 2
    }
    let failed = 0
    for (const step of steps) {
        console.log((step.failures.length === 0 ? 'PASS ' : 'FAIL ') + step.name)
        if (step.detail) console.log('    ' + step.detail)
        for (const f of step.failures) console.log('    ' + f)
        if (step.failures.length > 0) failed++
    }
    console.log(failed === 0 ? '[' + def.name + '] all ' + steps.length + ' checks passed' : '[' + def.name + '] ' + failed + ' of ' + steps.length + ' checks failed')
    return failed === 0 ? 0 : 1
}
