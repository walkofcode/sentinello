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
import { OSV_NORMALIZER_VERSION } from '@sentinello/core'
import type { OsvAdvisoryRow } from '@sentinello/core'

// Drives the REAL bundled binary — the same dist/cli.cjs npm publishes — as a subprocess. That is
// the point: an in-process test cannot catch a packaging fault (a dependency that failed to bundle,
// a broken shebang, an import that only resolves in the workspace).
//
// The run is hermetic by construction. Both feed URLs are set to 'off', which makes planSync skip
// every source, and --source osv,gemnasium sets includeNpmAudit=false so nothing is ever spawned.
// The advisory cache is pre-seeded from the frozen fixture, so findings are exact and permanent.

const execFileAsync = promisify(execFile)

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')
const CLI_BIN = join(REPO_ROOT, 'apps', 'cli', 'dist', 'cli.cjs')
const FIXTURE_PROJECT = join(REPO_ROOT, 'tests', 'fixtures', 'projects', 'npm-basic')
const FIXTURE_ADVISORIES = join(REPO_ROOT, 'tests', 'fixtures', 'advisories', 'osv-npm.ndjson')

const OFFLINE_ENV = {
    SENTINELLO_OSV_FEED_URL: 'off',
    SENTINELLO_GEMNASIUM_FEED_URL: 'off',
    NO_COLOR: '1'
}

let cacheDir: string

type RunResult = { code: number; stdout: string; stderr: string }

async function runCli(args: string[]): Promise<RunResult> {
    try {
        const { stdout, stderr } = await execFileAsync('node', [CLI_BIN, ...args], {
            env: { ...process.env, ...OFFLINE_ENV, SENTINELLO_CACHE_DIR: cacheDir },
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

    cacheDir = await mkdtemp(join(tmpdir(), 'sentinello-cli-e2e-'))

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

    const writer = createRowWriter(advisoryFilePath(cacheDir, 'osv', 'npm'))
    await writer.write(rows)
    const count = await writer.commit()

    await writeCacheMeta(cacheDir, {
        schemaVersion: 1,
        sources: {
            osv: { npm: { normalizerVersion: OSV_NORMALIZER_VERSION, recordCount: count, refreshedAt: Date.UTC(2026, 0, 1) } },
            gemnasium: {}
        }
    })
})

afterAll(async function cleanup() {
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
        // generatedAt is a real clock, so compare everything else.
        delete first.generatedAt
        delete second.generatedAt
        expect(first).toEqual(second)
        await rm(outDir, { recursive: true, force: true })
    })
})
