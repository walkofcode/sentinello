// Optional portal login gate. When SENTINELLO_PORTAL_TOKEN is set, the middleware redirects
// unauthenticated requests to /login; when unset the portal behaves exactly as before (no auth).
// This module is imported by the edge middleware AND by server actions, so it stays Node-free and
// uses Web Crypto (available in both runtimes). The session cookie holds an HMAC of a fixed message
// keyed by the token — proving knowledge of the token without ever storing it raw in the cookie.

export const PORTAL_COOKIE_NAME = 'sentinello_portal'
const COOKIE_MESSAGE = 'sentinello-portal-session-v1'

export function getPortalToken(): string | null {
    const token = (process.env.SENTINELLO_PORTAL_TOKEN || '').trim()
    return token.length > 0 ? token : null
}

export function isPortalAuthEnabled(): boolean {
    return getPortalToken() !== null
}

async function hmacHex(key: string, message: string): Promise<string> {
    const enc = new TextEncoder()
    const cryptoKey = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message))
    const bytes = new Uint8Array(sig)
    let hex = ''
    for (const b of bytes) hex += b.toString(16).padStart(2, '0')
    return hex
}

export async function sessionCookieValue(token: string): Promise<string> {
    return hmacHex(token, COOKIE_MESSAGE)
}

function constantTimeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false
    let diff = 0
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
    return diff === 0
}

export async function isValidSessionCookie(cookieValue: string | undefined): Promise<boolean> {
    const token = getPortalToken()
    if (!token || !cookieValue) return false
    const expected = await sessionCookieValue(token)
    return constantTimeEqual(cookieValue, expected)
}

// Constant-time check of a submitted login token against the configured one. Both sides are run
// through HMAC with a fixed key first, so the comparison is over equal-length digests and never
// short-circuits on the raw token contents or length.
export async function tokenMatches(submitted: string): Promise<boolean> {
    const token = getPortalToken()
    if (!token) return false
    const a = await hmacHex(COOKIE_MESSAGE, submitted)
    const b = await hmacHex(COOKIE_MESSAGE, token)
    return constantTimeEqual(a, b)
}
