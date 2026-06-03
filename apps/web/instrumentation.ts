// Next.js startup hook — runs once when the server boots. Used to surface MCP misconfiguration
// loudly: enabling the endpoint without a token leaves it refusing every request, which is easy to
// miss otherwise. Kept env-only (no DB access) since this runs before the rest of the app is ready.

export async function register(): Promise<void> {
    if (process.env.NEXT_RUNTIME !== 'nodejs') return
    const raw = (process.env.SENTINELLO_MCP_ENABLED || '').trim().toLowerCase()
    const enabled = raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
    if (!enabled) return
    const hasEnvToken = (process.env.SENTINELLO_MCP_API_TOKEN || '').trim().length > 0
    if (!hasEnvToken) {
        console.warn('[sentinello] SENTINELLO_MCP_ENABLED is on but SENTINELLO_MCP_API_TOKEN is not set. ' +
            'The /api/mcp endpoint will refuse every request until a token is configured here or in Settings → MCP.')
    }
}
