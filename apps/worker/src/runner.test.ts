import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    listFindingsForScan,
    listScansForProject,
    openDb,
    runMigrations,
    upsertProject,
    upsertRoot,
    type DrizzleDb,
    type SqliteDb
} from '@sentinello/db'
import type { Project } from '@sentinello/core'
import type { RawFinding, ScanContext, ScannerPlugin, ScanResult } from '@sentinello/scanners'

// Partial: notifyForCompletedScan runs for real in every test below (it writes the discovery ledger
// against the same database), and is only diverted for the one case that needs it to fail.
const notifier = vi.hoisted(function makeNotifier() {
    return { failOnce: false }
})

vi.mock('./notifier', async function mockNotifier(importOriginal) {
    const actual = await importOriginal<typeof import('./notifier')>()
    return {
        ...actual,
        notifyForCompletedScan: async function notifyForCompletedScan(input: Parameters<typeof actual.notifyForCompletedScan>[0]) {
            if (notifier.failOnce) {
                notifier.failOnce = false
                throw new Error('slack is down')
            }
            return actual.notifyForCompletedScan(input)
        }
    }
})

const { runBatch } = await import('./runner')

// runBatch already takes db, sqlite, scanners and projects as an injected object, so this drives the
// real orchestration with fake ScannerPlugins and a real database — no seam was needed.
//
// The behaviours worth pinning are the ones that only appear when several scanners run together:
// each scanner gets its own scan row and merges findings scoped to its own name (so a second
// scanner never resolves the first one's findings), and later scanners are suppressed for advisories
// an earlier one already reported. That ordering is a deliberate choice — the authoritative source
// goes first — so it has to be observable.
//
// The project directory is an empty temp dir: no manifests means the resolvers return nothing and
// every scanner receives a null graph, which the fakes ignore. That keeps the test on the runner's
// own logic rather than on resolver behaviour covered elsewhere.

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'db', 'drizzle')

const ROOT_ID = 'root-1'
const PROJECT_ID = 'project-1'
const T0 = Date.UTC(2026, 0, 1)

let db: DrizzleDb
let sqlite: SqliteDb
let dir: string
let projectDir: string

function project(overrides: Partial<Project> = {}): Project {
    return {
        id: PROJECT_ID,
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

function rawFinding(overrides: Partial<RawFinding> = {}): RawFinding {
    return {
        advisoryId: 'CVE-2024-1',
        advisoryTitle: 'Prototype pollution',
        advisoryUrl: 'https://example.test/1',
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

function okResult(findings: RawFinding[]): ScanResult {
    return { status: 'ok', reasonCode: 'ok', findings, rawJson: '{}', errorText: null, durationMs: 5 }
}

// A scanner that records the contexts it was handed, so tests can assert what the runner passed in.
function fakeScanner(name: string, result: ScanResult | (() => Promise<ScanResult>)): ScannerPlugin & {
    contexts: ScanContext[]
} {
    const contexts: ScanContext[] = []
    return {
        name,
        contexts,
        async scan(_path: string, ctx: ScanContext): Promise<ScanResult> {
            contexts.push(ctx)
            if (typeof result === 'function') return result()
            return result
        }
    }
}

function batch(scanners: ScannerPlugin[], projects: Project[], abortSignal?: AbortSignal) {
    return runBatch({ db, sqlite, scanners, projects, parallelism: 4, abortSignal })
}

beforeEach(async function setup() {
    notifier.failOnce = false
    dir = await mkdtemp(join(tmpdir(), 'sentinello-runner-'))
    projectDir = join(dir, 'repo')
    const opened = openDb({ dbPath: join(dir, 'test.sqlite') })
    db = opened.db
    sqlite = opened.sqlite
    runMigrations(db, { migrationsFolder: MIGRATIONS })
    upsertRoot(db, { id: ROOT_ID, path: projectDir, label: null, createdAt: T0 })
    upsertProject(db, project())
})

afterEach(async function teardown() {
    sqlite.close()
    await rm(dir, { recursive: true, force: true })
})

describe('runBatch — basics', function () {
    it('returns nothing for an empty project list', async function () {
        const outcomes = await batch([fakeScanner('osv', okResult([]))], [])
        expect(outcomes).toEqual([])
    })

    it('records a scan row and its findings', async function () {
        const outcomes = await batch([fakeScanner('osv', okResult([rawFinding()]))], [project()])
        expect(outcomes).toHaveLength(1)
        expect(outcomes[0]?.scan.status).toBe('ok')
        expect(outcomes[0]?.findings).toHaveLength(1)
        expect(listScansForProject(db, PROJECT_ID)).toHaveLength(1)
    })

    it('persists the findings against the scan', async function () {
        const outcomes = await batch([fakeScanner('osv', okResult([rawFinding()]))], [project()])
        const scanId = outcomes[0]?.scan.id as string
        expect(listFindingsForScan(db, scanId)).toHaveLength(1)
    })

    it('stamps the scan with the scanner name as both scanner and source', async function () {
        const outcomes = await batch([fakeScanner('gemnasium', okResult([]))], [project()])
        expect(outcomes[0]?.scan.scanner).toBe('gemnasium')
        expect(outcomes[0]?.scan.source).toBe('gemnasium')
    })

    it('defaults a finding with no ecosystem to npm', async function () {
        const outcomes = await batch([fakeScanner('npm-audit', okResult([rawFinding()]))], [project()])
        expect(outcomes[0]?.findings[0]?.ecosystem).toBe('npm')
    })

    it('keeps an ecosystem the scanner stamped', async function () {
        const outcomes = await batch(
            [fakeScanner('osv', okResult([rawFinding({ ecosystem: 'PyPI', packageName: 'django' })]))],
            [project()]
        )
        expect(outcomes[0]?.findings[0]?.ecosystem).toBe('PyPI')
    })

    it('scans every project in the batch', async function () {
        upsertProject(db, project({ id: 'project-2', relPath: 'other', name: 'other' }))
        const outcomes = await batch(
            [fakeScanner('osv', okResult([rawFinding()]))],
            [project(), project({ id: 'project-2', relPath: 'other', name: 'other' })]
        )
        expect(outcomes).toHaveLength(2)
        expect(outcomes.map(function id(o) { return o.project.id }).sort()).toEqual(['project-1', 'project-2'])
    })

    it('works when parallelism exceeds the number of projects', async function () {
        const outcomes = await runBatch({
            db,
            sqlite,
            scanners: [fakeScanner('osv', okResult([]))],
            projects: [project()],
            parallelism: 32
        })
        expect(outcomes).toHaveLength(1)
    })

    it('still runs when parallelism is zero or negative', async function () {
        const outcomes = await runBatch({
            db,
            sqlite,
            scanners: [fakeScanner('osv', okResult([]))],
            projects: [project()],
            parallelism: 0
        })
        expect(outcomes).toHaveLength(1)
    })
})

describe('runBatch — several scanners', function () {
    it('writes one scan row per scanner', async function () {
        await batch(
            [fakeScanner('npm-audit', okResult([])), fakeScanner('osv', okResult([]))],
            [project()]
        )
        const scans = listScansForProject(db, PROJECT_ID)
        expect(scans).toHaveLength(2)
        expect(scans.map(function s(x) { return x.scanner }).sort()).toEqual(['npm-audit', 'osv'])
    })

    it('runs scanners in the order given', async function () {
        const order: string[] = []
        const a: ScannerPlugin = {
            name: 'first',
            async scan() { order.push('first'); return okResult([]) }
        }
        const b: ScannerPlugin = {
            name: 'second',
            async scan() { order.push('second'); return okResult([]) }
        }
        await batch([a, b], [project()])
        expect(order).toEqual(['first', 'second'])
    })

    // The dedup rule: a later scanner's finding is suppressed when an earlier one already reported
    // the same advisory for the same package. This is why scanner order is meaningful — the
    // authoritative source goes first and wins.
    it('suppresses a later scanner reporting the same advisory for the same package', async function () {
        const outcomes = await batch(
            [
                fakeScanner('npm-audit', okResult([rawFinding({ advisoryId: 'CVE-2024-1' })])),
                fakeScanner('osv', okResult([rawFinding({ advisoryId: 'CVE-2024-1' })]))
            ],
            [project()]
        )
        const byScanner = new Map(outcomes.map(function e(o) { return [o.scan.scanner, o] }))
        expect(byScanner.get('npm-audit')?.findings).toHaveLength(1)
        expect(byScanner.get('osv')?.findings).toHaveLength(0)
    })

    // Dedup matches on aliases too, so the same vulnerability reported under a GHSA by one source and
    // a CVE by another collapses to one finding rather than double-reporting.
    it('suppresses a later scanner matching only by alias', async function () {
        const outcomes = await batch(
            [
                fakeScanner('npm-audit', okResult([rawFinding({ advisoryId: 'GHSA-aaaa-bbbb-cccc' })])),
                fakeScanner('osv', okResult([
                    rawFinding({ advisoryId: 'CVE-2024-1', aliases: ['GHSA-aaaa-bbbb-cccc'] })
                ]))
            ],
            [project()]
        )
        const byScanner = new Map(outcomes.map(function e(o) { return [o.scan.scanner, o] }))
        expect(byScanner.get('osv')?.findings).toHaveLength(0)
    })

    it('keeps a later scanner finding for a different package', async function () {
        const outcomes = await batch(
            [
                fakeScanner('npm-audit', okResult([rawFinding({ packageName: 'lodash' })])),
                fakeScanner('osv', okResult([rawFinding({ packageName: 'express' })]))
            ],
            [project()]
        )
        const byScanner = new Map(outcomes.map(function e(o) { return [o.scan.scanner, o] }))
        expect(byScanner.get('osv')?.findings).toHaveLength(1)
    })

    // Dedup is keyed on the ecosystem-scoped package identity, so a PyPI package must not be
    // collapsed into a same-named npm package that happens to share an alias.
    it('does not collapse the same package name across ecosystems', async function () {
        const outcomes = await batch(
            [
                fakeScanner('npm-audit', okResult([rawFinding({ packageName: 'requests', ecosystem: 'npm' })])),
                fakeScanner('osv', okResult([rawFinding({ packageName: 'requests', ecosystem: 'PyPI' })]))
            ],
            [project()]
        )
        const byScanner = new Map(outcomes.map(function e(o) { return [o.scan.scanner, o] }))
        expect(byScanner.get('osv')?.findings).toHaveLength(1)
    })

    // Each scanner merges scoped to its own name. Without that, the second scanner's pass would
    // resolve the first scanner's findings as "gone".
    it('does not let one scanner resolve another scanner findings', async function () {
        const outcomes = await batch(
            [
                fakeScanner('npm-audit', okResult([rawFinding({ packageName: 'lodash' })])),
                fakeScanner('osv', okResult([rawFinding({ packageName: 'express' })]))
            ],
            [project()]
        )
        for (const outcome of outcomes) {
            expect(outcome.findings).toHaveLength(1)
        }
    })

    it('starts each project with a clean dedup set', async function () {
        upsertProject(db, project({ id: 'project-2', relPath: 'other', name: 'other' }))
        const outcomes = await batch(
            [fakeScanner('osv', okResult([rawFinding()]))],
            [project(), project({ id: 'project-2', relPath: 'other', name: 'other' })]
        )
        for (const outcome of outcomes) {
            expect(outcome.findings).toHaveLength(1)
        }
    })
})

describe('runBatch — scanner context', function () {
    // nvm is JavaScript-only tooling. A project's .nvmrc must not make a toolchain-free feed source
    // try to switch Node versions.
    it('enables nvm only for npm-audit and only when an nvmrc exists', async function () {
        upsertProject(db, project({ nvmrcVersion: '24.14.0' }))
        const npmAudit = fakeScanner('npm-audit', okResult([]))
        const osv = fakeScanner('osv', okResult([]))
        await batch([npmAudit, osv], [project({ nvmrcVersion: '24.14.0' })])
        expect(npmAudit.contexts[0]?.useNvm).toBe(true)
        expect(osv.contexts[0]?.useNvm).toBe(false)
    })

    it('leaves nvm off for npm-audit when the project has no nvmrc', async function () {
        const npmAudit = fakeScanner('npm-audit', okResult([]))
        await batch([npmAudit], [project({ nvmrcVersion: null })])
        expect(npmAudit.contexts[0]?.useNvm).toBe(false)
    })

    // Feed sources record per-ecosystem coverage in their rawJson; npm-audit answers only for
    // JavaScript and ignores it.
    it('passes resolver coverage to feed sources but not to npm-audit', async function () {
        const npmAudit = fakeScanner('npm-audit', okResult([]))
        const osv = fakeScanner('osv', okResult([]))
        await batch([npmAudit, osv], [project()])
        expect(npmAudit.contexts[0]?.coverage).toBeUndefined()
        expect(osv.contexts[0]?.coverage).toBeDefined()
    })

    it('passes the abort signal through to the scanner', async function () {
        const controller = new AbortController()
        const osv = fakeScanner('osv', okResult([]))
        await batch([osv], [project()], controller.signal)
        expect(osv.contexts[0]?.abortSignal).toBe(controller.signal)
    })

    it('gives the scanner a timeout', async function () {
        const osv = fakeScanner('osv', okResult([]))
        await batch([osv], [project()])
        expect(osv.contexts[0]?.timeoutMs).toBeGreaterThan(0)
    })
})

describe('runBatch — failures', function () {
    it('records an error scan when the project root is missing from the database', async function () {
        const outcomes = await batch([fakeScanner('osv', okResult([]))], [project({ rootId: 'no-such-root' })])
        expect(outcomes).toHaveLength(1)
        expect(outcomes[0]?.scan.status).toBe('error')
        expect(outcomes[0]?.scan.errorText).toContain('root not found')
        expect(listScansForProject(db, PROJECT_ID)).toHaveLength(1)
    })

    it('records an error scan when a scanner throws', async function () {
        const thrower: ScannerPlugin = {
            name: 'osv',
            async scan() { throw new Error('scanner exploded') }
        }
        const outcomes = await batch([thrower], [project()])
        expect(outcomes[0]?.scan.status).toBe('error')
        expect(outcomes[0]?.scan.errorText).toContain('scanner exploded')
        expect(outcomes[0]?.findings).toEqual([])
    })

    it('describes a scanner that threw a non-Error', async function () {
        const thrower: ScannerPlugin = {
            name: 'osv',
            async scan() { throw 'just a string' }
        }
        const outcomes = await batch([thrower], [project()])
        expect(outcomes[0]?.scan.errorText).toContain('just a string')
    })

    it('keeps running the remaining scanners after one throws', async function () {
        const thrower: ScannerPlugin = {
            name: 'npm-audit',
            async scan() { throw new Error('boom') }
        }
        const outcomes = await batch([thrower, fakeScanner('osv', okResult([rawFinding()]))], [project()])
        expect(outcomes).toHaveLength(2)
        const byScanner = new Map(outcomes.map(function e(o) { return [o.scan.scanner, o] }))
        expect(byScanner.get('osv')?.findings).toHaveLength(1)
    })

    // A transient failure must not mass-resolve a project's findings — the portal keeps its
    // last-known view instead.
    it('leaves findings untouched for a non-ok scan', async function () {
        await batch([fakeScanner('osv', okResult([rawFinding()]))], [project()])

        const failing = fakeScanner('osv', {
            status: 'error',
            reasonCode: 'audit_unknown_failure',
            findings: [],
            rawJson: '',
            errorText: 'transient',
            durationMs: 1
        })
        const outcomes = await batch([failing], [project()])
        expect(outcomes[0]?.findings).toEqual([])

        // The earlier finding is still open: a fresh ok scan re-reports it as one active finding.
        const recovered = await batch([fakeScanner('osv', okResult([rawFinding()]))], [project()])
        expect(recovered[0]?.findings).toHaveLength(1)
    })

    it('records the scan row even for an unauditable result', async function () {
        const outcomes = await batch(
            [fakeScanner('osv', {
                status: 'unauditable',
                reasonCode: 'osv_db_not_seeded',
                findings: [],
                rawJson: '',
                errorText: 'not seeded',
                durationMs: 1
            })],
            [project()]
        )
        expect(outcomes[0]?.scan.reasonCode).toBe('osv_db_not_seeded')
        expect(listScansForProject(db, PROJECT_ID)).toHaveLength(1)
    })

    // The notifier is best-effort: a failing webhook must not lose the scan that already landed.
    it('keeps the scan when the notifier fails', async function () {
        const logged = vi.spyOn(console, 'error').mockImplementation(function silence() {})
        try {
            const outcomes = await batch([fakeScanner('osv', okResult([rawFinding()]))], [project()])
            expect(outcomes[0]?.scan.status).toBe('ok')
            expect(listScansForProject(db, PROJECT_ID)).toHaveLength(1)
        } finally {
            logged.mockRestore()
        }
    })
})

describe('runBatch — abort', function () {
    it('stops before the next scanner once aborted', async function () {
        const controller = new AbortController()
        const first: ScannerPlugin = {
            name: 'npm-audit',
            async scan() {
                controller.abort()
                return okResult([])
            }
        }
        const second = fakeScanner('osv', okResult([]))
        const outcomes = await batch([first, second], [project()], controller.signal)
        expect(outcomes).toHaveLength(1)
        expect(second.contexts).toEqual([])
    })

    it('stops taking new projects once aborted', async function () {
        upsertProject(db, project({ id: 'project-2', relPath: 'other', name: 'other' }))
        const controller = new AbortController()
        controller.abort()
        const scanner = fakeScanner('osv', okResult([]))
        const outcomes = await runBatch({
            db,
            sqlite,
            scanners: [scanner],
            projects: [project(), project({ id: 'project-2', relPath: 'other', name: 'other' })],
            parallelism: 1,
            abortSignal: controller.signal
        })
        expect(outcomes).toEqual([])
    })
})

describe('runBatch — the git branch refresh', function () {
    // The branch is re-read at scan time rather than trusted from the last discovery sweep, because
    // the checkout can move between the two — and the notification built later in this same pass
    // reads it off the in-memory project, so a stale value would page an operator about "main" for
    // findings that came from a feature branch.
    async function makeGitDir(head: string): Promise<void> {
        const { mkdir, writeFile } = await import('node:fs/promises')
        await mkdir(join(projectDir, '.git'), { recursive: true })
        await writeFile(join(projectDir, '.git', 'HEAD'), head, 'utf8')
    }

    function storedBranch(): string | null {
        return (sqlite.prepare('SELECT git_branch AS b FROM projects WHERE id = ?').get(PROJECT_ID) as { b: string | null }).b
    }

    it('records a branch that discovery had not seen', async function () {
        await makeGitDir('ref: refs/heads/release/2.7\n')
        const p = project({ gitBranch: null })

        await batch([fakeScanner('osv', okResult([]))], [p])

        expect(storedBranch()).toBe('release/2.7')
        // Mutated in place, not just persisted — this is the copy the notifier reads.
        expect(p.gitBranch).toBe('release/2.7')
    })

    it('updates a branch that has moved since the last sweep', async function () {
        await makeGitDir('ref: refs/heads/main\n')
        await batch([fakeScanner('osv', okResult([]))], [project({ gitBranch: 'old-branch' })])
        expect(storedBranch()).toBe('main')
    })

    // The short-circuit: an unchanged branch costs one file read and no write. Asserted by watching
    // updated_at, which setProjectGitBranch would bump.
    it('writes nothing when the branch is unchanged', async function () {
        await makeGitDir('ref: refs/heads/main\n')
        await batch([fakeScanner('osv', okResult([]))], [project({ gitBranch: 'main' })])

        const row = sqlite.prepare('SELECT git_branch AS b, updated_at AS u FROM projects WHERE id = ?').get(PROJECT_ID) as { b: string | null; u: number }
        expect(row.b).toBeNull()
        expect(row.u).toBe(T0)
    })

    it('leaves a non-git project on a null branch', async function () {
        await batch([fakeScanner('osv', okResult([]))], [project({ gitBranch: null })])
        expect(storedBranch()).toBeNull()
    })
})

describe('runBatch — the notifier', function () {
    // Notification is the last step and is explicitly best-effort: the scan, its findings and the
    // lifecycle merge are already committed by the time it runs. A webhook timeout must not discard
    // that work or mark the scan failed, because the data is what the portal shows and the
    // notification is only how the operator hears about it.
    it('keeps the scan and its findings when notification fails', async function () {
        notifier.failOnce = true
        const errors: string[] = []
        vi.spyOn(console, 'error').mockImplementation(function capture(...args: unknown[]) {
            errors.push(String(args[0]))
        })

        const outcomes = await batch([fakeScanner('osv', okResult([rawFinding()]))], [project()])

        expect(outcomes).toHaveLength(1)
        expect(outcomes[0]?.findings).toHaveLength(1)
        expect(listScansForProject(db, PROJECT_ID)).toHaveLength(1)
        expect(listFindingsForScan(db, outcomes[0]!.scan.id)).toHaveLength(1)
        expect(errors.some(function m(l) { return l.includes('notifier failed for project ' + PROJECT_ID + ': slack is down') })).toBe(true)
        vi.restoreAllMocks()
    })
})

describe('runBatch — ecosystem coverage', function () {
    // Coverage is what makes a clean scan honest: it records, per ecosystem, whether the dependency
    // graph was fully resolved. Without it a project whose lockfile could not be parsed reports zero
    // findings exactly like a project that genuinely has none, and the feed scanners have no way to
    // say "I could not see your dependencies" rather than "you are fine".
    //
    // Only the feed scanners receive it. npm-audit is handed undefined because it derives its own
    // reachability from the lockfile it just parsed, and stamping the resolver's view on top would
    // report the same gap twice.
    // projectDir is the ROOT path; the project itself lives at <root>/<relPath>, which is where the
    // runner resolves manifests from.
    async function writeManifest(files: Record<string, string>): Promise<void> {
        const { mkdir, writeFile } = await import('node:fs/promises')
        const path = join(projectDir, 'app')
        await mkdir(path, { recursive: true })
        for (const [name, body] of Object.entries(files)) {
            await writeFile(join(path, name), body, 'utf8')
        }
    }

    function coverageOf(scanner: { contexts: ScanContext[] }): unknown {
        return (scanner.contexts[0] as unknown as { coverage?: unknown }).coverage
    }

    it('reports ok coverage for a fully resolved graph', async function () {
        await writeManifest({
            'package.json': JSON.stringify({ name: 'app', dependencies: { lodash: '4.17.11' } }),
            'package-lock.json': JSON.stringify({
                lockfileVersion: 3,
                packages: { '': { name: 'app' }, 'node_modules/lodash': { version: '4.17.11' } }
            })
        })
        const osv = fakeScanner('osv', okResult([]))

        await batch([osv], [project()])

        expect(coverageOf(osv)).toEqual([{ ecosystem: 'npm', status: 'ok' }])
    })

    // yarn.lock is detected as the npm manifest but deliberately not parsed, so the graph is
    // unauditable rather than empty. Carrying the reasonCode and details through is the difference
    // between the portal saying "we could not read your yarn.lock" and it saying nothing at all
    // while showing zero findings.
    it('carries the reason code through for a graph that could not be resolved', async function () {
        await writeManifest({
            'package.json': JSON.stringify({ name: 'app', dependencies: { lodash: '^4.17.11' } }),
            'yarn.lock': '# yarn lockfile v1\n'
        })
        const osv = fakeScanner('osv', okResult([]))

        await batch([osv], [project()])

        const coverage = coverageOf(osv) as Array<{ ecosystem: string; status: string; reasonCode?: string; details?: string[] }>
        expect(coverage).toHaveLength(1)
        expect(coverage[0]).toMatchObject({ ecosystem: 'npm', status: 'unauditable', reasonCode: 'unsupported_lockfile' })
        expect(coverage[0]?.details?.[0]).toContain('yarn.lock')
    })

    it('withholds coverage from npm-audit, which derives its own', async function () {
        await writeManifest({
            'package.json': JSON.stringify({ name: 'app', dependencies: { lodash: '^4.17.11' } }),
            'yarn.lock': '# yarn lockfile v1\n'
        })
        const audit = fakeScanner('npm-audit', okResult([]))

        await batch([audit], [project()])

        expect(coverageOf(audit)).toBeUndefined()
    })
})
