import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { revalidatePath } from 'next/cache'
import { getConfigValue } from '@sentinello/db'
import { closePortalTestDb, openPortalTestDb, type PortalTestDb } from '@/lib/portal-test-db.fixture'
import { isMcpEnabled } from '@/lib/mcp/auth'
import { clearMcpTokenAction, generateMcpTokenAction } from './mcp'

vi.mock('next/cache', function stubNextCache() {
    return { revalidatePath: vi.fn() }
})

let handle: PortalTestDb

beforeEach(async function setup() {
    vi.mocked(revalidatePath).mockClear()
    handle = await openPortalTestDb('mcp-action')
})

afterEach(async function teardown() {
    await closePortalTestDb(handle)
})

// The design deliberately collapses two concepts: the stored token IS the on/off switch for the MCP
// endpoint. So these two actions are not just credential management — they are the enable/disable
// control for a surface that can mute findings and request scans. Each test asserts the persisted
// token and the resulting enabled state together, because they must never disagree.
describe('generateMcpTokenAction', function () {
    it('returns a 32-byte token as 64 hex characters', async function () {
        const { token } = await generateMcpTokenAction()

        expect(token).toMatch(/^[0-9a-f]{64}$/)
    })

    it('persists the returned token so the endpoint accepts it', async function () {
        const { token } = await generateMcpTokenAction()

        expect(getConfigValue<string>(handle.db, 'mcp_api_token')).toBe(token)
    })

    it('turns the MCP endpoint on', async function () {
        expect(isMcpEnabled()).toBe(false)

        await generateMcpTokenAction()

        expect(isMcpEnabled()).toBe(true)
    })

    // Regenerating is the rotation gesture: the old token must stop working immediately, so the new
    // value has to overwrite rather than accumulate alongside it.
    it('replaces the previous token on regeneration', async function () {
        const first = await generateMcpTokenAction()
        const second = await generateMcpTokenAction()

        expect(second.token).not.toBe(first.token)
        expect(getConfigValue<string>(handle.db, 'mcp_api_token')).toBe(second.token)
    })

    it('busts the MCP settings page', async function () {
        await generateMcpTokenAction()

        expect(vi.mocked(revalidatePath).mock.calls).toEqual([['/settings/mcp']])
    })
})

describe('clearMcpTokenAction', function () {
    it('turns the endpoint off by clearing the token', async function () {
        await generateMcpTokenAction()

        await clearMcpTokenAction()

        expect(getConfigValue<string>(handle.db, 'mcp_api_token')).toBeNull()
        expect(isMcpEnabled()).toBe(false)
    })

    it('is safe to call when no token was ever set', async function () {
        await expect(clearMcpTokenAction()).resolves.toBeUndefined()
        expect(isMcpEnabled()).toBe(false)
    })

    it('busts the MCP settings page', async function () {
        await clearMcpTokenAction()

        expect(vi.mocked(revalidatePath).mock.calls).toEqual([['/settings/mcp']])
    })
})
