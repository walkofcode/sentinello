import { ECOSYSTEMS, type EcosystemId } from '@sentinello/core'
import { discoverProjectsInTree } from '@sentinello/scanners'
import { advisoryFilePath, getSourceState, readCacheMeta, type CacheMeta, type SourceId } from './cache/meta'
import { registryCacheSummary, registryFilePath } from './cache/registry'
import { cacheRowCount, normalizerVersionOf } from './cache/sync'
import { runsNpmAudit, type CliOptions } from './options'
import { detectedEcosystems } from './scan'
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
    // The walk comes first, though it is printed last: which ecosystems the cache is reported for is what
    // a run here would sync, the ecosystems the projects hold.
    const skipped: string[] = []
    const projects = discoverProjectsInTree({
        rootPath: options.rootPath,
        maxDepth: options.maxDepth,
        excludes: options.excludes,
        onSkip: function record(skip) {
            skipped.push(skip.path + '  (' + skip.source + ')')
        }
    })
    lines.push('Cache')
    lines.push('  directory    ' + cacheDir)
    const meta = await readCacheMeta(cacheDir)
    const ecosystems = reportedEcosystems(detectedEcosystems(projects), meta)
    if (ecosystems.length === 0) lines.push('  (no ecosystem detected and nothing cached)')
    for (const ecosystem of ecosystems) {
        lines.push('  ' + ecosystem)
        for (const source of ['osv', 'gemnasium'] as SourceId[]) {
            for (const line of await sourceLines(cacheDir, meta, source, ecosystem)) lines.push(line)
        }
        // The registry answers the fix check (and, for npm, the way out read): reused for 24 hours,
        // refetched after.
        const registry = await registryCacheSummary(cacheDir, ecosystem)
        if (registry === null) {
            lines.push(LABEL_INDENT + 'registry'.padEnd(LABEL_WIDTH) + 'nothing cached yet')
        } else {
            lines.push(LABEL_INDENT + 'registry'.padEnd(LABEL_WIDTH) + registry.rows.toLocaleString() + ' package' + (registry.rows === 1 ? '' : 's') + ', oldest answer ' + describeAge(registry.oldestCheckedAt))
            lines.push(DETAIL_INDENT + registryFilePath(cacheDir, ecosystem))
        }
    }
    lines.push('')
    lines.push('Projects')
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

const LABEL_INDENT = '    '
const LABEL_WIDTH = 12
const DETAIL_INDENT = LABEL_INDENT + ' '.repeat(LABEL_WIDTH)

// The ecosystems the projects hold, plus any other the cache already holds advisories for, so a cache that
// was synced from another folder is not reported as missing. Registry order.
export function reportedEcosystems(detected: readonly EcosystemId[], meta: CacheMeta): EcosystemId[] {
    return ECOSYSTEMS.map(function id(eco) { return eco.id }).filter(function shown(ecosystem) {
        if (detected.includes(ecosystem)) return true
        return getSourceState(meta, 'osv', ecosystem) !== null || getSourceState(meta, 'gemnasium', ecosystem) !== null
    })
}

async function sourceLines(cacheDir: string, meta: CacheMeta, source: SourceId, ecosystem: EcosystemId): Promise<string[]> {
    const lines: string[] = []
    const label = LABEL_INDENT + source.padEnd(LABEL_WIDTH)
    const expected = normalizerVersionOf(source, ecosystem)
    const state = getSourceState(meta, source, ecosystem)
    // Always count what is actually on disk. Reporting purely from metadata would say "not downloaded"
    // about a cache file that exists and is being matched against, which is precisely the kind of
    // contradiction this command exists to eliminate.
    const rows = await cacheRowCount(cacheDir, source, ecosystem)
    if (!state) {
        if (rows === 0) return [label + 'not downloaded']
        lines.push(label + rows.toLocaleString() + ' advisories on disk, but no sync metadata')
        lines.push(DETAIL_INDENT + advisoryFilePath(cacheDir, source, ecosystem))
        // Without metadata nothing says which normalizer wrote these rows or when, so every scan (--offline
        // included) treats the cell as not downloaded rather than match against it.
        lines.push(DETAIL_INDENT + 'not used until it is synced again: a run without --offline re-downloads it')
        return lines
    }
    const age = describeAge(state.refreshedAt)
    const stale = state.normalizerVersion !== expected
        ? '  (normalizer v' + state.normalizerVersion + ' -> v' + expected + ', will re-download)'
        : ''
    lines.push(label + rows.toLocaleString() + ' advisories, refreshed ' + age + stale)
    lines.push(DETAIL_INDENT + advisoryFilePath(cacheDir, source, ecosystem))
    if (source === 'osv' && state.cursorIso) lines.push(DETAIL_INDENT + 'cursor ' + state.cursorIso)
    if (source === 'gemnasium' && state.headSha) lines.push(DETAIL_INDENT + 'commit ' + state.headSha.slice(0, 12))
    return lines
}

function describeSources(options: CliOptions): string {
    const names: string[] = []
    if (runsNpmAudit(options)) names.push('npm-audit')
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
