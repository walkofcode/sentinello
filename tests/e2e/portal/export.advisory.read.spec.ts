import type { Download, Page } from '@playwright/test'
import { expect, readTest as test } from './test-fixtures'
import { readFixtureManifest, SEEDED } from './paths'

const FIXTURE = readFixtureManifest()
const PROJECT_ID = FIXTURE.projects[SEEDED.projectName]

// The Advisory export menu, on the three surfaces that carry it.
//
// There is no server route behind this: the markdown comes back from a server ACTION and the file is
// assembled in the browser as a Blob and clicked through a synthetic anchor. That still fires a real
// download event, so it is assertable end to end — including the file's contents.

async function readDownload(download: Download): Promise<string> {
    const stream = await download.createReadStream()
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(chunk as Buffer)
    return Buffer.concat(chunks).toString('utf8')
}

async function downloadAdvisory(page: Page): Promise<Download> {
    await page.getByRole('button', { name: 'Advisory', exact: true }).click()
    // Registered BEFORE the click: the anchor is created, clicked and removed synchronously, so a
    // listener attached afterwards can miss the event entirely.
    const downloading = page.waitForEvent('download')
    await page.getByRole('menuitem', { name: 'Download .md' }).click()
    return await downloading
}

test.describe('the export menu', function () {
    test('offers copy and download', async function ({ page }) {
        await page.goto('/projects/' + PROJECT_ID)

        await page.getByRole('button', { name: 'Advisory', exact: true }).click()

        const menu = page.getByRole('menu')
        await expect(menu.getByRole('menuitem', { name: 'Copy to clipboard' })).toBeVisible()
        await expect(menu.getByRole('menuitem', { name: 'Download .md' })).toBeVisible()
    })

    test('is absent on a project with nothing to export', async function ({ page }) {
        const cleanId = FIXTURE.projects[SEEDED.cleanProjectName]
        await page.goto('/projects/' + cleanId)

        // Offering an export of zero findings is a control that can only disappoint.
        await expect(page.getByRole('button', { name: 'Advisory', exact: true })).toHaveCount(0)
    })
})

test.describe('downloading from a project', function () {
    test('produces a dated markdown file named after the scope', async function ({ page }) {
        await page.goto('/projects/' + PROJECT_ID)

        const download = await downloadAdvisory(page)

        expect(download.suggestedFilename()).toMatch(/^sentinello-.*-advisories-\d{4}-\d{2}-\d{2}\.md$/)
        expect(download.suggestedFilename()).toContain(SEEDED.projectName)
    })

    test('the file contains the project findings, not an empty template', async function ({ page }) {
        await page.goto('/projects/' + PROJECT_ID)

        const markdown = await readDownload(await downloadAdvisory(page))

        expect(markdown).toContain('lodash')
        expect(markdown).toContain('4.17.11')
        // The fix version is the single most actionable line in the document.
        expect(markdown).toContain('4.17.21')
    })

    test('honours the dependency-type filter in force on the page', async function ({ page }) {
        await page.goto('/projects/' + PROJECT_ID + '?dep=dev')

        const markdown = await readDownload(await downloadAdvisory(page))

        // A dev-only view that exported production findings would hand someone the wrong work list.
        expect(markdown).toContain('minimist')
        expect(markdown).not.toContain('lodash')
    })
})

test.describe('downloading from a library', function () {
    test('scopes the file to that package across projects', async function ({ page }) {
        await page.goto('/libraries/npm/lodash')

        const download = await downloadAdvisory(page)
        const markdown = await readDownload(download)

        expect(download.suggestedFilename()).toContain('lodash')
        expect(markdown).toContain('lodash')
    })
})

test.describe('copying to the clipboard', function () {
    test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

    test('puts the same markdown on the clipboard and confirms it did', async function ({ page }) {
        await page.goto('/projects/' + PROJECT_ID)

        await page.getByRole('button', { name: 'Advisory', exact: true }).click()
        await page.getByRole('menuitem', { name: 'Copy to clipboard' }).click()

        // The trigger label is the only feedback there is, and it reverts after two seconds.
        await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible()
        const clipboard = await page.evaluate(function read() { return navigator.clipboard.readText() })
        expect(clipboard).toContain('lodash')
    })
})
