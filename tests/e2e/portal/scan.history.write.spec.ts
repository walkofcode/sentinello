import { expect, test, visible } from './test-fixtures'
import { adminState, enqueueScanRequests } from './admin'
import { readFixtureManifest, SEEDED } from './paths'

const FIXTURE = readFixtureManifest()
const PROJECT_ID = FIXTURE.projects[SEEDED.projectName]
const SCAN_PAGE_SIZE = 20

// Scan-history pagination on the project detail page.
//
// The boot sweep records exactly one scan per project, so no amount of widening the fixture tree
// reaches a control that needs twenty-one. These are REAL scans: enqueueScanRequests writes pending
// rows and the real worker claims, runs and completes each one. It is only affordable because the
// poller's interval is overridden to 200ms for the suite — at its 5s production cadence this single
// file would take nearly two minutes.

// One already exists from the boot sweep, so twenty more clears the page size by one.
const EXTRA_SCANS = SCAN_PAGE_SIZE

async function runExtraScans(count: number): Promise<void> {
    const before = await adminState()
    await enqueueScanRequests(PROJECT_ID, count)
    await expect(async function drained() {
        const now = await adminState()
        expect(now.counts.scans).toBe(before.counts.scans + count)
        expect(now.inFlight).toBe(0)
    }).toPass({ timeout: 60_000 })
}

test.describe('a project with more scans than fit on a page', function () {
    test('renders a pagination control over the scan history', async function ({ page }) {
        await runExtraScans(EXTRA_SCANS)

        await page.goto('/projects/' + PROJECT_ID)

        await expect(visible(page, 'Showing 1–' + SCAN_PAGE_SIZE + ' of ' + (EXTRA_SCANS + 1) + ' scans'))
            .toBeVisible()
    })

    test('puts the page in the URL and drops it again on the first page', async function ({ page }) {
        await runExtraScans(EXTRA_SCANS)
        await page.goto('/projects/' + PROJECT_ID)

        await visible(page, 'Showing 1–' + SCAN_PAGE_SIZE + ' of ' + (EXTRA_SCANS + 1) + ' scans').scrollIntoViewIfNeeded()
        await page.getByRole('button', { name: 'Next page' }).last().click()
        await expect(page).toHaveURL(/scanPage=2/)

        await page.getByRole('button', { name: 'Previous page' }).last().click()
        await expect(page).not.toHaveURL(/scanPage=/)
    })

    test('the last page holds the remainder', async function ({ page }) {
        await runExtraScans(EXTRA_SCANS)

        await page.goto('/projects/' + PROJECT_ID + '?scanPage=2')

        await expect(visible(page, 'Showing ' + (SCAN_PAGE_SIZE + 1) + '–' + (EXTRA_SCANS + 1) + ' of ' + (EXTRA_SCANS + 1) + ' scans'))
            .toBeVisible()
    })

    test('an out-of-range page clamps rather than rendering nothing', async function ({ page }) {
        await runExtraScans(EXTRA_SCANS)

        const response = await page.goto('/projects/' + PROJECT_ID + '?scanPage=999')

        expect(response?.status()).toBe(200)
        await expect(visible(page, 'Showing ' + (SCAN_PAGE_SIZE + 1) + '–' + (EXTRA_SCANS + 1) + ' of ' + (EXTRA_SCANS + 1) + ' scans'))
            .toBeVisible()
    })
})

test.describe('before the history is long enough', function () {
    test('no scan pagination renders', async function ({ page }) {
        await page.goto('/projects/' + PROJECT_ID)

        await expect(page.getByText(/Showing \d+–\d+ of \d+ scans/)).toHaveCount(0)
    })
})

test.describe('what twenty-one real scans must not do', function () {
    // The scans are genuine, so this doubles as a durability check on the merge path: rescanning an
    // unchanged tree twenty times must not duplicate a single finding or reopen a closed episode.
    test('leaves the finding count exactly where it started', async function ({ page }) {
        const before = await adminState()

        await runExtraScans(EXTRA_SCANS)

        const after = await adminState()
        expect(after.counts.findings).toBe(before.counts.findings)
        await page.goto('/projects/' + PROJECT_ID)
        await expect(visible(page, 'lodash')).toBeVisible()
    })
})
