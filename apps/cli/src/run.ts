import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
    DEFAULT_ECOSYSTEM,
    DEFAULT_EXPORT_PROMPT,
    GEMNASIUM_NORMALIZER_VERSION,
    OSV_NORMALIZER_VERSION,
    errText
} from '@sentinello/core'
import { discoverProjectsInTree, type DiscoverySkip } from '@sentinello/scanners'
import { gemnasiumFeedDisabled, osvFeedDisabled } from '@sentinello/feeds'
import { isSeeded, readCacheMeta, resolveCacheDir, type CacheMeta, type SourceId } from './cache/meta'
import { loadCacheForPackages } from './cache/lookup'
import { planSync, runSync, type SyncOutcome, type SyncPlan, type SyncPlanItem } from './cache/sync'
import { applyConfigFile, explicitFlagNames, parseArgs, type CliOptions } from './options'
import {
    defaultOutputFilename,
    hasUnavailableSource,
    renderJson,
    renderMarkdown,
    resolvePrompt,
    shouldFail,
    summarize
} from './report'
import { buildScanners, collectPackageNames, resolveProjects, scanProject, type ProjectScanResult } from './scan'
import { createUi, type Ui } from './ui'
import { runDoctor } from './doctor'
import { CLI_VERSION, HELP_TEXT } from './help'

// The CLI's top-level flow: parse, dispatch a terminal mode, or run a scan.
//
// Deliberately NOT the entry point. src/cli.ts is, and it stays a thin bin carrying the shebang and
// the main() call — tsup's `entry: { cli: 'src/cli.ts' }` points there, and its config comments note
// that esbuild preserves the shebang from that file rather than emitting a banner. Splitting the body
// out is what makes main() assertable: importing the bin parses process.argv and sets process.exitCode
// as a side effect, so a test could never import it.
//
// main() returns an exit code rather than calling process.exit, which is what lets the bin decide to
// set process.exitCode instead — a scan that has written its document to a pipe should let stdout
// flush rather than being killed mid-write.

// Exit codes: 0 clean or findings with no gate configured, 1 a scan error, 2 the --fail-on threshold met.
const EXIT_OK = 0
const EXIT_ERROR = 1
const EXIT_THRESHOLD = 2

export async function main(): Promise<number> {
    const argv = process.argv.slice(2)
    const parsed = parseArgs(argv)
    if (parsed.kind === 'help') {
        process.stdout.write(HELP_TEXT)
        return EXIT_OK
    }
    if (parsed.kind === 'version') {
        process.stdout.write(CLI_VERSION + '\n')
        return EXIT_OK
    }
    if (parsed.kind === 'print-prompt') {
        // Dumps the built-in prompt so a custom one starts from a working base rather than a blank file.
        process.stdout.write(DEFAULT_EXPORT_PROMPT + '\n')
        return EXIT_OK
    }
    if (parsed.kind === 'error') {
        process.stderr.write('sentinello: ' + parsed.message + '\n\nRun `sentinello --help` for usage.\n')
        return EXIT_ERROR
    }
    const options = parsed.options
    const configError = await applyConfigFile(options, explicitFlagNames(argv))
    if (configError) {
        process.stderr.write('sentinello: ' + configError + '\n')
        return EXIT_ERROR
    }
    const cacheDir = resolveCacheDir(options.cacheDir)
    if (parsed.kind === 'doctor') {
        await runDoctor(options, cacheDir)
        return EXIT_OK
    }
    // Markdown goes to stdout when piped, so every human-facing line must go to stderr in that mode or it
    // would corrupt the document.
    const ui = createUi(options)
    return await runScan(options, cacheDir, ui)
}

export async function runScan(options: CliOptions, cacheDir: string, ui: Ui): Promise<number> {
    const generatedAt = Date.now()
    ui.banner()

    // 1. Discover. Done before any download so the run can stop immediately when there is nothing to scan.
    const skipped: DiscoverySkip[] = []
    const projects = discoverProjectsInTree({
        rootPath: options.rootPath,
        maxDepth: options.maxDepth,
        excludes: options.excludes,
        onSkip: function record(skip) {
            skipped.push(skip)
        }
    })
    ui.discovered(projects, skipped, options.rootPath)
    if (projects.length === 0) {
        ui.noProjects(skipped)
        return EXIT_OK
    }

    // A source the operator switched off and never seeded is not a source that failed, and the difference
    // decides an exit code. Resolved once, here, so the sync, the cache read and the scanners all agree on
    // one set — see enabledSources for why "off" alone is not enough to drop one.
    const sources = enabledSources(options.sources, await readCacheMeta(cacheDir))
    const switchedOff = options.sources.filter(function isOff(source): boolean {
        return !sources.includes(source)
    })
    if (switchedOff.length > 0) ui.sourcesSwitchedOff(switchedOff)

    // 2. Refresh the advisory cache. There is no separate sync command: the freshness checks are cheap
    // enough (a 304 for OSV, a commit sha for gemnasium) to run every time, and only a first seed is
    // expensive — which is the one case that asks permission.
    if (!options.offline && (sources.length > 0)) {
        const plan = await planSync({ cacheDir, sources, ecosystem: DEFAULT_ECOSYSTEM })
        if (plan.needsConsent && !options.assumeYes) {
            const approved = await ui.confirmSeed(plan)
            if (!approved) {
                // Declining is fine for a report. Under a gate it is not: the run would otherwise print
                // zero findings and exit 0, which on a fresh CI runner is indistinguishable from clean —
                // the documented `--fail-on high` gate silently passing without auditing anything.
                const gated = options.failOn !== 'none'
                ui.seedDeclined(gated)
                return gated ? EXIT_ERROR : EXIT_OK
            }
        }
        const syncOptions = {
            cacheDir,
            sources,
            ecosystem: DEFAULT_ECOSYSTEM,
            retryWaitMs: retryWaitMsFor(options.feedWaitSeconds),
            onProgress: ui.syncProgress,
            onRetry: ui.syncRetry,
            onStatus: ui.syncStatus
        }
        let outcomes = await runSync(syncOptions, plan)
        ui.syncDone(outcomes)
        // A failed source is offered a retry rather than being abandoned on the spot. The wait inside the
        // feeds layer is short by design, so without this the only way to re-attempt a download that failed
        // for a passing reason would be to re-run the whole scan. Re-runs cover ONLY the failed items, so a
        // source that already succeeded is never downloaded twice.
        for (;;) {
            const failed = failedItems(plan, outcomes)
            if (failed.length === 0) break
            const approved = await ui.confirmRetry(outcomes.filter(isErrorOutcome))
            if (!approved) break
            outcomes = await runSync(syncOptions, { items: failed, seedBytes: 0, needsConsent: false })
            ui.syncDone(outcomes)
        }
    } else if (options.offline) {
        ui.offlineNotice()
    }

    // 3. Resolve every project's dependency graph, then read the cache ONCE for the union of their
    // packages rather than re-reading a multi-megabyte file per project.
    const resolved = await resolveProjects(projects)
    const packageNames = collectPackageNames(resolved)
    const cache = await loadCacheForPackages(cacheDir, DEFAULT_ECOSYSTEM, packageNames, sources)

    // 4. Scan. Seeded state comes from the cache metadata, not from whether this project happened to match
    // any rows, so a dependency-free project is reported as scanned-and-clean rather than unauditable.
    const meta = await readCacheMeta(cacheDir)
    const setup = {
        cacheDir,
        sources,
        ecosystem: DEFAULT_ECOSYSTEM,
        includeNpmAudit: options.includeNpmAudit,
        seeded: {
            osv: isSeeded(meta, 'osv', DEFAULT_ECOSYSTEM, OSV_NORMALIZER_VERSION),
            gemnasium: isSeeded(meta, 'gemnasium', DEFAULT_ECOSYSTEM, GEMNASIUM_NORMALIZER_VERSION)
        }
    }
    const scanners = buildScanners(setup, cache)
    const results: ProjectScanResult[] = []
    ui.scanStart(resolved.length)
    for (const entry of resolved) {
        ui.scanProject(entry.project)
        const result = await scanProject(setup, entry, scanners)
        results.push(result)
        ui.scanProjectDone(result)
    }

    // 5. Report.
    const summary = summarize(results, options)
    let prompt: string
    try {
        prompt = await resolvePrompt(options)
    } catch (err) {
        ui.error('could not read prompt file: ' + errText(err))
        return EXIT_ERROR
    }
    const document = options.json
        ? renderJson(summary, options, generatedAt)
        : renderMarkdown(summary, options, prompt, generatedAt)

    const destination = resolveDestination(options, generatedAt)
    if (destination === null) {
        process.stdout.write(document)
    } else {
        await writeFile(destination, document, 'utf8')
    }
    ui.summary(summary, destination)

    if (shouldFail(summary, options.failOn)) return EXIT_THRESHOLD
    // A gate cannot be honoured by a scan that lost an advisory source: zero findings from a source that
    // never answered is not a clean result. EXIT_ERROR, not EXIT_THRESHOLD — nothing met the threshold;
    // the scan could not complete, which is what exit 1 already means.
    if (options.failOn !== 'none' && hasUnavailableSource(summary)) return EXIT_ERROR
    return EXIT_OK
}

// SourceId is exactly 'osv' | 'gemnasium', so there is no third arm to fall through to. Adding a
// defensive one would only be an unreachable branch that nothing can ever cover.
function feedSwitchedOff(source: SourceId): boolean {
    if (source === 'osv') return osvFeedDisabled()
    return gemnasiumFeedDisabled()
}

function normalizerVersionFor(source: SourceId): number {
    if (source === 'osv') return OSV_NORMALIZER_VERSION
    return GEMNASIUM_NORMALIZER_VERSION
}

// The requested sources, minus any the operator has switched off AND never seeded.
//
// Both halves matter. `SENTINELLO_*_FEED_URL=off` disables the FEED — the network sync — not the source:
// a cache seeded earlier (or provisioned out of band, which is the whole air-gapped workflow) stays
// perfectly valid, and dropping it would throw away real findings. So off-but-seeded is still a source.
//
// Off AND unseeded is different: that source can never contribute, by the operator's own choice. Leaving
// it in makes every project report the cell unauditable, which under --fail-on refuses the run forever
// for a configuration someone chose deliberately. A feed that is ON but unseeded is NOT dropped — that is
// a genuine failure or a declined download, and refusing the gate there is the point.
//
// Reads the feeds layer's own predicates rather than re-parsing the env vars, so "off" cannot come to
// mean two different things in two places.
export function enabledSources(sources: readonly SourceId[], meta: CacheMeta): SourceId[] {
    return sources.filter(function isUsable(source): boolean {
        if (!feedSwitchedOff(source)) return true
        return isSeeded(meta, source, DEFAULT_ECOSYSTEM, normalizerVersionFor(source))
    })
}

export function isErrorOutcome(outcome: SyncOutcome): boolean {
    return outcome.status === 'error'
}

// The plan items behind the outcomes that failed, so a retry re-runs those and nothing else.
//
// Matched back to the ORIGINAL plan item rather than reconstructed from the outcome, because the item is
// what carries `kind`. A failed seed has to retry as a seed; rebuilding it from the outcome would have to
// guess, and guessing 'refresh' would run an incremental pass against a cache that was never written.
export function failedItems(plan: SyncPlan, outcomes: readonly SyncOutcome[]): SyncPlanItem[] {
    return plan.items.filter(function wasError(item): boolean {
        return outcomes.some(function matches(outcome): boolean {
            return outcome.status === 'error' &&
                outcome.source === item.source &&
                outcome.ecosystem === item.ecosystem
        })
    })
}

// null means "the caller expressed no preference", which is not the same as 0 — 0 is an explicit
// instruction to stop waiting. Returning undefined for null is what lets the feeds layer apply its own
// default, so the two must not collapse into one another on the way down.
export function retryWaitMsFor(feedWaitSeconds: number | null): number | undefined {
    if (feedWaitSeconds === null) return undefined
    return feedWaitSeconds * 1000
}

// Where the document goes. `--out -` and a piped stdout both mean "write to stdout"; otherwise it lands in
// a dated file next to the user. Following the pipe is what lets `sentinello | claude -p` work without any
// flags while a bare terminal run still leaves an artifact behind instead of flooding the scrollback.
export function resolveDestination(options: CliOptions, generatedAt: number): string | null {
    if (options.outPath === '-') return null
    if (options.outPath) return resolve(options.rootPath, options.outPath)
    if (!process.stdout.isTTY) return null
    return resolve(options.rootPath, defaultOutputFilename(options, generatedAt))
}

