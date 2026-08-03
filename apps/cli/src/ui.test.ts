import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiscoveredProject, DiscoverySkip } from '@sentinello/scanners'
import type { SyncOutcome, SyncPlan, SyncPlanItem } from './cache/sync'
import type { CliOptions } from './options'
import type { RunSummary } from './report'
import type { ProjectScanResult } from './scan'

// The terminal layer. Two things make it worth pinning rather than treating as cosmetic:
//
//   - EVERYTHING must go to stderr. The advisory markdown on stdout is the program's output and may be
//     piped straight into an agent, so a single status line written to the wrong stream corrupts the
//     document. Every test here asserts against a stderr spy, and one asserts stdout was never touched.
//   - The interactive/TTY split is a real branch, not a cosmetic one: confirmSeed REFUSES on a
//     non-TTY (declining beats silently pulling hundreds of megabytes onto a build machine), and
//     progress rendering is suppressed entirely so a CI log gets a handful of lines rather than
//     thousands of carriage returns.
//
// createUi captures `interactive` and `startedAt` at construction, so isTTY and the clock must both be
// set BEFORE ui() is called — hence the builder rather than a shared beforeEach instance.

const readline = vi.hoisted(function makeReadlineDouble() {
    const state = { answer: '', closed: false, prompts: [] as string[] }
    return {
        state,
        createInterface: function createInterface() {
            return {
                question: function question(prompt: string): Promise<string> {
                    state.prompts.push(prompt)
                    return Promise.resolve(state.answer)
                },
                close: function close(): void {
                    state.closed = true
                }
            }
        }
    }
})

vi.mock('node:readline/promises', function mockReadline() {
    return { createInterface: readline.createInterface }
})

const { createUi, formatBytes } = await import('./ui')

const T0 = Date.UTC(2026, 0, 1)

let written: string[]
let stdoutWritten: string[]

function options(overrides: Partial<CliOptions> = {}): CliOptions {
    return {
        rootPath: '/srv/code',
        maxDepth: null,
        excludes: [],
        sources: [],
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
        // Colour off by default so assertions read as plain text; the palette gets its own test.
        color: false,
        quiet: false,
        verbose: false,
        ...overrides
    } as CliOptions
}

// isTTY is a plain property on the stream, absent under vitest's node environment. defineProperty (not
// assignment) is what makes it restorable, and it must be set before createUi reads it.
function setTty(stream: NodeJS.WriteStream | NodeJS.ReadStream, value: boolean): void {
    Object.defineProperty(stream, 'isTTY', { value, configurable: true, writable: true })
}

function ui(overrides: Partial<CliOptions> = {}) {
    return createUi(options(overrides))
}

function out(): string {
    return written.join('')
}

function lines(): string[] {
    return out().split('\n')
}

function project(overrides: Partial<DiscoveredProject> = {}): DiscoveredProject {
    return {
        absolutePath: '/srv/code/web',
        relPath: 'web',
        name: 'web',
        packageManager: 'npm',
        nvmrcVersion: null,
        gitBranch: null,
        ecosystems: ['npm'],
        ...overrides
    } as DiscoveredProject
}

function skip(path: string, source: DiscoverySkip['source'] = 'gitignore'): DiscoverySkip {
    return { path, source }
}

function planItem(overrides: Partial<SyncPlanItem> = {}): SyncPlanItem {
    return { source: 'osv', ecosystem: 'npm', kind: 'seed', downloadBytes: 1024 * 1024, downloadBytesEstimated: false, ...overrides } as SyncPlanItem
}

function outcome(overrides: Partial<SyncOutcome> = {}): SyncOutcome {
    return { source: 'osv', ecosystem: 'npm', status: 'unchanged', rowCount: 1234, message: null, ...overrides } as SyncOutcome
}

function scanResult(overrides: Partial<ProjectScanResult> = {}): ProjectScanResult {
    return { project: project(), findings: [], outcomes: [], ...overrides } as ProjectScanResult
}

function summary(overrides: Partial<RunSummary> = {}): RunSummary {
    return {
        projects: [],
        totalFindings: 0,
        counts: { critical: 0, high: 0, moderate: 0, low: 0, info: 0 },
        findings: [],
        ...overrides
    } as RunSummary
}

beforeEach(function setup() {
    written = []
    stdoutWritten = []
    vi.spyOn(process.stderr, 'write').mockImplementation(function captureErr(chunk: unknown): boolean {
        written.push(String(chunk))
        return true
    })
    vi.spyOn(process.stdout, 'write').mockImplementation(function captureOut(chunk: unknown): boolean {
        stdoutWritten.push(String(chunk))
        return true
    })
    setTty(process.stderr, true)
    setTty(process.stdin, true)
    readline.state.answer = ''
    readline.state.closed = false
    readline.state.prompts.length = 0
})

afterEach(function teardown() {
    vi.restoreAllMocks()
    vi.useRealTimers()
})

describe('formatBytes', function () {
    it('reports an unknown size rather than a bogus zero', function () {
        expect(formatBytes(null)).toBe('unknown size')
    })

    it('scales through B, KB, MB and GB', function () {
        expect(formatBytes(512)).toBe('512 B')
        expect(formatBytes(2048)).toBe('2 KB')
        expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
        expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.00 GB')
    })

    it('switches unit exactly at the 1 MB and 1 GB boundaries', function () {
        expect(formatBytes(1024 * 1024 - 1)).toMatch(/KB$/)
        expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
        expect(formatBytes(1024 * 1024 * 1024)).toBe('1.00 GB')
    })

    // A measured constant must not read as a figure the server actually advertised.
    it('marks an estimate with a tilde at every unit', function () {
        expect(formatBytes(512, true)).toBe('~512 B')
        expect(formatBytes(2048, true)).toBe('~2 KB')
        expect(formatBytes(80 * 1024 * 1024, true)).toBe('~80.0 MB')
        expect(formatBytes(3 * 1024 * 1024 * 1024, true)).toBe('~3.00 GB')
    })

    it('leaves an unknown size unmarked, since there is no figure to qualify', function () {
        expect(formatBytes(null, true)).toBe('unknown size')
    })
})

describe('stream discipline', function () {
    // The whole reason this module exists in the shape it does.
    it('never writes to stdout, because stdout carries the advisory document', function () {
        const u = ui()
        u.banner()
        u.scanStart(2)
        u.scanProjectDone(scanResult())
        u.summary(summary(), '/srv/code/advisory.md')
        u.error('boom')
        expect(stdoutWritten).toEqual([])
        expect(written.length).toBeGreaterThan(0)
    })

    it('writes nothing at all when quiet', function () {
        const u = ui({ quiet: true })
        u.banner()
        u.scanStart(1)
        u.seedDeclined()
        u.offlineNotice()
        u.summary(summary(), null)
        expect(written).toEqual([])
    })

    // error() bypasses write() deliberately — a failure must still be visible under --quiet.
    it('still reports errors when quiet', function () {
        ui({ quiet: true }).error('disk full')
        expect(out()).toContain('disk full')
    })
})

describe('banner and discovery', function () {
    it('names the tool and what it does', function () {
        ui().banner()
        expect(out()).toContain('sentinello')
        expect(out()).toContain('dependency advisories')
    })

    it('singularises the project count', function () {
        ui().discovered([project()], [], '/srv/code')
        expect(out()).toContain('1 project in /srv/code')
        expect(out()).not.toContain('projects')
    })

    it('pluralises the project count', function () {
        ui().discovered([project(), project({ relPath: 'api' })], [], '/srv/code')
        expect(out()).toContain('2 projects in /srv/code')
    })

    it('summarises skipped directories by count and points at --verbose', function () {
        ui().discovered([project()], [skip('/srv/code/vendor'), skip('/srv/code/tmp')], '/srv/code')
        expect(out()).toContain('2 directories skipped by ignore rules (--verbose to list)')
        expect(out()).not.toContain('/srv/code/vendor')
    })

    it('singularises a lone skipped directory', function () {
        ui().discovered([project()], [skip('/srv/code/vendor')], '/srv/code')
        expect(out()).toContain('1 directory skipped')
    })

    it('lists every skipped directory with its rule source under --verbose', function () {
        ui({ verbose: true }).discovered([project()], [skip('/srv/code/vendor', 'sentinelloignore')], '/srv/code')
        expect(out()).toContain('skipped /srv/code/vendor (sentinelloignore)')
        expect(out()).not.toContain('--verbose to list')
    })

    it('says nothing about skips when there were none', function () {
        ui().discovered([project()], [], '/srv/code')
        expect(out()).not.toContain('skipped')
    })
})

describe('noProjects', function () {
    // "No projects found" with a silent .gitignore behind it is the single most confusing outcome the
    // CLI can produce, so the explanation is asserted rather than assumed.
    it('blames ignore rules and offers the negation escape hatch when directories were skipped', function () {
        ui().noProjects([skip('/srv/code/vendor'), skip('/srv/code/tmp')])
        expect(out()).toContain('No projects found.')
        expect(out()).toContain('2 directories were skipped by .gitignore or .sentinelloignore rules.')
        expect(out()).toContain('add a "!" rule to .sentinelloignore')
    })

    it('singularises a lone skip', function () {
        ui().noProjects([skip('/srv/code/vendor')])
        expect(out()).toContain('1 directory was skipped')
    })

    it('offers no explanation when nothing was skipped', function () {
        ui().noProjects([])
        expect(out()).toContain('No projects found.')
        expect(out()).not.toContain('skipped')
    })
})

describe('confirmSeed', function () {
    function plan(): SyncPlan {
        return {
            items: [planItem(), planItem({ source: 'gemnasium', kind: 'refresh', downloadBytes: null })],
            seedBytes: 1024 * 1024,
            needsConsent: true
        } as SyncPlan
    }

    it('lists only the seeds and their transfer size', async function () {
        await ui().confirmSeed(plan())
        expect(out()).toContain('First run — the advisory databases need downloading.')
        expect(out()).toContain('OSV')
        expect(out()).toContain('1.0 MB')
        // The refresh item is not a download the user is being asked to approve.
        expect(out()).not.toContain('GitLab gemnasium')
    })

    it('states that nothing about the code is uploaded', async function () {
        await ui().confirmSeed(plan())
        expect(out()).toContain('Nothing about your code is uploaded.')
    })

    // gemnasium's size is a measured constant, not a Content-Length, and the prompt says so rather than
    // presenting it with the same authority as OSV's.
    it('renders an estimated seed size with a tilde alongside an exact one', async function () {
        await ui().confirmSeed({
            items: [
                planItem(),
                planItem({ source: 'gemnasium', downloadBytes: 80 * 1024 * 1024, downloadBytesEstimated: true })
            ],
            seedBytes: 1024 * 1024 + 80 * 1024 * 1024,
            needsConsent: true
        } as SyncPlan)
        expect(out()).toContain('1.0 MB')
        expect(out()).toContain('~80.0 MB')
        expect(out()).not.toContain('unknown size')
    })

    it.each([
        ['', true],
        ['y', true],
        ['Y', true],
        ['yes', true],
        ['  YES  ', true],
        ['n', false],
        ['no', false],
        ['maybe', false]
    ])('reads %j as %s', async function (answer, expected) {
        readline.state.answer = answer as string
        expect(await ui().confirmSeed(plan())).toBe(expected)
    })

    it('closes the readline interface even so', async function () {
        await ui().confirmSeed(plan())
        expect(readline.state.closed).toBe(true)
    })

    // Refusing beats silently pulling hundreds of megabytes on a build machine.
    it('refuses without prompting when stdin is not a terminal', async function () {
        setTty(process.stdin, false)
        expect(await ui().confirmSeed(plan())).toBe(false)
        expect(readline.state.prompts).toEqual([])
        expect(out()).toContain('Not an interactive terminal — pass --yes to allow the download.')
    })

    it('refuses without prompting when stderr is not a terminal', async function () {
        setTty(process.stderr, false)
        expect(await ui().confirmSeed(plan())).toBe(false)
        expect(readline.state.prompts).toEqual([])
    })
})

describe('sync reporting', function () {
    it('says downloading for a seed and checking for a refresh', function () {
        const u = ui()
        u.syncStatus(planItem({ kind: 'seed' }), 'start')
        u.syncStatus(planItem({ kind: 'refresh', source: 'gemnasium' }), 'start')
        expect(out()).toContain('downloading OSV')
        expect(out()).toContain('checking GitLab gemnasium')
    })

    it('passes an unrecognised source name through unchanged', function () {
        ui().syncDone([outcome({ source: 'osv' }), outcome({ source: 'nvd' as SyncOutcome['source'] })])
        expect(out()).toContain('OSV')
        expect(out()).toContain('nvd')
    })

    it('reports each terminal status distinctly', function () {
        ui().syncDone([
            outcome({ status: 'unchanged', rowCount: 1000 }),
            outcome({ status: 'seeded', rowCount: 2000 }),
            outcome({ status: 'refreshed', rowCount: 3000 }),
            outcome({ status: 'error', message: 'connection reset' }),
            outcome({ status: 'skipped', message: 'lock held' })
        ])
        const text = out()
        expect(text).toContain('up to date (1,000 advisories)')
        expect(text).toContain('downloaded (2,000 advisories)')
        expect(text).toContain('updated (3,000 advisories)')
        expect(text).toContain('connection reset')
        expect(text).toContain('lock held')
    })

    it('falls back to generic wording when a failure carries no message', function () {
        ui().syncDone([outcome({ status: 'error', message: null }), outcome({ status: 'skipped', message: null })])
        expect(out()).toContain('sync failed')
        expect(out()).toContain('skipped')
    })

    it('notes an offline run reuses the cache as-is', function () {
        ui().offlineNotice()
        expect(out()).toContain('offline — using the cached advisory data as-is')
    })

    it('explains how to enable the sources after a decline', function () {
        ui().seedDeclined()
        expect(out()).toContain('Run again and accept, or pass --yes')
    })
})

describe('syncProgress', function () {
    beforeEach(function freezeClock() {
        vi.useFakeTimers()
        vi.setSystemTime(T0)
    })

    it('renders a bar, percentage, transferred total and rate', function () {
        const u = ui()
        vi.setSystemTime(T0 + 1000)
        u.syncProgress(planItem(), 512 * 1024, 1024 * 1024)
        const text = out()
        expect(text).toContain('50%')
        expect(text).toContain('512 KB / 1.0 MB')
        expect(text).toContain('/s')
        expect(text).toContain('█')
        expect(text).toContain('░')
    })

    it('reports bytes alone when the total is unknown', function () {
        const u = ui()
        vi.setSystemTime(T0 + 1000)
        u.syncProgress(planItem(), 2048, null)
        expect(out()).toContain('2 KB')
        expect(out()).not.toContain('%')
    })

    // The very first chunk can land in the same millisecond the ui was constructed, which makes the
    // elapsed time zero. Dividing by it would print "Infinity/s" and an "Infinity left" estimate, so
    // both the rate and the ETA have to be suppressed until there is a measurable interval.
    it('omits the rate and the estimate when no time has elapsed yet', function () {
        const u = ui()
        u.syncProgress(planItem(), 512 * 1024, 1024 * 1024)
        const text = out()
        expect(text).toContain('50%')
        expect(text).not.toContain('/s')
        expect(text).not.toContain('left')
        expect(text).not.toContain('Infinity')
        expect(text).not.toContain('NaN')
    })

    // Writing on every chunk would spend more time emitting escape codes than doing work.
    it('throttles to roughly 20fps', function () {
        const u = ui()
        vi.setSystemTime(T0 + 1000)
        u.syncProgress(planItem(), 1000, 10_000)
        const afterFirst = written.length
        vi.setSystemTime(T0 + 1020)
        u.syncProgress(planItem(), 2000, 10_000)
        expect(written.length).toBe(afterFirst)
        vi.setSystemTime(T0 + 1100)
        u.syncProgress(planItem(), 3000, 10_000)
        expect(written.length).toBeGreaterThan(afterFirst)
    })

    it('estimates time remaining once there is more than a second of it left', function () {
        const u = ui()
        vi.setSystemTime(T0 + 1000)
        u.syncProgress(planItem(), 1024, 1024 * 1024)
        expect(out()).toContain('left')
    })

    it('omits the estimate when the transfer is essentially done', function () {
        const u = ui()
        vi.setSystemTime(T0 + 1000)
        u.syncProgress(planItem(), 1_000_000, 1_000_001)
        expect(out()).not.toContain('left')
    })

    it('is suppressed entirely on a non-TTY so CI logs stay readable', function () {
        setTty(process.stderr, false)
        const u = ui()
        vi.setSystemTime(T0 + 1000)
        u.syncProgress(planItem(), 512, 1024)
        expect(written).toEqual([])
    })

    it('is suppressed when quiet', function () {
        const u = ui({ quiet: true })
        vi.setSystemTime(T0 + 1000)
        u.syncProgress(planItem(), 512, 1024)
        expect(written).toEqual([])
    })

    // The in-place progress line has no newline, so anything printed after it must erase it first.
    it('erases the progress line before the next full-width write', function () {
        const u = ui()
        vi.setSystemTime(T0 + 1000)
        u.syncProgress(planItem(), 512, 1024)
        written.length = 0
        u.syncStatus(planItem(), 'done')
        expect(out()).toContain('\x1b[2K\r')
    })

    it('does not emit an erase when no progress line is showing', function () {
        ui().syncStatus(planItem(), 'done')
        expect(written).toEqual([])
    })
})

describe('scan progress', function () {
    it('pluralises the scan header', function () {
        ui().scanStart(1)
        expect(out()).toContain('Scanning 1 project')
        written.length = 0
        ui().scanStart(3)
        expect(out()).toContain('Scanning 3 projects')
    })

    it('shows the project currently being scanned on a TTY', function () {
        ui().scanProject(project({ relPath: 'services/api' }))
        expect(out()).toContain('services/api')
    })

    it('stays silent about the current project on a non-TTY', function () {
        setTty(process.stderr, false)
        ui().scanProject(project())
        expect(written).toEqual([])
    })

    it('marks a clean project and a project with findings differently', function () {
        const u = ui({ color: true })
        u.scanProjectDone(scanResult())
        const clean = out()
        written.length = 0
        u.scanProjectDone(scanResult({ findings: [{}, {}] as ProjectScanResult['findings'] }))
        const dirty = out()
        expect(clean).toContain('✓')
        expect(dirty).toContain('•')
        expect(dirty).toContain('2 findings')
    })

    it('singularises a lone finding', function () {
        ui().scanProjectDone(scanResult({ findings: [{}] as ProjectScanResult['findings'] }))
        expect(out()).toContain('1 finding')
        expect(out()).not.toContain('1 findings')
    })

    it('falls back to the project name when it is the root itself', function () {
        ui().scanProjectDone(scanResult({ project: project({ relPath: '.', name: 'my-repo' }) }))
        expect(out()).toContain('my-repo')
    })

    // "0 findings" must never be confused with "nothing could be checked".
    it('names the scanners that could not answer, with the reason', function () {
        ui().scanProjectDone(scanResult({
            outcomes: [
                { scanner: 'npm-audit', status: 'unauditable', reasonCode: 'no_lockfile', errorText: null, durationMs: 5 },
                { scanner: 'osv', status: 'ok', reasonCode: 'ok', errorText: null, durationMs: 5 }
            ]
        }))
        expect(out()).toContain('npm-audit: no_lockfile')
        expect(out()).not.toContain('osv: ok')
    })
})

describe('summary', function () {
    it('celebrates a clean run and counts the projects', function () {
        ui().summary(summary({ projects: [{ relPath: 'web' }, { relPath: 'api' }] as RunSummary['projects'] }), null)
        expect(out()).toContain('No findings.')
        expect(out()).toContain('2 projects clean.')
    })

    it('singularises a lone clean project', function () {
        ui().summary(summary({ projects: [{ relPath: 'web' }] as RunSummary['projects'] }), null)
        expect(out()).toContain('1 project clean.')
    })

    it('breaks the total down by severity, worst first, omitting empty buckets', function () {
        ui().summary(summary({
            totalFindings: 7,
            counts: { critical: 1, high: 0, moderate: 4, low: 2, info: 0 },
            projects: []
        }), null)
        const text = out()
        expect(text).toContain('7 findings')
        expect(text).toContain('critical')
        expect(text).toContain('moderate')
        expect(text).toContain('low')
        expect(text).not.toContain('high')
        expect(text.indexOf('critical')).toBeLessThan(text.indexOf('moderate'))
        expect(text.indexOf('moderate')).toBeLessThan(text.indexOf('low'))
    })

    // The total is pluralised independently of the clean-project count above, so it needs its own
    // singular case — "1 findings" is the kind of thing nobody notices until it ships.
    it('singularises a lone finding', function () {
        ui().summary(summary({
            totalFindings: 1,
            counts: { critical: 0, high: 1, moderate: 0, low: 0, info: 0 },
            projects: []
        }), null)
        expect(out()).toContain('1 finding ')
        expect(out()).not.toContain('1 findings')
    })

    // The "hand it to your agent" hint shortens the destination to its basename. A path ending in a
    // separator has no basename, and printing the empty string would leave `cat ` with no argument.
    it('falls back to the whole path when the destination has no basename', function () {
        ui().summary(summary(), '/srv/code/')
        expect(out()).toContain('cat /srv/code/')
    })

    // A bare total hides which repository in a folder of twenty actually needs the work.
    it('lists each project that has findings and skips the clean ones', function () {
        ui().summary(summary({
            totalFindings: 3,
            counts: { critical: 0, high: 3, moderate: 0, low: 0, info: 0 },
            projects: [
                { relPath: 'web', findingCount: 3, counts: { critical: 0, high: 3, moderate: 0, low: 0, info: 0 } },
                { relPath: 'clean-one', findingCount: 0, counts: { critical: 0, high: 0, moderate: 0, low: 0, info: 0 } }
            ] as RunSummary['projects']
        }), null)
        expect(out()).toContain('web')
        expect(out()).not.toContain('clean-one')
    })

    it('points at the written advisory and shows a copy-pasteable agent command', function () {
        ui().summary(summary(), '/srv/code/sentinello-2026-07-29.md')
        expect(out()).toContain('Advisory written to /srv/code/sentinello-2026-07-29.md')
        // The hint uses the basename, not the full path.
        expect(out()).toContain('claude -p "$(cat sentinello-2026-07-29.md)"')
    })

    it('says nothing about a destination when the document went to stdout', function () {
        ui().summary(summary(), null)
        expect(out()).not.toContain('Advisory written to')
    })
})

describe('colour', function () {
    it('emits ANSI escapes when colour is on', function () {
        ui({ color: true }).banner()
        expect(out()).toContain('\x1b[')
    })

    it('emits none when colour is off', function () {
        ui({ color: false }).banner()
        expect(out()).not.toContain('\x1b[')
    })

    it('gives each severity its own colour', function () {
        ui({ color: true }).summary(summary({
            totalFindings: 5,
            counts: { critical: 1, high: 1, moderate: 1, low: 1, info: 1 },
            projects: []
        }), null)
        const text = out()
        // red, magenta, yellow, blue, dim — five distinct codes, one per severity.
        for (const code of ['\x1b[31m', '\x1b[35m', '\x1b[33m', '\x1b[34m', '\x1b[2m']) {
            expect(text).toContain(code)
        }
    })
})

describe('error', function () {
    it('labels the message and terminates the line itself', function () {
        ui().error('cache is locked')
        expect(out()).toBe('  error cache is locked\n')
    })

    it('erases a live progress line first so the two do not collide', function () {
        vi.useFakeTimers()
        vi.setSystemTime(T0)
        const u = ui()
        vi.setSystemTime(T0 + 1000)
        u.syncProgress(planItem(), 512, 1024)
        written.length = 0
        u.error('interrupted')
        expect(lines()[0]).toContain('\x1b[2K\r')
    })
})
