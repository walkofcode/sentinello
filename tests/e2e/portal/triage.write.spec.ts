import { expect, test, visible } from './test-fixtures'
import { readFixtureManifest, SEEDED } from './paths'

const FIXTURE = readFixtureManifest()
const PROJECT_ID = FIXTURE.projects[SEEDED.projectName]

// Triage mutations, driven through the UI against a real worker.
//
// Every mutation here is already covered as a server-action FUNCTION by the vitest suite. What these
// add is the seam that layer cannot reach: that the button is wired to the action, that the form
// field names match, that revalidation lands, and that the page reflects the result afterwards.

test.describe('muting a finding', function () {
    // A muted finding leaves the default view entirely — out of the table AND out of every count
    // derived from it, so the project page agrees with the dashboard, the MCP tools and the export.
    // It is withheld, never deleted: "Show muted" brings it straight back, dimmed, with its control
    // flipped to "Unmute finding". Asserting the aria-label flip rather than the styling is what makes
    // that half robust — opacity is presentation, "Unmute finding" is the contract.
    test('withholds the row, and Show muted brings it back for unmuting', async function ({ page }) {
        await page.goto('/projects/' + PROJECT_ID)

        await page.getByRole('button', { name: 'Mute finding' }).first().click()
        const dialog = page.getByRole('dialog', { name: 'Mute finding' })
        await dialog.getByLabel('Reason (required)').fill('e2e: triaged, not exploitable here')
        await dialog.getByRole('button', { name: 'Mute', exact: true }).click()
        await expect(dialog).toBeHidden()

        // Gone from the default view — this is what stops accepted risk inflating the counts.
        await expect(visible(page, 'lodash')).toHaveCount(0)

        // One click away, never hidden outright. click() rather than check(): the box is controlled by
        // server state and only flips once router.replace round-trips, exactly like the dep-type filter,
        // so check()'s immediate state assertion races the navigation. The row returning is the contract.
        const showMuted = page.getByRole('checkbox', { name: /Show muted/ })
        await showMuted.click()
        await expect(visible(page, 'lodash')).toBeVisible()
        await expect(showMuted).toBeChecked()

        const unmute = page.getByRole('button', { name: 'Unmute finding' }).first()
        await expect(unmute).toBeVisible()
        await unmute.click()
        await expect(page.getByRole('button', { name: 'Mute finding' }).first()).toBeVisible()
    })

    // The reason is what makes a mute auditable after the fact, so the control must not permit one
    // without it. This is enforced in the action too — here we prove the UI never gets that far.
    test('cannot be submitted without a reason', async function ({ page }) {
        await page.goto('/projects/' + PROJECT_ID)
        await page.getByRole('button', { name: 'Mute finding' }).first().click()
        const dialog = page.getByRole('dialog', { name: 'Mute finding' })
        const submit = dialog.getByRole('button', { name: 'Mute', exact: true })
        await expect(submit).toBeDisabled()
        // Whitespace is not a reason.
        await dialog.getByLabel('Reason (required)').fill('   ')
        await expect(submit).toBeDisabled()
        await dialog.getByLabel('Reason (required)').fill('real')
        await expect(submit).toBeEnabled()
    })
})

test.describe('muting a whole project', function () {
    // Project scope behaves differently from finding scope and the difference is the point: the
    // project VANISHES from the dashboard rather than dimming, and only "Show muted" brings it back.
    test('removes the project from the dashboard until Show muted is ticked', async function ({ page }) {
        await page.goto('/projects/' + PROJECT_ID)
        await page.getByRole('button', { name: 'Mute project' }).first().click()
        const dialog = page.getByRole('dialog', { name: 'Mute project' })
        await dialog.getByLabel('Reason (required)').fill('e2e: retired service')
        await dialog.getByRole('button', { name: 'Mute', exact: true }).click()
        await expect(dialog).toBeHidden()

        await page.goto('/')
        await expect(visible(page, SEEDED.projectName)).toHaveCount(0)

        await page.getByRole('checkbox', { name: 'Show muted' }).check()
        await expect(visible(page, SEEDED.projectName)).toBeVisible()
    })
})

test.describe('renaming and tagging a project', function () {
    test('an alias replaces the folder name on the dashboard', async function ({ page }) {
        await page.goto('/projects/' + PROJECT_ID)
        await page.getByRole('button', { name: 'Edit name' }).click()
        const dialog = page.getByRole('dialog', { name: 'Edit display name' })
        await dialog.getByLabel('Display name').fill('Checkout (e2e alias)')
        await dialog.getByRole('button', { name: 'Save' }).click()
        await expect(dialog).toBeHidden()

        await page.goto('/')
        await expect(visible(page, 'Checkout (e2e alias)')).toBeVisible()
    })

    // setProjectTagsAction revalidates /projects — a path that does not exist as a route — and not
    // '/', while the dashboard renders tag chips and a tag filter. If this test ever goes flaky on
    // the dashboard assertion, that missing revalidate is the first place to look.
    test('tags entered on the detail page reach the dashboard filter', async function ({ page }) {
        await page.goto('/projects/' + PROJECT_ID)
        await page.getByRole('button', { name: 'Edit tags' }).click()
        const dialog = page.getByRole('dialog', { name: 'Edit tags' })
        await dialog.getByLabel('Tags').fill('payments, e2e')
        await dialog.getByRole('button', { name: 'Save' }).click()
        await expect(dialog).toBeHidden()

        await page.goto('/')
        await expect(visible(page, 'payments')).toBeVisible()
    })
})
