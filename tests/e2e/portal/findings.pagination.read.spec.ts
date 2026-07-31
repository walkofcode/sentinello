import { expect, readTest as test, visible } from './test-fixtures'
import { BULK_DEP_COUNT, readFixtureManifest, SEEDED } from './paths'

const FIXTURE = readFixtureManifest()
const BULK_ID = FIXTURE.projects[SEEDED.bulkProjectName]
const SMALL_ID = FIXTURE.projects[SEEDED.projectName]

// Pagination on the current-findings tabs of a project detail page.
//
// This spec is the reason bulk-deps exists. Pagination renders nothing at or below its page size, so
// with checkout-service's two findings the control was not merely untested — it was unreachable, and
// so were the off-by-one bugs it can hide.
//
// Both tabs paginate at 25 in React state with NO url parameter, which is itself worth pinning: a
// later change that moved them into the URL would break shareable links in the opposite direction.

const PAGE_SIZE = 25
const SECOND_PAGE = BULK_DEP_COUNT - PAGE_SIZE

test.describe('a project with more findings than fit on a page', function () {
    test('renders a pagination control that says what it is showing', async function ({ page }) {
        await page.goto('/projects/' + BULK_ID)

        // En-dash, and an ICU plural on the noun — both are easy to lose in a refactor and both are
        // what an operator actually reads.
        await expect(visible(page, 'Showing 1–' + PAGE_SIZE + ' of ' + BULK_DEP_COUNT + ' findings')).toBeVisible()
        await expect(visible(page, 'Page 1 of 2')).toBeVisible()
    })

    test('disables Previous on the first page and Next on the last', async function ({ page }) {
        await page.goto('/projects/' + BULK_ID)

        await expect(page.getByRole('button', { name: 'Previous page' }).first()).toBeDisabled()
        await expect(page.getByRole('button', { name: 'Next page' }).first()).toBeEnabled()

        await page.getByRole('button', { name: 'Next page' }).first().click()

        await expect(page.getByRole('button', { name: 'Previous page' }).first()).toBeEnabled()
        await expect(page.getByRole('button', { name: 'Next page' }).first()).toBeDisabled()
    })

    test('the second page holds the remainder', async function ({ page }) {
        await page.goto('/projects/' + BULK_ID)

        await page.getByRole('button', { name: 'Next page' }).first().click()

        await expect(visible(page, 'Showing ' + (PAGE_SIZE + 1) + '–' + BULK_DEP_COUNT + ' of ' + BULK_DEP_COUNT + ' findings'))
            .toBeVisible()
        await expect(visible(page, 'Page 2 of 2')).toBeVisible()
        expect(SECOND_PAGE).toBe(5)
    })

    test('paging changes which findings are on screen', async function ({ page }) {
        await page.goto('/projects/' + BULK_ID)
        const firstPage = await page.getByRole('table').first().innerText()

        await page.getByRole('button', { name: 'Next page' }).first().click()
        const secondPage = await page.getByRole('table').first().innerText()

        expect(secondPage).not.toBe(firstPage)
    })

    test('keeps pagination out of the URL', async function ({ page }) {
        await page.goto('/projects/' + BULK_ID)

        await page.getByRole('button', { name: 'Next page' }).first().click()
        await expect(visible(page, 'Page 2 of 2')).toBeVisible()

        // React state, deliberately. Asserting the absence pins the current contract so that moving it
        // into the URL later is a decision rather than an accident.
        expect(new URL(page.url()).search).toBe('')
    })

    test('going back returns the first page', async function ({ page }) {
        await page.goto('/projects/' + BULK_ID)

        await page.getByRole('button', { name: 'Next page' }).first().click()
        await expect(visible(page, 'Page 2 of 2')).toBeVisible()
        await page.getByRole('button', { name: 'Previous page' }).first().click()

        await expect(visible(page, 'Page 1 of 2')).toBeVisible()
    })
})

test.describe('the By library tab', function () {
    test('paginates its own groups independently', async function ({ page }) {
        await page.goto('/projects/' + BULK_ID)

        await page.getByRole('tab', { name: /By library/ }).click()

        // Every bulk package carries exactly one advisory, so the grouping is one-to-one and the group
        // count matches the finding count.
        await expect(visible(page, 'Showing 1–' + PAGE_SIZE + ' of ' + BULK_DEP_COUNT + ' libraries')).toBeVisible()
    })
})

test.describe('a project below the page size', function () {
    // Pagination returns null at or below its page size. That is the behaviour that made this whole
    // area untestable before bulk-deps existed, so it is worth stating rather than leaving implied.
    test('renders no pagination control at all', async function ({ page }) {
        await page.goto('/projects/' + SMALL_ID)

        await expect(visible(page, 'lodash')).toBeVisible()
        await expect(page.getByRole('button', { name: 'Next page' })).toHaveCount(0)
        await expect(page.getByText(/Showing \d+–\d+ of/)).toHaveCount(0)
    })
})
