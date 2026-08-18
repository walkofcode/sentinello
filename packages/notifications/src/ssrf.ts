// Guards webhook dispatch against SSRF. Rejects non-http(s) schemes and resolves the target host to
// block loopback / link-local / cloud-metadata (169.254.169.254) destinations. When
// SENTINELLO_WEBHOOK_STRICT is enabled it also blocks every RFC-1918 / unique-local range and
// requires https. Runs right before the request so a fresh DNS lookup narrows the rebinding window.

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

const STRICT_ENV = 'SENTINELLO_WEBHOOK_STRICT'

export type WebhookUrlValidation = { ok: true; url: string } | { ok: false; reason: string }

export function isWebhookStrictMode(): boolean {
    const raw = (process.env[STRICT_ENV] || '').trim().toLowerCase()
    return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}

export async function validateWebhookUrl(rawUrl: string): Promise<WebhookUrlValidation> {
    let parsed: URL
    try {
        parsed = new URL(rawUrl)
    } catch {
        return { ok: false, reason: 'not a valid URL' }
    }
    const strict = isWebhookStrictMode()
    const scheme = parsed.protocol.toLowerCase()
    if (scheme !== 'http:' && scheme !== 'https:') {
        return { ok: false, reason: 'only http(s) URLs are allowed' }
    }
    if (strict && scheme !== 'https:') {
        return { ok: false, reason: 'strict mode requires https' }
    }
    const addresses = await resolveHostAddresses(parsed.hostname)
    if (addresses.length === 0) {
        return { ok: false, reason: 'could not resolve host' }
    }
    for (const addr of addresses) {
        if (isBlockedAddress(addr, strict)) {
            return { ok: false, reason: 'destination ' + addr + ' is not an allowed network' }
        }
    }
    return { ok: true, url: rawUrl }
}

// No empty-host guard: the only caller passes parsed.hostname after the scheme check has restricted the
// URL to http/https, and WHATWG URL rejects an empty host outright for those schemes — `new URL('https://')`
// throws, and that throw is already caught upstream.
async function resolveHostAddresses(host: string): Promise<string[]> {
    if (isIP(host) !== 0) return [host]
    try {
        const results = await lookup(host, { all: true })
        return results.map(function pick(r) { return r.address })
    } catch {
        return []
    }
}

function isBlockedAddress(addr: string, strict: boolean): boolean {
    const family = isIP(addr)
    if (family === 4) return isBlockedIpv4(addr, strict)
    if (family === 6) return isBlockedIpv6(addr, strict)
    return true
}

// Folded rather than indexed: every caller supplies a dotted quad (isBlockedIpv4 runs only after
// isIP(addr) === 4, and inCidr's bases are literals below), so the four `parts[i] ?? 0` defaults this
// used to carry existed only to satisfy noUncheckedIndexedAccess and could never fire.
function ipv4ToInt(ip: string): number {
    return ip.split('.').reduce(function shiftIn(acc, octet) {
        return (acc * 256 + parseInt(octet, 10)) >>> 0
    }, 0)
}

function inCidr(ipInt: number, baseIp: string, maskBits: number): boolean {
    const base = ipv4ToInt(baseIp)
    // Correct across the whole 0..32 domain without a special case for /0. The obvious
    // `0xffffffff << (32 - maskBits)` is NOT: JS takes the shift count mod 32, so a /0 would shift by
    // 32, evaluate to -1, and silently behave as a /32 — inverting the block decision for that entry.
    // Computing the mask from the host-bit count has no such cliff, so the property is structural
    // rather than guarded.
    const mask = ~(2 ** (32 - maskBits) - 1) >>> 0
    return ((ipInt & mask) >>> 0) === ((base & mask) >>> 0)
}

function isBlockedIpv4(ip: string, strict: boolean): boolean {
    const n = ipv4ToInt(ip)
    if (inCidr(n, '0.0.0.0', 8)) return true
    if (inCidr(n, '127.0.0.0', 8)) return true
    if (inCidr(n, '169.254.0.0', 16)) return true
    if (strict) {
        if (inCidr(n, '10.0.0.0', 8)) return true
        if (inCidr(n, '172.16.0.0', 12)) return true
        if (inCidr(n, '192.168.0.0', 16)) return true
        if (inCidr(n, '100.64.0.0', 10)) return true
    }
    return false
}

function isBlockedIpv6(ip: string, strict: boolean): boolean {
    const addr = ip.toLowerCase()
    const mappedV4 = extractMappedV4(addr)
    if (mappedV4) return isBlockedIpv4(mappedV4, strict)
    if (addr === '::1') return true
    if (addr === '::') return true
    if (/^fe[89ab]/.test(addr)) return true
    if (strict && /^f[cd]/.test(addr)) return true
    return false
}

function extractMappedV4(addr: string): string {
    if (!addr.startsWith('::ffff:') && !addr.startsWith('::')) return ''
    const tail = addr.slice(addr.lastIndexOf(':') + 1)
    if (isIP(tail) === 4) return tail
    return ''
}
