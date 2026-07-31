import { expect, test } from '@playwright/test'
import { E2E_PORTAL_TOKEN } from './paths'

// The optional portal login gate, against the second server (playwright.config.ts starts one with
// SENTINELLO_PORTAL_TOKEN set, because lib/portal-auth.ts reads it from process-level env).
//
// playwright.config.ts promised a spec like this for a long time before one existed. It matters
// because the gate is the only thing standing in front of endpoints that can mute findings and
// request scans, and until now it was covered by unit tests on portal-auth.ts alone — which prove the
// HMAC is correct but not that the middleware actually consults it.
//
// Every test starts from a clean context, so none of them inherits another's session.
test.describe.configure({ mode: 'parallel' })

test.describe('with a portal token configured', function () {
    test('an unauthenticated request is redirected to the login page', async function ({ page }) {
        await page.goto('/')
        expect(page.url()).toContain('/login')
        await expect(page.getByLabel('Access token')).toBeVisible()
    })

    // EXEMPT_PREFIXES in apps/web/proxy.ts. The health endpoint has to answer without auth or a
    // container orchestrator could never tell a gated portal from a dead one.
    test('the health endpoint stays reachable without a session', async function ({ request }) {
        const response = await request.get('/api/health')
        expect(response.status()).toBe(200)
    })

    test('the wrong token is rejected and does not grant a session', async function ({ page }) {
        await page.goto('/login')
        await page.getByLabel('Access token').fill('not-the-token')
        await page.getByRole('button', { name: 'Sign in' }).click()

        await expect(page.getByText('That token didn’t match. Try again.')).toBeVisible()
        // Still gated: a rejected attempt must not leave a usable cookie behind.
        await page.goto('/')
        expect(page.url()).toContain('/login')
    })

    test('the correct token admits and the session persists across navigation', async function ({ page }) {
        await page.goto('/login')
        await page.getByLabel('Access token').fill(E2E_PORTAL_TOKEN)
        await page.getByRole('button', { name: 'Sign in' }).click()

        await expect(page).toHaveURL(/\/$/)
        await page.goto('/settings/roots')
        expect(page.url()).not.toContain('/login')
    })

    // The cookie holds an HMAC of a fixed message keyed by the token, never the token itself — so an
    // attacker reading the cookie jar cannot recover the credential. Asserting the raw token is
    // absent is what keeps that property from being refactored away.
    test('the session cookie never contains the raw token', async function ({ page, context }) {
        await page.goto('/login')
        await page.getByLabel('Access token').fill(E2E_PORTAL_TOKEN)
        await page.getByRole('button', { name: 'Sign in' }).click()
        await expect(page).toHaveURL(/\/$/)

        const cookies = await context.cookies()
        expect(cookies.length).toBeGreaterThan(0)
        for (const cookie of cookies) {
            expect(cookie.value, cookie.name).not.toContain(E2E_PORTAL_TOKEN)
        }
    })

    test('signing out ends the session', async function ({ page }) {
        await page.goto('/login')
        await page.getByLabel('Access token').fill(E2E_PORTAL_TOKEN)
        await page.getByRole('button', { name: 'Sign in' }).click()
        await expect(page).toHaveURL(/\/$/)

        // The Sign out control only renders when the gate is enabled, which is itself worth pinning:
        // on an open portal it would be a control that cannot do anything.
        await page.goto('/settings/profile')
        await page.getByRole('button', { name: 'Sign out' }).click()

        await expect(page).toHaveURL(/\/login/)
        await page.goto('/')
        expect(page.url()).toContain('/login')
    })
})
