import { expect, test, visible } from './test-fixtures'
import { readFixtureManifest, SEEDED } from './paths'

const FIXTURE = readFixtureManifest()
const PROJECT_ID = FIXTURE.projects[SEEDED.projectName]

// Settings → Defaults.
//
// The page has no Save button — every control persists on change — and its action revalidates '/' as
// well as its own route. That second path is the whole point of the feature and the last block here
// is what proves it: a default set on this page has to change what the dashboard renders with no
// filter in the URL at all.

test.describe('the default dependency view', function () {
    // These were three plain buttons whose selection lived only in a border colour. As a radiogroup
    // the state is readable by assistive tech and assertable here without touching a Tailwind class.
    test('exposes the three options as a radiogroup with exactly one checked', async function ({ page }) {
        await page.goto('/settings/defaults')

        const group = page.getByRole('radiogroup', { name: 'Default dependency view' })
        await expect(group.getByRole('radio')).toHaveCount(3)
        await expect(group.getByRole('radio', { name: /Production only/ })).toHaveAttribute('aria-checked', 'true')
        await expect(group.getByRole('radio', { name: /All dependencies/ })).toHaveAttribute('aria-checked', 'false')
        await expect(group.getByRole('radio', { name: /Dev only/ })).toHaveAttribute('aria-checked', 'false')
    })

    test('moves the checked state on selection and persists it', async function ({ page }) {
        await page.goto('/settings/defaults')
        const group = page.getByRole('radiogroup', { name: 'Default dependency view' })

        await group.getByRole('radio', { name: /Dev only/ }).click()

        await expect(group.getByRole('radio', { name: /Dev only/ })).toHaveAttribute('aria-checked', 'true')
        await expect(group.getByRole('radio', { name: /Production only/ })).toHaveAttribute('aria-checked', 'false')
        await page.reload()
        await expect(group.getByRole('radio', { name: /Dev only/ })).toHaveAttribute('aria-checked', 'true')
    })
})

test.describe('the default severity floor and sort', function () {
    test('persists a minimum severity', async function ({ page }) {
        await page.goto('/settings/defaults')

        await page.getByRole('button', { name: 'Default minimum severity' }).click()
        await page.getByRole('option', { name: 'High +' }).click()

        await expect(page.getByText('Saved', { exact: true })).toBeVisible()
        await page.reload()
        await expect(page.getByRole('button', { name: 'Default minimum severity' })).toContainText('High +')
    })

    test('persists a sort order', async function ({ page }) {
        await page.goto('/settings/defaults')

        await page.getByRole('button', { name: 'Default sort' }).click()
        await page.getByRole('option', { name: 'Name' }).click()

        await expect(page.getByText('Saved', { exact: true })).toBeVisible()
        await page.reload()
        await expect(page.getByRole('button', { name: 'Default sort' })).toContainText('Name')
    })

    test('offers the empty severity floor as a real option meaning no floor', async function ({ page }) {
        await page.goto('/settings/defaults')

        await page.getByRole('button', { name: 'Default minimum severity' }).click()
        await expect(page.getByRole('option', { name: 'Any severity' })).toBeVisible()
        await page.getByRole('option', { name: 'Any severity' }).click()

        await page.reload()
        await expect(page.getByRole('button', { name: 'Default minimum severity' })).toContainText('Any severity')
    })

    test('saves without a Save button, and says so before anything has been saved', async function ({ page }) {
        await page.goto('/settings/defaults')

        await expect(page.getByRole('button', { name: 'Save defaults' })).toHaveCount(0)
        await expect(page.getByText('Changes apply immediately to every page that reads defaults.')).toBeVisible()
    })
})

test.describe('a default reaching the pages that read it', function () {
    // updateFilterDefaultsAction revalidates '/' as well as '/settings/defaults'. Without that second
    // call this passes on a hard navigation and fails on a client one, which is the kind of bug that
    // only ever reproduces for the user.
    test('switching to All dependencies reveals the dev-only finding on the project page', async function ({ page }) {
        await page.goto('/projects/' + PROJECT_ID)
        // minimist 1.2.0 is a devDependency, and the built-in default is production-only.
        await expect(visible(page, 'minimist')).toHaveCount(0)

        await page.goto('/settings/defaults')
        await page.getByRole('radiogroup', { name: 'Default dependency view' })
            .getByRole('radio', { name: /All dependencies/ })
            .click()
        await expect(page.getByText('Saved', { exact: true })).toBeVisible()

        // No ?dep= in the URL: the default is doing the work, not a query parameter.
        await page.goto('/projects/' + PROJECT_ID)
        await expect(visible(page, 'minimist')).toBeVisible()
    })

    test('switching to Dev only hides the production finding', async function ({ page }) {
        await page.goto('/settings/defaults')
        await page.getByRole('radiogroup', { name: 'Default dependency view' })
            .getByRole('radio', { name: /Dev only/ })
            .click()
        await expect(page.getByText('Saved', { exact: true })).toBeVisible()

        await page.goto('/projects/' + PROJECT_ID)
        await expect(visible(page, 'minimist')).toBeVisible()
        await expect(visible(page, 'lodash')).toHaveCount(0)
    })

    test('an explicit URL filter still overrides the default', async function ({ page }) {
        await page.goto('/settings/defaults')
        await page.getByRole('radiogroup', { name: 'Default dependency view' })
            .getByRole('radio', { name: /Dev only/ })
            .click()
        await expect(page.getByText('Saved', { exact: true })).toBeVisible()

        await page.goto('/projects/' + PROJECT_ID + '?dep=prod')

        await expect(visible(page, 'lodash')).toBeVisible()
        await expect(visible(page, 'minimist')).toHaveCount(0)
    })
})
