import { join } from 'node:path'
import { expect, test, visible } from './test-fixtures'
import { adminState, enqueueScanRequests } from './admin'
import {
    BULK_DEP_COUNT,
    bulkLockResolved,
    bulkManifestResolved,
    readFixtureManifest,
    SEEDED
} from './paths'

const FIXTURE = readFixtureManifest()
const BULK_ID = FIXTURE.projects[SEEDED.bulkProjectName]
const RESOLVED_PAGE_SIZE = 25

// Resolved findings, and the pagination of the table that lists them.
//
// Findings do not resolve because anything says so — they resolve when an identity that is open in the
// database is ABSENT from a later scan (packages/db/src/queries/findings.ts). So the only honest way
// to produce a resolved finding is to change the tree and scan it again, which is what this file does:
// rewrite bulk-deps' manifest and lockfile so none of the vulnerable packages remain, queue a real
// scan request, and let the real worker close all BULK_DEP_COUNT episodes in one pass.
//
// writeFixtureFile puts the original bytes back afterwards. resetDb restores database rows and nothing
// else, so without that every later scan in the run would be looking at a tree this test emptied.

async function resolveEverything(
    writeFixtureFile: (relPath: string, contents: string) => void
): Promise<void> {
    writeFixtureFile(
        join(SEEDED.bulkProjectName, 'package.json'),
        bulkManifestResolved(SEEDED.bulkProjectName)
    )
    writeFixtureFile(
        join(SEEDED.bulkProjectName, 'package-lock.json'),
        bulkLockResolved(SEEDED.bulkProjectName)
    )

    const before = await adminState()
    await enqueueScanRequests(BULK_ID, 1)
    await expect(async function scanned() {
        const now = await adminState()
        expect(now.counts.scans).toBe(before.counts.scans + 1)
        expect(now.inFlight).toBe(0)
    }).toPass({ timeout: 60_000 })
}

test.describe('a project whose findings have all been fixed', function () {
    test('moves every finding into the resolved section', async function ({ page, writeFixtureFile }) {
        await resolveEverything(writeFixtureFile)

        await page.goto('/projects/' + BULK_ID)

        await expect(page.getByText('Resolved findings (' + BULK_DEP_COUNT + ')')).toBeVisible()
        // Resolved is not deleted: the history of what was once exposed is the point of the section.
        await expect(visible(page, 'fixture-pkg-01')).toBeVisible()
    })

    test('stops counting them as current', async function ({ page, writeFixtureFile }) {
        await resolveEverything(writeFixtureFile)

        await page.goto('/projects/' + BULK_ID)

        // Asserted through the grouping tabs rather than the pagination range, because the RESOLVED
        // table renders a range of its own using the same "N findings" plural — so a page-wide text
        // match cannot tell the two apart and would pass while 30 current findings were on screen.
        await expect(page.getByRole('tab', { name: /By advisory/ })).toHaveCount(0)
        await expect(page.getByText('Resolved findings (' + BULK_DEP_COUNT + ')')).toBeVisible()
    })

    test('drops the project off the dashboard as healthy', async function ({ page, writeFixtureFile }) {
        await resolveEverything(writeFixtureFile)

        await page.goto('/')

        await expect(visible(page, SEEDED.bulkProjectName)).toHaveCount(0)
        await page.getByRole('checkbox', { name: 'Show healthy' }).check()
        await expect(visible(page, SEEDED.bulkProjectName)).toBeVisible()
    })

    test('removes its packages from the library catalogue', async function ({ page, writeFixtureFile }) {
        await resolveEverything(writeFixtureFile)

        await page.goto('/libraries')

        // listLibraries excludes resolved rows outright, and unlike the dashboard there is no toggle
        // to bring them back.
        await expect(page.getByText('fixture-pkg-01')).toHaveCount(0)
        await expect(visible(page, 'lodash')).toBeVisible()
    })
})

test.describe('the resolved table pagination', function () {
    test('pages at twenty-five and reports the range', async function ({ page, writeFixtureFile }) {
        await resolveEverything(writeFixtureFile)
        await page.goto('/projects/' + BULK_ID)

        await expect(visible(page, 'Showing 1–' + RESOLVED_PAGE_SIZE + ' of ' + BULK_DEP_COUNT))
            .toBeVisible()
    })

    test('page one leaves the parameter out of the URL entirely', async function ({ page, writeFixtureFile }) {
        await resolveEverything(writeFixtureFile)
        await page.goto('/projects/' + BULK_ID)

        await page.getByRole('button', { name: 'Next page' }).first().click()
        await expect(page).toHaveURL(/resolvedPage=2/)

        await page.getByRole('button', { name: 'Previous page' }).first().click()

        // Deleted rather than set to 1 — assert the absence, since a URL that spells out the default
        // is a different contract from one that omits it.
        await expect(page).not.toHaveURL(/resolvedPage=/)
    })

    test('an out-of-range page clamps to the last one instead of erroring', async function ({ page, writeFixtureFile }) {
        await resolveEverything(writeFixtureFile)

        const response = await page.goto('/projects/' + BULK_ID + '?resolvedPage=999')

        expect(response?.status()).toBe(200)
        await expect(visible(page, 'Showing ' + (RESOLVED_PAGE_SIZE + 1) + '–' + BULK_DEP_COUNT + ' of ' + BULK_DEP_COUNT))
            .toBeVisible()
    })
})

test.describe('the tree the fixture restored', function () {
    // Guards the guard: if writeFixtureFile's teardown ever stopped restoring, every spec after this
    // file would silently run against an emptied bulk-deps and the failures would point anywhere but
    // here.
    test('is back to its full set of findings for whatever runs next', async function ({ page }) {
        await page.goto('/projects/' + BULK_ID)

        await expect(visible(page, 'Showing 1–25 of ' + BULK_DEP_COUNT + ' findings')).toBeVisible()
    })
})
