import { errorAlert, expect, fillStable, test } from './test-fixtures'
import { SEEDED } from './paths'

// Settings → Advanced.
//
// The only settings page with an explicit Save button, and until recently the only one that said
// nothing at all when you pressed it. Most assertions here read the value back after a reload rather
// than trusting the form's own state — persistence is the claim, and the form would look identical if
// the write had silently gone nowhere.

const WATCHER = 'Lockfile watcher (scan-on-change) — master switch. Worker enqueues a scan_request when a watched lockfile changes.'
const DRY_RUN = 'Dry-run notifications — log what would dispatch, never POST to external targets.'

test.describe('concurrent scans', function () {
    test('persists a value inside the permitted range', async function ({ page }) {
        await page.goto('/settings/advanced')

        await fillStable(page.getByLabel('Concurrent scans'), '8')
        await page.getByRole('button', { name: 'Save advanced settings' }).click()
        await expect(page.getByText('Saved', { exact: true })).toBeVisible()

        await page.reload()
        await expect(page.getByLabel('Concurrent scans')).toHaveValue('8')
    })

    // min/max on a native number input inside a real form means the browser refuses the submit before
    // any handler runs — no request is made, so there is nothing for the server to reject. Asserting
    // the value did NOT change is the only way to see that from outside.
    test('is blocked by the browser before it reaches the server', async function ({ page }) {
        await page.goto('/settings/advanced')
        await fillStable(page.getByLabel('Concurrent scans'), '8')
        await page.getByRole('button', { name: 'Save advanced settings' }).click()
        await expect(page.getByText('Saved', { exact: true })).toBeVisible()

        await fillStable(page.getByLabel('Concurrent scans'), '100')
        await page.getByRole('button', { name: 'Save advanced settings' }).click()

        await expect(page.getByLabel('Concurrent scans')).toHaveJSProperty('validity.valid', false)
        await page.reload()
        await expect(page.getByLabel('Concurrent scans')).toHaveValue('8')
    })

    test('accepts the boundary values', async function ({ page }) {
        await page.goto('/settings/advanced')

        for (const value of ['1', '64']) {
            await fillStable(page.getByLabel('Concurrent scans'), value)
            await page.getByRole('button', { name: 'Save advanced settings' }).click()
            await expect(page.getByText('Saved', { exact: true })).toBeVisible()
            await page.reload()
            await expect(page.getByLabel('Concurrent scans')).toHaveValue(value)
        }
        await expect(errorAlert(page)).toHaveCount(0)
    })
})

test.describe('portal base URL and notification language', function () {
    test('persists a base URL', async function ({ page }) {
        await page.goto('/settings/advanced')

        await fillStable(page.getByLabel('Portal base URL (used in notification deep links)'), 'https://sentinello.example.test')
        await page.getByRole('button', { name: 'Save advanced settings' }).click()
        await expect(page.getByText('Saved', { exact: true })).toBeVisible()

        await page.reload()
        await expect(page.getByLabel('Portal base URL (used in notification deep links)'))
            .toHaveValue('https://sentinello.example.test')
    })

    test('persists a notification language independent of the UI language', async function ({ page }) {
        await page.goto('/settings/advanced')

        await page.getByRole('button', { name: 'Notification language' }).click()
        await page.getByRole('option', { name: 'Español' }).click()
        await page.getByRole('button', { name: 'Save advanced settings' }).click()
        await expect(page.getByText('Saved', { exact: true })).toBeVisible()

        await page.reload()
        await expect(page.getByRole('button', { name: 'Notification language' })).toContainText('Español')
        // The page itself is still English: this setting is for what the worker sends, not what the
        // operator reads.
        await expect(page.getByRole('button', { name: 'Save advanced settings' })).toBeVisible()
    })
})

test.describe('global ignore patterns', function () {
    test('stores one pattern per line and drops the blanks', async function ({ page }) {
        await page.goto('/settings/advanced')

        await fillStable(page.getByLabel('Global ignore patterns (one per line)'), 'node_modules\n\n  dist  \n\n.next\n')
        await page.getByRole('button', { name: 'Save advanced settings' }).click()
        await expect(page.getByText('Saved', { exact: true })).toBeVisible()

        await page.reload()
        // Trimmed and compacted on the way in, so the round trip is the canonical form rather than
        // whatever was typed.
        await expect(page.getByLabel('Global ignore patterns (one per line)'))
            .toHaveValue('node_modules\ndist\n.next')
    })
})

test.describe('the lockfile watcher', function () {
    test('reveals the per-root opt-in only once the master switch is on', async function ({ page }) {
        await page.goto('/settings/advanced')

        await expect(page.getByText('Watched roots (opt-in per root)')).toHaveCount(0)

        await page.getByLabel(WATCHER).check()

        await expect(page.getByText('Watched roots (opt-in per root)')).toBeVisible()
        await expect(page.getByLabel(SEEDED.rootLabel)).toBeVisible()
    })

    test('warns that an empty selection watches nothing', async function ({ page }) {
        await page.goto('/settings/advanced')
        await page.getByLabel(WATCHER).check()

        // The honest phrasing of a real trap: master switch on, no roots ticked, nothing happens.
        await expect(page.getByText('An empty selection means the watcher will not run — even with the master switch on.'))
            .toBeVisible()
    })

    test('persists the master switch together with the chosen roots', async function ({ page }) {
        await page.goto('/settings/advanced')

        await page.getByLabel(WATCHER).check()
        await page.getByLabel(SEEDED.rootLabel).check()
        await page.getByRole('button', { name: 'Save advanced settings' }).click()
        await expect(page.getByText('Saved', { exact: true })).toBeVisible()

        await page.reload()
        await expect(page.getByLabel(WATCHER)).toBeChecked()
        await expect(page.getByLabel(SEEDED.rootLabel)).toBeChecked()
    })
})

test.describe('dry-run notifications', function () {
    // The seed turns this ON, and three other layers back it up, because a real worker dispatches
    // after every completed scan. This spec turns it off and back on within one reset window.
    test('is on in this environment and survives a round trip', async function ({ page }) {
        await page.goto('/settings/advanced')
        await expect(page.getByLabel(DRY_RUN)).toBeChecked()

        await page.getByLabel(DRY_RUN).uncheck()
        await page.getByRole('button', { name: 'Save advanced settings' }).click()
        await expect(page.getByText('Saved', { exact: true })).toBeVisible()
        await page.reload()
        await expect(page.getByLabel(DRY_RUN)).not.toBeChecked()

        await page.getByLabel(DRY_RUN).check()
        await page.getByRole('button', { name: 'Save advanced settings' }).click()
        await expect(page.getByText('Saved', { exact: true })).toBeVisible()
        await page.reload()
        await expect(page.getByLabel(DRY_RUN)).toBeChecked()
    })
})

test.describe('feedback', function () {
    // This page used to report success only by a button label flickering back from "Saving…", which is
    // nothing at all for anyone not watching that exact pixel — and nothing whatsoever for a screen
    // reader.
    test('confirms a save in a live region', async function ({ page }) {
        await page.goto('/settings/advanced')

        await fillStable(page.getByLabel('Concurrent scans'), '3')
        await page.getByRole('button', { name: 'Save advanced settings' }).click()

        await expect(page.locator('[aria-live="polite"]')).toContainText('Saved')
    })
})
