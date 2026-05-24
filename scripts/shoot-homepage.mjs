// Captures the light + dark screenshot sets rendered by the homepage Screenshots section
// (apps/homepage/components/sections/screenshots.tsx). Each of the four screens is shot once per
// theme into apps/homepage/public/screenshots/<key>-<theme>.png at 1440x900 @2x (2880x1800), which
// is the size the homepage <Image> tags expect.
//
// The portal must already be running and seeded with the demo-projects before you run this:
//   pnpm demo:gen && pnpm demo:up      # Docker, seeded, http://localhost:3870  (default target)
// or, against a manually-seeded dev portal:
//   SHOOT_BASE_URL=http://localhost:3870 pnpm shoot
//
// Then: pnpm shoot

import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const OUT_DIR = join(ROOT, 'apps/homepage/public/screenshots')
const BASE_URL = process.env.SHOOT_BASE_URL || 'http://localhost:3870'
const VIEWPORT = { width: 1440, height: 900 }
const THEMES = ['light', 'dark']

// Runs in the browser: pin next-themes to an explicit theme so the light set is never accidentally
// dark when the runner's OS prefers dark (next-themes defaults to 'system').
function pinTheme(theme) {
    localStorage.setItem('theme', theme)
}

async function firstHref(page, selector) {
    const count = await page.locator(selector).count()
    if (count === 0) {
        return null
    }
    return await page.locator(selector).first().getAttribute('href')
}

async function captureScreen(page, key, url) {
    for (const theme of THEMES) {
        await page.goto(BASE_URL + url, { waitUntil: 'networkidle' })
        await page.evaluate(pinTheme, theme)
        await page.reload({ waitUntil: 'networkidle' })
        // Let next-themes paint the resolved class and any lazy images settle before the shot.
        await page.waitForTimeout(600)
        const file = join(OUT_DIR, key + '-' + theme + '.png')
        await page.screenshot({ path: file })
        console.log('  wrote ' + key + '-' + theme + '.png')
    }
}

async function main() {
    const browser = await chromium.launch()
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 })
    const page = await context.newPage()

    // Discover the project + library targets from the live pages so we never hardcode the hashed
    // project IDs or the demo package names. After the Projects/Libraries split, projects live on /
    // and libraries on /libraries — each page is its own scrape source.
    await page.goto(BASE_URL + '/', { waitUntil: 'networkidle' })
    const projectHref = await firstHref(page, 'a[href^="/projects/"]')
    await page.goto(BASE_URL + '/libraries', { waitUntil: 'networkidle' })
    const libraryHref = await firstHref(page, 'a[href^="/libraries/"]')
    if (!projectHref || !libraryHref) {
        throw new Error('Pages have no project/library links — is the portal running at ' + BASE_URL + ' and seeded with the demo-projects?')
    }

    const screens = [
        { key: 'dashboard', url: '/' },
        { key: 'project', url: projectHref },
        { key: 'library', url: libraryHref },
        { key: 'export', url: '/settings/export' }
    ]

    for (const screen of screens) {
        console.log(screen.key + ':')
        await captureScreen(page, screen.key, screen.url)
    }

    await browser.close()
    console.log('Done — 8 screenshots written to ' + OUT_DIR)
}

main().catch(function onError(err) {
    console.error(err)
    process.exit(1)
})
