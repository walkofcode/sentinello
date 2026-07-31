import { expect, test } from './test-fixtures'

// Settings → MCP.
//
// The token is both the credential and the on/off switch, so this file is only half about the UI. The
// other half is the endpoint: generating a token has to make /api/mcp answer, and clearing it has to
// make /api/mcp 404 again. Asserting the page's own "live"/"off" label alone would pass just as well
// if the two had come uncoupled.

const INITIALIZE = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } }
}

async function callMcp(request: import('@playwright/test').APIRequestContext, token: string | null) {
    return await request.post('/api/mcp', {
        headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...(token ? { authorization: 'Bearer ' + token } : {})
        },
        data: INITIALIZE,
        failOnStatusCode: false
    })
}

// The generated token is shown exactly once, in a readonly input, and never round-tripped from the
// server again — so reading it out of the DOM at this moment is the only way a spec can ever hold it.
async function generateToken(page: import('@playwright/test').Page): Promise<string> {
    await page.goto('/settings/mcp')
    await page.getByRole('button', { name: 'Generate token' }).click()
    await expect(page.getByText('Copy this now — it will not be shown again.')).toBeVisible()
    const value = await page.locator('input[readonly]').nth(1).inputValue()
    expect(value).toMatch(/^[0-9a-f]{64}$/)
    return value
}

test.describe('before a token exists', function () {
    test('reports the endpoint as off and offers only Generate', async function ({ page }) {
        await page.goto('/settings/mcp')

        await expect(page.getByText('off — no token set, /api/mcp returns 404')).toBeVisible()
        await expect(page.getByRole('button', { name: 'Generate token' })).toBeVisible()
        await expect(page.getByRole('button', { name: 'Rotate token' })).toHaveCount(0)
        await expect(page.getByRole('button', { name: 'Clear token' })).toHaveCount(0)
    })

    test('the endpoint really is absent, not merely labelled so', async function ({ page, request }) {
        await page.goto('/settings/mcp')

        expect((await callMcp(request, null)).status()).toBe(404)
        expect((await callMcp(request, 'anything-at-all')).status()).toBe(404)
    })
})

test.describe('generating a token', function () {
    test('turns the endpoint on and switches the controls to rotate and clear', async function ({ page }) {
        await generateToken(page)

        await expect(page.getByText('live — endpoint is accepting requests')).toBeVisible()
        await expect(page.getByRole('button', { name: 'Rotate token' })).toBeVisible()
        await expect(page.getByRole('button', { name: 'Clear token' })).toBeVisible()
    })

    test('the generated token actually authenticates against /api/mcp', async function ({ page, request }) {
        const token = await generateToken(page)

        const ok = await callMcp(request, token)
        expect(ok.status()).toBe(200)

        // Wrong credential on a live endpoint is 401, not 404 — the two states are distinguishable,
        // which is what stops "MCP is off" and "your token is wrong" looking identical to a client.
        expect((await callMcp(request, 'not-the-token')).status()).toBe(401)
        expect((await callMcp(request, null)).status()).toBe(401)
    })

    test('rotating invalidates the previous token', async function ({ page, request }) {
        const first = await generateToken(page)
        expect((await callMcp(request, first)).status()).toBe(200)

        const revealed = page.locator('input[readonly]').nth(1)
        await page.getByRole('button', { name: 'Rotate token' }).click()
        // Waiting on the copy-once notice would not work here: it is already on screen from the
        // generate above, so the assertion passes instantly and reads the OLD value out of the input.
        // The value changing is the only signal that the rotation has landed.
        await expect(revealed).not.toHaveValue(first)
        const second = await revealed.inputValue()

        expect(second).toMatch(/^[0-9a-f]{64}$/)
        expect((await callMcp(request, second)).status()).toBe(200)
        expect((await callMcp(request, first)).status()).toBe(401)
    })

    test('does not show the token again after a reload', async function ({ page }) {
        const token = await generateToken(page)

        await page.reload()

        await expect(page.getByText('Copy this now — it will not be shown again.')).toHaveCount(0)
        await expect(page.locator('body')).not.toContainText(token)
    })
})

test.describe('clearing a token', function () {
    // Added because one click used to do this outright. It is the most destructive control in Settings
    // — every configured client breaks and the token is unrecoverable — yet removing a root and
    // removing a notification target both confirmed and this did not.
    test('asks first', async function ({ page }) {
        await generateToken(page)

        await page.getByRole('button', { name: 'Clear token' }).click()

        const dialog = page.getByRole('dialog', { name: 'Clear the MCP token?' })
        await expect(dialog).toBeVisible()
        await expect(dialog).toContainText('every configured client will lose access')
    })

    test('cancelling leaves the endpoint live', async function ({ page, request }) {
        const token = await generateToken(page)

        await page.getByRole('button', { name: 'Clear token' }).click()
        const dialog = page.getByRole('dialog', { name: 'Clear the MCP token?' })
        await dialog.getByRole('button', { name: 'Cancel' }).click()
        await expect(dialog).toBeHidden()

        await expect(page.getByText('live — endpoint is accepting requests')).toBeVisible()
        expect((await callMcp(request, token)).status()).toBe(200)
    })

    test('escape dismisses it without clearing', async function ({ page, request }) {
        const token = await generateToken(page)

        await page.getByRole('button', { name: 'Clear token' }).click()
        await expect(page.getByRole('dialog', { name: 'Clear the MCP token?' })).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(page.getByRole('dialog', { name: 'Clear the MCP token?' })).toBeHidden()

        expect((await callMcp(request, token)).status()).toBe(200)
    })

    test('confirming takes the endpoint back to 404', async function ({ page, request }) {
        const token = await generateToken(page)

        await page.getByRole('button', { name: 'Clear token' }).click()
        const dialog = page.getByRole('dialog', { name: 'Clear the MCP token?' })
        await dialog.getByRole('button', { name: 'Clear token' }).click()
        await expect(dialog).toBeHidden()

        await expect(page.getByText('off — no token set, /api/mcp returns 404')).toBeVisible()
        // 404 rather than 401: with no token the endpoint does not exist, so it does not advertise
        // itself to an unauthenticated caller.
        expect((await callMcp(request, token)).status()).toBe(404)
    })
})

test.describe('copy controls', function () {
    test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

    test('copies the server URL to the clipboard', async function ({ page }) {
        await page.goto('/settings/mcp')

        await page.getByRole('button', { name: 'Copy' }).first().click()

        await expect(page.getByText('Copied').first()).toBeVisible()
        const clipboard = await page.evaluate(function read() { return navigator.clipboard.readText() })
        expect(clipboard).toContain('/api/mcp')
    })

    test('copies the revealed token', async function ({ page }) {
        const token = await generateToken(page)

        // The second Copy on the page belongs to the revealed-token input; the first is the URL.
        await page.getByRole('button', { name: 'Copy' }).nth(1).click()

        const clipboard = await page.evaluate(function read() { return navigator.clipboard.readText() })
        expect(clipboard).toBe(token)
    })
})

test.describe('client snippets', function () {
    test('offers a snippet per supported client, carrying the live token once generated', async function ({ page }) {
        await page.goto('/settings/mcp')
        await expect(page.getByText('Replace <your-token> with your token (rotate above to reveal a fresh one).')).toBeVisible()

        const token = await generateToken(page)

        await expect(page.getByText('Snippets below include your new token. Copy the one for your client.')).toBeVisible()
        for (const client of ['Claude Code', 'Codex (~/.codex/config.toml)', 'Cursor (.cursor/mcp.json)']) {
            await expect(page.getByText(client, { exact: true })).toBeVisible()
        }
        await expect(page.locator('pre').first()).toContainText(token)
    })
})
