import { timingSafeEqual } from 'node:crypto'
import { getConfigValue } from '@sentinello/db'
import { getDb } from '@/lib/db'

// Source of truth for the MCP bearer token. Env wins so operators can inject via Docker without
// writing to the DB; otherwise the app_config value (set from the Settings UI) is used. Returns
// null when no token is configured anywhere — in that case the route refuses all requests.
export function getConfiguredToken(): string | null {
    const env = (process.env.SENTINELLO_MCP_API_TOKEN || '').trim()
    if (env.length > 0) return env
    const stored = getConfigValue<string>(getDb(), 'mcp_api_token')
    if (stored && stored.trim().length > 0) return stored.trim()
    return null
}

// MCP is enabled by default. Operators can opt out by setting SENTINELLO_MCP_ENABLED to a falsy
// string ('0', 'false', 'no', 'off'); the route then returns 404 as if the endpoint didn't exist.
export function isMcpEnabled(): boolean {
    const raw = (process.env.SENTINELLO_MCP_ENABLED || '').trim().toLowerCase()
    if (raw.length === 0) return true
    return raw !== '0' && raw !== 'false' && raw !== 'no' && raw !== 'off'
}

function safeEqual(a: string, b: string): boolean {
    const aBuf = Buffer.from(a)
    const bBuf = Buffer.from(b)
    // timingSafeEqual requires equal-length inputs. Comparing lengths first leaks length but not
    // contents, which is the standard tradeoff for bearer-token checks.
    if (aBuf.length !== bBuf.length) return false
    return timingSafeEqual(aBuf, bBuf)
}

export type AuthResult = { ok: true } | { ok: false; status: number; body: { error: string } }

// Verifies the Authorization header against the configured token. Returns a 401 result if no token
// is set OR the header is missing/malformed/wrong — all three look the same to the client so we
// don't disclose which case applies.
export function verifyMcpAuth(req: Request): AuthResult {
    const expected = getConfiguredToken()
    if (!expected) {
        return { ok: false, status: 401, body: { error: 'MCP token not configured' } }
    }
    const header = req.headers.get('authorization') || ''
    const match = header.match(/^Bearer\s+(.+)$/i)
    if (!match) {
        return { ok: false, status: 401, body: { error: 'Missing or malformed Authorization header' } }
    }
    if (!safeEqual(match[1].trim(), expected)) {
        return { ok: false, status: 401, body: { error: 'Invalid token' } }
    }
    return { ok: true }
}
