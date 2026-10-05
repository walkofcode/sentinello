import type { Download, Locator, Page } from '@playwright/test'
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

// The library page lists lost-lockfile's lodash beside checkout-service's, at the same severity. Only the
// annotation tells the retained one apart from the one a scan just re-checked.
const LIBRARY = '/libraries/npm/lodash?dep=all'
const NOT_RECHECKED = /not re-checked — the project cannot be scanned: No lockfile \(last scanned successfully /

// The expanded per-project row: after the container row in document order, so the last match is the inner one.
function usageRow(page: Page, projectName: string): Locator {
    return page.locator('tr').filter({ hasText: projectName }).filter({ visible: true }).last()
}

async function readDownload(download: Download): Promise<string> {
    const stream = await download.createReadStream()
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(chunk as Buffer)
    return Buffer.concat(chunks).toString('utf8')
}

test.describe('a project that cannot be scanned, on a library page', function () {
    test('marks its usage not re-checked in the By advisory grouping', async function ({ page }) {
        await page.goto(LIBRARY)

        await page.getByRole('button', { name: /Show details/ }).filter({ visible: true }).first().click()

        await expect(usageRow(page, SEEDED.cannotScanProjectName)).toContainText(NOT_RECHECKED)
        await expect(usageRow(page, SEEDED.projectName)).toBeVisible()
        await expect(usageRow(page, SEEDED.projectName)).not.toContainText('not re-checked')
    })

    test('marks its advisory not re-checked in the By project grouping', async function ({ page }) {
        await page.goto(LIBRARY)
        await page.getByRole('tablist', { name: 'Library findings grouping' }).getByRole('tab', { name: /By project/ }).click()

        await usageRow(page, SEEDED.cannotScanProjectName).getByRole('button', { name: /Show details/ }).click()

        const annotations = page.getByTestId('not-rechecked').filter({ visible: true })
        await expect(annotations).toHaveCount(1)
        await expect(annotations).toHaveText(NOT_RECHECKED)
    })

    test('lists it in the advisory export\'s "could not be fully scanned" section', async function ({ page }) {
        await page.goto(LIBRARY)

        await page.getByRole('button', { name: 'Advisory', exact: true }).click()
        const downloading = page.waitForEvent('download')
        await page.getByRole('menuitem', { name: 'Download .md' }).click()
        const markdown = await readDownload(await downloading)

        expect(markdown).toContain('## Projects that could not be fully scanned')
        expect(markdown).toContain('- **' + SEEDED.cannotScanProjectName + '** — Project cannot be scanned')
        expect(markdown).toContain("on the project's side")
        expect(markdown).not.toContain('- **' + SEEDED.projectName + '** —')
    })
})
