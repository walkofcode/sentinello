import { expect, readTest as test, visible } from './test-fixtures'
import { readFixtureManifest, SEEDED } from './paths'

// What a finding says and counts, read from the worker's own boot sweep: advisory-facts installs a notice, an
// advisory nobody graded and two unrelated advisories under one title (osv-npm-portal-facts.ndjson). None of these
// branches is covered by the coverage gate, which measures no .tsx.

const PROJECT_ID = readFixtureManifest().projects[SEEDED.factsProjectName]
const PROJECT = '/projects/' + PROJECT_ID

test.describe('a notice', function () {
    test('is listed apart on the project, with its kind, no grade and nothing to chase', async function ({ page }) {
        await page.goto(PROJECT)

        const notices = page.getByTestId('notices')
        await expect(notices.getByRole('heading', { name: '1 notice' })).toBeVisible()
        await expect(notices.getByText(/They are in no count, and alert nobody/)).toBeVisible()
        const row = notices.locator('tr, li, article').filter({ hasText: 'fixture-notice' }).filter({ visible: true }).first()
        await expect(row.getByTestId('notice-kind')).toHaveText('Unmaintained')
        await expect(row).toContainText('No fix to chase')
        await expect(row.getByRole('button', { name: 'Mute finding' })).toBeVisible()
    })

    test('is in neither tab of the vulnerabilities', async function ({ page }) {
        await page.goto(PROJECT)

        const tabs = page.getByRole('tablist', { name: 'Findings grouping' })
        // fixture-unrated, and the same title's two advisories.
        await expect(tabs.getByRole('tab', { name: /By advisory/ })).toContainText('3')
        await expect(tabs.getByRole('tab', { name: /By library/ })).toContainText('2')
    })

    test('stays under a severity floor, which it claims no grade to fail', async function ({ page }) {
        await page.goto(PROJECT + '?sev=critical')

        await expect(visible(page, 'fixture-same-title')).toHaveCount(0)
        await expect(page.getByTestId('notices').getByRole('heading', { name: '1 notice' })).toBeVisible()
    })

    test('keeps a notice-only library reachable and counted as no advisory', async function ({ page }) {
        await page.goto('/libraries?lq=fixture-notice')

        await expect(visible(page, 'fixture-notice')).toBeVisible()
        await expect(visible(page, '1 notice')).toBeVisible()
    })

    test('gets a library page of its own: zero advisories, the notice listed', async function ({ page }) {
        await page.goto('/libraries/npm/fixture-notice')

        await expect(visible(page, /0 advisories · 0 projects/)).toBeVisible()
        const notices = page.getByTestId('notices')
        await expect(notices.getByRole('heading', { name: '1 notice' })).toBeVisible()
        await expect(notices.getByTestId('notice-kind').filter({ visible: true }).first()).toHaveText('Unmaintained')
    })
})

test.describe('an advisory nobody graded', function () {
    test('reads unrated, not moderate', async function ({ page }) {
        await page.goto(PROJECT)

        const row = page.locator('tr, li, article').filter({ hasText: 'fixture-unrated' }).filter({ visible: true }).first()
        await expect(row.getByText('unrated', { exact: true })).toBeVisible()
        await expect(row.getByText('moderate', { exact: true })).toHaveCount(0)
    })

    test('ranks as moderate under a floor: kept at moderate, dropped at high', async function ({ page }) {
        await page.goto(PROJECT + '?sev=moderate')
        await expect(visible(page, 'fixture-unrated')).toBeVisible()

        await page.goto(PROJECT + '?sev=high')
        await expect(visible(page, 'fixture-unrated')).toHaveCount(0)
    })

    test('has its own bucket on the dashboard', async function ({ page }) {
        await page.goto('/?pq=' + SEEDED.factsProjectName)

        await expect(visible(page, SEEDED.factsProjectName)).toBeVisible()
        await expect(visible(page, 'unrated')).toBeVisible()
    })
})

test.describe('two advisories under one title', function () {
    test('stay two on the project, each with its own grade', async function ({ page }) {
        await page.goto(PROJECT)

        const rows = page.locator('tr, li, article').filter({ hasText: 'fixture-same-title' }).filter({ visible: true })
        await expect(rows).toHaveCount(2)
        await expect(rows.filter({ hasText: 'high' })).toHaveCount(1)
        await expect(rows.filter({ hasText: 'low' })).toHaveCount(1)
    })

    test('stay two on the library page', async function ({ page }) {
        await page.goto('/libraries/npm/fixture-same-title')

        await expect(visible(page, /2 advisories · 1 project/)).toBeVisible()
        const tabs = page.getByRole('tablist', { name: 'Library findings grouping' })
        await expect(tabs.getByRole('tab', { name: /By advisory/ })).toContainText('2')
    })
})
