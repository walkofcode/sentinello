import { createInterface } from 'node:readline/promises'
import { isSourceUnavailableReason, type Severity } from '@sentinello/core'
import type { RetryNotice } from '@sentinello/feeds'
import type { DiscoveredProject, DiscoverySkip } from '@sentinello/scanners'
import type { SyncOutcome, SyncPlan, SyncPlanItem } from './cache/sync'
import type { CliOptions } from './options'
import type { ProjectScanResult } from './scan'
import type { RunSummary } from './report'

// The terminal layer. Hand-rolled ANSI, no dependencies — the published package declares none, and a
// colour library would be the only thing standing in the way of that.
//
// EVERYTHING here writes to stderr, never stdout. The advisory markdown is the program's output and may be
// piped straight into an agent; a single stray status line on stdout would corrupt that document. stderr
// is also what a TTY still shows, so an interactive run looks identical either way.

// CSI introducer. Written as an escape sequence rather than a literal control byte, so the source stays
// greppable and a stray copy-paste cannot silently strip it.
const ESC = '\x1b['

type Palette = {
    reset: string
    bold: string
    dim: string
    red: string
    magenta: string
    yellow: string
    blue: string
    green: string
    cyan: string
}

const COLOR: Palette = {
    reset: ESC + '0m',
    bold: ESC + '1m',
    dim: ESC + '2m',
    red: ESC + '31m',
    magenta: ESC + '35m',
    yellow: ESC + '33m',
    blue: ESC + '34m',
    green: ESC + '32m',
    cyan: ESC + '36m'
}

const PLAIN: Palette = {
    reset: '', bold: '', dim: '', red: '', magenta: '', yellow: '', blue: '', green: '', cyan: ''
}

const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'moderate', 'low', 'info']

// `estimated` marks a figure that came from a measured constant rather than a Content-Length the server
// advertised, so an approximate number never reads as an exact one.
export function formatBytes(bytes: number | null, estimated = false): string {
    if (bytes === null) return 'unknown size'
    const prefix = estimated ? '~' : ''
    // Rounded like every other branch. This one assumed a whole byte count, but the progress line also
    // formats a computed transfer RATE, which is a float — so the first tick of every download rendered
    // as "541.0334346504559 B/s".
    if (bytes < 1024) return prefix + Math.round(bytes) + ' B'
    const mib = bytes / (1024 * 1024)
    if (mib < 1) return prefix + (bytes / 1024).toFixed(0) + ' KB'
    if (mib < 1024) return prefix + mib.toFixed(1) + ' MB'
    return prefix + (mib / 1024).toFixed(2) + ' GB'
}

// Rounding happens before the split, not after. Rounding the remainder on its own carries into a minute
// that was never added — 179.7s rendered as "2m 60s".
function formatDuration(ms: number): string {
    if (ms < 1000) return ms + 'ms'
    const seconds = ms / 1000
    if (seconds < 59.95) return seconds.toFixed(1) + 's'
    const total = Math.round(seconds)
    const minutes = Math.floor(total / 60)
    return minutes + 'm ' + (total - minutes * 60) + 's'
}

export type Ui = {
    banner(): void
    discovered(projects: readonly DiscoveredProject[], skipped: readonly DiscoverySkip[], root: string): void
    noProjects(skipped: readonly DiscoverySkip[]): void
    confirmSeed(plan: SyncPlan): Promise<boolean>
    confirmRetry(failed: readonly SyncOutcome[]): Promise<boolean>
    sourcesSwitchedOff(sources: readonly string[]): void
    seedDeclined(gated: boolean): void
    offlineNotice(): void
    syncStatus(item: SyncPlanItem, phase: 'start' | 'done'): void
    syncProgress(item: SyncPlanItem, bytesRead: number, totalBytes: number | null): void
    syncRetry(item: SyncPlanItem, notice: RetryNotice): void
    syncDone(outcomes: readonly SyncOutcome[]): void
    scanStart(count: number): void
    scanProject(project: DiscoveredProject): void
    scanProjectDone(result: ProjectScanResult): void
    summary(summary: RunSummary, destination: string | null): void
    error(message: string): void
}

export function createUi(options: CliOptions): Ui {
    const c = options.color ? COLOR : PLAIN
    const interactive = process.stderr.isTTY === true && !options.quiet
    const startedAt = Date.now()
    let lastProgressAt = 0
    let progressActive = false

    function write(line: string): void {
        if (options.quiet) return
        process.stderr.write(line + '\n')
    }

    // Progress redraws in place on a TTY and is suppressed entirely otherwise, so a CI log gets a handful
    // of lines instead of thousands of carriage returns.
    function clearProgress(): void {
        if (!progressActive) return
        process.stderr.write(ESC + '2K\r')
        progressActive = false
    }

    function severityColor(severity: Severity): string {
        if (severity === 'critical') return c.red
        if (severity === 'high') return c.magenta
        if (severity === 'moderate') return c.yellow
        if (severity === 'low') return c.blue
        return c.dim
    }

    function banner(): void {
        write('')
        write(c.bold + c.cyan + '  sentinello' + c.reset + c.dim + '  dependency advisories for the projects in this folder' + c.reset)
        write('')
    }

    function discovered(projects: readonly DiscoveredProject[], skipped: readonly DiscoverySkip[], root: string): void {
        const label = projects.length === 1 ? 'project' : 'projects'
        write('  ' + c.bold + String(projects.length) + c.reset + ' ' + label + ' in ' + c.dim + root + c.reset)
        if (skipped.length > 0 && options.verbose) {
            for (const skip of skipped) {
                write('    ' + c.dim + 'skipped ' + skip.path + ' (' + skip.source + ')' + c.reset)
            }
        } else if (skipped.length > 0) {
            write('    ' + c.dim + skipped.length + ' director' + (skipped.length === 1 ? 'y' : 'ies') + ' skipped by ignore rules (--verbose to list)' + c.reset)
        }
    }

    function noProjects(skipped: readonly DiscoverySkip[]): void {
        write('')
        write('  ' + c.yellow + 'No projects found.' + c.reset)
        if (skipped.length > 0) {
            // The likeliest cause by far, now that .gitignore is honoured — say so rather than leaving the
            // user to guess why a directory they can see was not scanned.
            write('  ' + c.dim + skipped.length + ' director' + (skipped.length === 1 ? 'y was' : 'ies were') + ' skipped by .gitignore or .sentinelloignore rules.' + c.reset)
            write('  ' + c.dim + 'Run with --verbose to see which, or add a "!" rule to .sentinelloignore to re-include one.' + c.reset)
        }
        write('')
    }

    async function confirmSeed(plan: SyncPlan): Promise<boolean> {
        const seeds = plan.items.filter(function isSeed(i): boolean {
            return i.kind === 'seed'
        })
        write('')
        write('  ' + c.bold + 'First run — the advisory databases need downloading.' + c.reset)
        write('')
        for (const item of seeds) {
            write('    ' + sourceLabel(item.source) + c.dim + '  ' + formatBytes(item.downloadBytes, item.downloadBytesEstimated) + c.reset)
        }
        write('')
        write('  ' + c.dim + 'Downloaded once from the upstream feeds, then kept fresh incrementally —' + c.reset)
        write('  ' + c.dim + 'later runs transfer next to nothing. Nothing about your code is uploaded.' + c.reset)
        write('')
        if (!process.stdin.isTTY || !process.stderr.isTTY) {
            // No terminal to ask on (CI, a pipeline). Refusing beats silently pulling hundreds of
            // megabytes on a build machine; --yes is the explicit opt-in.
            write('  ' + c.yellow + 'Not an interactive terminal — pass --yes to allow the download.' + c.reset)
            write('')
            return false
        }
        const rl = createInterface({ input: process.stdin, output: process.stderr })
        try {
            const answer = await rl.question('  Download now? ' + c.dim + '[Y/n]' + c.reset + ' ')
            const normalized = answer.trim().toLowerCase()
            return normalized === '' || normalized === 'y' || normalized === 'yes'
        } finally {
            rl.close()
        }
    }

    // `gated` is whether --fail-on asked this run a yes/no question. If it did, declining the download
    // is not a skip, it is a run that cannot answer — and it exits non-zero rather than looking clean.
    // Said out loud because the alternative is silent: a source switched off is dropped from the run
    // entirely, so a typo in SENTINELLO_OSV_FEED_URL would otherwise just quietly narrow what gets audited.
    function sourcesSwitchedOff(sources: readonly string[]): void {
        const names = sources.map(sourceLabel).join(', ')
        write('    ' + c.dim + '· ' + names + ' switched off and never seeded — not scanned' + c.reset)
    }

    // Offered after a source fails to download. The retry budget in the feeds layer is deliberately short
    // now, so this is what covers the case where waiting really would have helped: the user decides, having
    // seen the failure, instead of the CLI deciding for them by sitting there for minutes.
    //
    // Returns false without asking on a non-TTY or under --quiet, so CI fails fast instead of blocking on a
    // prompt nobody can answer. That is the same rule confirmSeed applies, for the same reason.
    async function confirmRetry(failed: readonly SyncOutcome[]): Promise<boolean> {
        if (!interactive || !process.stdin.isTTY || !process.stderr.isTTY) return false
        const names = failed.map(function label(outcome): string {
            return sourceLabel(outcome.source)
        }).join(', ')
        write('')
        write('  ' + c.yellow + names + ' could not be downloaded.' + c.reset)
        write('  ' + c.dim + 'The scan can continue without it, but anything only that source knows about' + c.reset)
        write('  ' + c.dim + 'will be missing from the report.' + c.reset)
        const rl = createInterface({ input: process.stdin, output: process.stderr })
        try {
            const answer = await rl.question('  Try the download again? ' + c.dim + '[Y/n]' + c.reset + ' ')
            const normalized = answer.trim().toLowerCase()
            return normalized === '' || normalized === 'y' || normalized === 'yes'
        } finally {
            rl.close()
        }
    }

    function seedDeclined(gated: boolean): void {
        write('')
        write('  ' + c.dim + 'Skipped. Run again and accept, or pass --yes, to enable the advisory sources.' + c.reset)
        if (gated) {
            write('  ' + c.yellow + '--fail-on cannot be evaluated without them; exiting non-zero rather than reporting clean.' + c.reset)
        }
        write('')
    }

    function offlineNotice(): void {
        write('  ' + c.dim + 'offline — using the cached advisory data as-is' + c.reset)
    }

    function syncStatus(item: SyncPlanItem, phase: 'start' | 'done'): void {
        if (phase === 'start') {
            const verb = item.kind === 'seed' ? 'downloading' : 'checking'
            write('  ' + verb + ' ' + sourceLabel(item.source))
            return
        }
        clearProgress()
    }

    function syncProgress(item: SyncPlanItem, bytesRead: number, totalBytes: number | null): void {
        if (options.quiet || !interactive) return
        const now = Date.now()
        // Throttled to ~20fps: writing on every chunk would spend more time on escape codes than on work.
        if (now - lastProgressAt < 50) return
        lastProgressAt = now
        const elapsed = (now - startedAt) / 1000
        const rate = elapsed > 0 ? bytesRead / elapsed : 0
        let line = '    ' + formatBytes(bytesRead)
        if (totalBytes) {
            const fraction = Math.min(1, bytesRead / totalBytes)
            line = '    ' + bar(fraction) + ' ' + (fraction * 100).toFixed(0).padStart(3) + '%  ' +
                formatBytes(bytesRead) + ' / ' + formatBytes(totalBytes)
            const remaining = rate > 0 ? (totalBytes - bytesRead) / rate : 0
            if (remaining > 1) line += '  ' + c.dim + formatDuration(remaining * 1000) + ' left' + c.reset
        }
        if (rate > 0) line += '  ' + c.dim + formatBytes(rate) + '/s' + c.reset
        process.stderr.write(ESC + '2K\r' + line)
        progressActive = true
    }

    // A slow-transient wait is minutes long, so it has to be narrated or the CLI looks wedged. The line
    // also names the remedy, because the alternative to waiting is a source the user silently never gets.
    function syncRetry(item: SyncPlanItem, notice: RetryNotice): void {
        clearProgress()
        const budgetLeft = Math.max(0, notice.budgetMs - notice.elapsedMs)
        write('    ' + c.yellow + '!' + c.reset + ' ' + sourceLabel(item.source) + ' declined the download (HTTP ' +
            notice.status + ') — retrying in ' + formatDuration(notice.waitMs) + c.dim +
            '  (waiting up to ' + formatDuration(budgetLeft) + ' more; --feed-wait 0 to skip)' + c.reset)
    }

    function bar(fraction: number): string {
        const width = 24
        const filled = Math.round(fraction * width)
        return c.cyan + '█'.repeat(filled) + c.dim + '░'.repeat(width - filled) + c.reset
    }

    function syncDone(outcomes: readonly SyncOutcome[]): void {
        clearProgress()
        for (const outcome of outcomes) {
            if (outcome.status === 'unchanged') {
                write('    ' + c.green + '✓' + c.reset + ' ' + sourceLabel(outcome.source) + c.dim + ' up to date (' + outcome.rowCount.toLocaleString() + ' advisories)' + c.reset)
                continue
            }
            if (outcome.status === 'error') {
                write('    ' + c.yellow + '!' + c.reset + ' ' + sourceLabel(outcome.source) + c.yellow + ' ' + (outcome.message ?? 'sync failed') + c.reset)
                continue
            }
            if (outcome.status === 'skipped') {
                write('    ' + c.dim + '· ' + sourceLabel(outcome.source) + ' ' + (outcome.message ?? 'skipped') + c.reset)
                continue
            }
            const verb = outcome.status === 'seeded' ? 'downloaded' : 'updated'
            write('    ' + c.green + '✓' + c.reset + ' ' + sourceLabel(outcome.source) + c.dim + ' ' + verb + ' (' + outcome.rowCount.toLocaleString() + ' advisories)' + c.reset)
        }
    }

    function sourceLabel(source: string): string {
        if (source === 'osv') return 'OSV'
        if (source === 'gemnasium') return 'GitLab gemnasium'
        return source
    }

    function scanStart(count: number): void {
        write('')
        write('  ' + c.bold + 'Scanning ' + count + ' project' + (count === 1 ? '' : 's') + c.reset)
    }

    function scanProject(project: DiscoveredProject): void {
        if (!interactive) return
        process.stderr.write(ESC + '2K\r    ' + c.dim + project.relPath + c.reset)
        progressActive = true
    }

    function scanProjectDone(result: ProjectScanResult): void {
        clearProgress()
        const total = result.findings.length
        const label = result.project.relPath === '.' ? result.project.name : result.project.relPath
        const mark = total === 0 ? c.green + '✓' + c.reset : c.yellow + '•' + c.reset
        let line = '    ' + mark + ' ' + label
        if (total > 0) line += c.dim + '  ' + total + ' finding' + (total === 1 ? '' : 's') + c.reset
        const blocked = result.outcomes.filter(function notOk(o): boolean {
            return o.status !== 'ok'
        })
        if (blocked.length > 0) {
            line += c.dim + '  (' + blocked.map(function name(o) { return o.scanner + ': ' + o.reasonCode }).join(', ') + ')' + c.reset
        }
        write(line)
    }

    // Sources that never answered, deduplicated across projects. report.ts's ProjectSummary comment says
    // "0 findings is never confused with nothing could be checked" — that was true of the document and
    // false of the terminal, which said "clean" regardless.
    function lostSourceLines(runSummary: RunSummary): string[] {
        const seen = new Map<string, string>()
        for (const project of runSummary.projects) {
            for (const entry of project.unauditable) {
                if (!isSourceUnavailableReason(entry.reasonCode)) continue
                if (seen.has(entry.scanner)) continue
                seen.set(entry.scanner, entry.errorText || entry.reasonCode)
            }
        }
        return Array.from(seen, function line([scanner, why]) {
            return sourceLabel(scanner) + c.dim + '  ' + why + c.reset
        })
    }

    function summary(runSummary: RunSummary, destination: string | null): void {
        write('')
        const lost = lostSourceLines(runSummary)
        if (runSummary.totalFindings === 0 && lost.length > 0) {
            // Deliberately not "clean". Nothing was found because nothing was consulted.
            write('  ' + c.yellow + c.bold + 'No findings — but not everything could be checked.' + c.reset)
        } else if (runSummary.totalFindings === 0) {
            write('  ' + c.green + c.bold + 'No findings.' + c.reset + c.dim + '  ' + runSummary.projects.length + ' project' + (runSummary.projects.length === 1 ? '' : 's') + ' clean.' + c.reset)
        } else {
            const parts: string[] = []
            for (const severity of SEVERITY_ORDER) {
                const count = runSummary.counts[severity]
                if (count === 0) continue
                parts.push(severityColor(severity) + c.bold + count + c.reset + ' ' + severityColor(severity) + severity + c.reset)
            }
            write('  ' + c.bold + runSummary.totalFindings + ' finding' + (runSummary.totalFindings === 1 ? '' : 's') + c.reset + '   ' + parts.join('   '))
            write('')
            // Every project with findings is listed explicitly: a total alone hides which repository in a
            // folder of twenty actually needs the work.
            for (const project of runSummary.projects) {
                if (project.findingCount === 0) continue
                const breakdown = SEVERITY_ORDER
                    .filter(function present(s): boolean {
                        return project.counts[s] > 0
                    })
                    .map(function render(s): string {
                        return severityColor(s) + project.counts[s] + ' ' + s + c.reset
                    })
                    .join(c.dim + ', ' + c.reset)
                write('    ' + project.relPath.padEnd(38).slice(0, 38) + '  ' + breakdown)
            }
        }
        if (lost.length > 0) {
            write('')
            for (const line of lost) write('    ' + c.yellow + '!' + c.reset + ' ' + line)
            if (options.failOn !== 'none') {
                // Without this the run exits 1 having just printed "No findings", which reads as a broken
                // tool rather than a gate correctly refusing to answer.
                write('    ' + c.dim + '--fail-on cannot be honoured by a scan that lost a source; exiting non-zero.' + c.reset)
            }
        }
        write('')
        if (destination) {
            write('  ' + c.bold + 'Advisory written to' + c.reset + ' ' + destination)
            write('  ' + c.dim + 'Hand it to your agent, e.g.  claude -p "$(cat ' + shortName(destination) + ')"' + c.reset)
        }
        write('')
    }

    function shortName(path: string): string {
        const parts = path.split('/')
        return parts[parts.length - 1] || path
    }

    function error(message: string): void {
        clearProgress()
        process.stderr.write('  ' + c.red + 'error' + c.reset + ' ' + message + '\n')
    }

    return {
        banner,
        discovered,
        noProjects,
        confirmSeed,
        confirmRetry,
        sourcesSwitchedOff,
        seedDeclined,
        offlineNotice,
        syncStatus,
        syncProgress,
        syncRetry,
        syncDone,
        scanStart,
        scanProject,
        scanProjectDone,
        summary,
        error
    }
}
