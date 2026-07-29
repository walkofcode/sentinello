import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    PORTAL_COOKIE_NAME,
    getPortalToken,
    isPortalAuthEnabled,
    isValidSessionCookie,
    sessionCookieValue,
    tokenMatches
} from './portal-auth'

// The optional portal login gate. Deliberately Node-free (Web Crypto only) because it is imported by
// the edge middleware AND by server actions, and the env var is read lazily inside getPortalToken
// rather than captured at import — which is what makes vi.stubEnv a real seam here.
//
// The property worth defending is that the raw token never lands in the cookie: the cookie holds an
// HMAC of a fixed message keyed by the token, so possession of the cookie proves knowledge of the
// token without the token being recoverable from it.

const TOKEN = 'correct-horse-battery-staple'

beforeEach(function setup() {
    vi.stubEnv('SENTINELLO_PORTAL_TOKEN', TOKEN)
})

afterEach(function teardown() {
    vi.unstubAllEnvs()
})

describe('getPortalToken', function () {
    it('returns the configured token', function () {
        expect(getPortalToken()).toBe(TOKEN)
    })

    it('trims surrounding whitespace', function () {
        vi.stubEnv('SENTINELLO_PORTAL_TOKEN', '  ' + TOKEN + '  ')
        expect(getPortalToken()).toBe(TOKEN)
    })

    // Unset and blank must both mean "no auth", not "auth with an empty token" — the latter would
    // gate the portal behind a secret anyone could guess.
    it.each([
        ['unset', undefined],
        ['empty', ''],
        ['whitespace only', '   ']
    ])('returns null when the variable is %s', function (_label, value) {
        vi.stubEnv('SENTINELLO_PORTAL_TOKEN', value as string)
        expect(getPortalToken()).toBeNull()
    })

    it('is read at call time, not captured at import', function () {
        vi.stubEnv('SENTINELLO_PORTAL_TOKEN', 'changed-later')
        expect(getPortalToken()).toBe('changed-later')
    })
})

describe('isPortalAuthEnabled', function () {
    it('is on when a token is configured', function () {
        expect(isPortalAuthEnabled()).toBe(true)
    })

    it('is off when no token is configured', function () {
        vi.stubEnv('SENTINELLO_PORTAL_TOKEN', '')
        expect(isPortalAuthEnabled()).toBe(false)
    })
})

describe('sessionCookieValue', function () {
    // The whole point of the scheme.
    it('never contains the raw token', async function () {
        const cookie = await sessionCookieValue(TOKEN)
        expect(cookie).not.toContain(TOKEN)
    })

    it('is a SHA-256 HMAC rendered as 64 lowercase hex characters', async function () {
        expect(await sessionCookieValue(TOKEN)).toMatch(/^[0-9a-f]{64}$/)
    })

    it('is stable for the same token', async function () {
        expect(await sessionCookieValue(TOKEN)).toBe(await sessionCookieValue(TOKEN))
    })

    it('differs for a different token', async function () {
        expect(await sessionCookieValue(TOKEN)).not.toBe(await sessionCookieValue('other-token'))
    })
})

describe('isValidSessionCookie', function () {
    it('accepts the cookie minted for the configured token', async function () {
        expect(await isValidSessionCookie(await sessionCookieValue(TOKEN))).toBe(true)
    })

    it('rejects a cookie minted for a different token', async function () {
        expect(await isValidSessionCookie(await sessionCookieValue('other-token'))).toBe(false)
    })

    it.each([
        ['undefined', undefined],
        ['empty', ''],
        ['a wrong-length digest', 'deadbeef'],
        ['a same-length but wrong digest', 'f'.repeat(64)]
    ])('rejects %s', async function (_label, value) {
        expect(await isValidSessionCookie(value as string | undefined)).toBe(false)
    })

    // With auth off there is no session to validate, so every cookie — including a previously valid
    // one from when auth was on — must be rejected rather than trusted.
    it('rejects everything when no token is configured', async function () {
        const cookie = await sessionCookieValue(TOKEN)
        vi.stubEnv('SENTINELLO_PORTAL_TOKEN', '')
        expect(await isValidSessionCookie(cookie)).toBe(false)
    })
})

describe('tokenMatches', function () {
    it('accepts the configured token', async function () {
        expect(await tokenMatches(TOKEN)).toBe(true)
    })

    it.each([
        ['a different token of the same length', 'X'.repeat(TOKEN.length)],
        ['a token differing only in the last character', TOKEN.slice(0, -1) + 'X'],
        ['a prefix of the real token', TOKEN.slice(0, -1)],
        ['the token with trailing whitespace', TOKEN + ' '],
        ['an empty submission', '']
    ])('rejects %s', async function (_label, submitted) {
        expect(await tokenMatches(submitted as string)).toBe(false)
    })

    it('rejects everything when no token is configured', async function () {
        vi.stubEnv('SENTINELLO_PORTAL_TOKEN', '')
        expect(await tokenMatches('anything')).toBe(false)
        expect(await tokenMatches('')).toBe(false)
    })

    // sessionCookieValue HMACs (key=token, message=COOKIE_MESSAGE) while tokenMatches HMACs
    // (key=COOKIE_MESSAGE, message=submitted) — key and message swap between the two. Running both
    // sides of the login check through HMAC first is what makes the comparison equal-length, so it
    // never short-circuits on the raw token's contents or length. A refactor that "tidied" these into
    // one call would silently break that, and would also make a login token validate as a cookie.
    it('does not produce the same digest as the session cookie for the same token', async function () {
        const cookie = await sessionCookieValue(TOKEN)
        expect(await isValidSessionCookie(cookie)).toBe(true)
        // The login path and the cookie path are different HMACs, so a cookie is not a valid token
        // submission and vice versa.
        expect(await tokenMatches(cookie)).toBe(false)
    })

    it('takes the same code path for a short and a long wrong submission', async function () {
        expect(await tokenMatches('x')).toBe(false)
        expect(await tokenMatches('x'.repeat(4096))).toBe(false)
    })
})

describe('PORTAL_COOKIE_NAME', function () {
    // Shared between the middleware that reads it and the server action that sets it; a rename on one
    // side alone silently logs everyone out.
    it('is the name both sides agree on', function () {
        expect(PORTAL_COOKIE_NAME).toBe('sentinello_portal')
    })
})
