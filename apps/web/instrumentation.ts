// Next.js startup hook — runs once when the server boots. Two boot-time jobs that bridge env vars
// into app_config (the shared SQLite both web and worker read):
//   1. SENTINELLO_PORTAL_BASE_URL is authoritative when set — seed it into the DB every boot so
//      notification links and the portal use it. When unset, Settings → Advanced owns the value.
//   2. MCP is now configured entirely from Settings → MCP (the bearer token in app_config is both
//      the credential and the on/off switch); the SENTINELLO_MCP_ENABLED / SENTINELLO_MCP_API_TOKEN
//      env vars are gone. We still import a legacy env token into the DB once so MCP keeps working
//      after the upgrade instead of silently going dark.

export async function register(): Promise<void> {
    if (process.env.NEXT_RUNTIME !== 'nodejs') return
    const portalBaseUrl = (process.env.SENTINELLO_PORTAL_BASE_URL || '').trim()
    const legacyToken = (process.env.SENTINELLO_MCP_API_TOKEN || '').trim()
    const legacyEnabled = (process.env.SENTINELLO_MCP_ENABLED || '').trim().length > 0
    if (portalBaseUrl.length === 0 && legacyToken.length === 0 && !legacyEnabled) return

    // Deferred import: these pull in the SQLite singleton, which we don't want loaded in non-nodejs
    // runtimes or before this guard.
    const { getConfigValue, setConfigValue } = await import('@sentinello/db')
    const { getDb } = await import('@/lib/db')
    const db = getDb()

    if (portalBaseUrl.length > 0) {
        setConfigValue(db, 'portalBaseUrl', portalBaseUrl)
    }

    if (legacyToken.length === 0 && !legacyEnabled) return
    const existing = getConfigValue<string>(db, 'mcp_api_token')
    const hasStored = Boolean(existing && existing.trim().length > 0)
    if (legacyToken.length > 0 && !hasStored) {
        setConfigValue(db, 'mcp_api_token', legacyToken)
        console.warn('[sentinello] SENTINELLO_MCP_API_TOKEN is removed — MCP is now configured in ' +
            'Settings → MCP. Imported your env token into the database this once; remove the env var ' +
            'and manage the token from the UI going forward.')
        return
    }
    console.warn('[sentinello] SENTINELLO_MCP_ENABLED / SENTINELLO_MCP_API_TOKEN are removed and no ' +
        'longer have any effect. Generate a token under Settings → MCP to turn the /api/mcp endpoint ' +
        'on; remove these env vars.')
}
