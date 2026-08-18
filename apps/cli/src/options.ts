import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { errText, type Severity } from '@sentinello/core'
import type { SourceId } from './cache/meta'

// Argument parsing and configuration resolution.
//
// Precedence is flags > project config > defaults. Everything is a flag; the optional
// sentinello.config.json exists so a team can commit its settings once and run `sentinello` bare.

export type DepTypeFilter = 'all' | 'prod' | 'dev'
export type FailOn = 'none' | Severity | 'any'

export const ALL_SOURCES: SourceId[] = ['osv', 'gemnasium']

export type CliOptions = {
    rootPath: string
    maxDepth: number | null
    excludes: string[]
    sources: SourceId[]
    includeNpmAudit: boolean
    depType: DepTypeFilter
    minSeverity: Severity
    promptPath: string | null
    includePrompt: boolean
    outPath: string | null
    json: boolean
    failOn: FailOn
    assumeYes: boolean
    offline: boolean
    cacheDir: string | null
    // Seconds to keep waiting out a feed that answers with a slow-transient rejection. null uses the
    // feeds-layer default; 0 fails on the first one.
    feedWaitSeconds: number | null
    color: boolean
    quiet: boolean
    verbose: boolean
}

export type ParseResult =
    | { kind: 'options'; options: CliOptions }
    // Terminal modes that print something and exit without scanning.
    | { kind: 'help' }
    | { kind: 'version' }
    | { kind: 'print-prompt' }
    | { kind: 'doctor'; options: CliOptions }
    | { kind: 'error'; message: string }

// Presentation order for --severity's help text and the membership check behind isSeverity. NOT a
// rank table: comparing severities goes through meetsSeverityFloor / severityWeight in core, which is
// the one place that decides which of two grades is worse.
const SEVERITIES: Severity[] = ['critical', 'high', 'moderate', 'low', 'info']

function defaults(): CliOptions {
    return {
        rootPath: process.cwd(),
        // Unlimited, matching the portal. Descent still stops at the first directory holding a manifest,
        // so this walks between projects rather than through them.
        maxDepth: null,
        excludes: [],
        sources: ALL_SOURCES.slice(),
        includeNpmAudit: true,
        depType: 'all',
        minSeverity: 'info',
        promptPath: null,
        includePrompt: true,
        outPath: null,
        json: false,
        failOn: 'none',
        feedWaitSeconds: null,
        assumeYes: false,
        offline: false,
        cacheDir: null,
        // NO_COLOR is honoured as an opt-out, and a non-TTY stdout gets no escapes either way.
        color: !process.env.NO_COLOR && process.stdout.isTTY === true,
        quiet: false,
        verbose: false
    }
}

export function parseArgs(argv: readonly string[]): ParseResult {
    const options = defaults()
    let positional: string | null = null
    let doctor = false
    let i = 0
    while (i < argv.length) {
        const arg = argv[i]!
        i++
        if (arg === '--help' || arg === '-h') return { kind: 'help' }
        if (arg === '--version' || arg === '-V') return { kind: 'version' }
        if (arg === '--print-prompt') return { kind: 'print-prompt' }
        if (arg === '--yes' || arg === '-y') {
            options.assumeYes = true
            continue
        }
        if (arg === '--offline') {
            options.offline = true
            continue
        }
        if (arg === '--json') {
            options.json = true
            continue
        }
        if (arg === '--no-prompt') {
            options.includePrompt = false
            continue
        }
        if (arg === '--no-color') {
            options.color = false
            continue
        }
        if (arg === '--quiet' || arg === '-q') {
            options.quiet = true
            continue
        }
        if (arg === '--verbose') {
            options.verbose = true
            continue
        }
        if (arg === '--doctor') {
            // Recorded as a mode rather than returned here, so flags after it (--cache-dir, a positional
            // path) are still parsed and applied.
            doctor = true
            continue
        }
        const value = valueFor(arg, argv, i)
        if (value.kind === 'missing') return { kind: 'error', message: 'missing value for ' + arg }
        if (value.kind === 'flaglike') {
            const hint = arg === '--out' ? ' (use "-" alone to write the advisory to stdout)' : ''
            return { kind: 'error', message: arg + ' expects a value, but got "' + value.taken + '"' + hint }
        }
        if (value.kind === 'none') {
            if (arg.startsWith('-')) return { kind: 'error', message: 'unknown option ' + arg }
            if (positional !== null) return { kind: 'error', message: 'unexpected extra argument ' + arg }
            positional = arg
            continue
        }
        if (value.consumed) i++
        const applied = applyValueFlag(options, value.name, value.value)
        if (applied) return { kind: 'error', message: applied }
    }
    if (positional !== null) options.rootPath = resolve(positional)
    if (doctor) return { kind: 'doctor', options }
    return { kind: 'options', options }
}

type FlagValue =
    | { kind: 'none' }
    | { kind: 'missing' }
    | { kind: 'flaglike'; taken: string }
    | { kind: 'value'; name: string; value: string; consumed: boolean }

// Supports both `--flag value` and `--flag=value`.
function valueFor(arg: string, argv: readonly string[], nextIndex: number): FlagValue {
    if (!arg.startsWith('--')) return { kind: 'none' }
    const eq = arg.indexOf('=')
    if (eq !== -1) {
        return { kind: 'value', name: arg.slice(0, eq), value: arg.slice(eq + 1), consumed: false }
    }
    if (!VALUE_FLAGS.has(arg)) return { kind: 'none' }
    const next = argv[nextIndex]
    if (next === undefined) return { kind: 'missing' }
    // A following token that looks like a flag is a typo, not a value. `--out --` used to be taken
    // literally and wrote an advisory to a file named "--" inside the scanned project — a name most
    // shells will not delete without being argued with. The lone "-" stays valid: it means stdout.
    if (next !== '-' && next.startsWith('-')) return { kind: 'flaglike', taken: next }
    return { kind: 'value', name: arg, value: next, consumed: true }
}

const VALUE_FLAGS = new Set([
    '--depth',
    '--exclude',
    '--source',
    '--dep-type',
    '--severity',
    '--prompt',
    '--out',
    '--fail-on',
    '--cache-dir',
    '--feed-wait'
])

// Returns an error message, or null on success.
function applyValueFlag(options: CliOptions, name: string, raw: string): string | null {
    const value = raw.trim()
    if (name === '--depth') {
        if (value === 'all') {
            options.maxDepth = null
            return null
        }
        const parsed = Number(value)
        if (!Number.isInteger(parsed) || parsed < 0) return '--depth expects a non-negative integer or "all"'
        options.maxDepth = parsed
        return null
    }
    if (name === '--exclude') {
        // Repeatable, and also accepts a comma-separated list.
        for (const part of value.split(',')) {
            const trimmed = part.trim()
            if (trimmed.length > 0) options.excludes.push(trimmed)
        }
        return null
    }
    if (name === '--source') {
        const requested = value.split(',').map(function trim(s) { return s.trim() }).filter(function nonEmpty(s) { return s.length > 0 })
        if (requested.length === 0) return '--source expects at least one source'
        const sources: SourceId[] = []
        let includeNpmAudit = false
        for (const source of requested) {
            if (source === 'npm-audit') {
                includeNpmAudit = true
                continue
            }
            if (source === 'osv' || source === 'gemnasium') {
                sources.push(source)
                continue
            }
            return 'unknown source "' + source + '" (expected npm-audit, osv, or gemnasium)'
        }
        options.sources = sources
        options.includeNpmAudit = includeNpmAudit
        return null
    }
    if (name === '--dep-type') {
        if (value !== 'all' && value !== 'prod' && value !== 'dev') return '--dep-type expects all, prod, or dev'
        options.depType = value
        return null
    }
    if (name === '--severity') {
        if (!isSeverity(value)) return '--severity expects one of ' + SEVERITIES.join(', ')
        options.minSeverity = value
        return null
    }
    if (name === '--prompt') {
        if (value === 'none') {
            options.includePrompt = false
            return null
        }
        options.promptPath = resolve(value)
        return null
    }
    if (name === '--out') {
        // Also reached via `--out=--`, which skips the flag-shaped check in valueFor. A path beginning
        // with a dash is a mistake in every case worth supporting; "-" alone means stdout.
        if (value !== '-' && value.startsWith('-')) {
            return '--out expects a file path or "-" for stdout, not "' + value + '"'
        }
        options.outPath = value
        return null
    }
    if (name === '--fail-on') {
        if (value === 'any') {
            options.failOn = 'any'
            return null
        }
        if (value === 'none') {
            options.failOn = 'none'
            return null
        }
        if (!isSeverity(value)) return '--fail-on expects a severity, "any", or "none"'
        options.failOn = value
        return null
    }
    if (name === '--cache-dir') {
        options.cacheDir = value
        return null
    }
    if (name === '--feed-wait') {
        const parsed = Number(value)
        if (!Number.isFinite(parsed) || parsed < 0) return '--feed-wait expects a non-negative number of seconds'
        options.feedWaitSeconds = parsed
        return null
    }
    return 'unknown option ' + name
}

function isSeverity(value: string): value is Severity {
    return (SEVERITIES as string[]).includes(value)
}

type FileConfig = {
    depth?: number | 'all'
    exclude?: string[]
    sources?: string[]
    depType?: string
    prompt?: string
    failOn?: string
    out?: string
    feedWait?: number
}

// Reads sentinello.config.json from the scan root, if present. Flags always win: the file supplies
// defaults for a team that wants `sentinello` to behave a certain way without typing flags, not a way to
// override what someone explicitly asked for on the command line.
export async function applyConfigFile(options: CliOptions, explicitFlags: ReadonlySet<string>): Promise<string | null> {
    let text: string
    try {
        text = await readFile(join(options.rootPath, 'sentinello.config.json'), 'utf8')
    } catch {
        return null
    }
    let parsed: unknown
    try {
        parsed = JSON.parse(text)
    } catch (err) {
        return 'sentinello.config.json is not valid JSON: ' + errText(err)
    }
    // Array.isArray is not redundant with the typeof check — `typeof [] === 'object'`, so without it a
    // JSON array is accepted as a config. It carries none of the recognised keys, so every setting
    // silently falls back to its default rather than reporting the file the team actually committed.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'sentinello.config.json must contain an object'
    const config = parsed as FileConfig
    if (config.depth !== undefined && !explicitFlags.has('--depth')) {
        const error = applyValueFlag(options, '--depth', String(config.depth))
        if (error) return 'sentinello.config.json: ' + error
    }
    if (Array.isArray(config.exclude) && !explicitFlags.has('--exclude')) {
        for (const pattern of config.exclude) {
            if (typeof pattern === 'string' && pattern.trim().length > 0) options.excludes.push(pattern.trim())
        }
    }
    if (Array.isArray(config.sources) && !explicitFlags.has('--source')) {
        const error = applyValueFlag(options, '--source', config.sources.join(','))
        if (error) return 'sentinello.config.json: ' + error
    }
    if (typeof config.depType === 'string' && !explicitFlags.has('--dep-type')) {
        const error = applyValueFlag(options, '--dep-type', config.depType)
        if (error) return 'sentinello.config.json: ' + error
    }
    if (typeof config.prompt === 'string' && !explicitFlags.has('--prompt')) {
        // Resolved against the config file's directory, so a committed relative path works from anywhere.
        options.promptPath = resolve(options.rootPath, config.prompt)
    }
    if (typeof config.failOn === 'string' && !explicitFlags.has('--fail-on')) {
        const error = applyValueFlag(options, '--fail-on', config.failOn)
        if (error) return 'sentinello.config.json: ' + error
    }
    if (typeof config.out === 'string' && !explicitFlags.has('--out')) {
        options.outPath = config.out
    }
    if (typeof config.feedWait === 'number' && !explicitFlags.has('--feed-wait')) {
        const error = applyValueFlag(options, '--feed-wait', String(config.feedWait))
        if (error) return 'sentinello.config.json: ' + error
    }
    return null
}

// The flags actually typed, so config-file values never overwrite an explicit choice.
export function explicitFlagNames(argv: readonly string[]): Set<string> {
    const out = new Set<string>()
    for (const arg of argv) {
        if (!arg.startsWith('--')) continue
        const eq = arg.indexOf('=')
        out.add(eq === -1 ? arg : arg.slice(0, eq))
    }
    return out
}
