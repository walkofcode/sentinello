import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// CLI_VERSION is resolved once, in an IIFE, at module load. That means the environment has to be set
// BEFORE the import — hence resetModules plus a dynamic import per case rather than a top-level one.
//
// The precedence it encodes matters at release time: tsup injects __SENTINELLO_VERSION__ into the
// published bundle, and the env var is the escape hatch for running the unbundled source (tsx has no
// define, so without a fallback `pnpm --filter sentinello dev` would report nothing at all).
//
// The define IS reachable here, which this file used to claim it was not. `__SENTINELLO_VERSION__` is
// only `declare`d, so the emitted code is a bare identifier that resolves through globalThis at
// runtime — vi.stubGlobal reaches it. Adding a vitest `define` would NOT be the equivalent fix: it
// would make the define arm always taken and move the hole onto the env fallback instead.

async function loadVersion(): Promise<string> {
    vi.resetModules()
    const mod = await import('./help')
    return mod.CLI_VERSION
}

beforeEach(function reset() {
    vi.unstubAllEnvs()
})

afterEach(function cleanup() {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.resetModules()
})

describe('CLI_VERSION', function () {
    it('falls back to dev when nothing names a version', async function () {
        vi.stubEnv('SENTINELLO_VERSION', undefined)
        expect(await loadVersion()).toBe('dev')
    })

    it('reads the environment override', async function () {
        vi.stubEnv('SENTINELLO_VERSION', '2.6.0')
        expect(await loadVersion()).toBe('2.6.0')
    })

    it('trims the environment override', async function () {
        vi.stubEnv('SENTINELLO_VERSION', '  2.6.0\n')
        expect(await loadVersion()).toBe('2.6.0')
    })

    // An empty or whitespace-only value is an unset variable that happens to exist — reporting it
    // verbatim would print a blank version rather than saying "dev".
    it.each(['', '   '])('treats the blank override %j as unset', async function (value) {
        vi.stubEnv('SENTINELLO_VERSION', value)
        expect(await loadVersion()).toBe('dev')
    })

    // The published path. This is what `npx sentinello --version` actually prints, and nothing else in
    // the suite runs the bundle, so without this the released binary's version line is untested.
    it('prefers the build-time define over the environment', async function () {
        vi.stubGlobal('__SENTINELLO_VERSION__', '9.9.9')
        vi.stubEnv('SENTINELLO_VERSION', '2.6.0')
        expect(await loadVersion()).toBe('9.9.9')
    })

    // tsup writes JSON.stringify(rootVersion()) into the bundle, so a release cut with no version in
    // package.json would inject an empty string rather than omit the define. Falling through to the
    // env var beats reporting a blank version.
    it('falls through to the environment when the define is blank', async function () {
        vi.stubGlobal('__SENTINELLO_VERSION__', '')
        vi.stubEnv('SENTINELLO_VERSION', '2.6.0')
        expect(await loadVersion()).toBe('2.6.0')
    })
})

describe('HELP_TEXT', function () {
    // `sentinello --help` is the whole discovery surface for a tool people reach through npx and
    // never install, so every flag the parser accepts has to appear in it.
    it('documents the usage line and the npx entry point', async function () {
        const { HELP_TEXT } = await import('./help')
        expect(HELP_TEXT).toContain('sentinello [path] [options]')
        expect(HELP_TEXT).toContain('npx sentinello')
    })

    it.each([
        '--help',
        '--version',
        '--offline',
        '--json',
        '--fail-on'
    ])('documents %s', async function (flag) {
        const { HELP_TEXT } = await import('./help')
        expect(HELP_TEXT).toContain(flag)
    })
})
