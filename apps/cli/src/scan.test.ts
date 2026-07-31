import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DiscoveredProject, GemnasiumAdvisory, OsvAdvisory, RawFinding, ScanContext, ScanResult, ScannerPlugin } from '@sentinello/scanners'
import type { LoadedCache } from './cache/lookup'
import { buildScanners, collectPackageNames, resolveProjects, scanProject, type ResolvedProject, type ScanSetup } from './scan'

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
        ...overrides
    } as DiscoveredProject
}

function resolved(overrides: Partial<ResolvedProject> = {}): ResolvedProject {
    return {
        project: project(),
        results: [],
        merged: null,
        npmGraph: null,
        ...overrides
    } as ResolvedProject
}

function setup(overrides: Partial<ScanSetup> = {}): ScanSetup {
    return {
        cacheDir: dir,
        sources: ['osv', 'gemnasium'],
        ecosystem: 'npm',
        includeNpmAudit: true,
        seeded: { osv: true, gemnasium: true },
        ...overrides
    } as ScanSetup
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
        depPath: ['lodash'],
        isProd: true,
        isDev: false,
        ...overrides
    } as RawFinding
}

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
    return { osv: new Map(), gemnasium: new Map() }
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
        expect(first(out, 'resolved project').merged?.packages.map(function name(p) { return p.name })).toContain('lodash')
    })

    it('keeps the npm graph separately from the merged graph', async function () {
        await makeProject('web')
        const out = await resolveProjects([project()])
        expect(first(out, 'resolved project').npmGraph?.packages.map(function name(p) { return p.name })).toContain('lodash')
    })

    it('returns a null graph for a directory with nothing resolvable', async function () {
        await mkdir(join(dir, 'empty'), { recursive: true })
        const out = await resolveProjects([project({ absolutePath: join(dir, 'empty'), relPath: 'empty' })])
        expect(first(out, 'resolved project').merged).toBeNull()
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
})

describe('collectPackageNames', function () {
    // The cache is read ONCE for the union across every project rather than re-reading a 6.4 MB file
    // per project, so the union is what this has to produce.
    it('unions every package name across projects and deduplicates', async function () {
        await makeProject('web')
        await makeProject('api')
        const out = await resolveProjects([
            project({ absolutePath: join(dir, 'web'), relPath: 'web' }),
            project({ absolutePath: join(dir, 'api'), relPath: 'api' })
        ])
        expect(collectPackageNames(out).filter(function isLodash(n) { return n === 'lodash' })).toHaveLength(1)
    })

    it('skips projects whose graph did not resolve', function () {
        expect(collectPackageNames([resolved({ merged: null })])).toEqual([])
    })

    it('returns nothing for no projects', function () {
        expect(collectPackageNames([])).toEqual([])
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

    it('includes only the sources that are enabled', function () {
        expect(buildScanners(setup({ includeNpmAudit: false, sources: ['osv'] }), emptyCache()).map(function n(s) { return s.name })).toEqual(['osv'])
        expect(buildScanners(setup({ includeNpmAudit: false, sources: ['gemnasium'] }), emptyCache()).map(function n(s) { return s.name })).toEqual(['gemnasium'])
    })

    it('builds nothing when everything is disabled', function () {
        expect(buildScanners(setup({ includeNpmAudit: false, sources: [] }), emptyCache())).toEqual([])
    })

    // A cache mid-rebuild must report "not downloaded", never "no vulnerabilities".
    it('reports the source as unseeded when the cache metadata says so', async function () {
        await makeProject('web')
        const scanners = buildScanners(setup({ includeNpmAudit: false, sources: ['osv'], seeded: { osv: false, gemnasium: false } }), emptyCache())
        const scanned = await first(scanners, 'scanner').scan(join(dir, 'web'), { timeoutMs: 1000 })
        expect(scanned.status).not.toBe('ok')
    })

    it('serves matching advisories out of the preloaded cache', async function () {
        await makeProject('web')
        const cache: LoadedCache = {
            osv: new Map([['lodash', [osvAdvisory()]]]),
            gemnasium: new Map()
        }
        const scanners = buildScanners(setup({ includeNpmAudit: false, sources: ['osv'] }), cache)
        const graphs = await resolveProjects([project()])
        const scanned = await first(scanners, 'scanner').scan(join(dir, 'web'), { timeoutMs: 1000, resolvedGraph: first(graphs, 'resolved project').merged ?? undefined })
        expect(scanned.status).toBe('ok')
        expect(scanned.findings.map(function id(f) { return f.advisoryId })).toContain('GHSA-aaaa')
    })

    // A preloaded cache holding nothing for this project must read as "scanned, clean" — no findings and
    // no error. NOT a test of pick()'s cross-ecosystem guard: matchPackages skips an ecosystem via
    // isEnabled before it ever calls lookup, and the CLI's isEnabled is the same equality pick re-checks,
    // so that guard is unreachable from here. See the shape (c) inventory in vitest.config.ts.
    it('serves no findings from an empty preloaded cache', async function () {
        await makeProject('web')
        const scanners = buildScanners(setup({ includeNpmAudit: false, sources: ['osv'], ecosystem: 'npm' }), emptyCache())
        const graphs = await resolveProjects([project()])
        const scanned = await first(scanners, 'scanner').scan(join(dir, 'web'), { timeoutMs: 1000, resolvedGraph: first(graphs, 'resolved project').merged ?? undefined })
        expect(scanned.status).toBe('ok')
        expect(scanned.findings).toEqual([])
    })

    // The gemnasium wiring, which was built by every test above but never driven. The CLI and the worker
    // must bind the same three closures to the same cache semantics, because a CLI run and a portal scan
    // of one project are supposed to produce identical findings.
    it('serves matching advisories out of the preloaded gemnasium cache', async function () {
        await makeProject('web')
        const cache: LoadedCache = {
            osv: new Map(),
            gemnasium: new Map([['lodash', [gemnasiumAdvisory()]]])
        }
        const scanners = buildScanners(setup({ includeNpmAudit: false, sources: ['gemnasium'] }), cache)
        const graphs = await resolveProjects([project()])
        const scanned = await first(scanners, 'scanner').scan(join(dir, 'web'), { timeoutMs: 1000, resolvedGraph: first(graphs, 'resolved project').merged ?? undefined })
        expect(scanned.status).toBe('ok')
        expect(scanned.findings.map(function id(f) { return f.advisoryId })).toContain('GMS-2024-1')
    })

    // gemnasium's seed flag is global rather than per-ecosystem (one download covers every ecosystem), so
    // an unseeded cache has to report unauditable rather than zero findings — otherwise a cache that was
    // never downloaded reads exactly like a clean project.
    it('reports gemnasium as unseeded when the cache metadata says so', async function () {
        await makeProject('web')
        const scanners = buildScanners(setup({ includeNpmAudit: false, sources: ['gemnasium'], seeded: { osv: false, gemnasium: false } }), emptyCache())
        const scanned = await first(scanners, 'scanner').scan(join(dir, 'web'), { timeoutMs: 1000 })
        expect(scanned.status).toBe('unauditable')
        expect(scanned.reasonCode).toBe('gemnasium_db_not_seeded')
    })
})

describe('scanProject', function () {
    it('runs every scanner and records one outcome each, in order', async function () {
        const scanners = [fakeScanner('a', result()), fakeScanner('b', result())]
        const out = await scanProject(setup(), resolved(), scanners)
        expect(out.outcomes.map(function n(o) { return o.scanner })).toEqual(['a', 'b'])
    })

    it('returns the project it was given', async function () {
        const out = await scanProject(setup(), resolved(), [])
        expect(out.project.relPath).toBe('web')
    })

    it('collects findings from every successful scanner', async function () {
        const scanners = [
            fakeScanner('a', result({ findings: [finding()] })),
            fakeScanner('b', result({ findings: [finding({ advisoryId: 'GHSA-bbbb', packageName: 'express' })] }))
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
        const scanners = [fakeScanner('a', result({ status: 'unauditable', reasonCode: 'no_lockfile', findings: [finding()] }))]
        const out = await scanProject(setup(), resolved(), scanners)
        expect(first(out.outcomes, 'outcome')).toMatchObject({ status: 'unauditable', reasonCode: 'no_lockfile' })
        expect(out.findings).toEqual([])
    })

    // One scanner blowing up must not lose the other scanners' results for the same project.
    it('contains a thrown error as an outcome and carries on', async function () {
        const scanners = [
            throwingScanner('boom', new Error('spawn failed')),
            fakeScanner('b', result({ findings: [finding()] }))
        ]
        const out = await scanProject(setup(), resolved(), scanners)
        expect(first(out.outcomes, 'outcome')).toMatchObject({
            scanner: 'boom',
            status: 'error',
            reasonCode: 'audit_unknown_failure',
            errorText: 'spawn failed'
        })
        expect(out.findings).toHaveLength(1)
    })

    it('stringifies a non-Error throw rather than losing it', async function () {
        const scanners = [throwingScanner('boom', 'plain string')]
        const out = await scanProject(setup(), resolved(), scanners)
        expect(first(out.outcomes, 'outcome').errorText).toBe('plain string')
    })

    it('stops before the next scanner once the run is aborted', async function () {
        const controller = new AbortController()
        controller.abort()
        const scanners = [fakeScanner('a', result()), fakeScanner('b', result())]
        const out = await scanProject(setup({ abortSignal: controller.signal }), resolved(), scanners)
        expect(out.outcomes).toEqual([])
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

        it('hands npm-audit the npm graph and the feed scanners the merged graph', async function () {
            const npmGraph = { packages: [{ name: 'npm-only' }] } as ResolvedProject['npmGraph']
            const merged = { packages: [{ name: 'merged' }] } as ResolvedProject['merged']
            const audit = fakeScanner('npm-audit', result())
            const osv = fakeScanner('osv', result())
            await scanProject(setup(), resolved({ npmGraph, merged }), [audit, osv])
            expect(ctxOf(audit).resolvedGraph).toBe(npmGraph)
            expect(ctxOf(osv).resolvedGraph).toBe(merged)
        })

        // Coverage is per-ecosystem resolver status, which npm-audit has no use for.
        it('passes resolver coverage to the feed scanners but not to npm-audit', async function () {
            const audit = fakeScanner('npm-audit', result())
            const osv = fakeScanner('osv', result())
            await scanProject(setup(), resolved({
                results: [
                    { ecosystem: 'npm', status: 'ok' },
                    { ecosystem: 'PyPI', status: 'unauditable', reasonCode: 'no_lockfile', details: ['no requirements.txt'] }
                ] as ResolvedProject['results']
            }), [audit, osv])
            expect(ctxOf(audit).coverage).toBeUndefined()
            expect(ctxOf(osv).coverage).toEqual([
                { ecosystem: 'npm', status: 'ok' },
                { ecosystem: 'PyPI', status: 'unauditable', reasonCode: 'no_lockfile', details: ['no requirements.txt'] }
            ])
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
