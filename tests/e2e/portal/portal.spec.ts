import { expect, test } from '@playwright/test'
import { SEEDED } from './paths'
import type { Page } from '@playwright/test'

// The portal renders card and table variants of the same data and hides one by viewport, so a bare
// getByText().first() can resolve to the hidden copy. Always assert against the visible one.
function visible(page: Page, text: string | RegExp) {
    return page.getByText(text).filter({ visible: true }).first()
}

// Exercises the portal as a user meets it: a real production build, a real SQLite database, real
// server components. The unit suite covers the pure logic; this covers the parts only a browser
// against a running server can prove — routing, rendering, auth, and the health contract.

test.describe('health endpoint', function () {
    // Docker's HEALTHCHECK depends on this contract, so it is worth asserting precisely.
    test('reports the database as up without requiring auth', async function ({ request }) {
        const response = await request.get('/api/health')
        expect(response.status()).toBe(200)

        const body = await response.json()
        expect(body.ok).toBe(true)
        expect(body.db).toBe('up')
        expect(body.dataDir).toBe('rw')
    })

    // Deliberately version-free: anyone who can reach the port must not be able to fingerprint the
    // running version here.
    test('does not leak the running version', async function ({ request }) {
        const body = await (await request.get('/api/health')).json()
        expect(body).not.toHaveProperty('version')
    })

    test('is not cached', async function ({ request }) {
        const response = await request.get('/api/health')
        expect(response.headers()['cache-control']).toContain('no-store')
    })
})

test.describe('dashboard', function () {
    // The default view shows only projects that need attention — healthy ones sit behind a
    // "Show healthy" toggle — so the project WITH findings is the one that must be visible here.
    test('renders the project that has findings', async function ({ page }) {
        await page.goto('/')
        await expect(visible(page, SEEDED.projectName)).toBeVisible()
    })

    test('renders without a client-side error', async function ({ page }) {
        const errors: string[] = []
        page.on('pageerror', function record(err) {
            errors.push(err.message)
        })
        await page.goto('/')
        await expect(visible(page, SEEDED.projectName)).toBeVisible()
        expect(errors).toEqual([])
    })

    // SENTINELLO_UPDATE_FEED_URL=off must fully disable the GitHub lookup, so no banner appears
    // and no outbound request is made during the test run.
    test('shows no update banner when the update check is disabled', async function ({ page }) {
        await page.goto('/')
        await expect(visible(page, /available/i)).toHaveCount(0)
    })
})

test.describe('project detail', function () {
    test('lists the seeded finding with its package and installed version', async function ({ page }) {
        await page.goto('/projects/' + SEEDED.projectId)

        await expect(visible(page, 'lodash')).toBeVisible()
        await expect(visible(page, '4.17.11')).toBeVisible()
    })

    // The view defaults to production dependencies only, so the dev-only minimist finding is
    // correctly hidden until the filter is widened. Asserting both halves pins the default.
    test('hides a dev-only finding under the default production filter', async function ({ page }) {
        await page.goto('/projects/' + SEEDED.projectId)
        await expect(visible(page, 'lodash')).toBeVisible()
        await expect(visible(page, 'minimist')).toHaveCount(0)
    })

    test('shows the fix version for a finding that has one', async function ({ page }) {
        await page.goto('/projects/' + SEEDED.projectId)
        await expect(visible(page, '4.17.21')).toBeVisible()
    })

    test('renders a project with no findings without erroring', async function ({ page }) {
        const errors: string[] = []
        page.on('pageerror', function record(err) {
            errors.push(err.message)
        })
        await page.goto('/projects/' + SEEDED.cleanProjectId)
        await expect(visible(page, SEEDED.cleanProjectName)).toBeVisible()
        expect(errors).toEqual([])
    })
})

test.describe('core routes render', function () {
    // A smoke sweep: each of these is a server component reading the database, and a schema or
    // query regression usually surfaces here as a 500 long before any unit test notices.
    for (const path of ['/', '/libraries', '/settings', '/settings/about', '/settings/sources', '/settings/roots']) {
        test('GET ' + path + ' returns 200', async function ({ page }) {
            const response = await page.goto(path)
            expect(response?.status(), path).toBe(200)
        })
    }
})

test.describe('auth', function () {
    // With SENTINELLO_PORTAL_TOKEN unset the portal is deliberately open — this is the default
    // self-hosted posture, and asserting it means an accidental gate would be caught.
    test('is open when no portal token is configured', async function ({ page }) {
        const response = await page.goto('/')
        expect(response?.status()).toBe(200)
        expect(page.url()).not.toContain('/login')
    })
})

test.describe('triage accessibility', function () {
    // These four are the only mechanical guard the .tsx layer has: eslint.config.mjs scopes to
    // **/*.ts and no component in apps/web has a unit test, so nothing else would notice these
    // regressing. Each pins an accessibility property that was absent before, and each doubles as the
    // locator the rest of the UI suite is built on.

    // The grouped library rows used to be bare <TableCell onClick> — no role, no name, no state, and
    // unreachable by keyboard. Deliberately NOT role="button" on the row: these rows contain a mute
    // button and advisory links, and the button role is Children Presentational, which would prune
    // them out of the accessibility tree.
    test('a library row exposes a named, stateful disclosure control', async function ({ page }) {
        await page.goto('/projects/' + SEEDED.projectId)
        await page.getByRole('tab', { name: 'By library' }).click()
        const toggle = page.getByRole('button', { name: 'Show details for lodash' })
        await expect(toggle).toHaveCount(1)
        await expect(toggle).toHaveAttribute('aria-expanded', 'false')
        await toggle.click()
        await expect(toggle).toHaveAttribute('aria-expanded', 'true')
        await expect(visible(page, 'Fixture: prototype pollution in lodash')).toBeVisible()
    })

    // A native <button> rather than a div with a click handler, so Enter and Space come from the
    // platform rather than a hand-written onKeyDown that can silently rot.
    test('the disclosure control is operable from the keyboard', async function ({ page }) {
        await page.goto('/projects/' + SEEDED.projectId)
        await page.getByRole('tab', { name: 'By library' }).click()
        const toggle = page.getByRole('button', { name: 'Show details for lodash' })
        await toggle.focus()
        await page.keyboard.press('Enter')
        await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    })

    // The mute modals hand-rolled their overlay and had no role, no aria-modal, no accessible name
    // and no Escape — an operator on a screen reader got an unannounced overlay they could not
    // dismiss. They now go through components/ui/dialog.tsx like every other modal.
    test('the mute modal is a real dialog and Escape dismisses it', async function ({ page }) {
        await page.goto('/projects/' + SEEDED.projectId)
        await page.getByRole('button', { name: 'Mute finding' }).first().click()
        const dialog = page.getByRole('dialog', { name: 'Mute finding' })
        await expect(dialog).toBeVisible()
        await expect(dialog.getByLabel('Reason (required)')).toBeFocused()
        // The reason is what makes a mute auditable, so the submit stays shut until there is one.
        await expect(dialog.getByRole('button', { name: 'Mute', exact: true })).toBeDisabled()
        await page.keyboard.press('Escape')
        await expect(dialog).toBeHidden()
    })

    // Without the restore, focus falls to <body> on close and a keyboard user resumes tabbing from
    // the top of the page — having lost the control they just used.
    test('closing the dialog returns focus to the control that opened it', async function ({ page }) {
        await page.goto('/projects/' + SEEDED.projectId)
        const trigger = page.getByRole('button', { name: 'Mute finding' }).first()
        await trigger.click()
        await page.keyboard.press('Escape')
        await expect(trigger).toBeFocused()
    })
})
