import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { discoverProjectsInTree, versionSetFromSemverRange, type DiscoveredProject, type GemnasiumAdvisory, type OsvAdvisory, type RawFinding, type ResolvedGraph, type ResolvedPackage, type ScanContext, type ScanResult, type ScannerPlugin } from '@sentinello/scanners'
import type { NpmPackageResult, PublishedResult } from '@sentinello/feeds'
import { createMemoryRegistryStore, createNpmRegistryClient, createPublishedRegistryClient, type RegistryClients } from '@sentinello/fixes'
import type { EcosystemCache, FeedCell, LoadedCache } from './cache/lookup'
import { buildScanners, cellRuns, cliScanState, collectPackageNames, detectedEcosystems, installationsFor, pick, projectEcosystems, resolveProjects, scanProject, type ResolvedManifest, type ResolvedProject, type ScanSetup } from './scan'

// The CLI's scan runner — structurally apps/worker/src/runner.ts with the database and notification calls
// removed. The symmetry is the point: a CLI run and a portal scan of the same project must produce the
// same findings, which is only true if they drive the scanners identically. What is worth pinning here is
// therefore the ORCHESTRATION, not the scanning: order, dedup, per-scanner context, and error containment.
//
// The scanners are hand-written doubles rather than the real plugins. That is not a shortcut around a
// missing seam — ScannerPlugin is already a two-field interface, and buildScanners hands runBatch the real
// npmAuditPlugin, which shells out to `npm audit` per project. Driving the orchestration with fakes is the
// only way to assert on it without spawning subprocesses.

let dir: string

function project(overrides: Partial<DiscoveredProject> = {}): DiscoveredProject {
    return {
        absolutePath: join(dir, 'web'),
        relPath: 'web',
        name: 'web',
        packageManager: 'npm',
        nvmrcVersion: null,
        gitBranch: null,
        ecosystems: ['npm'],
        manifests: [{ path: 'package-lock.json', ecosystem: 'npm', kind: 'package-lock.json' }],
        ...overrides
    } as DiscoveredProject
}

function pkg(ecosystem: string, name: string, version = '1.0.0', manifestPath = 'package-lock.json'): ResolvedPackage {
    return { ecosystem, name, version, scope: { isProd: true, isDev: false, isOptional: false }, depPaths: [], manifestPath }
}

// Only `packages` is read by the merge and `byName` by the installations lookup.
function graphOf(packages: ResolvedPackage[]): ResolvedGraph {
    return {
        packages,
        classify: function classify() { return { isProd: true, isDev: false, isOptional: false } },
        byName: function byName(name: string) { return packages.filter(function named(p) { return p.name === name }) },
        nodeGraph: null
    }
}

function okManifest(manifestPath: string, ecosystem: string, packages: ResolvedPackage[] = []): ResolvedManifest {
    return { manifestPath, result: { status: 'ok', ecosystem, graph: graphOf(packages) } }
}

// A project holding one npm lockfile, unless the test says otherwise.
function resolved(overrides: Partial<ResolvedProject> = {}): ResolvedProject {
    return {
        project: project(),
        manifests: [okManifest('package-lock.json', 'npm')],
        npmGraph: null,
        ...overrides
    }
}

function cells(sources: FeedCell['source'][], ecosystems: FeedCell['ecosystem'][] = ['npm']): FeedCell[] {
    return sources.flatMap(function bySource(source) {
        return ecosystems.map(function cell(ecosystem) { return { source, ecosystem } })
    })
}

function setup(overrides: Partial<ScanSetup> = {}): ScanSetup {
    return {
        cacheDir: dir,
        cells: cells(['osv', 'gemnasium']),
        includeNpmAudit: true,
        seeded: cells(['osv', 'gemnasium']),
        settledAt: 0,
        registry: null,
        ...overrides
    }
}

function finding(overrides: Partial<RawFinding> = {}): RawFinding {
    return {
        advisoryId: 'GHSA-aaaa',
        advisoryTitle: 'Prototype pollution',
        advisoryUrl: null,
        packageName: 'lodash',
        installedVersion: '4.17.11',
        vulnerableRange: '<4.17.21',
        severity: 'high',
        fixAvailable: true,
        fixVersion: '4.17.21',
        fixInputs: {
            source: 'osv',
            installed: ['4.17.11'],
            affected: versionSetFromSemverRange('<4.17.21'),
            patched: null,
            patchedSet: null,
            statedFix: '4.17.21',
            fixViaParent: false
        },
        depPath: ['lodash'],
        isProd: true,
        isDev: false,
        ...overrides
    }
}

// A PyPI affected set: fix evidence is in its ecosystem's comparator, and settlement refuses any other.
const PEP440_THROUGH_2 = { comparator: 'pep440' as const, ranges: [{ type: 'ECOSYSTEM', introduced: '0', fixed: null, lastAffected: '2.0.0' }], exact: [], complete: true }

function result(overrides: Partial<ScanResult> = {}): ScanResult {
    return {
        status: 'ok',
        reasonCode: 'ok',
        findings: [],
        rawJson: '{}',
        errorText: null,
        durationMs: 7,
        ...overrides
    } as ScanResult
}

// Records the ScanContext it was handed so the per-scanner wiring can be asserted.
function fakeScanner(name: string, produce: ScanResult): ScannerPlugin & { contexts: ScanContext[] } {
    const contexts: ScanContext[] = []
    return {
        name,
        contexts,
        scan: async function scan(_path: string, ctx: ScanContext): Promise<ScanResult> {
            contexts.push(ctx)
            return produce
        }
    }
}

// A scanner that blows up instead of returning, for the error-containment path.
function throwingScanner(name: string, thrown: unknown): ScannerPlugin {
    return {
        name,
        scan: async function scan(): Promise<ScanResult> {
            throw thrown
        }
    }
}

// Indexed access is checked here (noUncheckedIndexedAccess), and these two throw rather than returning
// undefined so a wiring mistake fails on the missing element instead of on a confusing
// property-of-undefined several lines later.
function first<T>(items: readonly T[], what: string): T {
    const item = items[0]
    if (!item) throw new Error('expected at least one ' + what)
    return item
}

// The context the scanner was actually handed.
function ctxOf(scanner: { contexts: ScanContext[] }): ScanContext {
    return first(scanner.contexts, 'scanner invocation')
}

function emptyCache(): LoadedCache {
    return new Map()
}

function cacheOf(ecosystem: string, entry: Partial<EcosystemCache>): LoadedCache {
    return new Map([[ecosystem, { osv: new Map(), gemnasium: new Map(), withdrawalsChecked: false, ...entry }]])
}

// Typed rather than cast: the range needs `lastAffected` and the severity is a plain string, both of
// which a cast would have hidden while the scanner quietly matched nothing.
function osvAdvisory(overrides: Partial<OsvAdvisory> = {}): OsvAdvisory {
    return {
        advisoryId: 'GHSA-aaaa',
        aliases: [],
        ranges: [{ type: 'SEMVER', introduced: '0', fixed: '4.17.21', lastAffected: null }],
        versions: [],
        severity: 'high',
        summary: 'Prototype pollution',
        url: null,
        malicious: false,
        withdrawn: null,
        ...overrides
    }
}

// gemnasium carries no malware flag and uses ranges rather than enumerated versions, so its rows are not
// interchangeable with the OSV fixture above even though both feed the same matching engine.
function gemnasiumAdvisory(overrides: Partial<GemnasiumAdvisory> = {}): GemnasiumAdvisory {
    return {
        advisoryId: 'GMS-2024-1',
        aliases: [],
        ranges: [{ introduced: '0', fixed: '4.17.21' }],
        versions: [],
        severity: 'high',
        summary: 'Prototype pollution',
        url: null,
        withdrawn: null,
        ...overrides
    }
}

async function makeProject(relPath: string, extra: Record<string, string> = {}): Promise<string> {
    const target = join(dir, relPath)
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'package.json'), JSON.stringify({
        name: relPath.replace(/\//g, '-'),
        version: '1.0.0',
        dependencies: { lodash: '^4.17.11' }
    }), 'utf8')
    await writeFile(join(target, 'package-lock.json'), JSON.stringify({
        name: relPath.replace(/\//g, '-'),
        lockfileVersion: 3,
        packages: {
            '': { name: relPath.replace(/\//g, '-'), version: '1.0.0', dependencies: { lodash: '^4.17.11' } },
            'node_modules/lodash': { version: '4.17.11' }
        }
    }), 'utf8')
    for (const [name, content] of Object.entries(extra)) {
        await writeFile(join(target, name), content, 'utf8')
    }
    return target
}

beforeEach(async function setupDir() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-cli-scan-'))
})

afterEach(async function teardown() {
    await rm(dir, { recursive: true, force: true })
})

describe('resolveProjects', function () {
    it('resolves each project graph from its real lockfile', async function () {
        await makeProject('web')
        const out = await resolveProjects([project()])
        expect(out).toHaveLength(1)
        const manifest = first(first(out, 'resolved project').manifests, 'manifest')
        expect(manifest.manifestPath).toBe('package-lock.json')
        expect(manifest.result.status === 'ok' && manifest.result.graph.packages.map(function name(p) { return p.name })).toContain('lodash')
    })

    it('keeps the npm graph for npm-audit and the way out', async function () {
        await makeProject('web')
        const out = await resolveProjects([project()])
        expect(first(out, 'resolved project').npmGraph?.packages.map(function name(p) { return p.name })).toContain('lodash')
    })

    it('reads a manifest that cannot be resolved as unauditable, with no npm graph', async function () {
        await mkdir(join(dir, 'empty'), { recursive: true })
        await writeFile(join(dir, 'empty', 'package.json'), '{}', 'utf8')
        const out = await resolveProjects([project({ absolutePath: join(dir, 'empty'), relPath: 'empty', manifests: [{ path: 'package.json', ecosystem: 'npm', kind: 'package.json' }] })])
        expect(first(first(out, 'resolved project').manifests, 'manifest').result.status).toBe('unauditable')
        expect(first(out, 'resolved project').npmGraph).toBeNull()
    })

    it('preserves input order across several projects', async function () {
        await makeProject('web')
        await makeProject('api')
        const out = await resolveProjects([
            project({ absolutePath: join(dir, 'web'), relPath: 'web' }),
            project({ absolutePath: join(dir, 'api'), relPath: 'api' })
        ])
        expect(out.map(function rel(r) { return r.project.relPath })).toEqual(['web', 'api'])
    })

    // The manifests discovery assigned, as the worker reads them: a sub-manifest belongs to its project.
    it('resolves the sub-manifests discovery assigned to the project, each under its own path', async function () {
        await makeProject('app', { 'requirements.txt': 'requests==2.0.0\n' })
        await mkdir(join(dir, 'app', 'ios'), { recursive: true })
        await writeFile(join(dir, 'app', 'ios', 'Gemfile.lock'), 'GEM\n  remote: https://rubygems.org/\n  specs:\n    rack (2.0.0)\n\nPLATFORMS\n  ruby\n\nDEPENDENCIES\n  rack\n', 'utf8')
        const [app] = discoverProjectsInTree({ rootPath: join(dir, 'app') })
        const out = await resolveProjects([app as DiscoveredProject])
        const manifests = first(out, 'resolved project').manifests
        expect(manifests.map(function shape(m) { return [m.manifestPath, m.result.ecosystem] })).toEqual([
            ['package-lock.json', 'npm'],
            ['requirements.txt', 'PyPI'],
            ['ios/Gemfile.lock', 'RubyGems']
        ])
    })
})

describe('detectedEcosystems', function () {
    it('lists every ecosystem the projects hold once, in registry order', function () {
        expect(detectedEcosystems([
            project({ ecosystems: ['RubyGems', 'npm'] }),
            project({ ecosystems: ['PyPI', 'npm'] })
        ])).toEqual(['npm', 'PyPI', 'RubyGems'])
    })

    it('is empty for no projects', function () {
        expect(detectedEcosystems([])).toEqual([])
    })
})

describe('collectPackageNames', function () {
    // The cache is read ONCE for the union across every project rather than re-reading a 6.4 MB file
    // per project, so the union is what this has to produce — per ecosystem, since each has its own file.
    it('unions every package name across projects and deduplicates', async function () {
        await makeProject('web')
        await makeProject('api')
        const out = await resolveProjects([
            project({ absolutePath: join(dir, 'web'), relPath: 'web' }),
            project({ absolutePath: join(dir, 'api'), relPath: 'api' })
        ])
        expect(collectPackageNames(out).get('npm')).toEqual(['lodash'])
    })

    it('keeps each ecosystem\'s names apart, even where two spell the same name', function () {
        const names = collectPackageNames([resolved({
            manifests: [
                okManifest('package-lock.json', 'npm', [pkg('npm', 'requests')]),
                okManifest('requirements.txt', 'PyPI', [pkg('PyPI', 'requests'), pkg('PyPI', 'urllib3')]),
                okManifest('ios/Gemfile.lock', 'RubyGems', [pkg('RubyGems', 'rack')]),
                okManifest('android/Gemfile.lock', 'RubyGems', [pkg('RubyGems', 'rack')])
            ]
        })])
        expect(Object.fromEntries(names)).toEqual({ npm: ['requests'], PyPI: ['requests', 'urllib3'], RubyGems: ['rack'] })
    })

    it('skips manifests that did not resolve', function () {
        expect(collectPackageNames([resolved({ manifests: [{ manifestPath: 'package.json', result: { status: 'unauditable', ecosystem: 'npm', reasonCode: 'no_lockfile', details: [] } }] })]).size).toBe(0)
    })

    it('returns nothing for no projects', function () {
        expect(collectPackageNames([]).size).toBe(0)
    })
})

describe('pick', function () {
    // Each ecosystem's advisories are their own map, so a query is answered out of the asked ecosystem's
    // rows or not at all: serving npm rows for a Python query would invent findings.
    const rows = new Map([['lodash', [{ advisoryId: 'GHSA-1' }]], ['empty', []]])

    it('serves the rows of the asked names', function () {
        expect([...pick(rows, ['lodash']).keys()]).toEqual(['lodash'])
    })

    it('serves nothing for an ecosystem the run loaded nothing for', function () {
        expect(pick(undefined, ['lodash']).size).toBe(0)
    })

    it('omits names the cache has no rows for, or an empty list', function () {
        expect(pick(rows, ['express', 'empty']).size).toBe(0)
    })
})

describe('cellRuns', function () {
    it('runs npm-audit for npm alone, and only when the run includes it', function () {
        expect(cellRuns(setup(), 'npm-audit', 'npm')).toBe(true)
        expect(cellRuns(setup(), 'npm-audit', 'PyPI')).toBe(false)
        expect(cellRuns(setup({ includeNpmAudit: false }), 'npm-audit', 'npm')).toBe(false)
    })

    it('runs a feed source for each cell the run audits', function () {
        const polyglot = setup({ cells: [{ source: 'osv', ecosystem: 'PyPI' }] })
        expect(cellRuns(polyglot, 'osv', 'PyPI')).toBe(true)
        expect(cellRuns(polyglot, 'osv', 'npm')).toBe(false)
        expect(cellRuns(polyglot, 'gemnasium', 'PyPI')).toBe(false)
    })
})

describe('projectEcosystems', function () {
    it('lists the ecosystems of the project\'s manifests once, in registry order', function () {
        expect(projectEcosystems({ manifests: [okManifest('Gemfile.lock', 'RubyGems'), okManifest('package-lock.json', 'npm'), okManifest('ios/Gemfile.lock', 'RubyGems')] })).toEqual(['npm', 'RubyGems'])
    })
})

describe('buildScanners', function () {
    // Order IS the dedup priority: npm-audit is authoritative and goes first, then OSV, then gemnasium —
    // identical to the worker's selectScanners.
    it('puts npm-audit first, then osv, then gemnasium', function () {
        const names = buildScanners(setup(), emptyCache()).map(function name(s) { return s.name })
        expect(names).toEqual(['npm-audit', 'osv', 'gemnasium'])
    })

    it('omits npm-audit when it is switched off', function () {
        const names = buildScanners(setup({ includeNpmAudit: false }), emptyCache()).map(function name(s) { return s.name })
        expect(names).toEqual(['osv', 'gemnasium'])
    })

    it('builds a feed source when any ecosystem has a cell for it', function () {
        expect(buildScanners(setup({ includeNpmAudit: false, cells: cells(['osv'], ['Go']) }), emptyCache()).map(function n(s) { return s.name })).toEqual(['osv'])
        expect(buildScanners(setup({ includeNpmAudit: false, cells: cells(['gemnasium']) }), emptyCache()).map(function n(s) { return s.name })).toEqual(['gemnasium'])
    })

    it('builds nothing when everything is disabled', function () {
        expect(buildScanners(setup({ includeNpmAudit: false, cells: [] }), emptyCache())).toEqual([])
    })

    // A cache mid-rebuild must report "not downloaded", never "no vulnerabilities".
    it('reports OSV as unseeded for an ecosystem whose cache metadata says so', async function () {
        await makeProject('web')
        const graphs = await resolveProjects([project()])
        const scanners = buildScanners(setup({ includeNpmAudit: false, cells: cells(['osv']), seeded: [] }), emptyCache())
        const scanned = await first(scanners, 'scanner').scan(join(dir, 'web'), { timeoutMs: 1000, ecosystem: 'npm', resolvedGraph: first(graphs, 'resolved project').npmGraph })
        expect(scanned).toMatchObject({ status: 'unauditable', reasonCode: 'osv_db_not_seeded' })
    })

    it('serves matching advisories out of the preloaded cache', async function () {
        await makeProject('web')
        const scanners = buildScanners(setup({ includeNpmAudit: false, cells: cells(['osv']) }), cacheOf('npm', { osv: new Map([['lodash', [osvAdvisory()]]]) }))
        const graphs = await resolveProjects([project()])
        const scanned = await first(scanners, 'scanner').scan(join(dir, 'web'), { timeoutMs: 1000, ecosystem: 'npm', resolvedGraph: first(graphs, 'resolved project').npmGraph })
        expect(scanned.status).toBe('ok')
        expect(scanned.findings.map(function id(f) { return f.advisoryId })).toContain('GHSA-aaaa')
    })

    // Another ecosystem's rows never answer: the PyPI entry holds lodash, the npm entry nothing.
    it('serves no findings out of another ecosystem\'s rows', async function () {
        await makeProject('web')
        const scanners = buildScanners(setup({ includeNpmAudit: false, cells: cells(['osv'], ['npm', 'PyPI']) }), cacheOf('PyPI', { osv: new Map([['lodash', [osvAdvisory()]]]) }))
        const graphs = await resolveProjects([project()])
        const scanned = await first(scanners, 'scanner').scan(join(dir, 'web'), { timeoutMs: 1000, ecosystem: 'npm', resolvedGraph: first(graphs, 'resolved project').npmGraph })
        expect(scanned.status).toBe('ok')
        expect(scanned.findings).toEqual([])
    })

    // The gemnasium wiring. The CLI and the worker must bind the same closures to the same cache semantics,
    // because a CLI run and a portal scan of one project are supposed to produce identical findings.
    it('serves matching advisories out of the preloaded gemnasium cache', async function () {
        await makeProject('web')
        const scanners = buildScanners(setup({ includeNpmAudit: false, cells: cells(['gemnasium']) }), cacheOf('npm', { gemnasium: new Map([['lodash', [gemnasiumAdvisory()]]]) }))
        const graphs = await resolveProjects([project()])
        const scanned = await first(scanners, 'scanner').scan(join(dir, 'web'), { timeoutMs: 1000, ecosystem: 'npm', resolvedGraph: first(graphs, 'resolved project').npmGraph })
        expect(scanned.status).toBe('ok')
        expect(scanned.findings.map(function id(f) { return f.advisoryId })).toContain('GMS-2024-1')
    })

    // The scanner's own seed gate takes no ecosystem, but the CLI seeds each ecosystem's file on its own: the
    // gate is the cell the run is for, and a run with no ecosystem named has none seeded.
    it.each([
        ['an ecosystem whose cache was never seeded', 'PyPI' as const],
        ['a run that names no ecosystem', undefined]
    ])('reports gemnasium as unseeded for %s', async function (_label, ecosystem) {
        const scanners = buildScanners(setup({ includeNpmAudit: false, cells: cells(['gemnasium'], ['npm', 'PyPI']), seeded: cells(['gemnasium']) }), emptyCache())
        const scanned = await first(scanners, 'scanner').scan(join(dir, 'web'), { timeoutMs: 1000, ecosystem })
        expect(scanned.status).toBe('unauditable')
        expect(scanned.reasonCode).toBe('gemnasium_db_not_seeded')
    })
})

describe('scanProject', function () {
    it('runs every scanner and records one outcome each, in order', async function () {
        const scanners = [fakeScanner('osv', result()), fakeScanner('gemnasium', result())]
        const out = await scanProject(setup(), resolved(), scanners)
        expect(out.outcomes.map(function n(o) { return [o.scanner, o.ecosystem] })).toEqual([['osv', 'npm'], ['gemnasium', 'npm']])
    })

    // runProjectScanners' loop: every source once per cell, the ecosystems in registry order.
    it('runs each source once per ecosystem the project holds, and npm-audit for npm alone', async function () {
        const audit = fakeScanner('npm-audit', result())
        const osv = fakeScanner('osv', result())
        const gemnasium = fakeScanner('gemnasium', result())
        const polyglot = resolved({ manifests: [okManifest('Gemfile.lock', 'RubyGems'), okManifest('package-lock.json', 'npm'), okManifest('requirements.txt', 'PyPI')] })
        const out = await scanProject(setup({ cells: cells(['osv', 'gemnasium'], ['npm', 'PyPI', 'RubyGems']) }), polyglot, [audit, osv, gemnasium])
        expect(out.outcomes.map(function n(o) { return o.scanner + ' ' + o.ecosystem })).toEqual([
            'npm-audit npm',
            'osv npm', 'osv PyPI', 'osv RubyGems',
            'gemnasium npm', 'gemnasium PyPI', 'gemnasium RubyGems'
        ])
        expect(osv.contexts.map(function eco(c) { return c.ecosystem })).toEqual(['npm', 'PyPI', 'RubyGems'])
    })

    it('skips a cell the run does not audit', async function () {
        const osv = fakeScanner('osv', result())
        const polyglot = resolved({ manifests: [okManifest('package-lock.json', 'npm'), okManifest('go.mod', 'Go')] })
        const out = await scanProject(setup({ cells: cells(['osv'], ['Go']) }), polyglot, [osv])
        expect(out.outcomes.map(function n(o) { return o.ecosystem })).toEqual(['Go'])
    })

    // The dedup keys are ecosystem-scoped: a PyPI `requests` is not an npm `requests` sharing an alias.
    it('keeps the same advisory reported for a same-named package of another ecosystem', async function () {
        const shared = { advisoryId: 'GHSA-shared', aliases: ['CVE-FAKE-1'], packageName: 'requests' }
        const osv = { name: 'osv', scan: async function scan(_path: string, ctx: ScanContext): Promise<ScanResult> {
            const own = ctx.ecosystem === 'PyPI' ? { fixInputs: { ...finding().fixInputs, affected: PEP440_THROUGH_2 } } : {}
            return result({ findings: [finding({ ...shared, ...own, ecosystem: ctx.ecosystem })] })
        } }
        const polyglot = resolved({ manifests: [okManifest('package-lock.json', 'npm'), okManifest('requirements.txt', 'PyPI')] })
        const out = await scanProject(setup({ cells: cells(['osv'], ['npm', 'PyPI']) }), polyglot, [osv])
        expect(out.findings.map(function eco(f) { return f.ecosystem })).toEqual(['npm', 'PyPI'])
    })

    it('returns the project it was given', async function () {
        const out = await scanProject(setup(), resolved(), [])
        expect(out.project.relPath).toBe('web')
    })

    it('collects findings from every successful scanner', async function () {
        const scanners = [
            fakeScanner('osv', result({ findings: [finding()] })),
            fakeScanner('gemnasium', result({ findings: [finding({ advisoryId: 'GHSA-bbbb', packageName: 'express' })] }))
        ]
        const out = await scanProject(setup(), resolved(), scanners)
        expect(out.findings.map(function id(f) { return f.advisoryId })).toEqual(['GHSA-aaaa', 'GHSA-bbbb'])
    })

    // Order is dedup priority: a later source drops what an earlier one already surfaced.
    it('drops a later scanner\'s duplicate of an advisory already reported for the same package', async function () {
        const scanners = [
            fakeScanner('npm-audit', result({ findings: [finding()] })),
            fakeScanner('osv', result({ findings: [finding({ aliases: ['GHSA-aaaa'] })] }))
        ]
        const out = await scanProject(setup(), resolved(), scanners)
        expect(out.findings).toHaveLength(1)
    })

    it('keeps a same-advisory finding reported against a different package', async function () {
        const scanners = [
            fakeScanner('npm-audit', result({ findings: [finding()] })),
            fakeScanner('osv', result({ findings: [finding({ packageName: 'express' })] }))
        ]
        const out = await scanProject(setup(), resolved(), scanners)
        expect(out.findings).toHaveLength(2)
    })

    it('records a non-ok outcome and contributes none of its findings', async function () {
        const scanners = [fakeScanner('osv', result({ status: 'unauditable', reasonCode: 'no_lockfile', findings: [finding()] }))]
        const out = await scanProject(setup(), resolved(), scanners)
        expect(first(out.outcomes, 'outcome')).toMatchObject({ status: 'unauditable', reasonCode: 'no_lockfile' })
        expect(out.findings).toEqual([])
    })

    // One scanner blowing up must not lose the other scanners' results for the same project.
    it('contains a thrown error as an outcome and carries on', async function () {
        const scanners = [
            throwingScanner('npm-audit', new Error('spawn failed')),
            fakeScanner('osv', result({ findings: [finding()] }))
        ]
        const out = await scanProject(setup(), resolved(), scanners)
        expect(first(out.outcomes, 'outcome')).toMatchObject({
            scanner: 'npm-audit',
            ecosystem: 'npm',
            status: 'error',
            reasonCode: 'audit_unknown_failure',
            errorText: 'spawn failed'
        })
        expect(out.findings).toHaveLength(1)
    })

    it('stringifies a non-Error throw rather than losing it', async function () {
        const scanners = [throwingScanner('osv', 'plain string')]
        const out = await scanProject(setup(), resolved(), scanners)
        expect(first(out.outcomes, 'outcome').errorText).toBe('plain string')
    })

    it('stops before the next scanner once the run is aborted', async function () {
        const controller = new AbortController()
        controller.abort()
        const scanners = [fakeScanner('osv', result()), fakeScanner('gemnasium', result())]
        const out = await scanProject(setup({ abortSignal: controller.signal }), resolved(), scanners)
        expect(out.outcomes).toEqual([])
    })

    // The fix is settled by the same settleProject the worker calls, against the run's registry client.
    describe('fix settlement', function () {
        const braces = finding({
            advisoryId: 'GHSA-vfj7-8cjw-p6xm',
            packageName: 'braces',
            installedVersion: '3.0.3',
            vulnerableRange: '<=3.0.3',
            fixAvailable: false,
            fixVersion: null,
            fixInputs: { source: 'osv', installed: ['3.0.3'], affected: versionSetFromSemverRange('<=3.0.3'), patched: null, patchedSet: null, statedFix: null, fixViaParent: false }
        })

        function registry(fail = false) {
            const asked: string[] = []
            const client = createNpmRegistryClient(createMemoryRegistryStore(), {
                now: function now() { return 1 },
                fetchPackage: async function fetchPackage(name: string): Promise<NpmPackageResult> {
                    asked.push(name)
                    if (fail) return { status: 'error', reason: 'HTTP 503' }
                    return { status: 'ok', summary: { v: 2, name, latest: '3.0.3', modified: 1, maintainers: 1, repository: null, versions: { '3.0.3': { publishedAt: 1, deprecated: null, edges: null } }, prereleases: {}, edges: [] }, etag: null, bytes: 1 }
                },
                fetchDownloads: async function fetchDownloads() { return { status: 'error', reason: 'down' } }
            })
            return { client, asked }
        }

        it('settles against the registry and carries the way out of a finding with no released fix', async function () {
            const { client, asked } = registry()
            // Reported by two sources: one identity, one lookup, one settlement, one way out.
            const scanners = [fakeScanner('osv', result({ findings: [braces] })), fakeScanner('gemnasium', result({ findings: [{ ...braces, fixInputs: { ...braces.fixInputs, source: 'gemnasium' } }] }))]
            const out = await scanProject(setup({ registry: { npm: client } }), resolved(), scanners)
            expect(out.findings).toHaveLength(1)
            expect(asked).toEqual(['braces'])
            const kept = first(out.findings, 'finding')
            expect(out.fixes.get(kept)).toMatchObject({ fixStatus: 'none_released', fixVersion: null, fixCheck: { registry: 'ok' } })
            expect(out.remediations.get(kept)).toMatchObject({ package: 'braces' })
            expect(out.wayOutError).toBeNull()
        })

        it('leaves a finding unverified with no way out when the registry cannot answer', async function () {
            const { client } = registry(true)
            const out = await scanProject(setup({ registry: { npm: client } }), resolved(), [fakeScanner('osv', result({ findings: [braces] }))])
            const kept = first(out.findings, 'finding')
            expect(out.fixes.get(kept)).toMatchObject({ fixStatus: 'unverified', fixCheck: { registry: 'error' } })
            expect(out.remediations.size).toBe(0)
        })

        // Each ecosystem settles against its own registry, through the client the run built for it.
        it('settles a PyPI finding against the PyPI client, and its way out is the npm-only verdict', async function () {
            const asked: string[] = []
            const pypi: NonNullable<RegistryClients['PyPI']> = createPublishedRegistryClient(createMemoryRegistryStore(), async function fetchPackage(name: string): Promise<PublishedResult> {
                asked.push(name)
                return { status: 'ok', summary: { v: 1, name, versions: { '1.0.0': { yanked: false }, '2.0.0': { yanked: false } } }, etag: null }
            }, { now: function now() { return 1 } })
            const pyFinding = finding({
                ecosystem: 'PyPI',
                packageName: 'fake-py-lib',
                installedVersion: '2.0.0',
                vulnerableRange: '<=2.0.0',
                fixAvailable: false,
                fixVersion: null,
                fixInputs: { source: 'osv', installed: ['2.0.0'], affected: PEP440_THROUGH_2, patched: null, patchedSet: null, statedFix: null, fixViaParent: false }
            })
            const polyglot = resolved({ manifests: [okManifest('requirements.txt', 'PyPI')] })
            const out = await scanProject(setup({ cells: cells(['osv'], ['PyPI']), registry: { PyPI: pypi } }), polyglot, [fakeScanner('osv', result({ findings: [pyFinding] }))])
            const kept = first(out.findings, 'finding')
            expect(asked).toEqual(['fake-py-lib'])
            expect(out.fixes.get(kept)).toMatchObject({ fixStatus: 'none_released' })
            expect(out.remediations.get(kept)?.chains.map(function verdict(c) { return c.verdict.kind })).toEqual(['unknown'])
        })

        it('asks nothing offline, and marks the fix as not checked because of it', async function () {
            const out = await scanProject(setup({ registry: null }), resolved(), [fakeScanner('osv', result({ findings: [braces] }))])
            expect(out.fixes.get(first(out.findings, 'finding'))).toMatchObject({ fixStatus: 'unverified', fixCheck: { registry: 'offline' } })
            expect(out.remediations.size).toBe(0)
        })
    })

    describe('per-scanner context', function () {
        // Only npm-audit touches the Node toolchain, and only when the project pins a version.
        it('enables nvm only for npm-audit on a project with an .nvmrc', async function () {
            const audit = fakeScanner('npm-audit', result())
            const osv = fakeScanner('osv', result())
            await scanProject(setup(), resolved({ project: project({ nvmrcVersion: '22.1.0' }) }), [audit, osv])
            expect(ctxOf(audit).useNvm).toBe(true)
            expect(ctxOf(osv).useNvm).toBe(false)
        })

        it('leaves nvm off when the project pins no version', async function () {
            const audit = fakeScanner('npm-audit', result())
            await scanProject(setup(), resolved({ project: project({ nvmrcVersion: null }) }), [audit])
            expect(ctxOf(audit).useNvm).toBe(false)
        })

        it('hands npm-audit the npm graph and a feed scanner only its cell\'s packages', async function () {
            const npmGraph = graphOf([pkg('npm', 'npm-only')])
            const audit = fakeScanner('npm-audit', result())
            const osv = fakeScanner('osv', result())
            const polyglot = resolved({
                npmGraph,
                manifests: [
                    okManifest('package-lock.json', 'npm', [pkg('npm', 'left-pad')]),
                    okManifest('ios/Gemfile.lock', 'RubyGems', [pkg('RubyGems', 'rack', '2.0.0', 'ios/Gemfile.lock')]),
                    okManifest('android/Gemfile.lock', 'RubyGems', [pkg('RubyGems', 'rack', '2.1.0', 'android/Gemfile.lock')])
                ]
            })
            await scanProject(setup({ cells: cells(['osv'], ['npm', 'RubyGems']) }), polyglot, [audit, osv])
            expect(ctxOf(audit).resolvedGraph).toBe(npmGraph)
            expect(osv.contexts.map(function names(c) { return c.resolvedGraph?.packages.map(function id(p) { return p.name + '@' + p.version }) })).toEqual([
                ['left-pad@1.0.0'],
                // Two manifests of one ecosystem are merged into the one cell.
                ['rack@2.0.0', 'rack@2.1.0']
            ])
        })

        // Coverage is per-manifest resolver status for the cell's ecosystem, which npm-audit has no use for.
        it('passes each cell its own manifests\' coverage, and npm-audit none', async function () {
            const audit = fakeScanner('npm-audit', result())
            const osv = fakeScanner('osv', result())
            await scanProject(setup({ cells: cells(['osv'], ['npm', 'PyPI']) }), resolved({
                manifests: [
                    okManifest('package-lock.json', 'npm'),
                    { manifestPath: 'pyproject.toml', result: { status: 'unauditable', ecosystem: 'PyPI', reasonCode: 'no_lockfile', details: ['no lockfile'] } }
                ]
            }), [audit, osv])
            expect(ctxOf(audit).coverage).toBeUndefined()
            expect(osv.contexts.map(function coverage(c) { return c.coverage })).toEqual([
                [{ ecosystem: 'npm', manifestPath: 'package-lock.json', status: 'ok' }],
                [{ ecosystem: 'PyPI', manifestPath: 'pyproject.toml', status: 'unauditable', reasonCode: 'no_lockfile', details: ['no lockfile'] }]
            ])
            // A cell with nothing readable gets no graph to match.
            expect(osv.contexts[1]?.resolvedGraph).toBeNull()
        })

        it('threads the abort signal and a timeout into every scanner', async function () {
            const controller = new AbortController()
            const osv = fakeScanner('osv', result())
            await scanProject(setup({ abortSignal: controller.signal }), resolved(), [osv])
            expect(ctxOf(osv).abortSignal).toBe(controller.signal)
            expect(ctxOf(osv).timeoutMs).toBeGreaterThan(0)
        })
    })
})

// tests/fixtures/projects/npm-no-lockfile: a package.json with nothing pinned. Every source the run enabled
// is refused for the same reason, on the project's side, so the project cannot be scanned — never clean.
describe('project cannot be scanned — a lockfile-less project', function () {
    const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tests', 'fixtures', 'projects', 'npm-no-lockfile')

    it('reads as cannot be scanned: No lockfile, from the source and the npm dependencies', async function () {
        const [entry] = await resolveProjects([project({ absolutePath: FIXTURE, relPath: 'npm-no-lockfile', name: 'npm-no-lockfile', manifests: [{ path: 'package.json', ecosystem: 'npm', kind: 'package.json' }] })])
        const scanners = buildScanners(setup({ includeNpmAudit: false, cells: cells(['osv']) }), emptyCache())
        const scanned = await scanProject(setup({ includeNpmAudit: false, cells: cells(['osv']) }), entry as ResolvedProject, scanners)
        expect(scanned.findings).toEqual([])
        expect(scanned.scanState).toEqual({
            state: 'cannot_scan',
            reasons: [
                { source: 'osv', ecosystem: null, reasonCode: 'no_lockfile', side: 'project' },
                { source: null, ecosystem: 'npm', reasonCode: 'no_lockfile', side: 'project' }
            ]
        })
    })
})

describe('cliScanState — the run is its own expected sources', function () {
    const ok = okManifest('package-lock.json', 'npm')
    const outcome = function outcome(scanner: string, ecosystem: 'npm' | 'PyPI' = 'npm') {
        return { scanner, ecosystem, status: 'ok', reasonCode: 'ok', errorText: null, durationMs: 1 }
    }

    it('is scanned when every cell the run enabled answered and every ecosystem was read', function () {
        expect(cliScanState(setup({ cells: cells(['osv']) }), { manifests: [ok] }, [{ name: 'osv' }], [outcome('osv')])).toEqual({ state: 'scanned', reasons: [] })
    })

    // Every ecosystem the run audits answers for itself: an unreadable PyPI manifest is a reason.
    it('reads an unreadable manifest of another audited ecosystem as a reason', function () {
        const pyproject: ResolvedManifest = { manifestPath: 'pyproject.toml', result: { status: 'unauditable', ecosystem: 'PyPI', reasonCode: 'no_lockfile', details: [] } }
        const state = cliScanState(setup({ cells: cells(['osv'], ['npm', 'PyPI']) }), { manifests: [ok, pyproject] }, [{ name: 'osv' }], [outcome('osv'), outcome('osv', 'PyPI')])
        expect(state).toEqual({ state: 'partial', reasons: [{ source: null, ecosystem: 'PyPI', reasonCode: 'no_lockfile', side: 'project' }] })
    })

    // `--source npm-audit` on a tree with a Python project: nothing answers for PyPI, which is a reason,
    // never a clean result.
    it('reads an ecosystem no cell answers for as having no source enabled', function () {
        const requirements = okManifest('requirements.txt', 'PyPI')
        const state = cliScanState(setup({ cells: [] }), { manifests: [ok, requirements] }, [{ name: 'npm-audit' }], [outcome('npm-audit')])
        expect(state).toEqual({ state: 'partial', reasons: [{ source: null, ecosystem: 'PyPI', reasonCode: 'ecosystem_source_disabled', side: 'environment' }] })
    })

    it('reads a scanner the run never reached as not yet run, and a partly read ecosystem by its reason', function () {
        const partial: ResolvedManifest = { manifestPath: 'package-lock.json', result: { status: 'partial', ecosystem: 'npm', reasonCode: 'partial_dependency_graph', details: [], graph: graphOf([]) } }
        expect(cliScanState(setup({ cells: cells(['osv']) }), { manifests: [partial] }, [{ name: 'npm-audit' }, { name: 'osv' }], [outcome('npm-audit')])).toEqual({
            state: 'partial',
            reasons: [
                { source: 'osv', ecosystem: null, reasonCode: 'not_yet_run', side: null },
                { source: null, ecosystem: 'npm', reasonCode: 'partial_dependency_graph', side: 'project' }
            ]
        })
    })

    it('cannot be scanned when the run enabled no scanner for any of its ecosystems', function () {
        expect(cliScanState(setup({ cells: [], includeNpmAudit: false }), { manifests: [ok] }, [], [])).toEqual({
            state: 'cannot_scan',
            reasons: [{ source: null, ecosystem: 'npm', reasonCode: 'ecosystem_source_disabled', side: 'environment' }]
        })
    })
})

describe('installationsFor', function () {
    const graph = graphOf([
        pkg('npm', 'lodash', '4.17.11', 'package-lock.json'),
        pkg('npm', 'lodash', '4.17.11', 'package-lock.json'),
        pkg('npm', 'lodash', '4.17.20', 'packages/app/package-lock.json'),
        pkg('npm', 'lodash', '4.17.21', 'package-lock.json')
    ])

    it('keeps what the matcher recorded', function () {
        const recorded = [{ manifestPath: 'requirements.txt', version: '2.0.0' }]
        expect(installationsFor(finding({ installations: recorded }), graph)).toBe(recorded)
    })

    // npm-audit reports a comma-joined installed value and no installations: they come from the npm graph.
    it('finds an npm-audit finding\'s copies in the npm graph, each once', function () {
        expect(installationsFor(finding({ installedVersion: '4.17.11, 4.17.20' }), graph)).toEqual([
            { manifestPath: 'package-lock.json', version: '4.17.11' },
            { manifestPath: 'packages/app/package-lock.json', version: '4.17.20' }
        ])
    })

    it('names none with no npm graph to look in', function () {
        expect(installationsFor(finding(), null)).toEqual([])
    })
})
