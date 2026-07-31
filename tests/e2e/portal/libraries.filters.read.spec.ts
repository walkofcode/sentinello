import { expect, readTest as test, visible } from './test-fixtures'
import { BULK_DEP_COUNT } from './paths'

// /libraries — the catalogue rolled up by package rather than by project.
//
// Same hybrid filter model as the dashboard: `ldep` re-queries the server, `lq` / `lsev` / `lsort`
// filter rows already in the browser and mirror into the URL. The difference worth a spec is what the
// underlying query EXCLUDES: muted and resolved rows never reach this page at all, and unlike the
// dashboard there is no "Show muted" to bring them back.

test.describe('the catalogue', function () {
    test('lists every library with a current finding', async function ({ page }) {
        await page.goto('/libraries')

        await expect(visible(page, 'lodash')).toBeVisible()
        await expect(visible(page, 'fixture-pkg-01')).toBeVisible()
        // axios is installed but already patched, so it is not a library with a finding.
        await expect(page.getByText('axios')).toHaveCount(0)
    })

    test('shows the columns an operator triages by', async function ({ page }) {
        await page.goto('/libraries')

        for (const header of ['Library', 'Language', 'Advisories', 'Affected projects', 'Max severity']) {
            await expect(page.getByRole('columnheader', { name: header })).toBeVisible()
        }
    })
})

test.describe('search', function () {
    test('narrows by package name', async function ({ page }) {
        await page.goto('/libraries')

        await page.getByRole('searchbox', { name: 'Search packages' }).fill('lodash')

        await expect(visible(page, 'lodash')).toBeVisible()
        await expect(page.getByText('fixture-pkg-01')).toHaveCount(0)
        await expect(page).toHaveURL(/lq=lodash/)
    })

    test('hydrates from the URL', async function ({ page }) {
        // A production-scope package: the default view is production-only, so searching for minimist
        // here would find nothing regardless of whether hydration worked.
        await page.goto('/libraries?lq=fixture-pkg-07')

        await expect(visible(page, 'fixture-pkg-07')).toBeVisible()
        await expect(page.getByText('lodash')).toHaveCount(0)
    })

    test('says so when nothing matches', async function ({ page }) {
        await page.goto('/libraries?lq=no-such-package')

        await expect(page.getByText('No libraries to show')).toBeVisible()
        await expect(page.getByText('Adjust filters above, or wait for the next scan to populate findings.'))
            .toBeVisible()
    })
})

test.describe('the severity floor', function () {
    test('keeps only libraries at or above the chosen severity', async function ({ page }) {
        await page.goto('/libraries')

        await page.getByRole('button', { name: 'Filter by severity' }).click()
        await page.getByRole('option', { name: 'Critical only' }).click()

        // lodash's fixture advisory is HIGH, so it falls away under a critical floor.
        await expect(page.getByText('lodash')).toHaveCount(0)
        await expect(page).toHaveURL(/lsev=critical/)
    })
})

test.describe('the dependency-type filter', function () {
    test('re-queries the server and drops the parameter at the default', async function ({ page }) {
        await page.goto('/libraries')

        await page.getByRole('button', { name: 'Filter by dependency type' }).click()
        await page.getByRole('option', { name: 'Dev only' }).click()
        await expect(page).toHaveURL(/ldep=dev/)
        // minimist is the tree's only dev-scope finding.
        await expect(visible(page, 'minimist')).toBeVisible()
        await expect(page.getByText('lodash')).toHaveCount(0)

        await page.getByRole('button', { name: 'Filter by dependency type' }).click()
        await page.getByRole('option', { name: 'Production only' }).click()
        await expect(page).not.toHaveURL(/ldep=/)
    })
})

test.describe('sorting', function () {
    test('offers four orders and puts the non-default ones in the URL', async function ({ page }) {
        await page.goto('/libraries')

        await page.getByRole('button', { name: 'Sort by' }).click()
        for (const option of ['Sort: severity', 'Sort: name', 'Sort: most projects', 'Sort: most advisories']) {
            await expect(page.getByRole('option', { name: option })).toBeVisible()
        }

        await page.getByRole('option', { name: 'Sort: name' }).click()
        await expect(page).toHaveURL(/lsort=name/)
    })

    test('by name is alphabetical', async function ({ page }) {
        await page.goto('/libraries?lsort=name')

        const table = await page.getByRole('table').first().innerText()
        expect(table.indexOf('fixture-pkg-01')).toBeLessThan(table.indexOf('lodash'))
    })
})

test.describe('what the page refuses to show', function () {
    test('renders every finding-bearing library and no pagination control', async function ({ page }) {
        await page.goto('/libraries')

        // 30 bulk packages plus lodash. minimist is dev-scope and the default view is production, so
        // the catalogue is BULK_DEP_COUNT + 1 under the default filter.
        await expect(visible(page, 'fixture-pkg-' + String(BULK_DEP_COUNT).padStart(2, '0'))).toBeVisible()
        // There is deliberately no pagination here — the whole list renders and the filters narrow it.
        await expect(page.getByRole('button', { name: 'Next page' })).toHaveCount(0)
    })
})
