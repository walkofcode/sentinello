import { expect, readTest as test, visible } from './test-fixtures'
import { SEEDED } from './paths'

// /libraries/[ecosystem]/[name] — one package, everywhere it appears.
//
// Both route segments are decodeURIComponent'd, which matters for scoped packages; the fixture set has
// none, so the flat case is what is covered here.

test.describe('the header', function () {
    test('names the package and counts its advisories and projects', async function ({ page }) {
        await page.goto('/libraries/npm/lodash')

        await expect(page.getByRole('heading', { name: 'lodash' })).toBeVisible()
        await expect(page.getByText('Library', { exact: true })).toBeVisible()
        // ICU plurals on both nouns, and lodash has exactly one of each in this fixture — so a regex
        // that assumed the plural form would fail on the very data the suite ships.
        await expect(visible(page, /\d+ advisor(y|ies) · \d+ projects?/)).toBeVisible()
    })

    test('offers the advisory export and the mute-everywhere control', async function ({ page }) {
        await page.goto('/libraries/npm/lodash')

        await expect(page.getByRole('button', { name: 'Advisory', exact: true })).toBeVisible()
        await expect(page.getByRole('button', {
            name: 'Mute every advisory on this library across all projects'
        })).toBeVisible()
    })
})

test.describe('the findings sections', function () {
    test('groups the same findings two ways', async function ({ page }) {
        await page.goto('/libraries/npm/lodash')

        const tablist = page.getByRole('tablist', { name: 'Library findings grouping' })
        await expect(tablist.getByRole('tab', { name: /By advisory/ })).toBeVisible()
        await expect(tablist.getByRole('tab', { name: /By project/ })).toBeVisible()

        await tablist.getByRole('tab', { name: /By project/ }).click()
        await expect(tablist.getByRole('tab', { name: /By project/ })).toHaveAttribute('aria-selected', 'true')
    })

    test('lists the advisory that put the package here', async function ({ page }) {
        await page.goto('/libraries/npm/lodash')

        // The table shows the advisory SUMMARY and its vulnerable range, not the GHSA id — the id is
        // behind the link, and the summary is what an operator triages from.
        await expect(visible(page, 'Fixture: prototype pollution in lodash')).toBeVisible()
        await expect(visible(page, '>=4.0.0 <4.17.21')).toBeVisible()
    })

    test('the By project tab names the projects the package is installed in', async function ({ page }) {
        await page.goto('/libraries/npm/lodash')

        await page.getByRole('tablist', { name: 'Library findings grouping' })
            .getByRole('tab', { name: /By project/ })
            .click()

        await expect(visible(page, SEEDED.projectName)).toBeVisible()
    })

    test('names the section with a count', async function ({ page }) {
        await page.goto('/libraries/npm/lodash')

        await expect(page.getByText(/Current advisories \(\d+\)/)).toBeVisible()
    })
})

test.describe('the filters', function () {
    test('the dependency-type filter re-queries and drops the parameter at the default', async function ({ page }) {
        await page.goto('/libraries/npm/minimist?dep=dev')

        // minimist is dev-scope, so a dev view is where it has a finding at all.
        await expect(visible(page, 'Fixture: prototype pollution in minimist')).toBeVisible()

        await page.getByRole('button', { name: 'Filter by dependency type' }).click()
        await page.getByRole('option', { name: 'Production only' }).click()
        await expect(page).not.toHaveURL(/dep=/)
    })

    test('the source filter is absent while only one source is enabled', async function ({ page }) {
        await page.goto('/libraries/npm/lodash')

        // The seed leaves OSV as the only active cell. A single-option filter is noise, so the control
        // does not render below two sources — asserting that keeps a future regression honest.
        await expect(page.getByRole('button', { name: 'Filter by source' })).toHaveCount(0)
    })
})

test.describe('a library with nothing to show', function () {
    test('renders an empty state rather than an error', async function ({ page }) {
        const errors: string[] = []
        page.on('pageerror', function record(err) { errors.push(err.message) })

        // axios is present in the tree and named by an advisory, but the installed version is already
        // patched — so the page exists and is legitimately empty.
        const response = await page.goto('/libraries/npm/axios')

        expect(response?.status()).toBe(200)
        await expect(page.getByText('No findings for this library')).toBeVisible()
        expect(errors).toEqual([])
    })
})

test.describe('reaching it from the catalogue', function () {
    test('a row click opens the matching library', async function ({ page }) {
        await page.goto('/libraries')

        await visible(page, 'lodash').click()

        await expect(page).toHaveURL(/\/libraries\/npm\/lodash/)
        await expect(page.getByRole('heading', { name: 'lodash' })).toBeVisible()
    })
})
