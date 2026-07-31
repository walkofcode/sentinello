import { errorAlert, expect, test } from './test-fixtures'

// Settings → Schedule.
//
// Nothing here asserts the SEEDED schedule's literal value. seed.ts anchors the start hour six hours
// from now on purpose, so the cron cannot fire mid-run, which means the stored value differs on every
// execution. Every assertion below is about a value this spec itself chose.

test.describe('the scan cadence', function () {
    test('persists an interval chosen from the five offered', async function ({ page }) {
        await page.goto('/settings/schedule')

        await page.getByRole('button', { name: '6h', exact: true }).click()
        await expect(page.getByText('Saved', { exact: true })).toBeVisible()

        await page.reload()
        // The chosen interval is the only one rendered as a filled button; the rest are outlines. There
        // is no aria-pressed on these, so the round trip through the database is the honest assertion.
        await page.getByRole('button', { name: '12h', exact: true }).click()
        await expect(page.getByText('Saved', { exact: true })).toBeVisible()
        await page.reload()
        await expect(page.getByRole('button', { name: '12h', exact: true })).toBeVisible()
    })

    test('hides the start hour and timezone at an hourly cadence', async function ({ page }) {
        await page.goto('/settings/schedule')

        // An anchor is meaningless when the job runs every hour, so the controls are not merely
        // disabled — they are absent.
        await page.getByRole('button', { name: '1h', exact: true }).click()
        await expect(page.getByRole('button', { name: 'Start at' })).toHaveCount(0)
        await expect(page.getByRole('button', { name: 'Timezone' })).toHaveCount(0)

        await page.getByRole('button', { name: '24h', exact: true }).click()
        await expect(page.getByRole('button', { name: 'Start at' })).toBeVisible()
        await expect(page.getByRole('button', { name: 'Timezone' })).toBeVisible()
    })
})

test.describe('the start hour', function () {
    test('offers all twenty-four hours and persists the chosen one', async function ({ page }) {
        await page.goto('/settings/schedule')
        await page.getByRole('button', { name: '24h', exact: true }).click()

        await page.getByRole('button', { name: 'Start at' }).click()
        await expect(page.getByRole('option', { name: '00:00' })).toBeVisible()
        await expect(page.getByRole('option', { name: '23:00' })).toBeVisible()
        await page.getByRole('option', { name: '03:00' }).click()

        await expect(page.getByText('Saved', { exact: true })).toBeVisible()
        await page.reload()
        await expect(page.getByRole('button', { name: 'Start at' })).toContainText('03:00')
    })
})

test.describe('the timezone', function () {
    // The only searchable dropdown in the app — the IANA list is far too long to scroll, so the search
    // box is the control rather than a convenience.
    test('filters a long list down to the typed zone', async function ({ page }) {
        await page.goto('/settings/schedule')
        await page.getByRole('button', { name: '24h', exact: true }).click()

        await page.getByRole('button', { name: 'Timezone' }).click()
        await page.getByRole('textbox', { name: 'Search' }).fill('Madrid')
        await page.getByRole('option', { name: 'Europe/Madrid' }).click()

        await expect(page.getByText('Saved', { exact: true })).toBeVisible()
        await page.reload()
        await expect(page.getByRole('button', { name: 'Timezone' })).toContainText('Europe/Madrid')
    })

    test('says so when the search matches nothing', async function ({ page }) {
        await page.goto('/settings/schedule')
        await page.getByRole('button', { name: '24h', exact: true }).click()

        await page.getByRole('button', { name: 'Timezone' }).click()
        await page.getByRole('textbox', { name: 'Search' }).fill('Atlantis')

        await expect(page.getByRole('option')).toHaveCount(0)
        await expect(page.getByText('No matches')).toBeVisible()
    })
})

test.describe('feedback', function () {
    test('announces saving and then saved in a live region', async function ({ page }) {
        await page.goto('/settings/schedule')

        await page.getByRole('button', { name: '3h', exact: true }).click()

        // The status region is polite rather than an alert: a successful save is exactly the kind of
        // thing that should be announced without interrupting.
        const status = page.locator('[aria-live="polite"]')
        await expect(status).toContainText('Saved')
        await expect(errorAlert(page)).toHaveCount(0)
    })
})
