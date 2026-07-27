import { afterEach, describe, expect, it, vi } from 'vitest'
import { isWebhookStrictMode, validateWebhookUrl } from './ssrf'

// This module is a security control, not a formatter: it is the only thing standing between an
// operator-supplied webhook URL and a request originating from inside the deployment's network. The
// cases below are therefore written as "must be refused", not as "returns the right shape".
//
// Almost none of this needs DNS. resolveHostAddresses short-circuits when the hostname is already an IP
// literal (isIP(host) !== 0), so an address-literal URL exercises the whole IPv4 blocklist offline. The
// IPv6 blocklist is only reachable through a resolved hostname (see the note above that describe block),
// so those cases mock node:dns/promises.

const STRICT_ENV = 'SENTINELLO_WEBHOOK_STRICT'

// Blocked in every mode: unspecified, loopback, and link-local — the last of which is what makes
// 169.254.169.254 (the AWS/GCP/Azure instance metadata endpoint) unreachable.
const ALWAYS_BLOCKED_V4 = [
    'http://0.0.0.0/hook',
    'http://0.1.2.3/hook',
    'http://127.0.0.1/hook',
    'http://127.13.37.1/hook',
    'http://169.254.0.1/hook',
    'http://169.254.169.254/latest/meta-data/'
]

// Private ranges reach internal services but not the host itself, so they are allowed by default and
// refused only once the operator opts into strict mode.
const STRICT_ONLY_BLOCKED_V4 = [
    'https://10.0.0.1/hook',
    'https://172.16.0.1/hook',
    'https://172.31.255.254/hook',
    'https://192.168.1.1/hook',
    'https://100.64.0.1/hook'
]

// Addresses as node:dns hands them back — bare, no brackets. This is the only route by which the IPv6
// blocklist runs at all.
const ALWAYS_BLOCKED_V6 = ['::1', '::', '::ffff:127.0.0.1', 'fe80::1', 'feb0::1']
const STRICT_ONLY_BLOCKED_V6 = ['fc00::1', 'fd12::1', '::ffff:10.0.0.1']

const NOT_HTTP = ['file:///etc/passwd', 'gopher://127.0.0.1/', 'ftp://example.com/x', 'javascript:alert(1)']

const STRICT_TRUTHY = ['1', 'true', 'TRUE', 'yes', 'on', '  on  ']
const STRICT_FALSY = ['', '0', 'false', 'no', 'off', 'maybe']

type LookupAnswer = Array<{ address: string; family: number }>

// Re-imports the module with node:dns/promises stubbed, so the `lookup` binding is resolved against the
// stub. Returns the freshly imported module rather than the top-level one.
async function withLookup(answer: LookupAnswer | Error) {
    vi.doMock('node:dns/promises', function stub() {
        return {
            lookup: async function lookup() {
                if (answer instanceof Error) throw answer
                return answer
            }
        }
    })
    vi.resetModules()
    return await import('./ssrf')
}

function answering(addresses: string[]): LookupAnswer {
    return addresses.map(function toAnswer(address) {
        return { address, family: address.includes(':') ? 6 : 4 }
    })
}

afterEach(function reset() {
    vi.unstubAllEnvs()
    vi.doUnmock('node:dns/promises')
    vi.resetModules()
})

describe('isWebhookStrictMode', function () {
    it.each(STRICT_TRUTHY)('treats %j as enabled', function (raw) {
        vi.stubEnv(STRICT_ENV, raw)
        expect(isWebhookStrictMode()).toBe(true)
    })

    it.each(STRICT_FALSY)('treats %j as disabled', function (raw) {
        vi.stubEnv(STRICT_ENV, raw)
        expect(isWebhookStrictMode()).toBe(false)
    })

    it('is disabled when the variable is unset', function () {
        vi.stubEnv(STRICT_ENV, undefined)
        expect(isWebhookStrictMode()).toBe(false)
    })
})

describe('validateWebhookUrl scheme handling', function () {
    it('rejects a string that is not a URL at all', async function () {
        expect(await validateWebhookUrl('not a url')).toEqual({ ok: false, reason: 'not a valid URL' })
    })

    it.each(NOT_HTTP)('rejects the non-http(s) scheme in %s', async function (url) {
        expect(await validateWebhookUrl(url)).toEqual({ ok: false, reason: 'only http(s) URLs are allowed' })
    })

    it('allows plain http to a public address by default', async function () {
        expect(await validateWebhookUrl('http://93.184.216.34/hook')).toEqual({ ok: true, url: 'http://93.184.216.34/hook' })
    })

    it('requires https in strict mode', async function () {
        vi.stubEnv(STRICT_ENV, '1')
        expect(await validateWebhookUrl('http://93.184.216.34/hook')).toEqual({ ok: false, reason: 'strict mode requires https' })
    })

    it('still allows https in strict mode', async function () {
        vi.stubEnv(STRICT_ENV, '1')
        expect(await validateWebhookUrl('https://93.184.216.34/hook')).toEqual({ ok: true, url: 'https://93.184.216.34/hook' })
    })
})

describe('validateWebhookUrl IPv4 literals', function () {
    it.each(ALWAYS_BLOCKED_V4)('refuses %s in the default mode', async function (url) {
        expect((await validateWebhookUrl(url)).ok).toBe(false)
    })

    it.each(ALWAYS_BLOCKED_V4)('refuses %s in strict mode too', async function (url) {
        vi.stubEnv(STRICT_ENV, '1')
        expect((await validateWebhookUrl(url)).ok).toBe(false)
    })

    // The single most important row in this file: the cloud instance-metadata endpoint is the classic
    // SSRF target, and it is only unreachable because 169.254.0.0/16 is blocked.
    it('names the blocked destination in the refusal reason', async function () {
        expect(await validateWebhookUrl('http://169.254.169.254/latest/meta-data/')).toEqual({
            ok: false,
            reason: 'destination 169.254.169.254 is not an allowed network'
        })
    })

    it.each(STRICT_ONLY_BLOCKED_V4)('allows %s by default', async function (url) {
        expect((await validateWebhookUrl(url)).ok).toBe(true)
    })

    it.each(STRICT_ONLY_BLOCKED_V4)('refuses %s once strict mode is on', async function (url) {
        vi.stubEnv(STRICT_ENV, '1')
        expect((await validateWebhookUrl(url)).ok).toBe(false)
    })
})

// KNOWN BUG, pinned here rather than fixed — a fix is a behaviour change to a security control and is
// Betty's call. `new URL('http://[::1]/').hostname` returns the string "[::1]" WITH the brackets, and
// isIP("[::1]") is 0, so resolveHostAddresses never takes its literal short-circuit for IPv6. It falls
// through to a DNS lookup of the literal "[::1]", which fails, and every IPv6 literal is refused with
// "could not resolve host".
//
// Two consequences: the refusal reason is misleading, and a legitimate PUBLIC IPv6 webhook cannot be
// configured at all. It fails closed, so it is not a bypass. One-line fix: strip surrounding brackets
// before the isIP check in resolveHostAddresses.
describe('validateWebhookUrl IPv6 literals (current behaviour)', function () {
    it.each([
        'http://[::1]/hook',
        'http://[::ffff:127.0.0.1]/hook',
        'http://[fe80::1]/hook',
        'http://[2606:2800:220:1:248:1893:25c8:1946]/hook'
    ])('refuses %s at the resolution step rather than the blocklist', async function (url) {
        expect(await validateWebhookUrl(url)).toEqual({ ok: false, reason: 'could not resolve host' })
    })
})

// The IPv6 blocklist only ever sees addresses that came back from node:dns, which are bare (no
// brackets) — so this is the path that actually exercises isBlockedIpv6 and the IPv4-mapped unwrapping.
describe('validateWebhookUrl hostname resolution', function () {
    it('resolves a hostname and allows a public result', async function () {
        const mod = await withLookup(answering(['93.184.216.34']))
        expect((await mod.validateWebhookUrl('https://example.com/hook')).ok).toBe(true)
    })

    it('refuses a hostname that resolves to loopback', async function () {
        const mod = await withLookup(answering(['127.0.0.1']))
        expect(await mod.validateWebhookUrl('https://localtest.me/hook')).toEqual({
            ok: false,
            reason: 'destination 127.0.0.1 is not an allowed network'
        })
    })

    // A rebinding-style record set: one public answer and one internal. Every address must clear the
    // blocklist, not just the first — otherwise the check is trivially bypassed.
    it('refuses when any one of several addresses is internal', async function () {
        const mod = await withLookup(answering(['93.184.216.34', '169.254.169.254']))
        expect(await mod.validateWebhookUrl('https://rebind.example/hook')).toEqual({
            ok: false,
            reason: 'destination 169.254.169.254 is not an allowed network'
        })
    })

    it('allows a hostname that resolves to a public IPv6 address', async function () {
        const mod = await withLookup(answering(['2606:2800:220:1:248:1893:25c8:1946']))
        expect((await mod.validateWebhookUrl('https://example.com/hook')).ok).toBe(true)
    })

    it.each(ALWAYS_BLOCKED_V6)('refuses a hostname resolving to %s in the default mode', async function (address) {
        const mod = await withLookup(answering([address]))
        expect((await mod.validateWebhookUrl('https://internal.example/hook')).ok).toBe(false)
    })

    it.each(STRICT_ONLY_BLOCKED_V6)('allows a hostname resolving to %s by default', async function (address) {
        const mod = await withLookup(answering([address]))
        expect((await mod.validateWebhookUrl('https://internal.example/hook')).ok).toBe(true)
    })

    it.each(STRICT_ONLY_BLOCKED_V6)('refuses a hostname resolving to %s in strict mode', async function (address) {
        vi.stubEnv(STRICT_ENV, '1')
        const mod = await withLookup(answering([address]))
        expect((await mod.validateWebhookUrl('https://internal.example/hook')).ok).toBe(false)
    })

    // An answer that is neither valid IPv4 nor IPv6 is treated as blocked — isBlockedAddress fails
    // closed on anything it cannot classify.
    it('refuses an address it cannot classify', async function () {
        const mod = await withLookup([{ address: 'not-an-address', family: 4 }])
        expect((await mod.validateWebhookUrl('https://weird.example/hook')).ok).toBe(false)
    })

    it('refuses when the host does not resolve', async function () {
        const mod = await withLookup([])
        expect(await mod.validateWebhookUrl('https://nx.example/hook')).toEqual({ ok: false, reason: 'could not resolve host' })
    })

    it('refuses when the lookup itself throws', async function () {
        const mod = await withLookup(new Error('ENOTFOUND'))
        expect(await mod.validateWebhookUrl('https://nx.example/hook')).toEqual({ ok: false, reason: 'could not resolve host' })
    })
})
