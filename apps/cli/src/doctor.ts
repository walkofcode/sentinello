import { GEMNASIUM_NORMALIZER_VERSION, OSV_NORMALIZER_VERSION, DEFAULT_ECOSYSTEM } from '@sentinello/core'
import { discoverProjectsInTree } from '@sentinello/scanners'
import { advisoryFilePath, getSourceState, readCacheMeta, type SourceId } from './cache/meta'
import { cacheRowCount } from './cache/sync'
import type { CliOptions } from './options'
import { CLI_VERSION } from './help'

// `--doctor` answers the question that otherwise turns into a support thread: why did this run find
// nothing? It prints what the CLI resolved, what the cache holds, and which projects it can actually see —
// including the directories it skipped and why.

export async function runDoctor(options: CliOptions, cacheDir: string): Promise<void> {
    const lines: string[] = []
    lines.push('sentinello ' + CLI_VERSION)
    lines.push('node       ' + process.version)
    lines.push('')
    lines.push('Settings')
    lines.push('  root         ' + options.rootPath)
    lines.push('  depth        ' + (options.maxDepth === null ? 'all' : String(options.maxDepth)))
    lines.push('  excludes     ' + (options.excludes.length > 0 ? options.excludes.join(', ') : '(none)'))
    lines.push('  sources      ' + describeSources(options))
    lines.push('  dep type     ' + options.depType)
    lines.push('  min severity ' + options.minSeverity)
    lines.push('  prompt       ' + (!options.includePrompt ? '(none)' : options.promptPath ?? 'built-in'))
    lines.push('  fail-on      ' + options.failOn)
    lines.push('')
    lines.push('Advisory cache')
    lines.push('  directory    ' + cacheDir)
    const meta = await readCacheMeta(cacheDir)
    for (const source of ['osv', 'gemnasium'] as SourceId[]) {
        const expected = source === 'osv' ? OSV_NORMALIZER_VERSION : GEMNASIUM_NORMALIZER_VERSION
        const state = getSourceState(meta, source, DEFAULT_ECOSYSTEM)
        // Always count what is actually on disk. Reporting purely from metadata would say "not downloaded"
        // about a cache file that exists and is being matched against, which is precisely the kind of
        // contradiction this command exists to eliminate.
        const rows = await cacheRowCount(cacheDir, source, DEFAULT_ECOSYSTEM)
        if (!state) {
            if (rows === 0) {
                lines.push('  ' + source.padEnd(12) + 'not downloaded')
                continue
            }
            lines.push('  ' + source.padEnd(12) + rows.toLocaleString() + ' advisories on disk, but no sync metadata')
            lines.push('               ' + advisoryFilePath(cacheDir, source, DEFAULT_ECOSYSTEM))
            lines.push('               ' + 'usable with --offline; a normal run will re-download it')
            continue
        }
        const age = describeAge(state.refreshedAt)
        const stale = state.normalizerVersion !== expected
            ? '  (normalizer v' + state.normalizerVersion + ' -> v' + expected + ', will re-download)'
            : ''
        lines.push('  ' + source.padEnd(12) + rows.toLocaleString() + ' advisories, refreshed ' + age + stale)
        lines.push('               ' + advisoryFilePath(cacheDir, source, DEFAULT_ECOSYSTEM))
        if (source === 'osv' && state.cursorIso) lines.push('               cursor ' + state.cursorIso)
        if (source === 'gemnasium' && state.headSha) lines.push('               commit ' + state.headSha.slice(0, 12))
    }
    lines.push('')
    lines.push('Projects')
    const skipped: string[] = []
    const projects = discoverProjectsInTree({
        rootPath: options.rootPath,
        maxDepth: options.maxDepth,
        excludes: options.excludes,
        onSkip: function record(skip) {
            skipped.push(skip.path + '  (' + skip.source + ')')
        }
    })
    if (projects.length === 0) {
        lines.push('  (none found)')
    }
    for (const project of projects) {
        lines.push('  ' + project.relPath.padEnd(40).slice(0, 40) + ' ' + project.packageManager.padEnd(8) + project.ecosystems.join(', '))
    }
    if (skipped.length > 0) {
        lines.push('')
        lines.push('Skipped by ignore rules (' + skipped.length + ')')
        for (const entry of skipped) lines.push('  ' + entry)
    }
    lines.push('')
    process.stdout.write(lines.join('\n') + '\n')
}

function describeSources(options: CliOptions): string {
    const names: string[] = []
    if (options.includeNpmAudit) names.push('npm-audit')
    for (const source of options.sources) names.push(source)
    return names.length > 0 ? names.join(', ') : '(none)'
}

function describeAge(refreshedAt: number): string {
    const ms = Date.now() - refreshedAt
    if (ms < 60_000) return 'just now'
    const minutes = Math.floor(ms / 60_000)
    if (minutes < 60) return minutes + 'm ago'
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return hours + 'h ago'
    return Math.floor(hours / 24) + 'd ago'
}
