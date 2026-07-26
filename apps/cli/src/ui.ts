import { createInterface } from 'node:readline/promises'
import type { Severity } from '@sentinello/core'
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

export function formatBytes(bytes: number | null): string {
    if (bytes === null) return 'unknown size'
    if (bytes < 1024) return bytes + ' B'
    const mib = bytes / (1024 * 1024)
    if (mib < 1) return (bytes / 1024).toFixed(0) + ' KB'
    if (mib < 1024) return mib.toFixed(1) + ' MB'
    return (mib / 1024).toFixed(2) + ' GB'
}

function formatDuration(ms: number): string {
    if (ms < 1000) return ms + 'ms'
    const seconds = ms / 1000
    if (seconds < 60) return seconds.toFixed(1) + 's'
    const minutes = Math.floor(seconds / 60)
    return minutes + 'm ' + Math.round(seconds - minutes * 60) + 's'
}

export type Ui = {
    banner(): void
    discovered(projects: readonly DiscoveredProject[], skipped: readonly DiscoverySkip[], root: string): void
    noProjects(skipped: readonly DiscoverySkip[]): void
    confirmSeed(plan: SyncPlan): Promise<boolean>
    seedDeclined(): void
    offlineNotice(): void
    syncStatus(item: SyncPlanItem, phase: 'start' | 'done'): void
    syncProgress(item: SyncPlanItem, bytesRead: number, totalBytes: number | null): void
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
            write('    ' + sourceLabel(item.source) + c.dim + '  ' + formatBytes(item.downloadBytes) + c.reset)
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

    function seedDeclined(): void {
        write('')
        write('  ' + c.dim + 'Skipped. Run again and accept, or pass --yes, to enable the advisory sources.' + c.reset)
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

    function summary(runSummary: RunSummary, destination: string | null): void {
        write('')
        if (runSummary.totalFindings === 0) {
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
        seedDeclined,
        offlineNotice,
        syncStatus,
        syncProgress,
        syncDone,
        scanStart,
        scanProject,
        scanProjectDone,
        summary,
        error
    }
}
