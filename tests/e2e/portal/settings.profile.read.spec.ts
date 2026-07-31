import { expect, readTest as test } from './test-fixtures'

// Settings → Profile.
//
// A read spec despite every control here doing something: theme and font size are client-only
// (next-themes localStorage and a CSS custom property), and the language switch writes a COOKIE rather
// than a row. Nothing on this page touches the database, so it needs no reset and can run in parallel.
//
// Sign-out is the one exception and lives in gate.auth.spec.ts, because the button only renders when
// SENTINELLO_PORTAL_TOKEN is set — which is a different server on a different port.

test.describe('theme', function () {
    // ThemeCard gates aria-checked on a `mounted` flag, so on first paint NOTHING is checked — the
    // server cannot know which theme localStorage holds without a hydration mismatch. Every assertion
    // here has to wait that out rather than read the first frame.
    test('marks exactly one theme as chosen once mounted', async function ({ page }) {
        await page.goto('/settings/profile')

        const group = page.getByRole('radio', { name: 'Light' })
        await expect(group).toHaveAttribute('aria-checked', /true|false/)
        await expect(page.getByRole('radio', { name: 'Dark' })).toBeVisible()
    })

    test('switching theme moves the checked state', async function ({ page }) {
        await page.goto('/settings/profile')
        const dark = page.getByRole('radio', { name: 'Dark' })
        const light = page.getByRole('radio', { name: 'Light' })

        await dark.click()
        await expect(dark).toHaveAttribute('aria-checked', 'true')
        await expect(light).toHaveAttribute('aria-checked', 'false')

        await light.click()
        await expect(light).toHaveAttribute('aria-checked', 'true')
        await expect(dark).toHaveAttribute('aria-checked', 'false')
    })

    test('the choice reaches the document, not just the control', async function ({ page }) {
        await page.goto('/settings/profile')

        await page.getByRole('radio', { name: 'Dark' }).click()

        // next-themes stamps the class on <html>. Asserting it is what proves the control is wired to
        // the theme rather than merely to its own aria-checked.
        await expect(page.locator('html')).toHaveClass(/dark/)
    })
})

test.describe('font size', function () {
    test('offers four sizes and moves the checked state', async function ({ page }) {
        await page.goto('/settings/profile')

        // exact throughout: "Large" is a substring of "Extra large", so a loose match resolves to both.
        for (const size of ['Small', 'Normal', 'Large', 'Extra large']) {
            await expect(page.getByRole('radio', { name: size, exact: true })).toBeVisible()
        }

        await page.getByRole('radio', { name: 'Large', exact: true }).click()
        await expect(page.getByRole('radio', { name: 'Large', exact: true })).toHaveAttribute('aria-checked', 'true')
        await expect(page.getByRole('radio', { name: 'Normal' })).toHaveAttribute('aria-checked', 'false')
    })

    test('survives a reload, because it is stored rather than transient', async function ({ page }) {
        await page.goto('/settings/profile')

        await page.getByRole('radio', { name: 'Extra large', exact: true }).click()
        await expect(page.getByRole('radio', { name: 'Extra large', exact: true })).toHaveAttribute('aria-checked', 'true')

        await page.reload()
        await expect(page.getByRole('radio', { name: 'Extra large', exact: true })).toHaveAttribute('aria-checked', 'true')
    })
})

test.describe('language', function () {
    test('re-renders the page in the chosen language', async function ({ page }) {
        await page.goto('/settings/profile')

        await page.getByRole('button', { name: 'Language' }).click()
        await page.getByRole('option', { name: 'Español' }).click()

        // The heading is the proof: setLocale writes a cookie server-side and calls router.refresh(),
        // so the SERVER has to re-render for this to change. A purely client-side switch would leave it.
        await expect(page.getByRole('heading', { name: 'Idioma' })).toBeVisible()
    })

    test('the language outlives the page it was set on', async function ({ page }) {
        await page.goto('/settings/profile')
        await page.getByRole('button', { name: 'Language' }).click()
        await page.getByRole('option', { name: 'Español' }).click()
        await expect(page.getByRole('heading', { name: 'Idioma' })).toBeVisible()

        await page.goto('/settings/roots')

        // Cookie-backed, so it applies to every route rather than just the one that set it.
        await expect(page.getByRole('button', { name: 'Agregar raíz' })).toBeVisible()
    })
})
