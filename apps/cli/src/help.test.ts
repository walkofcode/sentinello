import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// CLI_VERSION is resolved once, in an IIFE, at module load. That means the environment has to be set
// BEFORE the import — hence resetModules plus a dynamic import per case rather than a top-level one.
//
// The precedence it encodes matters at release time: tsup injects __SENTINELLO_VERSION__ into the
// published bundle, and the env var is the escape hatch for running the unbundled source (tsx has no
// define, so without a fallback `pnpm --filter sentinello dev` would report nothing at all). The
// build-time define cannot be exercised here — vitest declares no `define` for it, so under test it
// is always undefined, which is exactly the dev path the fallback exists for.

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
