import { timingSafeEqual } from 'node:crypto'
import { getConfigValue } from '@sentinello/db'
import { getDb } from '@/lib/db'

// Source of truth for the MCP bearer token: the app_config value set from Settings → MCP. Returns
// null when no token is configured — in that case the endpoint is off (the route returns 404). The
// token IS the on/off switch: generate one to turn MCP on, clear it to turn MCP off.
export function getConfiguredToken(): string | null {
    const stored = getConfigValue<string>(getDb(), 'mcp_api_token')
    if (stored && stored.trim().length > 0) return stored.trim()
    return null
}

// MCP is enabled exactly when a token is configured. There is no separate enable flag — a token is
// both necessary (an open, auth-less endpoint would be a hole) and sufficient (its presence means
// the operator deliberately turned MCP on from the UI). No token ⇒ the route returns 404.
export function isMcpEnabled(): boolean {
    return getConfiguredToken() !== null
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
