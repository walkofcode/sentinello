import type { Page } from '@playwright/test'
import { errorAlert, expect, fillStable, test } from './test-fixtures'

// Settings → Advisory (the nav calls it "Advisory", the route is /settings/export).
//
// Only the prompt editor lives here. The actual Markdown export is a client-side Blob on the project
// and library detail pages — see export.advisory.read.spec.ts.

// Types into the prompt and does not return until the field holds exactly that and React has seen it.
//
// fillStable handles the hydration race — see its comment; this textarea is where it was found. The
// enabled check on top of it is specific to this form: Save is gated on `prompt !== initialPrompt`,
// so it going enabled proves React processed the change rather than merely that the DOM holds it.
async function typePrompt(page: Page, text: string): Promise<void> {
    await fillStable(page.getByLabel('Prompt body (Markdown)'), text)
    await expect(page.getByRole('button', { name: 'Save prompt' })).toBeEnabled()
}

test.describe('the prompt editor', function () {
    test('starts on the built-in default and says so', async function ({ page }) {
        await page.goto('/settings/export')

        await expect(page.getByText('Currently using:')).toContainText('default prompt')
        await expect(page.getByLabel('Prompt body (Markdown)')).not.toHaveValue('')
    })

    test('gates Save on the textarea being dirty', async function ({ page }) {
        await page.goto('/settings/export')

        await expect(page.getByRole('button', { name: 'Save prompt' })).toBeDisabled()
        // typePrompt's own wait is the assertion here: it returns only once Save has gone enabled.
        await typePrompt(page, 'Fix these before Friday.')
    })

    test('persists a custom prompt and flips the current-mode line', async function ({ page }) {
        await page.goto('/settings/export')

        await typePrompt(page, 'Fix these before Friday.')
        await page.getByRole('button', { name: 'Save prompt' }).click()

        await expect(page.getByText('Currently using:')).toContainText('custom prompt')
        await page.reload()
        await expect(page.getByLabel('Prompt body (Markdown)')).toHaveValue('Fix these before Friday.')
        await expect(page.getByText('Currently using:')).toContainText('custom prompt')
        // Dirty-gating again after a reload, because the saved value is now the baseline.
        await expect(page.getByRole('button', { name: 'Save prompt' })).toBeDisabled()
    })

    test('trims what it stores', async function ({ page }) {
        await page.goto('/settings/export')

        await typePrompt(page, '   Fix these.   ')
        await page.getByRole('button', { name: 'Save prompt' }).click()
        await expect(page.getByText('Saved', { exact: true })).toBeVisible()

        await page.reload()
        await expect(page.getByLabel('Prompt body (Markdown)')).toHaveValue('Fix these.')
    })
})

test.describe('resetting', function () {
    test('puts the default back and returns the mode line to default', async function ({ page }) {
        await page.goto('/settings/export')
        await typePrompt(page, 'Fix these before Friday.')
        await page.getByRole('button', { name: 'Save prompt' }).click()
        await expect(page.getByText('Currently using:')).toContainText('custom prompt')

        await page.getByRole('button', { name: 'Reset to default' }).click()

        await expect(page.getByText('Currently using:')).toContainText('default prompt')
        await expect(page.getByLabel('Prompt body (Markdown)')).not.toHaveValue('Fix these before Friday.')
        await page.reload()
        await expect(page.getByText('Currently using:')).toContainText('default prompt')
    })
})

test.describe('an empty prompt', function () {
    // Reachable, not theoretical: Save is gated on dirtiness, and clearing the textarea makes it dirty.
    // Before the action returned its rejection, this tore the page down into an error overlay.
    test('is rejected with a message rather than an error overlay', async function ({ page }) {
        const errors: string[] = []
        page.on('pageerror', function record(err) { errors.push(err.message) })
        await page.goto('/settings/export')

        await typePrompt(page, '   ')
        await page.getByRole('button', { name: 'Save prompt' }).click()

        await expect(errorAlert(page)).toHaveText('prompt cannot be empty')
        expect(errors).toEqual([])
    })

    test('leaves the stored prompt untouched', async function ({ page }) {
        await page.goto('/settings/export')
        await typePrompt(page, 'Fix these before Friday.')
        await page.getByRole('button', { name: 'Save prompt' }).click()
        await expect(page.getByText('Currently using:')).toContainText('custom prompt')

        await typePrompt(page, '')
        await page.getByRole('button', { name: 'Save prompt' }).click()
        await expect(errorAlert(page)).toBeVisible()

        await page.reload()
        await expect(page.getByLabel('Prompt body (Markdown)')).toHaveValue('Fix these before Friday.')
    })
})

test.describe('the prompt reaching an export', function () {
    test('is what a generated advisory is prefixed with', async function ({ page }) {
        await page.goto('/settings/export')
        await typePrompt(page, 'E2E POLICY: patch within one sprint.')
        await page.getByRole('button', { name: 'Save prompt' }).click()
        await expect(page.getByText('Currently using:')).toContainText('custom prompt')

        // The library page is the shortest route to an export that has findings in it.
        await page.goto('/libraries/npm/lodash')
        // exact, because "Mute every advisory on this library across all projects" also contains the
        // word and a substring match resolves to both.
        await page.getByRole('button', { name: 'Advisory', exact: true }).click()
        // Registered before the click, not after: the anchor is created, clicked and removed
        // synchronously, so a listener attached afterwards can miss the event entirely.
        const downloading = page.waitForEvent('download')
        await page.getByRole('menuitem', { name: 'Download .md' }).click()
        const download = await downloading

        const stream = await download.createReadStream()
        const chunks: Buffer[] = []
        for await (const chunk of stream) chunks.push(chunk as Buffer)
        expect(Buffer.concat(chunks).toString('utf8')).toContain('E2E POLICY: patch within one sprint.')
    })
})
