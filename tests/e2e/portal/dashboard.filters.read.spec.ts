import type { Page } from '@playwright/test'
import { expect, readTest as test, visible } from './test-fixtures'
import { SEEDED } from './paths'

// The dashboard's filter bar.
//
// Read-only: every control here filters or sorts, and none of them writes a row. What makes the page
// worth a spec of its own is that its filters are of TWO kinds and only one of them is obvious —
// `pdep` round-trips to the server through router.replace and re-queries, while the other seven filter
// rows already in the browser and mirror themselves into the URL with history.replaceState. So a URL
// is loadable and shareable, but changing a control fires no navigation at all.

// The default view is production dependencies with healthy projects hidden, so this is what the
// fixture tree shows before anything is touched: docs-site is absent because it is clean.
const WITH_FINDINGS = [SEEDED.projectName, SEEDED.bulkProjectName]

function row(page: Page, name: string) {
    return visible(page, name)
}

test.describe('the default view', function () {
    test('shows the projects that need attention and hides the healthy one', async function ({ page }) {
        await page.goto('/')

        for (const name of WITH_FINDINGS) await expect(row(page, name)).toBeVisible()
        // legacy-yarn is unauditable rather than healthy — "we could not check this" is not "this is
        // fine", and hiding it would be the more dangerous of the two mistakes.
        await expect(row(page, SEEDED.unauditableProjectName)).toBeVisible()
        await expect(visible(page, SEEDED.cleanProjectName)).toHaveCount(0)
    })

    test('carries no filter parameters in the URL until something is changed', async function ({ page }) {
        await page.goto('/')

        expect(new URL(page.url()).search).toBe('')
    })
})

test.describe('search', function () {
    test('narrows to a matching project and drops the rest', async function ({ page }) {
        await page.goto('/')

        await page.getByRole('searchbox', { name: 'Search projects' }).fill('checkout')

        await expect(row(page, SEEDED.projectName)).toBeVisible()
        await expect(visible(page, SEEDED.bulkProjectName)).toHaveCount(0)
    })

    test('mirrors itself into the URL without asking the server', async function ({ page }) {
        await page.goto('/')
        await page.waitForLoadState('networkidle')

        // Documents and RSC payloads only. Counting every request would fold in the chunks and fonts
        // the page is still pulling in on its own, and counting framenavigated events would not work
        // either — Chromium fires those for same-document history.replaceState, so they cannot tell a
        // client-side filter from a router push.
        const fetched: string[] = []
        page.on('request', function record(r) {
            if (r.resourceType() === 'document' || r.url().includes('_rsc=')) fetched.push(r.url())
        })

        await page.getByRole('searchbox', { name: 'Search projects' }).fill('checkout')
        await expect(page).toHaveURL(/pq=checkout/)

        // The actual claim: the rows are already in the browser, so narrowing them asks the server
        // nothing at all.
        expect(fetched).toEqual([])
    })

    test('is applied on load when it arrives in the URL', async function ({ page }) {
        await page.goto('/?pq=checkout')

        await expect(row(page, SEEDED.projectName)).toBeVisible()
        await expect(visible(page, SEEDED.bulkProjectName)).toHaveCount(0)
    })

    test('says so when nothing matches rather than rendering an empty table', async function ({ page }) {
        await page.goto('/?pq=nothing-matches-this')

        await expect(page.getByText('All clear — great job!')).toBeVisible()
    })
})

test.describe('the severity floor', function () {
    test('keeps only projects at or above the chosen severity', async function ({ page }) {
        await page.goto('/')

        await page.getByRole('button', { name: 'Filter by severity' }).click()
        await page.getByRole('option', { name: 'Critical only' }).click()

        // bulk-deps carries critical advisories; checkout-service tops out at high.
        await expect(row(page, SEEDED.bulkProjectName)).toBeVisible()
        await expect(visible(page, SEEDED.projectName)).toHaveCount(0)
        await expect(page).toHaveURL(/psev=critical/)
    })

    test('hydrates from the URL', async function ({ page }) {
        await page.goto('/?psev=critical')

        await expect(row(page, SEEDED.bulkProjectName)).toBeVisible()
        await expect(visible(page, SEEDED.projectName)).toHaveCount(0)
    })
})

test.describe('the dependency-type filter', function () {
    // The one filter that is NOT client-side: it changes which findings the server counts, so it has
    // to re-query rather than hide rows.
    test('round-trips to the server and puts pdep in the URL', async function ({ page }) {
        await page.goto('/')

        await page.getByRole('button', { name: 'Filter by dependency type' }).click()
        await page.getByRole('option', { name: 'Dev only' }).click()

        await expect(page).toHaveURL(/pdep=dev/)
        // minimist is checkout-service's only dev-scope finding, so the project survives a dev-only view.
        await expect(row(page, SEEDED.projectName)).toBeVisible()
    })

    test('drops the parameter again when set back to the default', async function ({ page }) {
        await page.goto('/?pdep=dev')

        await page.getByRole('button', { name: 'Filter by dependency type' }).click()
        await page.getByRole('option', { name: 'Production only' }).click()

        // Absent rather than pdep=prod: the default is not worth carrying, and a URL that spells it out
        // would pin behaviour that Settings → Defaults is allowed to change.
        await expect(page).not.toHaveURL(/pdep=/)
    })
})

test.describe('the healthy and muted toggles', function () {
    test('Show healthy reveals the clean project', async function ({ page }) {
        await page.goto('/')
        await expect(visible(page, SEEDED.cleanProjectName)).toHaveCount(0)

        await page.getByRole('checkbox', { name: 'Show healthy' }).check()

        await expect(row(page, SEEDED.cleanProjectName)).toBeVisible()
        await expect(page).toHaveURL(/phealthy=1/)
    })

    test('both toggles hydrate from the URL', async function ({ page }) {
        await page.goto('/?phealthy=1&pmuted=1')

        await expect(page.getByRole('checkbox', { name: 'Show healthy' })).toBeChecked()
        await expect(page.getByRole('checkbox', { name: 'Show muted' })).toBeChecked()
        await expect(row(page, SEEDED.cleanProjectName)).toBeVisible()
    })
})

test.describe('sorting', function () {
    test('by name puts the sort in the URL, and severity — the default — does not', async function ({ page }) {
        await page.goto('/')

        await page.getByRole('button', { name: 'Sort by' }).click()
        await page.getByRole('option', { name: 'Sort: name' }).click()
        await expect(page).toHaveURL(/psort=name/)

        await page.getByRole('button', { name: 'Sort by' }).click()
        await page.getByRole('option', { name: 'Sort: severity' }).click()
        await expect(page).not.toHaveURL(/psort=/)
    })

    test('by severity puts the most severe project above the rest', async function ({ page }) {
        await page.goto('/')

        // Compared by position within the table's text rather than by collecting link elements: the
        // page renders a card list and a table with the same names, so an element-based ordering
        // assertion has to disambiguate which copy it is reading before it means anything.
        const table = await page.getByRole('table').first().innerText()
        expect(table.indexOf(SEEDED.bulkProjectName)).toBeLessThan(table.indexOf(SEEDED.projectName))
    })

    test('by name sorts alphabetically instead', async function ({ page }) {
        await page.goto('/?psort=name')

        const table = await page.getByRole('table').first().innerText()
        expect(table.indexOf(SEEDED.bulkProjectName)).toBeLessThan(table.indexOf(SEEDED.projectName))
        expect(table.indexOf(SEEDED.projectName)).toBeLessThan(table.indexOf(SEEDED.unauditableProjectName))
    })
})

test.describe('the root and tag filters', function () {
    test('offer an all-inclusive option and the seeded root', async function ({ page }) {
        await page.goto('/')

        await page.getByRole('button', { name: 'Filter by root' }).click()
        await expect(page.getByRole('option', { name: 'All roots' })).toBeVisible()
        await expect(page.getByRole('option', { name: new RegExp(SEEDED.rootLabel) })).toBeVisible()
    })

    test('the tag filter offers only All tags while nothing is tagged', async function ({ page }) {
        await page.goto('/')

        await page.getByRole('button', { name: 'Filter by tag' }).click()

        await expect(page.getByRole('option')).toHaveCount(1)
        await expect(page.getByRole('option', { name: 'All tags' })).toBeVisible()
    })
})

test.describe('the overview cards', function () {
    test('the severity breakdown tracks the filters rather than the catalogue', async function ({ page }) {
        await page.goto('/')
        // bulk-deps contributes the only critical advisories in the tree.
        await expect(visible(page, 'critical')).toBeVisible()

        await page.getByRole('searchbox', { name: 'Search projects' }).fill('checkout')

        // The counts are derived from the FILTERED rows. A breakdown that ignored the filter would sit
        // directly above a table that contradicts it, which is worse than showing nothing.
        await expect(page.getByText('critical')).toHaveCount(0)
        await expect(visible(page, 'high')).toBeVisible()
    })
})

test.describe('returning from a project', function () {
    test('the back link restores the filtered dashboard rather than a bare one', async function ({ page }) {
        await page.goto('/')
        await page.getByRole('searchbox', { name: 'Search projects' }).fill('checkout')
        await expect(page).toHaveURL(/pq=checkout/)

        await visible(page, SEEDED.projectName).click()
        await expect(page).toHaveURL(/\/projects\//)

        await page.getByRole('link', { name: /Projects/ }).first().click()

        // sessionStorage-backed (lib/home-url-memory.ts). Losing the filter on the way back is a small
        // thing that makes triaging a long list genuinely painful.
        await expect(page).toHaveURL(/pq=checkout/)
    })
})
