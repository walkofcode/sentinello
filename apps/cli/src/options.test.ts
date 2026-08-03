import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ALL_SOURCES, applyConfigFile, explicitFlagNames, parseArgs, severityAtLeast } from './options'
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

    // `--out --` was taken literally and wrote the advisory to a file named "--" inside the scanned
    // project, which is both surprising and awkward to delete. Reported from the help text's own
    // `<file|->` notation being read as a double dash.
    it('rejects a flag-shaped value rather than treating it as a filename', function () {
        expect(errorOf(['--out', '--'])).toContain('--out expects a value')
        expect(errorOf(['--out', '--'])).toContain('"-" alone')
        expect(errorOf(['--out', '--json'])).toContain('got "--json"')
    })

    // The `=` form skips the check in valueFor, so --out validates its own value too.
    it('rejects a dash-leading path given with =', function () {
        expect(errorOf(['--out=--'])).toContain('not "--"')
    })

    it('applies the same guard to every value flag', function () {
        expect(errorOf(['--cache-dir', '--quiet'])).toContain('--cache-dir expects a value')
        expect(errorOf(['--severity', '--json'])).toContain('--severity expects a value')
        // …but only --out earns the stdout hint, since only --out has a "-" form.
        expect(errorOf(['--cache-dir', '--quiet'])).not.toContain('"-" alone')
    })

    it('still accepts the lone dash that means stdout', function () {
        expect(optionsOf(['--out', '-']).outPath).toBe('-')
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

describe('applyConfigFile', function () {
    // sentinello.config.json lets a team commit its settings once and run `sentinello` bare. The rule
    // that makes it safe is precedence: the file supplies DEFAULTS, and anything typed on the command
    // line wins. Every key below is therefore tested twice — applied, and suppressed by its own flag —
    // because a precedence bug is silent in exactly the direction that matters: the user types a flag,
    // the committed file quietly overrides it, and the scan they get is not the scan they asked for.
    //
    // Reached end to end elsewhere (run.test.ts drives main()); this covers the function directly,
    // which is the only way to exercise each key in isolation.

    let dir: string

    beforeEach(async function setup() {
        dir = await mkdtemp(join(tmpdir(), 'sentinello-config-'))
    })

    afterEach(async function teardown() {
        await rm(dir, { recursive: true, force: true })
    })

    async function writeConfig(body: unknown): Promise<void> {
        await writeFile(join(dir, 'sentinello.config.json'), typeof body === 'string' ? body : JSON.stringify(body), 'utf8')
    }

    function optionsAt(): CliOptions {
        const options = optionsOf([])
        options.rootPath = dir
        return options
    }

    async function apply(body: unknown, flags: string[] = []): Promise<{ options: CliOptions; error: string | null }> {
        await writeConfig(body)
        const options = optionsAt()
        const error = await applyConfigFile(options, new Set(flags))
        return { options, error }
    }

    describe('reading the file', function () {
        // Absent is the overwhelmingly common case and must not be an error — most projects have no
        // config file at all.
        it('returns null when there is no config file', async function () {
            const options = optionsAt()
            expect(await applyConfigFile(options, new Set())).toBeNull()
            expect(options.maxDepth).toBeNull()
        })

        it('reports invalid JSON with the parser message', async function () {
            const { error } = await apply('{not json')
            expect(error).toMatch(/^sentinello\.config\.json is not valid JSON: /)
        })

        it.each([
            ['a bare string', '"just a string"'],
            ['a number', '42'],
            ['null', 'null'],
            ['an empty array', '[]'],
            ['a populated array', '[{"depth":3}]']
        ])('rejects %s', async function (_label, body) {
            const { error } = await apply(body as string)
            expect(error).toBe('sentinello.config.json must contain an object')
        })

        it('accepts an empty object and changes nothing', async function () {
            const { options, error } = await apply({})
            expect(error).toBeNull()
            expect(options).toEqual(optionsAt())
        })

        // Read from options.rootPath, not the working directory, so `sentinello /some/other/repo`
        // picks up THAT repo's committed settings rather than the one you happen to be standing in.
        it('reads from the scan root rather than the working directory', async function () {
            await writeConfig({ depth: 2 })
            const options = optionsOf([])
            options.rootPath = join(dir, 'nowhere')
            expect(await applyConfigFile(options, new Set())).toBeNull()
            expect(options.maxDepth).toBeNull()
        })
    })

    describe('each key applies, and each yields to its own flag', function () {
        it('applies depth, including the "all" spelling', async function () {
            expect((await apply({ depth: 3 })).options.maxDepth).toBe(3)
            expect((await apply({ depth: 'all' })).options.maxDepth).toBeNull()
            // Numbers are stringified before reuse of the flag parser, so 0 must survive as 0 rather
            // than being treated as absent.
            expect((await apply({ depth: 0 })).options.maxDepth).toBe(0)
        })

        it('reports an invalid depth with the file prefix', async function () {
            const { error } = await apply({ depth: -1 })
            expect(error).toBe('sentinello.config.json: --depth expects a non-negative integer or "all"')
        })

        it('appends excludes, dropping non-strings and blanks', async function () {
            const { options } = await apply({ exclude: ['dist', '  build  ', '', '   ', 42, null, ['nested']] })
            expect(options.excludes).toEqual(['dist', 'build'])
        })

        it('ignores a non-array exclude rather than erroring', async function () {
            const { options, error } = await apply({ exclude: 'dist' })
            expect(error).toBeNull()
            expect(options.excludes).toEqual([])
        })

        it('applies sources', async function () {
            const { options } = await apply({ sources: ['osv', 'npm-audit'] })
            expect(options.sources).toEqual(['osv'])
            expect(options.includeNpmAudit).toBe(true)
        })

        it('reports an unknown source with the file prefix', async function () {
            const { error } = await apply({ sources: ['snyk'] })
            expect(error).toBe('sentinello.config.json: unknown source "snyk" (expected npm-audit, osv, or gemnasium)')
        })

        it('ignores a non-array sources', async function () {
            const { options, error } = await apply({ sources: 'osv' })
            expect(error).toBeNull()
            expect(options.sources).toEqual(ALL_SOURCES)
        })

        it('applies depType and reports an invalid one', async function () {
            expect((await apply({ depType: 'prod' })).options.depType).toBe('prod')
            expect((await apply({ depType: 'staging' })).error).toBe('sentinello.config.json: --dep-type expects all, prod, or dev')
        })

        it('ignores a non-string depType', async function () {
            const { options, error } = await apply({ depType: 3 })
            expect(error).toBeNull()
            expect(options.depType).toBe('all')
        })

        // Resolved against the config file's directory, so a committed relative path works no matter
        // where the CLI is invoked from — which is the only way a committed value can be useful.
        it('resolves a relative prompt against the scan root', async function () {
            const { options } = await apply({ prompt: 'docs/prompt.md' })
            expect(options.promptPath).toBe(resolve(dir, 'docs/prompt.md'))
        })

        it('leaves an absolute prompt alone', async function () {
            const { options } = await apply({ prompt: '/etc/prompt.md' })
            expect(options.promptPath).toBe('/etc/prompt.md')
        })

        it('ignores a non-string prompt', async function () {
            const { options } = await apply({ prompt: 42 })
            expect(options.promptPath).toBeNull()
        })

        it('applies failOn and reports an invalid one', async function () {
            expect((await apply({ failOn: 'high' })).options.failOn).toBe('high')
            expect((await apply({ failOn: 'catastrophic' })).error).toMatch(/^sentinello\.config\.json: --fail-on/)
        })

        it('ignores a non-string failOn', async function () {
            const { options } = await apply({ failOn: true })
            expect(options.failOn).toBe('none')
        })

        // out is stored verbatim rather than resolved, unlike prompt: it is where the run WRITES, and
        // resolving it against the scan root would put the report inside the repository being scanned.
        it('applies out verbatim', async function () {
            const { options } = await apply({ out: 'report.md' })
            expect(options.outPath).toBe('report.md')
        })

        it('ignores a non-string out', async function () {
            const { options } = await apply({ out: ['report.md'] })
            expect(options.outPath).toBeNull()
        })

        it.each([
            ['depth', { depth: 3 }, '--depth', function check(o: CliOptions) { expect(o.maxDepth).toBeNull() }],
            ['exclude', { exclude: ['dist'] }, '--exclude', function check(o: CliOptions) { expect(o.excludes).toEqual([]) }],
            ['sources', { sources: ['osv'] }, '--source', function check(o: CliOptions) { expect(o.sources).toEqual(ALL_SOURCES) }],
            ['depType', { depType: 'prod' }, '--dep-type', function check(o: CliOptions) { expect(o.depType).toBe('all') }],
            ['prompt', { prompt: 'p.md' }, '--prompt', function check(o: CliOptions) { expect(o.promptPath).toBeNull() }],
            ['failOn', { failOn: 'high' }, '--fail-on', function check(o: CliOptions) { expect(o.failOn).toBe('none') }],
            ['out', { out: 'r.md' }, '--out', function check(o: CliOptions) { expect(o.outPath).toBeNull() }]
        ])('leaves %s alone when its flag was typed', async function (_label, body, flag, check) {
            const { options, error } = await apply(body, [flag as string])
            expect(error).toBeNull()
            ;(check as (o: CliOptions) => void)(options)
        })

        // An invalid value behind a typed flag is not even parsed, so a committed typo cannot fail a
        // run that overrode it on the command line.
        it('does not validate a key whose flag was typed', async function () {
            const { error } = await apply({ depth: -1, sources: ['snyk'], depType: 'staging' }, ['--depth', '--source', '--dep-type'])
            expect(error).toBeNull()
        })
    })

    describe('applying several keys at once', function () {
        it('applies every recognised key in one pass', async function () {
            const { options, error } = await apply({
                depth: 4,
                exclude: ['dist', 'vendor'],
                sources: ['gemnasium'],
                depType: 'dev',
                prompt: 'p.md',
                failOn: 'moderate',
                out: 'report.md',
                unrecognised: 'ignored'
            })

            expect(error).toBeNull()
            expect(options).toMatchObject({
                maxDepth: 4,
                excludes: ['dist', 'vendor'],
                sources: ['gemnasium'],
                includeNpmAudit: false,
                depType: 'dev',
                promptPath: resolve(dir, 'p.md'),
                failOn: 'moderate',
                outPath: 'report.md'
            })
        })

        // Stops at the FIRST invalid value in declaration order rather than collecting them, so the
        // reported error names the key the reader should fix first.
        it('reports the first invalid key and stops', async function () {
            const { options, error } = await apply({ depth: -1, depType: 'staging' })
            expect(error).toContain('--depth')
            expect(options.depType).toBe('all')
        })
    })
})
