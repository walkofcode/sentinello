import type { Download, Locator, Page } from '@playwright/test'
import { expect, readTest as test } from './test-fixtures'
import { readFixtureManifest, SEEDED } from './paths'

// The portal's half of "report only released fixes": watch-tools carries braces 3.0.3 (dev, through
// nodemon › chokidar) and node-forge 1.4.0 (prod, direct), whose advisories name no fix — and npm has
// published neither 3.0.4 nor 1.4.1, the versions Sentinello used to invent. The worker settled both
// against the seeded registry cache (seed-registry.ts) during its boot sweep; this asserts what the page
// and the advisory export show for them.

const FIXTURE = readFixtureManifest()
const PROJECT_ID = FIXTURE.projects[SEEDED.noFixProjectName]
const INVENTED = ['3.0.4', '1.4.1']

function visible(page: Page, text: string | RegExp): Locator {
    return page.getByText(text).filter({ visible: true }).first()
}

// The row (card or table, whichever the viewport shows) that carries the package.
function rowOf(page: Page, pkg: string): Locator {
    return page.locator('tr, li, article').filter({ hasText: pkg }).filter({ visible: true }).first()
}

async function readDownload(download: Download): Promise<string> {
    const stream = await download.createReadStream()
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(chunk as Buffer)
    return Buffer.concat(chunks).toString('utf8')
}

test.describe('a finding with no fixed version released', function () {
    test('is still reported, says so plainly, and names no invented version', async function ({ page }) {
        await page.goto('/projects/' + PROJECT_ID + '?dep=all')

        await expect(visible(page, 'braces')).toBeVisible()
        await expect(visible(page, 'node-forge')).toBeVisible()
        await expect(rowOf(page, 'braces')).toContainText('No fixed version released')
        await expect(rowOf(page, 'node-forge')).toContainText('No fixed version released')
        const text = await page.locator('main').innerText()
        for (const version of INVENTED) expect(text).not.toContain(version)
    })

    test('opens the way out: health, the blocked nodemon chain, dev tooling only', async function ({ page }) {
        await page.goto('/projects/' + PROJECT_ID + '?dep=all')

        const braces = rowOf(page, 'braces')
        await braces.locator('summary', { hasText: 'Way out' }).click()
        // braces' last publish was 2024-05-21: unmaintained by the six-month rule.
        await expect(braces).toContainText('unmaintained (no publish for 6+ months) → replace it')
        await expect(braces).toContainText('last publish May 21, 2024')
        await expect(braces).toContainText('nodemon@3.1.14 › chokidar@3.6.0 › braces@3.0.3')
        await expect(braces).toContainText('dev tooling only')
        // chokidar 4 drops braces, but nodemon 3.1.14 (its latest) still requires ^3.5.2.
        await expect(braces).toContainText(/chokidar\s*≥\s*4\.0\.0 drops braces, but no released nodemon admits it/)
        await expect(braces).toContainText('^3.5.2')
        await expect(braces).toContainText('Every path reaches only dev tooling')
    })

    test('calls node-forge a direct dependency to replace', async function ({ page }) {
        await page.goto('/projects/' + PROJECT_ID + '?dep=all')

        const forge = rowOf(page, 'node-forge')
        await forge.locator('summary', { hasText: 'Way out' }).click()
        await expect(forge).toContainText('node-forge is a direct dependency — the only way out is to replace it')
        await expect(forge).toContainText('At least one production path reaches this package.')
    })

    test('the advisory export carries the same fix line and way out', async function ({ page }) {
        await page.goto('/projects/' + PROJECT_ID + '?dep=all')

        await page.getByRole('button', { name: 'Advisory', exact: true }).click()
        const downloading = page.waitForEvent('download')
        await page.getByRole('menuitem', { name: 'Download .md' }).click()
        const markdown = await readDownload(await downloading)

        const fixLines = markdown.split('\n').filter(function fix(line) { return line.startsWith('- **Fix:**') })
        expect(fixLines).toHaveLength(2)
        for (const line of fixLines) expect(line).toContain('**No fixed version released**')
        expect(markdown.match(/^- \*\*Way out:\*\*/gm)).toHaveLength(2)
        expect(markdown).toContain('## When no fixed version is released')
        for (const version of INVENTED) expect(markdown).not.toContain(version)
    })
})

test.describe('the About page', function () {
    // The worker now calls npm's registry and download API after scans; the network table must say so.
    test('lists the registry metadata and download-count calls', async function ({ page }) {
        await page.goto('/about')
        await expect(visible(page, 'registry.npmjs.org (package metadata)')).toBeVisible()
        await expect(visible(page, 'api.npmjs.org (download counts)')).toBeVisible()
    })
})
