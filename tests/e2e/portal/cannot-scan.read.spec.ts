import type { Locator, Page } from '@playwright/test'
import { expect, readTest as test } from './test-fixtures'
import { readFixtureManifest, SEEDED } from './paths'

// "Project cannot be scanned", in the portal. lost-lockfile is a package.json with no lockfile whose two
// findings an earlier scan recorded (seed.ts): lodash, which that scan settled (fix 4.17.21), and minimist,
// which no settlement ever wrote. The worker's boot sweep could not scan it, so the page must say so and
// why, never call it all clear, and mark both findings not re-checked — never "rescan pending", which a
// rescan of a project nothing can read would never clear.

const FIXTURE = readFixtureManifest()
const PROJECT_ID = FIXTURE.projects[SEEDED.cannotScanProjectName]

function visible(page: Page, text: string | RegExp): Locator {
    return page.getByText(text).filter({ visible: true }).first()
}

// The row (card or table, whichever the viewport shows) that carries the package.
function rowOf(page: Page, pkg: string): Locator {
    return page.locator('tr, li, article').filter({ hasText: pkg }).filter({ visible: true }).first()
}

test.describe('a project that cannot be scanned', function () {
    test('says "Project cannot be scanned" and why, and never "All clear"', async function ({ page }) {
        await page.goto('/projects/' + PROJECT_ID + '?dep=all')

        const banner = page.getByTestId('scan-state-banner')
        await expect(banner).toContainText('Project cannot be scanned')
        await expect(banner).toContainText('No lockfile')
        await expect(banner).toContainText("on the project's side")
        await expect(page.getByText('All clear')).toHaveCount(0)
    })

    test('keeps the settled fix and marks it not re-checked, and says the same in place of "rescan pending"', async function ({ page }) {
        await page.goto('/projects/' + PROJECT_ID + '?dep=all')

        await expect(visible(page, 'lodash')).toBeVisible()
        await expect(visible(page, 'minimist')).toBeVisible()
        const lodash = rowOf(page, 'lodash')
        await expect(lodash).toContainText('4.17.21')
        await expect(lodash).toContainText(/not re-checked — the project cannot be scanned: No lockfile \(last scanned successfully /)
        await expect(rowOf(page, 'minimist')).toContainText(/not re-checked — the project cannot be scanned: No lockfile \(last scanned successfully /)
        expect(await page.locator('main').innerText()).not.toContain('rescan pending')
    })

    test('reads "Cannot be scanned" in the projects list', async function ({ page }) {
        await page.goto('/')

        const row = page.locator('tr, li, article').filter({ hasText: SEEDED.cannotScanProjectName }).filter({ visible: true }).first()
        await expect(row).toContainText('Cannot be scanned')
        await expect(row).toContainText('No lockfile (the project)')
    })
})
