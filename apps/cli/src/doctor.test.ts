import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GEMNASIUM_NORMALIZER_VERSION, OSV_NORMALIZER_VERSION } from '@sentinello/core'
import { advisoryFilePath, ensureCacheDir, readCacheMeta, setSourceState, writeCacheMeta, type SourceId, type SourceState } from './cache/meta'
import { createRowWriter } from './cache/store'
import type { CliOptions } from './options'
import { runDoctor } from './doctor'

// `--doctor` exists to end a support thread before it starts: "why did this run find nothing?". Nothing
// here is mocked — the cache files are real gzipped NDJSON written through the production row writer, the
// meta is real JSON round-tripped through readCacheMeta, and the project list comes from a real walk of a
// real temp tree. That matters because the command's whole job is to report what is ACTUALLY on disk.
//
// The one deliberate design point worth pinning: doctor counts rows on disk rather than trusting the meta.
// Reporting from metadata alone would let it say "not downloaded" about a cache file that exists and is
// being matched against — precisely the contradiction the command exists to eliminate.

const T0 = Date.UTC(2026, 0, 1)

let dir: string
let cacheDir: string
let rootPath: string
let stdout: string[]

function options(overrides: Partial<CliOptions> = {}): CliOptions {
    return {
        rootPath,
        maxDepth: null,
        excludes: [],
        sources: ['osv', 'gemnasium'],
        includeNpmAudit: true,
        depType: 'prod',
        minSeverity: 'info',
        promptPath: null,
        includePrompt: false,
        outPath: null,
        json: false,
        failOn: 'never',
        assumeYes: false,
        offline: false,
        cacheDir: null,
        color: false,
        quiet: false,
        verbose: false,
        ...overrides
    } as CliOptions
}

function report(): string {
    return stdout.join('')
}

async function seedRows(source: SourceId, count: number): Promise<void> {
    await ensureCacheDir(cacheDir)
    const writer = createRowWriter(advisoryFilePath(cacheDir, source, 'npm'))
    const rows = Array.from({ length: count }, function row(_unused, i) {
        return { packageName: 'pkg-' + i, advisoryId: 'CVE-2024-' + i }
    })
    await writer.write(rows)
    await writer.commit()
}

async function seedState(source: SourceId, overrides: Partial<SourceState> = {}): Promise<void> {
    const meta = await readCacheMeta(cacheDir)
    setSourceState(meta, source, 'npm', {
        normalizerVersion: source === 'osv' ? OSV_NORMALIZER_VERSION : GEMNASIUM_NORMALIZER_VERSION,
        recordCount: 2,
        refreshedAt: T0,
        ...overrides
    })
    await writeCacheMeta(cacheDir, meta)
}

async function makeProject(relPath: string): Promise<void> {
    const { mkdir, writeFile } = await import('node:fs/promises')
    const target = join(rootPath, relPath)
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'package.json'), JSON.stringify({ name: relPath, version: '1.0.0' }), 'utf8')
    await writeFile(join(target, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {} }), 'utf8')
}

beforeEach(async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-doctor-'))
    cacheDir = join(dir, 'cache')
    rootPath = join(dir, 'code')
    stdout = []
    vi.spyOn(process.stdout, 'write').mockImplementation(function capture(chunk: unknown): boolean {
        stdout.push(String(chunk))
        return true
    })
})

afterEach(async function teardown() {
    vi.restoreAllMocks()
    vi.useRealTimers()
    await rm(dir, { recursive: true, force: true })
})

describe('runDoctor — environment and settings', function () {
    it('reports the CLI and node versions', async function () {
        await makeProject('.')
        await runDoctor(options(), cacheDir)
        expect(report()).toContain('sentinello ')
        expect(report()).toContain('node       ' + process.version)
    })

    it('echoes back the resolved settings', async function () {
        await makeProject('.')
        await runDoctor(options({ depType: 'all', minSeverity: 'high', failOn: 'critical' }), cacheDir)
        const text = report()
        expect(text).toContain('root         ' + rootPath)
        expect(text).toContain('dep type     all')
        expect(text).toContain('min severity high')
        expect(text).toContain('fail-on      critical')
    })

    it('renders an unlimited depth as "all" and a set depth as the number', async function () {
        await makeProject('.')
        await runDoctor(options({ maxDepth: null }), cacheDir)
        expect(report()).toContain('depth        all')
        stdout.length = 0
        await runDoctor(options({ maxDepth: 3 }), cacheDir)
        expect(report()).toContain('depth        3')
    })

    it('renders an empty exclude list as "(none)" and a set one joined', async function () {
        await makeProject('.')
        await runDoctor(options({ excludes: [] }), cacheDir)
        expect(report()).toContain('excludes     (none)')
        stdout.length = 0
        await runDoctor(options({ excludes: ['vendor', 'tmp'] }), cacheDir)
        expect(report()).toContain('excludes     vendor, tmp')
    })

    it('lists npm-audit alongside the configured advisory sources', async function () {
        await makeProject('.')
        await runDoctor(options({ includeNpmAudit: true, sources: ['osv'] }), cacheDir)
        expect(report()).toContain('sources      npm-audit, osv')
    })

    it('omits npm-audit when it is switched off', async function () {
        await makeProject('.')
        await runDoctor(options({ includeNpmAudit: false, sources: ['gemnasium'] }), cacheDir)
        expect(report()).toContain('sources      gemnasium')
    })

    it('reports "(none)" when every source is switched off', async function () {
        await makeProject('.')
        await runDoctor(options({ includeNpmAudit: false, sources: [] }), cacheDir)
        expect(report()).toContain('sources      (none)')
    })

    it('distinguishes no prompt, the built-in prompt and a custom one', async function () {
        await makeProject('.')
        await runDoctor(options({ includePrompt: false, promptPath: '/tmp/custom.md' }), cacheDir)
        expect(report()).toContain('prompt       (none)')
        stdout.length = 0
        await runDoctor(options({ includePrompt: true, promptPath: null }), cacheDir)
        expect(report()).toContain('prompt       built-in')
        stdout.length = 0
        await runDoctor(options({ includePrompt: true, promptPath: '/tmp/custom.md' }), cacheDir)
        expect(report()).toContain('prompt       /tmp/custom.md')
    })
})

describe('runDoctor — advisory cache', function () {
    it('reports both sources as not downloaded on a cold cache', async function () {
        await makeProject('.')
        await runDoctor(options(), cacheDir)
        const text = report()
        expect(text).toContain('osv         not downloaded')
        expect(text).toContain('gemnasium   not downloaded')
    })

    // The contradiction this command exists to eliminate: rows present, metadata missing.
    it('reports rows found on disk with no sync metadata, and how to use them', async function () {
        await makeProject('.')
        await seedRows('osv', 3)
        await runDoctor(options(), cacheDir)
        const text = report()
        expect(text).toContain('3 advisories on disk, but no sync metadata')
        expect(text).toContain(advisoryFilePath(cacheDir, 'osv', 'npm'))
        expect(text).toContain('usable with --offline; a normal run will re-download it')
    })

    it('reports the on-disk count and the cache path once synced', async function () {
        await makeProject('.')
        await seedRows('osv', 1500)
        await seedState('osv')
        await runDoctor(options(), cacheDir)
        const text = report()
        expect(text).toContain('1,500 advisories, refreshed')
        expect(text).toContain(advisoryFilePath(cacheDir, 'osv', 'npm'))
    })

    // The count comes from the file, not from state.recordCount — so a stale metadata number cannot lie.
    it('trusts the file over a stale recordCount in the metadata', async function () {
        await makeProject('.')
        await seedRows('osv', 2)
        await seedState('osv', { recordCount: 99_999 })
        await runDoctor(options(), cacheDir)
        expect(report()).toContain('2 advisories, refreshed')
        expect(report()).not.toContain('99,999')
    })

    it('warns that a normalizer bump will force a re-download', async function () {
        await makeProject('.')
        await seedRows('osv', 5)
        await seedState('osv', { normalizerVersion: OSV_NORMALIZER_VERSION - 1 })
        await runDoctor(options(), cacheDir)
        expect(report()).toContain('normalizer v' + (OSV_NORMALIZER_VERSION - 1) + ' -> v' + OSV_NORMALIZER_VERSION + ', will re-download')
    })

    it('says nothing about the normalizer when the cache is current', async function () {
        await makeProject('.')
        await seedRows('osv', 5)
        await seedState('osv')
        await runDoctor(options(), cacheDir)
        expect(report()).not.toContain('will re-download')
    })

    it('shows the OSV cursor and the gemnasium commit, each only for its own source', async function () {
        await makeProject('.')
        await seedRows('osv', 1)
        await seedRows('gemnasium', 1)
        await seedState('osv', { cursorIso: '2026-07-01T00:00:00Z', headSha: 'ffffffffffffffff' })
        await seedState('gemnasium', { headSha: 'abcdef0123456789', cursorIso: '2026-07-01T00:00:00Z' })
        await runDoctor(options(), cacheDir)
        const text = report()
        expect(text).toContain('cursor 2026-07-01T00:00:00Z')
        // Truncated to 12 characters, and the OSV row must not print a commit.
        expect(text).toContain('commit abcdef012345')
        expect(text).not.toContain('commit ffffffffffff')
    })

    it('omits the cursor and commit lines when neither is recorded', async function () {
        await makeProject('.')
        await seedRows('osv', 1)
        await seedState('osv', { cursorIso: null })
        await seedRows('gemnasium', 1)
        await seedState('gemnasium', { headSha: null })
        await runDoctor(options(), cacheDir)
        expect(report()).not.toContain('cursor ')
        expect(report()).not.toContain('commit ')
    })

    it.each([
        [30_000, 'just now'],
        [5 * 60_000, '5m ago'],
        [3 * 3_600_000, '3h ago'],
        [2 * 86_400_000, '2d ago']
    ])('describes an age of %dms as %s', async function (elapsed, expected) {
        vi.useFakeTimers()
        vi.setSystemTime(T0 + (elapsed as number))
        await makeProject('.')
        await seedRows('osv', 1)
        await seedState('osv', { refreshedAt: T0 })
        await runDoctor(options(), cacheDir)
        expect(report()).toContain('refreshed ' + expected)
    })
})

describe('runDoctor — projects', function () {
    it('lists each project with its package manager and ecosystems', async function () {
        await makeProject('web')
        await makeProject('services/api')
        await runDoctor(options(), cacheDir)
        const text = report()
        expect(text).toContain('web')
        expect(text).toContain('services/api')
        expect(text).toContain('npm')
    })

    it('says so plainly when the walk found nothing', async function () {
        const { mkdir } = await import('node:fs/promises')
        await mkdir(rootPath, { recursive: true })
        await runDoctor(options(), cacheDir)
        expect(report()).toContain('(none found)')
    })

    // The half of the answer to "why did this find nothing?" that lives outside the cache.
    it('names every directory an ignore rule skipped, with the rule source', async function () {
        const { writeFile } = await import('node:fs/promises')
        await makeProject('web')
        await makeProject('vendor')
        await writeFile(join(rootPath, '.sentinelloignore'), 'vendor\n', 'utf8')
        await runDoctor(options(), cacheDir)
        const text = report()
        expect(text).toContain('Skipped by ignore rules (1)')
        expect(text).toContain('sentinelloignore')
        expect(text).toContain('vendor')
    })

    it('omits the skipped section entirely when nothing was skipped', async function () {
        await makeProject('web')
        await runDoctor(options(), cacheDir)
        expect(report()).not.toContain('Skipped by ignore rules')
    })

    it('honours an explicit exclude and attributes the skip to it', async function () {
        await makeProject('web')
        await makeProject('tools')
        await runDoctor(options({ excludes: ['tools'] }), cacheDir)
        const text = report()
        expect(text).toContain('Skipped by ignore rules')
        expect(text).toContain('excludes')
    })
})

describe('runDoctor — output shape', function () {
    it('writes one trailing-newline-terminated document in a single call', async function () {
        await makeProject('.')
        await runDoctor(options(), cacheDir)
        expect(stdout).toHaveLength(1)
        expect(stdout[0]?.endsWith('\n')).toBe(true)
    })

    it('keeps the sections in a stable order', async function () {
        await makeProject('.')
        await runDoctor(options(), cacheDir)
        const text = report()
        expect(text.indexOf('Settings')).toBeLessThan(text.indexOf('Advisory cache'))
        expect(text.indexOf('Advisory cache')).toBeLessThan(text.indexOf('Projects'))
    })
})
