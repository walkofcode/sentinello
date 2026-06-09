'use server'

import { randomBytes } from 'node:crypto'
import { revalidatePath } from 'next/cache'
import { setConfigValue } from '@sentinello/db'
import { getDb } from '@/lib/db'

// Generates a new bearer token, persists it to app_config.mcp_api_token, and returns it so the
// caller can show it once. Plain hex string — easy to paste into a client config. Saving a token is
// what turns the MCP endpoint on.
export async function generateMcpTokenAction(): Promise<{ token: string }> {
    const token = randomBytes(32).toString('hex')
    setConfigValue(getDb(), 'mcp_api_token', token)
    revalidatePath('/settings/mcp')
    return { token }
}

// Clears the stored token, turning the MCP endpoint off — it returns 404 again until a new token is
// generated.
export async function clearMcpTokenAction(): Promise<void> {
    setConfigValue(getDb(), 'mcp_api_token', null)
    revalidatePath('/settings/mcp')
}
