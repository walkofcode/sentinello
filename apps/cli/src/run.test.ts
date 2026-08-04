import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GEMNASIUM_NORMALIZER_VERSION, OSV_NORMALIZER_VERSION } from '@sentinello/core'
import type { CacheMeta } from './cache/meta'
import type { CliOptions } from './options'
import type { Ui } from './ui'

// The CLI's top-level flow — the last uncovered file in apps/cli, and the reason src/cli.ts is now a
// thin bin. main() returns an exit code rather than calling process.exit, which makes it pleasant to
// assert on; the bin turns that into process.exitCode so a document written to a pipe can flush.
//
// @sentinello/feeds is the only stub, and only because it owns the network. The cache, the discovery
// walk, the resolvers and the report renderer all run for real against a temp tree. The subprocess
// scanner is switched off by NAMING the sources (see scanArgs below) rather than by mocking, because
// the real npmAuditPlugin shells out to `npm audit` once per project.

const feeds = vi.hoisted(function makeFeedDoubles() {
    return {
        headOsvSeed: vi.fn(async function head() { return { contentLength: 1024 } }),
        streamOsvSeed: vi.fn(),
        fetchOsvChangedIds: vi.fn(async function changed() { return { status: 'ok', ids: [], etag: null, newestIso: null } }),
        fetchOsvAdvisoryRows: vi.fn(async function rows() { return [] }),
        fetchGemnasiumHeadSha: vi.fn(async function sha() { return null }),
        fetchGemnasiumChangedPaths: vi.fn(async function paths() { return { status: 'ok', changed: [], deleted: [] } }),
        fetchGemnasiumFileRows: vi.fn(async function rows() { return [] }),
        streamGemnasiumArchive: vi.fn(),
        osvFeedDisabled: vi.fn(function disabled() { return false }),
        gemnasiumFeedDisabled: vi.fn(function disabled() { return false })
    }
})

vi.mock('@sentinello/feeds', async function mockFeeds(importOriginal) {
    const actual = await importOriginal<typeof import('@sentinello/feeds')>()
    return { ...actual, ...feeds }
})

// The one scanner that shells out. Everything else in @sentinello/scanners — discovery, the resolvers,
// the feed scanners — runs for real; only this plugin is replaced, and only so the npm-audit-only run
// below does not invoke `npm audit` as a subprocess against the network.
const npmAudit = vi.hoisted(function makeNpmAuditDouble() {
    return {
        npmAuditPlugin: {
            name: 'npm-audit',
            scan: vi.fn(async function scan() {
                return { status: 'ok', reasonCode: 'ok', findings: [], rawJson: '{}', errorText: null, durationMs: 1 }
            })
        }
    }
})

vi.mock('@sentinello/scanners', async function mockScanners(importOriginal) {
    const actual = await importOriginal<typeof import('@sentinello/scanners')>()
    return { ...actual, ...npmAudit }
})

const { main, resolveDestination, enabledSources } = await import('./run')

const EXIT_OK = 0
const EXIT_ERROR = 1
const EXIT_THRESHOLD = 2

let dir: string
let stdout: string[]
let stderr: string[]

function argv(...args: string[]): void {
    process.argv = ['node', 'sentinello', ...args]
}

function out(): string {
    return stdout.join('')
}

function err(): string {
    return stderr.join('')
}

function setTty(stream: NodeJS.WriteStream, value: boolean): void {
    Object.defineProperty(stream, 'isTTY', { value, configurable: true, writable: true })
}

async function makeProject(relPath: string): Promise<void> {
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
}

// The scan root is POSITIONAL, not a flag. `--source osv` selects the one feed source and, by
// omitting npm-audit from the list, switches the subprocess scanner off — the source list is
// replace-not-append, so naming osv alone means npm-audit does not run. `--offline` skips the sync.
// Together: the whole pipeline, no subprocess and no network, reporting zero findings.
function scanArgs(...extra: string[]): string[] {
    return [dir, '--cache-dir', join(dir, '.cache'), '--source', 'osv', '--offline', ...extra]
}

beforeEach(async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-cli-run-'))
    stdout = []
    stderr = []
    vi.spyOn(process.stdout, 'write').mockImplementation(function captureOut(chunk: unknown): boolean {
        stdout.push(String(chunk))
        return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation(function captureErr(chunk: unknown): boolean {
        stderr.push(String(chunk))
        return true
    })
    // Non-TTY by default: that is what CI looks like, and it routes the document to stdout.
    setTty(process.stdout, false)
    setTty(process.stderr, false)
    // Restored explicitly: vi.clearAllMocks() resets calls but NOT a mockReturnValue, so a test that
    // switches a feed off would otherwise leak that into every test after it.
    feeds.osvFeedDisabled.mockReturnValue(false)
    feeds.gemnasiumFeedDisabled.mockReturnValue(false)
})

afterEach(async function teardown() {
    vi.restoreAllMocks()
    vi.clearAllMocks()
    await rm(dir, { recursive: true, force: true })
})

describe('terminal modes', function () {
    it('prints usage for --help and exits clean', async function () {
        argv('--help')
        expect(await main()).toBe(EXIT_OK)
        expect(out()).toContain('USAGE')
    })

    // __SENTINELLO_VERSION__ is a tsup `define`, so it only exists in the built bundle. Under tsx and
    // vitest the fallback chain runs instead: SENTINELLO_VERSION, then the literal 'dev'. Both arms
    // matter — the env one is what keeps `pnpm --filter sentinello dev` reporting something real.
    it('prints the fallback version under tsx', async function () {
        argv('--version')
        expect(await main()).toBe(EXIT_OK)
        expect(out().trim()).toBe('dev')
    })

    // So a custom prompt starts from a working base rather than a blank file.
    it('dumps the built-in prompt for --print-prompt', async function () {
        argv('--print-prompt')
        expect(await main()).toBe(EXIT_OK)
        expect(out().length).toBeGreaterThan(100)
    })

    it('reports an unparseable argument on stderr and exits 1', async function () {
        argv('--not-a-real-flag')
        expect(await main()).toBe(EXIT_ERROR)
        expect(err()).toContain('sentinello:')
        expect(err()).toContain('--help')
        expect(out()).toBe('')
    })

    it('runs the diagnostics report for --doctor', async function () {
        await makeProject('web')
        argv('--doctor', dir, '--cache-dir', join(dir, '.cache'))
        expect(await main()).toBe(EXIT_OK)
        expect(out()).toContain('Advisory cache')
        expect(out()).toContain('Projects')
    })
})

describe('config file', function () {
    // sentinello.config.json is read from the scan root so a team can commit its settings once and
    // run `sentinello` bare. A malformed one must stop the run rather than silently falling back to
    // defaults the team did not choose.
    it('reports a malformed sentinello.config.json and exits 1', async function () {
        await writeFile(join(dir, 'sentinello.config.json'), '{not json', 'utf8')
        argv(dir, '--cache-dir', join(dir, '.cache'))
        expect(await main()).toBe(EXIT_ERROR)
        expect(err()).toContain('sentinello.config.json is not valid JSON')
    })

    // The array cases are the regression guard: `typeof [] === 'object'`, so the object check alone
    // let a JSON array through and every setting silently fell back to its default. A non-empty array
    // is listed too — an empty one would also pass a `length > 0` style fix that missed the real point.
    it.each([
        ['a bare string', '"just a string"'],
        ['a number', '42'],
        ['null', 'null'],
        ['an empty array', '[]'],
        ['a populated array', '[{"depth":3}]']
    ])('rejects a config file containing %s', async function (_label, body) {
        await writeFile(join(dir, 'sentinello.config.json'), body as string, 'utf8')
        argv(dir, '--cache-dir', join(dir, '.cache'))
        expect(await main()).toBe(EXIT_ERROR)
        expect(err()).toContain('must contain an object')
    })
})

describe('scanning', function () {
    it('stops early and exits clean when there are no projects', async function () {
        argv(...scanArgs())
        expect(await main()).toBe(EXIT_OK)
        expect(err()).toContain('No projects found.')
    })

    it('writes the advisory document to stdout when stdout is piped', async function () {
        await makeProject('web')
        argv(...scanArgs())
        expect(await main()).toBe(EXIT_OK)
        expect(out()).toContain('# ')
        expect(out().length).toBeGreaterThan(0)
    })

    it('emits JSON instead of markdown for --json', async function () {
        await makeProject('web')
        argv(...scanArgs('--json'))
        expect(await main()).toBe(EXIT_OK)
        expect(function parse() {
            JSON.parse(out())
        }).not.toThrow()
    })

    it('writes to a file when --out names one', async function () {
        await makeProject('web')
        argv(...scanArgs('--out', 'advisory.md'))
        expect(await main()).toBe(EXIT_OK)
        expect((await readFile(join(dir, 'advisory.md'), 'utf8')).length).toBeGreaterThan(0)
        // The document went to the file, not the pipe.
        expect(out()).toBe('')
    })

    it('scans several projects in one run', async function () {
        await makeProject('web')
        await makeProject('services/api')
        argv(...scanArgs())
        expect(await main()).toBe(EXIT_OK)
        expect(err()).toContain('2 projects')
    })

    it('reports a missing prompt file and exits 1 rather than writing a broken document', async function () {
        await makeProject('web')
        argv(...scanArgs('--prompt', join(dir, 'nope.md')))
        expect(await main()).toBe(EXIT_ERROR)
        expect(err()).toContain('could not read prompt file')
    })

    it('skips the sync entirely when offline', async function () {
        await makeProject('web')
        argv(dir, '--cache-dir', join(dir, '.cache'), '--source', 'osv', '--offline')
        expect(await main()).toBe(EXIT_OK)
        expect(err()).toContain('offline')
        expect(feeds.fetchOsvChangedIds).not.toHaveBeenCalled()
    })

    // `--source npm-audit` selects the subprocess scanner and NO advisory feed, because the source list
    // replaces rather than appends. There is then nothing to sync: the run must go straight to scanning
    // without touching the network and without printing the offline notice, which belongs to --offline
    // alone. This is the config for someone who wants a scan but not a multi-hundred-megabyte download.
    it('syncs nothing when npm-audit is the only source', async function () {
        await makeProject('web')
        argv(dir, '--cache-dir', join(dir, '.cache'), '--source', 'npm-audit')

        expect(await main()).toBe(EXIT_OK)
        expect(feeds.fetchOsvChangedIds).not.toHaveBeenCalled()
        expect(feeds.headOsvSeed).not.toHaveBeenCalled()
        expect(err()).not.toContain('offline')
        expect(npmAudit.npmAuditPlugin.scan).toHaveBeenCalled()
    })

    // Declining the first seed must leave the run clean rather than scanning against an empty cache
    // and reporting a false all-clear.
    it('exits clean without scanning when the seed is declined', async function () {
        await makeProject('web')
        const zeroBatches = async function* stream() {}
        feeds.streamOsvSeed.mockImplementation(zeroBatches)
        feeds.streamGemnasiumArchive.mockImplementation(zeroBatches)
        setTty(process.stdout, false)
        setTty(process.stderr, false)
        argv(dir, '--cache-dir', join(dir, '.cache'), '--source', 'osv')

        expect(await main()).toBe(EXIT_OK)
        // Non-interactive, so confirmSeed refuses rather than prompting.
        expect(err()).toContain('pass --yes')
        expect(feeds.streamOsvSeed).not.toHaveBeenCalled()
    })

    it('proceeds through the seed when --yes is given', async function () {
        await makeProject('web')
        feeds.streamOsvSeed.mockImplementation(async function* stream() {})
        argv(dir, '--cache-dir', join(dir, '.cache'), '--source', 'osv', '--yes')

        expect(await main()).toBe(EXIT_OK)
        expect(feeds.streamOsvSeed).toHaveBeenCalled()
    })

    // The interactive half of the same decision, and the one a first-time user actually hits: they are
    // asked, they answer yes, the seed runs. --yes above skips confirmSeed entirely rather than
    // approving it, so it exercises a different branch and cannot stand in for this. Driven through
    // runScan's injected Ui because the real prompt reads from a TTY stdin no test process has.
    it('proceeds through the seed when the prompt is approved interactively', async function () {
        await makeProject('web')
        feeds.streamOsvSeed.mockImplementation(async function* stream() {})
        const approving = new Proxy({} as Ui, {
            get: function get(_target, prop: string) {
                return function respond(): unknown {
                    return prop === 'confirmSeed' ? Promise.resolve(true) : undefined
                }
            }
        })
        const { runScan } = await import('./run')
        const { parseArgs } = await import('./options')
        const parsed = parseArgs([dir, '--cache-dir', join(dir, '.cache'), '--source', 'osv'])
        if (parsed.kind !== 'options') throw new Error('expected options')

        expect(await runScan(parsed.options, join(dir, '.cache'), approving)).toBe(EXIT_OK)
        expect(feeds.streamOsvSeed).toHaveBeenCalled()
    })

    // The retry loop. The feeds layer now gives up on a declined download in seconds rather than minutes,
    // so this prompt is what stands in for the wait it no longer does. It must re-run ONLY what failed:
    // re-downloading a source that already succeeded would make one failure cost two seeds.
    describe('the seed retry prompt', function () {
        function uiAnswering(retry: boolean, calls: string[]): Ui {
            return new Proxy({} as Ui, {
                get: function get(_target, prop: string) {
                    return function respond(): unknown {
                        calls.push(prop)
                        if (prop === 'confirmSeed') return Promise.resolve(true)
                        if (prop === 'confirmRetry') return Promise.resolve(retry)
                        return undefined
                    }
                }
            })
        }

        async function runWith(ui: Ui, gate: string[] = []): Promise<number> {
            const { runScan } = await import('./run')
            const { parseArgs } = await import('./options')
            const parsed = parseArgs([dir, '--cache-dir', join(dir, '.cache'), '--source', 'osv,gemnasium', ...gate])
            if (parsed.kind !== 'options') throw new Error('expected options')
            return await runScan(parsed.options, join(dir, '.cache'), ui)
        }

        // Fails the gemnasium seed once, then succeeds — the shape of a genuinely transient refusal.
        function gemnasiumFailingOnce(): void {
            let attempts = 0
            feeds.streamGemnasiumArchive.mockImplementation(function stream() {
                attempts++
                // Thrown from the call rather than from inside the generator: seedGemnasium opens the
                // stream inside its try, so both land as an 'error' outcome, and this way the fake is
                // not a generator that never yields.
                if (attempts === 1) throw new Error('GET https://gitlab.test failed: HTTP 406 after 4 attempts over 15s')
                return (async function* ok() {})()
            })
        }

        it('re-runs only the failed source when the retry is approved', async function () {
            await makeProject('web')
            feeds.streamOsvSeed.mockImplementation(async function* stream() {})
            gemnasiumFailingOnce()
            const calls: string[] = []

            expect(await runWith(uiAnswering(true, calls))).toBe(EXIT_OK)
            expect(calls).toContain('confirmRetry')
            expect(feeds.streamGemnasiumArchive).toHaveBeenCalledTimes(2)
            // OSV succeeded the first time, so the retry must not have touched it again.
            expect(feeds.streamOsvSeed).toHaveBeenCalledTimes(1)
        })

        it('leaves the failure alone when the retry is declined', async function () {
            await makeProject('web')
            feeds.streamOsvSeed.mockImplementation(async function* stream() {})
            gemnasiumFailingOnce()
            const calls: string[] = []

            await runWith(uiAnswering(false, calls))
            expect(calls).toContain('confirmRetry')
            expect(feeds.streamGemnasiumArchive).toHaveBeenCalledTimes(1)
        })

        it('never asks when every source succeeded', async function () {
            await makeProject('web')
            feeds.streamOsvSeed.mockImplementation(async function* stream() {})
            feeds.streamGemnasiumArchive.mockImplementation(async function* stream() {})
            const calls: string[] = []

            expect(await runWith(uiAnswering(true, calls))).toBe(EXIT_OK)
            expect(calls).not.toContain('confirmRetry')
        })
    })

    // The air-gapped regression, end to end. An install with SENTINELLO_GEMNASIUM_FEED_URL=off and no
    // seeded cache used to report the cell unauditable on every project, so a --fail-on gate refused the
    // run forever — for a configuration the operator chose deliberately. It must exit clean AND say which
    // source it dropped, because dropping one silently is how a typo'd env var narrows an audit unnoticed.
    it('drops a switched-off unseeded source and says so, rather than refusing the gate', async function () {
        await makeProject('web')
        feeds.gemnasiumFeedDisabled.mockReturnValue(true)
        const announced: string[][] = []
        const watching = new Proxy({} as Ui, {
            get: function get(_target, prop: string) {
                return function respond(arg: unknown): unknown {
                    if (prop === 'sourcesSwitchedOff') announced.push(arg as string[])
                    if (prop === 'confirmSeed') return Promise.resolve(true)
                    if (prop === 'confirmRetry') return Promise.resolve(false)
                    return undefined
                }
            }
        })
        const { runScan } = await import('./run')
        const { parseArgs } = await import('./options')
        const parsed = parseArgs([dir, '--cache-dir', join(dir, '.cache'), '--source', 'gemnasium', '--offline', '--fail-on', 'high'])
        if (parsed.kind !== 'options') throw new Error('expected options')

        expect(await runScan(parsed.options, join(dir, '.cache'), watching)).toBe(EXIT_OK)
        expect(announced).toEqual([['gemnasium']])
    })

    // Declining without a gate is a legitimate choice — the user said no to a 200 MB download and gets a
    // report from whatever sources are already seeded. It must stay exit 0; only --fail-on turns the same
    // decline into a refusal, which is the pair below.
    it.each([
        { gate: [] as string[], expected: EXIT_OK, label: 'no gate' },
        { gate: ['--fail-on', 'high'], expected: EXIT_ERROR, label: 'a gate' }
    ])('exits correctly when the seed is declined with $label', async function ({ gate, expected }) {
        await makeProject('web')
        const declining = new Proxy({} as Ui, {
            get: function get(_target, prop: string) {
                return function respond(): unknown {
                    return prop === 'confirmSeed' ? Promise.resolve(false) : undefined
                }
            }
        })
        const { runScan } = await import('./run')
        const { parseArgs } = await import('./options')
        const parsed = parseArgs([dir, '--cache-dir', join(dir, '.cache'), '--source', 'osv', ...gate])
        if (parsed.kind !== 'options') throw new Error('expected options')

        expect(await runScan(parsed.options, join(dir, '.cache'), declining)).toBe(expected)
        // Either way the download must not have happened — that is what declining means.
        expect(feeds.streamOsvSeed).not.toHaveBeenCalled()
    })
})

describe('exit codes', function () {
    // Seeds the real ndjson cache through the real seed path — only the network call is a double — so
    // the scan below finds a genuine advisory rather than one injected past the matcher. Without this
    // every test in this suite scans a clean tree, which is why the threshold code was never exercised
    // end-to-end before: the gate can only fire when something is actually found.
    async function seedVulnerableLodash(): Promise<void> {
        feeds.streamOsvSeed.mockImplementation(async function* stream() {
            yield {
                rows: [{
                    advisoryId: 'GHSA-vulnerable-lodash',
                    ecosystem: 'npm',
                    packageName: 'lodash',
                    aliases: [],
                    ranges: [{ type: 'SEMVER', introduced: '0', fixed: '4.17.21', lastAffected: null }],
                    versions: [],
                    severity: 'high',
                    summary: 'Prototype pollution',
                    url: 'https://example.test/GHSA-vulnerable-lodash',
                    malicious: false,
                    withdrawn: null
                }],
                lastModified: '2026-07-01T00:00:00Z'
            }
        })
    }

    // The gate is what makes the CLI usable in CI, so the distinct code matters more than the message.
    function seededScanArgs(...extra: string[]): string[] {
        return [dir, '--cache-dir', join(dir, '.cache'), '--source', 'osv', '--yes', ...extra]
    }

    it('exits 0 for a clean scan with no gate configured', async function () {
        await makeProject('web')
        argv(...scanArgs())
        expect(await main()).toBe(EXIT_OK)
    })

    // Was "exits 0 when a gate is set but nothing meets it", asserted against an UNSEEDED cache — which
    // is the bug, not the contract: no advisory data means nothing can meet the gate, so it passed for
    // the wrong reason. That contract is covered properly below, against a seeded cache with a real
    // finding sitting under the threshold. What the unseeded case must do now is refuse.
    it('exits 1 when a gate is set but a source could not be consulted', async function () {
        await makeProject('web')
        // scanArgs is --offline against an empty cache dir, so OSV reports osv_db_not_seeded.
        argv(...scanArgs('--fail-on', 'critical'))
        expect(await main()).toBe(EXIT_ERROR)
    })

    // The fix is scoped to gated runs. Without --fail-on the caller asked for a report, and a report is
    // allowed to say a source was unavailable and carry on — the outcomes are printed either way.
    it('leaves the same unaudited scan at 0 when no gate is set', async function () {
        await makeProject('web')
        argv(...scanArgs())
        expect(await main()).toBe(EXIT_OK)
    })

    // The CI contract: a real finding at or above the gate must produce exit 2, distinct from the 1 an
    // internal failure produces, so a pipeline can tell "your dependencies are vulnerable" apart from
    // "the scanner broke". Asserted through main() rather than against the constant, because a gate
    // that silently stopped firing would still satisfy an assertion about the constant's value.
    it('exits 2 when a finding meets the --fail-on gate', async function () {
        await makeProject('web')
        await seedVulnerableLodash()
        argv(...seededScanArgs('--fail-on', 'high'))

        expect(await main()).toBe(EXIT_THRESHOLD)
        expect(out()).toContain('GHSA-vulnerable-lodash')
    })

    // Same finding, stricter gate: high does not satisfy critical, so the run reports the vulnerability
    // and still exits clean. This is the pair that proves the gate compares severities rather than just
    // counting findings.
    it('exits 0 when the same finding sits below the gate', async function () {
        await makeProject('web')
        await seedVulnerableLodash()
        argv(...seededScanArgs('--fail-on', 'critical'))

        expect(await main()).toBe(EXIT_OK)
        expect(out()).toContain('GHSA-vulnerable-lodash')
    })

    it('reserves a distinct code for the threshold, separate from an error', function () {
        expect(EXIT_THRESHOLD).toBe(2)
        expect(EXIT_ERROR).toBe(1)
    })
})

describe('retryWaitMsFor', function () {
    // Seconds at the flag, milliseconds at the feeds layer.
    it('converts seconds to milliseconds', async function () {
        const { retryWaitMsFor } = await import('./run')
        expect(retryWaitMsFor(180)).toBe(180_000)
        expect(retryWaitMsFor(30)).toBe(30_000)
    })

    // The distinction the whole function exists for. undefined lets the feeds layer apply its default;
    // 0 is the user saying "do not wait at all". Collapsing them would turn --feed-wait 0 into a
    // three-minute stall, which is the exact opposite of what was asked for.
    it('keeps "no preference" and "do not wait" apart', async function () {
        const { retryWaitMsFor } = await import('./run')
        expect(retryWaitMsFor(null)).toBeUndefined()
        expect(retryWaitMsFor(0)).toBe(0)
    })
})

describe('resolveDestination', function () {
    function options(overrides: Partial<CliOptions> = {}): CliOptions {
        return { rootPath: '/srv/code', outPath: null, ...overrides } as CliOptions
    }

    // What lets `sentinello | claude -p` work with no flags at all.
    it('returns null for an explicit --out -', function () {
        expect(resolveDestination(options({ outPath: '-' }), 0)).toBeNull()
    })

    it('returns null when stdout is piped', function () {
        setTty(process.stdout, false)
        expect(resolveDestination(options(), 0)).toBeNull()
    })

    it('resolves an explicit --out against the scan root', function () {
        expect(resolveDestination(options({ outPath: 'report.md' }), 0)).toBe('/srv/code/report.md')
    })

    // An explicit --out wins even on a pipe: the user asked for a file.
    it('honours --out even when stdout is piped', function () {
        setTty(process.stdout, false)
        expect(resolveDestination(options({ outPath: 'report.md' }), 0)).toBe('/srv/code/report.md')
    })

    // A bare terminal run leaves an artifact behind instead of flooding the scrollback.
    it('falls back to a dated file on a TTY', function () {
        setTty(process.stdout, true)
        const destination = resolveDestination(options(), Date.UTC(2026, 6, 29))
        expect(destination).toContain('/srv/code/')
        expect(destination).toMatch(/\.md$/)
    })
})

describe('Ui contract', function () {
    // runScan takes the Ui as a parameter, which is what lets the whole terminal layer be swapped.
    // Asserting the call ORDER matters because the document is written between scanProjectDone and
    // summary — a UI that printed the summary first would describe a file that did not exist yet.
    it('drives the terminal layer in a fixed order', async function () {
        await makeProject('web')
        const calls: string[] = []
        const recorder = new Proxy({} as Ui, {
            get: function get(_target, prop: string) {
                return function record(): unknown {
                    calls.push(prop)
                    if (prop === 'confirmSeed') return Promise.resolve(false)
                    return undefined
                }
            }
        })
        const { runScan } = await import('./run')
        const { parseArgs } = await import('./options')
        const parsed = parseArgs(scanArgs())
        if (parsed.kind !== 'options') throw new Error('expected options')

        await runScan(parsed.options, join(dir, '.cache'), recorder)

        expect(calls[0]).toBe('banner')
        expect(calls).toContain('discovered')
        expect(calls.indexOf('scanStart')).toBeLessThan(calls.indexOf('summary'))
        expect(calls[calls.length - 1]).toBe('summary')
    })
})

// The distinction that decides an exit code. `SENTINELLO_*_FEED_URL=off` switches off the FEED, not the
// source: a cache seeded earlier stays valid and must keep producing findings. Only off-AND-unseeded is
// a source that can never contribute, and only that one may be dropped — a feed that is ON but unseeded
// is a real failure or a declined download, and refusing a gate there is the whole point.
describe('enabledSources', function () {
    function cell(seeded: boolean | undefined, normalizerVersion: number): Record<string, unknown> {
        if (!seeded) return {}
        return { npm: { normalizerVersion, recordCount: 1, refreshedAt: 0 } }
    }

    function metaWith(seeded: { osv?: boolean; gemnasium?: boolean }): CacheMeta {
        return {
            schemaVersion: 1,
            sources: {
                osv: cell(seeded.osv, OSV_NORMALIZER_VERSION),
                gemnasium: cell(seeded.gemnasium, GEMNASIUM_NORMALIZER_VERSION)
            }
        } as unknown as CacheMeta
    }

    it('keeps a source whose feed is on and cache is seeded', function () {
        expect(enabledSources(['osv', 'gemnasium'], metaWith({ osv: true, gemnasium: true })))
            .toEqual(['osv', 'gemnasium'])
    })

    // The case the gate exists for: nothing was ever downloaded, so the scan must still report the cell
    // unauditable and refuse under --fail-on rather than quietly narrowing what it audited.
    it('keeps a source whose feed is on but cache is unseeded', function () {
        expect(enabledSources(['osv', 'gemnasium'], metaWith({})))
            .toEqual(['osv', 'gemnasium'])
    })

    // Air-gapped with a cache provisioned out of band. Dropping this would throw away real findings.
    it('keeps a source whose feed is off when the cache is seeded', function () {
        feeds.gemnasiumFeedDisabled.mockReturnValue(true)
        expect(enabledSources(['gemnasium'], metaWith({ gemnasium: true }))).toEqual(['gemnasium'])
    })

    it('drops a source whose feed is off and cache was never seeded', function () {
        feeds.gemnasiumFeedDisabled.mockReturnValue(true)
        expect(enabledSources(['osv', 'gemnasium'], metaWith({ osv: true }))).toEqual(['osv'])
    })

    it('drops osv on the same rule', function () {
        feeds.osvFeedDisabled.mockReturnValue(true)
        expect(enabledSources(['osv', 'gemnasium'], metaWith({ gemnasium: true }))).toEqual(['gemnasium'])
    })

    // A stale normalizer version means every cached row was parsed by code that no longer exists, so the
    // cache counts as unseeded and the source is dropped rather than trusted.
    it('treats a cache from a superseded normalizer as unseeded', function () {
        feeds.gemnasiumFeedDisabled.mockReturnValue(true)
        const stale = {
            schemaVersion: 1,
            sources: { osv: {}, gemnasium: { npm: { normalizerVersion: GEMNASIUM_NORMALIZER_VERSION - 1, recordCount: 1, refreshedAt: 0 } } }
        } as unknown as CacheMeta
        expect(enabledSources(['gemnasium'], stale)).toEqual([])
    })
})
