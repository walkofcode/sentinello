#!/usr/bin/env node
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
    DEFAULT_ECOSYSTEM,
    DEFAULT_EXPORT_PROMPT,
    GEMNASIUM_NORMALIZER_VERSION,
    OSV_NORMALIZER_VERSION
} from '@sentinello/core'
import { discoverProjectsInTree, type DiscoverySkip } from '@sentinello/scanners'
import { isSeeded, readCacheMeta, resolveCacheDir } from './cache/meta'
import { loadCacheForPackages } from './cache/lookup'
import { planSync, runSync } from './cache/sync'
import { applyConfigFile, explicitFlagNames, parseArgs, type CliOptions } from './options'
import {
    defaultOutputFilename,
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

// Exit codes: 0 clean or findings with no gate configured, 1 a scan error, 2 the --fail-on threshold met.
const EXIT_OK = 0
const EXIT_ERROR = 1
const EXIT_THRESHOLD = 2

async function main(): Promise<number> {
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

async function runScan(options: CliOptions, cacheDir: string, ui: Ui): Promise<number> {
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

    // 2. Refresh the advisory cache. There is no separate sync command: the freshness checks are cheap
    // enough (a 304 for OSV, a commit sha for gemnasium) to run every time, and only a first seed is
    // expensive — which is the one case that asks permission.
    if (!options.offline && (options.sources.length > 0)) {
        const plan = await planSync({ cacheDir, sources: options.sources, ecosystem: DEFAULT_ECOSYSTEM })
        if (plan.needsConsent && !options.assumeYes) {
            const approved = await ui.confirmSeed(plan)
            if (!approved) {
                ui.seedDeclined()
                return EXIT_OK
            }
        }
        const outcomes = await runSync({
            cacheDir,
            sources: options.sources,
            ecosystem: DEFAULT_ECOSYSTEM,
            onProgress: ui.syncProgress,
            onStatus: ui.syncStatus
        }, plan)
        ui.syncDone(outcomes)
    } else if (options.offline) {
        ui.offlineNotice()
    }

    // 3. Resolve every project's dependency graph, then read the cache ONCE for the union of their
    // packages rather than re-reading a multi-megabyte file per project.
    const resolved = await resolveProjects(projects)
    const packageNames = collectPackageNames(resolved)
    const cache = await loadCacheForPackages(cacheDir, DEFAULT_ECOSYSTEM, packageNames, options.sources)

    // 4. Scan. Seeded state comes from the cache metadata, not from whether this project happened to match
    // any rows, so a dependency-free project is reported as scanned-and-clean rather than unauditable.
    const meta = await readCacheMeta(cacheDir)
    const setup = {
        cacheDir,
        sources: options.sources,
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
        ui.error('could not read prompt file: ' + (err instanceof Error && err.message || String(err)))
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
    return EXIT_OK
}

// Where the document goes. `--out -` and a piped stdout both mean "write to stdout"; otherwise it lands in
// a dated file next to the user. Following the pipe is what lets `sentinello | claude -p` work without any
// flags while a bare terminal run still leaves an artifact behind instead of flooding the scrollback.
function resolveDestination(options: CliOptions, generatedAt: number): string | null {
    if (options.outPath === '-') return null
    if (options.outPath) return resolve(options.rootPath, options.outPath)
    if (!process.stdout.isTTY) return null
    return resolve(options.rootPath, defaultOutputFilename(options, generatedAt))
}

main()
    .then(function exit(code: number) {
        process.exitCode = code
    })
    .catch(function onFatal(err: unknown) {
        const message = err instanceof Error && err.message || String(err)
        process.stderr.write('sentinello: ' + message + '\n')
        process.exitCode = EXIT_ERROR
    })
