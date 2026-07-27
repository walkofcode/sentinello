import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ALL_SOURCES, explicitFlagNames, parseArgs, severityAtLeast } from './options'
import type { CliOptions } from './options'

function optionsOf(argv: string[]): CliOptions {
    const result = parseArgs(argv)
    if (result.kind !== 'options') throw new Error('expected options, got ' + result.kind)
    return result.options
}

function errorOf(argv: string[]): string {
    const result = parseArgs(argv)
    if (result.kind !== 'error') throw new Error('expected error, got ' + result.kind)
    return result.message
}

describe('parseArgs — terminal modes', function () {
    it('returns help for --help and -h', function () {
        expect(parseArgs(['--help'])).toEqual({ kind: 'help' })
        expect(parseArgs(['-h'])).toEqual({ kind: 'help' })
    })

    // -V is capital on purpose; lowercase -v is not a version alias.
    it('returns version for --version and -V but not -v', function () {
        expect(parseArgs(['--version'])).toEqual({ kind: 'version' })
        expect(parseArgs(['-V'])).toEqual({ kind: 'version' })
        expect(errorOf(['-v'])).toBe('unknown option -v')
    })

    it('returns print-prompt', function () {
        expect(parseArgs(['--print-prompt'])).toEqual({ kind: 'print-prompt' })
    })

    it('stops parsing at the first terminal flag', function () {
        expect(parseArgs(['--help', '--totally-bogus'])).toEqual({ kind: 'help' })
    })

    // --doctor is deliberately NOT terminal, so flags after it still apply.
    it('returns doctor while still applying later flags and the positional', function () {
        const result = parseArgs(['--doctor', '--cache-dir', '/tmp/cache', '/tmp/root'])
        expect(result.kind).toBe('doctor')
        if (result.kind !== 'doctor') throw new Error('unreachable')
        expect(result.options.cacheDir).toBe('/tmp/cache')
        expect(result.options.rootPath).toBe(resolve('/tmp/root'))
    })
})

describe('parseArgs — defaults', function () {
    it('defaults to the current working directory', function () {
        expect(optionsOf([]).rootPath).toBe(process.cwd())
    })

    it('enables both advisory feeds and npm-audit by default', function () {
        const options = optionsOf([])
        expect(options.sources).toEqual(ALL_SOURCES)
        expect(options.includeNpmAudit).toBe(true)
    })

    it('defaults to an unlimited walk, no filters and no failure threshold', function () {
        const options = optionsOf([])
        expect(options.maxDepth).toBeNull()
        expect(options.excludes).toEqual([])
        expect(options.depType).toBe('all')
        expect(options.minSeverity).toBe('info')
        expect(options.failOn).toBe('none')
        expect(options.includePrompt).toBe(true)
    })

    // Mutating one result's array must not bleed into the next parse.
    it('does not share the default sources array between calls', function () {
        const first = optionsOf([])
        first.sources.push('osv')
        expect(optionsOf([]).sources).toEqual(ALL_SOURCES)
    })
})

describe('parseArgs — boolean flags', function () {
    it('sets each boolean flag', function () {
        expect(optionsOf(['--yes']).assumeYes).toBe(true)
        expect(optionsOf(['-y']).assumeYes).toBe(true)
        expect(optionsOf(['--offline']).offline).toBe(true)
        expect(optionsOf(['--json']).json).toBe(true)
        expect(optionsOf(['--no-prompt']).includePrompt).toBe(false)
        expect(optionsOf(['--no-color']).color).toBe(false)
        expect(optionsOf(['--quiet']).quiet).toBe(true)
        expect(optionsOf(['-q']).quiet).toBe(true)
        expect(optionsOf(['--verbose']).verbose).toBe(true)
    })

    // Boolean flags are matched by exact string, so the `=` form falls through to the value-flag
    // handler and is reported as unknown. Pinned as current behaviour, not endorsed as ideal.
    it('rejects the =true form of a boolean flag', function () {
        expect(errorOf(['--json=true'])).toBe('unknown option --json')
        expect(errorOf(['--offline=1'])).toBe('unknown option --offline')
        expect(errorOf(['--verbose=yes'])).toBe('unknown option --verbose')
        expect(errorOf(['--quiet=1'])).toBe('unknown option --quiet')
    })

    it('does not support bundled short flags', function () {
        expect(errorOf(['-yq'])).toBe('unknown option -yq')
    })
})

describe('parseArgs — value flags accept both syntaxes', function () {
    it('accepts --flag value and --flag=value identically', function () {
        expect(optionsOf(['--depth', '3']).maxDepth).toBe(3)
        expect(optionsOf(['--depth=3']).maxDepth).toBe(3)
        expect(optionsOf(['--severity', 'high']).minSeverity).toBe('high')
        expect(optionsOf(['--severity=high']).minSeverity).toBe('high')
    })

    it('trims whitespace around a value', function () {
        expect(optionsOf(['--dep-type=  prod  ']).depType).toBe('prod')
    })

    it('reports a value flag left dangling at the end of argv', function () {
        expect(errorOf(['--depth'])).toBe('missing value for --depth')
        expect(errorOf(['--cache-dir'])).toBe('missing value for --cache-dir')
    })
})

describe('parseArgs — --depth', function () {
    it('accepts a non-negative integer and the literal all', function () {
        expect(optionsOf(['--depth=0']).maxDepth).toBe(0)
        expect(optionsOf(['--depth=7']).maxDepth).toBe(7)
        expect(optionsOf(['--depth=all']).maxDepth).toBeNull()
    })

    it('rejects negatives, fractions and non-numbers', function () {
        const expected = '--depth expects a non-negative integer or "all"'
        expect(errorOf(['--depth=-1'])).toBe(expected)
        expect(errorOf(['--depth=3.5'])).toBe(expected)
        expect(errorOf(['--depth=abc'])).toBe(expected)
    })

    // Number('') is 0, so an empty value silently becomes the MOST restrictive walk (root only)
    // rather than an error. Pinned as current behaviour; a user who types `--depth=` by accident
    // gets a near-empty scan with no warning.
    it('treats an empty value as depth 0 rather than an error', function () {
        expect(optionsOf(['--depth=']).maxDepth).toBe(0)
        expect(optionsOf(['--depth=  ']).maxDepth).toBe(0)
    })
})

describe('parseArgs — --exclude', function () {
    it('accumulates across repeats', function () {
        expect(optionsOf(['--exclude=a', '--exclude=b']).excludes).toEqual(['a', 'b'])
    })

    it('splits a comma-separated list', function () {
        expect(optionsOf(['--exclude=a,b,c']).excludes).toEqual(['a', 'b', 'c'])
    })

    it('trims parts and drops empty ones without erroring', function () {
        expect(optionsOf(['--exclude= a , ,b ']).excludes).toEqual(['a', 'b'])
        expect(optionsOf(['--exclude=']).excludes).toEqual([])
    })
})

describe('parseArgs — --source', function () {
    it('selects a single feed and turns npm-audit off', function () {
        const options = optionsOf(['--source=osv'])
        expect(options.sources).toEqual(['osv'])
        expect(options.includeNpmAudit).toBe(false)
    })

    it('turns npm-audit on only when explicitly listed', function () {
        const options = optionsOf(['--source=npm-audit,osv'])
        expect(options.sources).toEqual(['osv'])
        expect(options.includeNpmAudit).toBe(true)
    })

    // npm-audit alone leaves no advisory-feed sources at all, which the CLI uses to skip cache sync.
    it('yields an empty feed list for npm-audit alone', function () {
        const options = optionsOf(['--source=npm-audit'])
        expect(options.sources).toEqual([])
        expect(options.includeNpmAudit).toBe(true)
    })

    // Replace, not merge — a later --source wipes the earlier one entirely.
    it('replaces rather than merges on repeat', function () {
        const options = optionsOf(['--source=osv', '--source=gemnasium'])
        expect(options.sources).toEqual(['gemnasium'])
    })

    it('rejects an empty list and an unknown source', function () {
        expect(errorOf(['--source='])).toBe('--source expects at least one source')
        expect(errorOf(['--source=,,'])).toBe('--source expects at least one source')
        expect(errorOf(['--source=snyk'])).toBe('unknown source "snyk" (expected npm-audit, osv, or gemnasium)')
    })
})

describe('parseArgs — --dep-type, --severity, --fail-on', function () {
    it('accepts the valid values', function () {
        expect(optionsOf(['--dep-type=prod']).depType).toBe('prod')
        expect(optionsOf(['--dep-type=dev']).depType).toBe('dev')
        expect(optionsOf(['--severity=critical']).minSeverity).toBe('critical')
        expect(optionsOf(['--fail-on=any']).failOn).toBe('any')
        expect(optionsOf(['--fail-on=none']).failOn).toBe('none')
        expect(optionsOf(['--fail-on=high']).failOn).toBe('high')
    })

    it('rejects invalid values with the documented message', function () {
        expect(errorOf(['--dep-type=production'])).toBe('--dep-type expects all, prod, or dev')
        expect(errorOf(['--severity=urgent'])).toBe('--severity expects one of critical, high, moderate, low, info')
        expect(errorOf(['--fail-on=urgent'])).toBe('--fail-on expects a severity, "any", or "none"')
    })
})

describe('parseArgs — --prompt and --out', function () {
    it('resolves a prompt path to absolute', function () {
        expect(optionsOf(['--prompt=./p.md']).promptPath).toBe(resolve('./p.md'))
    })

    // 'none' disables the prompt rather than naming a file called none.
    it('treats --prompt none as disabling the prompt', function () {
        const options = optionsOf(['--prompt=none'])
        expect(options.includePrompt).toBe(false)
        expect(options.promptPath).toBeNull()
    })

    // --out is stored raw; the destination is resolved later against rootPath, and '-' means stdout.
    it('stores --out unresolved', function () {
        expect(optionsOf(['--out=report.md']).outPath).toBe('report.md')
        expect(optionsOf(['--out=-']).outPath).toBe('-')
    })
})

describe('parseArgs — positional argument', function () {
    it('resolves the positional to an absolute root path', function () {
        expect(optionsOf(['/tmp/somewhere']).rootPath).toBe(resolve('/tmp/somewhere'))
    })

    // The positional is applied after the loop, so flag order does not matter.
    it('accepts the positional before or after flags', function () {
        expect(optionsOf(['--json', '/tmp/x']).rootPath).toBe(optionsOf(['/tmp/x', '--json']).rootPath)
    })

    it('rejects a second positional', function () {
        expect(errorOf(['/tmp/a', '/tmp/b'])).toBe('unexpected extra argument /tmp/b')
    })
})

describe('parseArgs — unknown options', function () {
    it('reports an unknown long flag', function () {
        expect(errorOf(['--nope'])).toBe('unknown option --nope')
    })

    it('reports an unknown long flag given in = form', function () {
        expect(errorOf(['--nope=1'])).toBe('unknown option --nope')
    })

    it('reports an unknown short flag', function () {
        expect(errorOf(['-z'])).toBe('unknown option -z')
    })
})

describe('explicitFlagNames', function () {
    it('collects long flag names in both syntaxes', function () {
        expect(explicitFlagNames(['--depth', '3', '--json'])).toEqual(new Set(['--depth', '--json']))
        expect(explicitFlagNames(['--depth=3'])).toEqual(new Set(['--depth']))
    })

    it('ignores short flags and positionals', function () {
        expect(explicitFlagNames(['-y', '/tmp/x'])).toEqual(new Set())
    })

    // It scans every argv element, including values, so a value that looks like a flag is recorded
    // as explicitly typed. This suppresses the config file for a flag the user never actually set.
    it('also records a flag-shaped VALUE as explicit', function () {
        expect(explicitFlagNames(['--exclude', '--depth'])).toEqual(new Set(['--exclude', '--depth']))
    })
})

describe('severityAtLeast', function () {
    it('is true when the value is at least as severe as the floor', function () {
        expect(severityAtLeast('critical', 'low')).toBe(true)
        expect(severityAtLeast('low', 'low')).toBe(true)
    })

    it('is false when the value is less severe than the floor', function () {
        expect(severityAtLeast('low', 'critical')).toBe(false)
        expect(severityAtLeast('info', 'moderate')).toBe(false)
    })
})
