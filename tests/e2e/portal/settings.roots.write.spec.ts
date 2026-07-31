import { join } from 'node:path'
import { expect, fillStable, test, visible } from './test-fixtures'
import { E2E_FIXTURE_ROOT, SEEDED } from './paths'

// Settings → Roots.
//
// The add-root dialog browses the REAL filesystem through listDirectoryAction, so this file navigates
// the actual fixture tree rather than a stubbed one. Adding a root also enqueues a scan of it, which a
// real worker then performs — the assertions below stay on what the page shows so they do not race it.

const CLEAN_PROJECT_DIR = join(E2E_FIXTURE_ROOT, SEEDED.cleanProjectName)

// Opens the browser and does not return until its FIRST listing has landed.
//
// The dialog kicks off a listing of the home directory the moment it mounts. Typing a path and
// pressing Go before that resolves starts a second listing which the first then overwrites when it
// arrives — the dialog ends up showing the operator's home directory instead of the path they typed,
// and the failure reads as "the folder you asked for has no subdirectories".
//
// "Add this folder" is disabled while `loading || !listing`, so it going enabled is precisely the
// signal that the initial navigation has completed.
async function openBrowser(page: import('@playwright/test').Page) {
    await page.getByRole('button', { name: 'Add root' }).click()
    const dialog = page.getByRole('dialog', { name: 'Add root' })
    await expect(dialog.getByRole('button', { name: 'Add this folder' })).toBeEnabled()
    return dialog
}

// Types a path into the open browser and waits for THAT listing to be the one on screen.
async function browseTo(dialog: import('@playwright/test').Locator, path: string) {
    await fillStable(dialog.getByPlaceholder('/Users/me/code'), path)
    await dialog.getByRole('button', { name: 'Go', exact: true }).click()
    await expect(dialog.getByRole('button', { name: path.split('/').pop() as string, exact: true })).toBeVisible()
}

test.describe('the roots table', function () {
    test('lists the seeded root with its label and project count', async function ({ page }) {
        await page.goto('/settings/roots')

        await expect(visible(page, E2E_FIXTURE_ROOT)).toBeVisible()
        await expect(visible(page, SEEDED.rootLabel)).toBeVisible()
        // Four projects: the worker's boot sweep discovered every directory in the fixture tree.
        await expect(page.getByRole('cell', { name: '4', exact: true })).toBeVisible()
    })

    test('offers per-row scan, rename and remove controls', async function ({ page }) {
        await page.goto('/settings/roots')

        await expect(page.getByRole('button', { name: 'Edit label' }).first()).toBeVisible()
        await expect(page.getByRole('button', { name: 'Remove root' }).first()).toBeVisible()
        await expect(visible(page, 'Scan now')).toBeVisible()
    })
})

test.describe('renaming a root', function () {
    test('replaces the label and survives a reload', async function ({ page }) {
        await page.goto('/settings/roots')

        await page.getByRole('button', { name: 'Edit label' }).first().click()
        await fillStable(page.getByPlaceholder('Label (blank to clear)'), 'Renamed by e2e')
        await page.getByRole('button', { name: 'Save label' }).click()

        await expect(visible(page, 'Renamed by e2e')).toBeVisible()
        await page.reload()
        await expect(visible(page, 'Renamed by e2e')).toBeVisible()
    })

    test('cancelling leaves the original label in place', async function ({ page }) {
        await page.goto('/settings/roots')

        await page.getByRole('button', { name: 'Edit label' }).first().click()
        await fillStable(page.getByPlaceholder('Label (blank to clear)'), 'Never committed')
        await page.getByRole('button', { name: 'Cancel edit' }).click()

        await expect(visible(page, SEEDED.rootLabel)).toBeVisible()
        await page.reload()
        await expect(visible(page, SEEDED.rootLabel)).toBeVisible()
        await expect(page.getByText('Never committed')).toHaveCount(0)
    })

    test('an empty label clears it rather than storing a blank string', async function ({ page }) {
        await page.goto('/settings/roots')

        await page.getByRole('button', { name: 'Edit label' }).first().click()
        await fillStable(page.getByPlaceholder('Label (blank to clear)'), '')
        await page.getByRole('button', { name: 'Save label' }).click()

        await page.reload()
        await expect(page.getByText(SEEDED.rootLabel)).toHaveCount(0)
    })
})

test.describe('the add-root browser', function () {
    test('navigates to a typed path and offers to add it', async function ({ page }) {
        await page.goto('/settings/roots')
        const dialog = await openBrowser(page)
        await browseTo(dialog, CLEAN_PROJECT_DIR)

        await expect(dialog.getByRole('button', { name: 'Add this folder' })).toBeEnabled()
    })

    test('refuses a path that is already a root', async function ({ page }) {
        await page.goto('/settings/roots')
        const dialog = await openBrowser(page)
        await browseTo(dialog, E2E_FIXTURE_ROOT)

        await expect(dialog.getByText('This path is already configured as a root.')).toBeVisible()
        await expect(dialog.getByRole('button', { name: 'Add this folder' })).toBeDisabled()
    })

    test('surfaces a filesystem error rather than failing silently', async function ({ page }) {
        await page.goto('/settings/roots')
        const dialog = await openBrowser(page)
        await browseTo(dialog, join(E2E_FIXTURE_ROOT, 'no-such-directory'))

        // The raw errno message is shown deliberately — an operator typing a path needs to know whether
        // it is missing, unreadable, or not a directory.
        await expect(dialog.getByRole('button', { name: 'Add this folder' })).toBeDisabled()
    })

    test('walks up to the parent directory', async function ({ page }) {
        await page.goto('/settings/roots')
        const dialog = await openBrowser(page)
        await browseTo(dialog, CLEAN_PROJECT_DIR)
        await expect(dialog.getByRole('button', { name: 'Add this folder' })).toBeEnabled()

        await dialog.getByRole('button', { name: 'Go to parent directory' }).click()

        // The parent IS the configured root, so walking up lands on the already-added case.
        await expect(dialog.getByText('This path is already configured as a root.')).toBeVisible()
    })

    test('lists the subdirectories it finds', async function ({ page }) {
        await page.goto('/settings/roots')
        const dialog = await openBrowser(page)
        await browseTo(dialog, E2E_FIXTURE_ROOT)

        for (const name of [SEEDED.projectName, SEEDED.cleanProjectName, SEEDED.bulkProjectName]) {
            await expect(dialog.getByRole('button', { name, exact: true })).toBeVisible()
        }
    })

    test('closes on Cancel without adding anything', async function ({ page }) {
        await page.goto('/settings/roots')
        const dialog = await openBrowser(page)
        await dialog.getByRole('button', { name: 'Cancel' }).click()

        await expect(dialog).toBeHidden()
        await expect(page.getByRole('row')).toHaveCount(2)
    })
})

test.describe('adding a root', function () {
    test('adds the browsed folder and shows it in the table', async function ({ page }) {
        await page.goto('/settings/roots')
        const dialog = await openBrowser(page)
        await browseTo(dialog, CLEAN_PROJECT_DIR)
        await fillStable(dialog.getByLabel('Label (optional)'), 'Docs only')
        await dialog.getByRole('button', { name: 'Add this folder' }).click()

        await expect(dialog).toBeHidden()
        await expect(visible(page, 'Docs only')).toBeVisible()
        await expect(visible(page, CLEAN_PROJECT_DIR)).toBeVisible()
    })
})

test.describe('removing a root', function () {
    test('asks first, naming the path and what else goes with it', async function ({ page }) {
        await page.goto('/settings/roots')

        await page.getByRole('button', { name: 'Remove root' }).first().click()

        const confirm = page.getByRole('dialog', { name: 'Remove root?' })
        await expect(confirm).toBeVisible()
        await expect(confirm).toContainText(E2E_FIXTURE_ROOT)
        // The count matters: this is the sentence that tells an operator they are about to delete four
        // projects' worth of scans and findings, not just a path.
        await expect(confirm).toContainText('4 projects')
        await expect(confirm).toContainText('This cannot be undone.')
    })

    test('cancelling keeps the root', async function ({ page }) {
        await page.goto('/settings/roots')

        await page.getByRole('button', { name: 'Remove root' }).first().click()
        await page.getByRole('dialog', { name: 'Remove root?' }).getByRole('button', { name: 'Cancel' }).click()

        await expect(page.getByRole('dialog', { name: 'Remove root?' })).toBeHidden()
        await page.reload()
        await expect(visible(page, E2E_FIXTURE_ROOT)).toBeVisible()
    })

    test('confirming removes the root and everything discovered under it', async function ({ page }) {
        await page.goto('/settings/roots')

        await page.getByRole('button', { name: 'Remove root' }).first().click()
        await page.getByRole('dialog', { name: 'Remove root?' })
            .getByRole('button', { name: 'Remove root' })
            .click()

        await expect(page.getByText('No roots configured yet')).toBeVisible()
        // The cascade is the point — projects hang off roots, so the dashboard has to be empty too.
        await page.goto('/')
        await expect(visible(page, SEEDED.projectName)).toHaveCount(0)
    })
})
