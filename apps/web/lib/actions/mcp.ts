'use server'

import { randomBytes } from 'node:crypto'
import { revalidatePath } from 'next/cache'
import { setConfigValue } from '@sentinello/db'
import { getDb } from '@/lib/db'

// Generates a new bearer token, persists it to app_config.mcp_api_token, and returns it so the
// caller can show it once. Plain hex string — easy to paste into Claude Desktop / Cursor config.
export async function generateMcpTokenAction(): Promise<{ token: string }> {
    const token = randomBytes(32).toString('hex')
    setConfigValue(getDb(), 'mcp_api_token', token)
    revalidatePath('/settings/advanced')
    return { token }
}

// Clears the stored token. After this the MCP endpoint refuses every request until either a new
// token is generated or SENTINELLO_MCP_API_TOKEN is set in the environment.
export async function clearMcpTokenAction(): Promise<void> {
    setConfigValue(getDb(), 'mcp_api_token', null)
    revalidatePath('/settings/advanced')
}
