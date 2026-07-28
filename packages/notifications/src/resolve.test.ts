import { afterEach, describe, expect, it } from 'vitest'
import { resolveSecret } from './resolve'

// resolveSecret is what lets an operator keep a Slack webhook URL or a Telegram bot token out of the
// database entirely, storing `env:NAME` in notification_targets.config_json instead.
//
// The failure mode that matters is the unset variable. Returning the literal 'env:NAME' would send
// that string to the transport as if it were the credential — Telegram would receive a URL with
// "env:MY_TOKEN" in the path, and the operator would see an authentication error rather than a
// configuration one. Returning empty makes every sender's existing "missing credential" branch fire,
// which is the accurate diagnosis.

const VAR = 'SENTINELLO_TEST_RESOLVE_SECRET'

afterEach(function clearEnv() {
    delete process.env[VAR]
})

describe('resolveSecret', function () {
    it('passes a literal value through untouched', function () {
        expect(resolveSecret('https://hooks.example.test/incoming')).toBe('https://hooks.example.test/incoming')
    })

    it('returns an empty value unchanged', function () {
        expect(resolveSecret('')).toBe('')
    })

    it('resolves an env: reference from the environment', function () {
        process.env[VAR] = 'the-real-value'
        expect(resolveSecret('env:' + VAR)).toBe('the-real-value')
    })

    it('tolerates whitespace around the variable name', function () {
        process.env[VAR] = 'the-real-value'
        expect(resolveSecret('env:  ' + VAR + '  ')).toBe('the-real-value')
    })

    // Empty, not the literal — so the sender reports "missing credential" instead of posting the
    // string "env:NAME" to the wire and surfacing an authentication error.
    it('resolves to empty when the variable is not set', function () {
        expect(resolveSecret('env:' + VAR)).toBe('')
    })

    it('resolves to empty when the variable is set but blank', function () {
        process.env[VAR] = ''
        expect(resolveSecret('env:' + VAR)).toBe('')
    })

    // Nothing follows the prefix, so there is no variable to look up. Returning the literal keeps it
    // distinguishable from a resolved-but-empty variable.
    it('returns the literal for a bare env: with no name', function () {
        expect(resolveSecret('env:')).toBe('env:')
        expect(resolveSecret('env:   ')).toBe('env:   ')
    })

    it('only treats env: as a prefix, not as a substring', function () {
        expect(resolveSecret('https://example.test/?x=env:' + VAR)).toBe('https://example.test/?x=env:' + VAR)
    })

    it('is case sensitive about the prefix', function () {
        process.env[VAR] = 'the-real-value'
        expect(resolveSecret('ENV:' + VAR)).toBe('ENV:' + VAR)
    })
})
