import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRowWriter } from '../../../apps/cli/src/cache/store'
import { advisoryFilePath, writeCacheMeta } from '../../../apps/cli/src/cache/meta'
import { startStubRegistry, type StubRegistry } from '../../fixtures/registry-stub'
import { OSV_NORMALIZER_VERSION } from '@sentinello/core'
import type { OsvAdvisoryRow } from '@sentinello/core'

// Drives the REAL bundled binary — the same dist/cli.cjs npm publishes — as a subprocess. That is
// the point: an in-process test cannot catch a packaging fault (a dependency that failed to bundle,
// a broken shebang, an import that only resolves in the workspace).
//
// The run is hermetic by construction. Both feed URLs are set to 'off', which makes planSync skip
// every source, and --source osv,gemnasium sets includeNpmAudit=false so nothing is ever spawned.
// The advisory cache is pre-seeded from the frozen fixture, so findings are exact and permanent. The fix
// check reads the npm registry, so every run points it at a loopback stub over recorded packuments: this
// suite never reaches the live registry, and it counts every request the CLI makes.

const execFileAsync = promisify(execFile)

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')
const CLI_BIN = join(REPO_ROOT, 'apps', 'cli', 'dist', 'cli.cjs')
const FIXTURE_PROJECT = join(REPO_ROOT, 'tests', 'fixtures', 'projects', 'npm-basic')
const FIXTURE_NO_FIX_PROJECT = join(REPO_ROOT, 'tests', 'fixtures', 'projects', 'npm-no-fix')
const FIXTURE_ADVISORIES = join(REPO_ROOT, 'tests', 'fixtures', 'advisories', 'osv-npm.ndjson')
const REGISTRY_LAYERS = [
    join(REPO_ROOT, 'apps', 'worker', 'test', 'fixtures', 'registry', 'base'),
    join(REPO_ROOT, 'tests', 'fixtures', 'registry', 'npm-basic')
]

const OFFLINE_ENV = {
    SENTINELLO_OSV_FEED_URL: 'off',
    SENTINELLO_GEMNASIUM_FEED_URL: 'off',
    NO_COLOR: '1'
}

let cacheDir: string
let stub: StubRegistry

type RunResult = { code: number; stdout: string; stderr: string }

async function runCli(args: string[], cache: string = cacheDir): Promise<RunResult> {
    try {
        const { stdout, stderr } = await execFileAsync('node', [CLI_BIN, ...args], {
            env: { ...process.env, ...OFFLINE_ENV, SENTINELLO_CACHE_DIR: cache, SENTINELLO_NPM_REGISTRY_URL: stub.url, SENTINELLO_NPM_DOWNLOADS_URL: stub.url },
            maxBuffer: 32 * 1024 * 1024
        })
        return { code: 0, stdout, stderr }
    } catch (err) {
        const e = err as { code?: number; stdout?: string; stderr?: string }
        return { code: e.code ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
    }
}

// A scan of the fixture project with the advisory feeds as the only sources: no network, no spawn.
async function scanFixture(extraArgs: string[] = []): Promise<RunResult> {
    return await runCli([FIXTURE_PROJECT, '--source', 'osv,gemnasium', '--no-prompt', '--out', '-', ...extraArgs])
}

beforeAll(async function seedCache() {
    if (!existsSync(CLI_BIN)) {
        throw new Error('CLI bundle missing at ' + CLI_BIN + ' — run `pnpm --filter sentinello build` first')
    }

    stub = await startStubRegistry(REGISTRY_LAYERS)
    cacheDir = await seededCache()
})

// An advisory cache seeded from the frozen fixture, with no registry cache yet.
async function seededCache(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'sentinello-cli-e2e-'))

    // Seed through the real writer, so the cache is byte-identical to one a live sync would produce.
    const text = await readFile(FIXTURE_ADVISORIES, 'utf8')
    const rows: OsvAdvisoryRow[] = text
        .split('\n')
        .filter(function nonEmpty(line) {
            return line.trim().length > 0
        })
        .map(function parse(line) {
            return JSON.parse(line) as OsvAdvisoryRow
        })

    const writer = createRowWriter(advisoryFilePath(dir, 'osv', 'npm'))
    await writer.write(rows)
    const count = await writer.commit()

    await writeCacheMeta(dir, {
        schemaVersion: 1,
        sources: {
            osv: { npm: { normalizerVersion: OSV_NORMALIZER_VERSION, recordCount: count, refreshedAt: Date.UTC(2026, 0, 1) } },
            gemnasium: {}
        }
    })
    return dir
}

afterAll(async function cleanup() {
    await stub.close()
    await rm(cacheDir, { recursive: true, force: true })
})

describe('sentinello --version and --help', function () {
    it('prints a version', async function () {
        const result = await runCli(['--version'])
        expect(result.code).toBe(0)
        expect(result.stdout.trim().length).toBeGreaterThan(0)
    })

    it('prints usage listing the documented flags', async function () {
        const result = await runCli(['--help'])
        expect(result.code).toBe(0)
        for (const flag of ['--source', '--severity', '--fail-on', '--json', '--offline', '--cache-dir']) {
            expect(result.stdout, flag).toContain(flag)
        }
    })

    it('rejects an unknown flag with exit code 1', async function () {
        const result = await runCli(['--definitely-not-a-flag'])
        expect(result.code).toBe(1)
        expect(result.stderr).toContain('unknown option')
    })
})

describe('scanning the frozen fixture', function () {
    it('finds exactly the advisories the frozen data implies', async function () {
        const result = await scanFixture(['--json'])
        expect(result.code).toBe(0)

        const doc = JSON.parse(result.stdout)
        const ids = doc.findings.map(function id(f: { advisoryId: string }) {
            return f.advisoryId
        })

        // lodash 4.17.11 is inside [4.0.0, 4.17.21); minimist 1.2.0 is inside [1.0.0, 1.2.6).
        expect(ids.sort()).toEqual(['GHSA-FIXTURE-lodash', 'GHSA-FIXTURE-minimist'])
        // axios 1.7.0 is ABOVE the fixed boundary of 1.6.0, so its advisory must not appear...
        expect(ids).not.toContain('GHSA-FIXTURE-axios-patched')
        // ...the GIT-typed range is unevaluable by the semver comparator and must be dropped...
        expect(ids).not.toContain('GHSA-FIXTURE-git-only')
        // ...and a malware record for a package that is not installed must not be invented.
        expect(ids).not.toContain('MAL-FIXTURE-0001')
    })

    it('reports the installed versions and fixes from the lockfile', async function () {
        const doc = JSON.parse((await scanFixture(['--json'])).stdout)
        const lodash = doc.findings.find(function isLodash(f: { packageName: string }) {
            return f.packageName === 'lodash'
        })
        expect(lodash.installedVersion).toBe('4.17.11')
        expect(lodash.fixVersion).toBe('4.17.21')
        expect(lodash.severity).toBe('high')
    })

    it('classifies prod and dev dependencies from the lockfile', async function () {
        const doc = JSON.parse((await scanFixture(['--json'])).stdout)
        const lodash = doc.findings.find(function isLodash(f: { packageName: string }) {
            return f.packageName === 'lodash'
        })
        const minimist = doc.findings.find(function isMinimist(f: { packageName: string }) {
            return f.packageName === 'minimist'
        })
        expect(lodash.isProd).toBe(true)
        expect(minimist.isDev).toBe(true)
    })

    it('honours --dep-type prod', async function () {
        const doc = JSON.parse((await scanFixture(['--json', '--dep-type', 'prod'])).stdout)
        expect(doc.findings.map(function name(f: { packageName: string }) {
            return f.packageName
        })).toEqual(['lodash'])
    })

    it('honours --severity as a floor', async function () {
        const doc = JSON.parse((await scanFixture(['--json', '--severity', 'high'])).stdout)
        expect(doc.totalFindings).toBe(1)
        expect(doc.findings[0].packageName).toBe('lodash')
    })
})

// braces <=3.0.3 and node-forge <=1.4.0: every source says no fix, and npm has published neither 3.0.4 nor
// 1.4.1. The CLI used to print "upgrade to 3.0.4" / "1.4.1" anyway — a version bumped out of the `<=` bound —
// and five fix agents each lost a run chasing them. It now asks the registry, exactly as the worker does:
// both are settled `none_released` and carry the way out.
describe('advisories with no fixed version released', function () {
    let noFixCache: string

    beforeAll(async function freshCache() {
        noFixCache = await seededCache()
    })

    afterAll(async function dropCache() {
        await rm(noFixCache, { recursive: true, force: true })
    })

    async function scanNoFix(extraArgs: string[] = []): Promise<RunResult> {
        return await runCli([FIXTURE_NO_FIX_PROJECT, '--source', 'osv,gemnasium', '--no-prompt', '--out', '-', ...extraArgs], noFixCache)
    }

    it('settles both against the registry as none_released, with the way out, in JSON and markdown', async function () {
        const before = stub.requests.length
        const json = await scanNoFix(['--json'])
        expect(json.code).toBe(0)
        expect(stub.requests.length).toBeGreaterThan(before)
        const doc = JSON.parse(json.stdout)
        const byName = new Map(doc.findings.map(function entry(f: { packageName: string }) {
            return [f.packageName, f] as const
        }))
        expect([...byName.keys()].sort()).toEqual(['braces', 'node-forge'])
        expect(byName.get('braces')).toMatchObject({ advisoryId: 'GHSA-vfj7-8cjw-p6xm', fixStatus: 'none_released', fixVersion: null, fixCheck: { registry: 'ok' } })
        expect(byName.get('node-forge')).toMatchObject({ advisoryId: 'GHSA-86w9-cpqp-85rv', fixStatus: 'none_released', fixVersion: null, fixCheck: { registry: 'ok' } })
        // braces: unmaintained, and the nodemon chain is blocked by chokidar 4.0.0, whose closure still reaches it.
        const braces = byName.get('braces') as { remediation: { health: { unmaintained: boolean }; chains: { path: string[]; verdict: { kind: string; proof?: { release: string } } }[] } }
        expect(braces.remediation.health.unmaintained).toBe(true)
        const nodemon = braces.remediation.chains.find(function viaNodemon(c) { return c.path[0]?.startsWith('nodemon@') })
        expect(nodemon?.verdict).toMatchObject({ kind: 'blocked', proof: { release: 'chokidar@4.0.0' } })
        expect((byName.get('node-forge') as { remediation: unknown }).remediation).not.toBeNull()

        const markdown = await scanNoFix([])
        expect(markdown.code).toBe(0)
        expect(markdown.stdout).toContain('No fixed version released')
        expect(markdown.stdout).toContain('- **Way out:**')
        expect(markdown.stdout).not.toContain('not checked against the registry')
        expect(markdown.stdout).not.toContain('upgrade to')

        for (const output of [json, markdown]) {
            expect(output.stdout + output.stderr).not.toContain('3.0.4')
            expect(output.stdout + output.stderr).not.toContain('1.4.1')
        }
    })

    // The first test's run cached every answer; a run within 24 hours asks the registry for no packument.
    it('makes no packument request on a second run within 24 hours', async function () {
        const before = stub.requests.length
        const result = await scanNoFix(['--json'])
        expect(result.code).toBe(0)
        expect(stub.requests.length).toBe(before)
        expect(JSON.parse(result.stdout).findings.map(function s(f: { fixStatus: string }) { return f.fixStatus })).toEqual(['none_released', 'none_released'])
    })

    it('makes no request at all under --offline, and says the fix was not checked because of it', async function () {
        const packuments = stub.requests.length
        const counts = stub.downloadRequests.length
        const result = await scanNoFix(['--offline'])
        expect(result.code).toBe(0)
        expect(stub.requests.length).toBe(packuments)
        expect(stub.downloadRequests.length).toBe(counts)
        expect(result.stdout).toContain('no fix stated by the advisory · not checked against the registry (offline)')
        expect(result.stdout).not.toContain('- **Way out:**')
        expect(result.stdout).not.toContain('3.0.4')
    })
})

// A fix the registry confirms is an instruction; one it was not asked about is only the advisory's word.
describe('fixes the registry confirms', function () {
    it('renders a published stated fix as an upgrade', async function () {
        const result = await scanFixture([])
        expect(result.stdout).toContain('upgrade to `4.17.21`')
        expect(result.stdout).not.toContain('not checked against the registry')
    })

    it('labels the same fix as unverified under --offline', async function () {
        const result = await scanFixture(['--offline'])
        expect(result.stdout).toContain('advisory names `4.17.21` as the fix · not checked against the registry (offline)')
        expect(result.stdout).not.toContain('upgrade to')
    })
})

describe('exit codes', function () {
    it('exits 0 by default even when findings exist', async function () {
        const result = await scanFixture([])
        expect(result.code).toBe(0)
    })

    it('exits 2 when --fail-on any is met', async function () {
        expect((await scanFixture(['--fail-on', 'any'])).code).toBe(2)
    })

    it('exits 2 when a finding reaches the --fail-on severity', async function () {
        expect((await scanFixture(['--fail-on', 'high'])).code).toBe(2)
    })

    it('exits 0 when no finding reaches the --fail-on severity', async function () {
        expect((await scanFixture(['--fail-on', 'critical'])).code).toBe(0)
    })
})

describe('output routing', function () {
    // The contract is that stdout carries ONLY the document, so `sentinello > report.md` and
    // `sentinello --json | jq` both work. All human chatter goes to stderr.
    it('writes only the document to stdout, with progress on stderr', async function () {
        const result = await scanFixture(['--json'])
        expect(function parseStdout() {
            JSON.parse(result.stdout)
        }).not.toThrow()
        expect(result.stdout).not.toContain('Scanning')
    })

    it('writes markdown to stdout when --json is not given', async function () {
        const result = await scanFixture([])
        expect(result.stdout).toContain('#')
        expect(result.stdout).toContain('lodash')
        expect(function shouldNotBeJson() {
            JSON.parse(result.stdout)
        }).toThrow()
    })

    it('writes the document to a file when --out names one', async function () {
        const outDir = await mkdtemp(join(tmpdir(), 'sentinello-out-'))
        const outPath = join(outDir, 'report.json')
        const result = await runCli([
            FIXTURE_PROJECT, '--source', 'osv,gemnasium', '--no-prompt', '--json', '--out', outPath
        ])

        expect(result.code).toBe(0)
        const written = JSON.parse(await readFile(outPath, 'utf8'))
        expect(written.totalFindings).toBe(2)
        await rm(outDir, { recursive: true, force: true })
    })
})

describe('doctor', function () {
    it('reports the seeded cache', async function () {
        const result = await runCli(['--doctor'])
        expect(result.code).toBe(0)
        expect(result.stdout).toContain('osv')
        expect(result.stdout).toContain(cacheDir)
    })
})

describe('hermetic guarantees', function () {
    // If this ever fails, the suite has started depending on the network.
    it('never reaches the live npm registry: every lookup went to the stub', async function () {
        await scanFixture([])
        expect(stub.requests.length + stub.downloadRequests.length).toBeGreaterThan(0)
    })

    it('never reports a sync when both feeds are disabled', async function () {
        const result = await scanFixture([])
        expect(result.stderr).not.toContain('Downloading')
        expect(result.stderr).not.toContain('osv-vulnerabilities.storage.googleapis.com')
    })

    it('produces byte-identical JSON across runs for a fixed instant', async function () {
        const outDir = await mkdtemp(join(tmpdir(), 'sentinello-det-'))
        await writeFile(join(outDir, 'placeholder'), '')
        const first = JSON.parse((await scanFixture(['--json'])).stdout)
        const second = JSON.parse((await scanFixture(['--json'])).stdout)
        // generatedAt is a real clock, and every fix snapshot is stamped with it as its settlement time,
        // so compare everything else.
        delete first.generatedAt
        delete second.generatedAt
        for (const doc of [first, second]) {
            for (const f of doc.findings) {
                expect(f.fixCheck.registry).toBe('ok')
                delete f.fixCheck.checkedAt
            }
        }
        expect(first).toEqual(second)
        await rm(outDir, { recursive: true, force: true })
    })
})
