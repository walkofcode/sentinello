import { errorAlert, expect, test } from './test-fixtures'

// Settings → Sources: the Languages × Sources matrix.
//
// The seed leaves exactly one cell active — OSV · npm, with npm-audit off because it spawns the
// package manager and needs the registry. That is not incidental to this file, it is what makes the
// "at least one source must stay enabled" invariant reachable through the UI at all: with a single
// active cell, the very first switch a spec touches is the last one.

const OSV_NPM = 'OSV · npm'
const NPM_AUDIT_NPM = 'npm audit · npm'
const INVARIANT = 'At least one vulnerability source must stay enabled — Sentinello cannot run with zero sources.'

test.describe('the source matrix', function () {
    test('renders one switch per (source, ecosystem) cell, named for both', async function ({ page }) {
        await page.goto('/settings/sources')

        // The accessible name is 'label · ecosystem' precisely because the label alone repeats down the
        // page — four ecosystems each offer OSV, so "OSV" identifies nothing on its own.
        await expect(page.getByRole('switch', { name: OSV_NPM })).toHaveAttribute('aria-checked', 'true')
        await expect(page.getByRole('switch', { name: NPM_AUDIT_NPM })).toHaveAttribute('aria-checked', 'false')
        await expect(page.getByRole('switch', { name: 'OSV · PyPI' })).toHaveAttribute('aria-checked', 'false')
    })

    test('a cell can be enabled and disabled once another one is active', async function ({ page }) {
        await page.goto('/settings/sources')
        const npmAudit = page.getByRole('switch', { name: NPM_AUDIT_NPM })

        await npmAudit.click()
        await expect(npmAudit).toHaveAttribute('aria-checked', 'true')
        await page.reload()
        await expect(npmAudit).toHaveAttribute('aria-checked', 'true')

        // Now that two cells are active, OSV is no longer the last one and may be turned off.
        const osv = page.getByRole('switch', { name: OSV_NPM })
        await osv.click()
        await expect(osv).toHaveAttribute('aria-checked', 'false')
        await expect(errorAlert(page)).toHaveCount(0)
        await page.reload()
        await expect(osv).toHaveAttribute('aria-checked', 'false')
    })
})

test.describe('the always-a-source-on invariant', function () {
    // The regression this pins is not "the write is rejected" — the action test covers that. It is that
    // the operator is TOLD. This assertion failed against the shipped build: the message was replaced
    // by Next.js's production redaction notice, because the action threw it instead of returning it.
    test('explains itself when the last active cell is switched off', async function ({ page }) {
        await page.goto('/settings/sources')
        const osv = page.getByRole('switch', { name: OSV_NPM })

        await osv.click()

        await expect(errorAlert(page)).toHaveText(INVARIANT)
    })

    test('puts the switch back rather than leaving it showing a state the server refused', async function ({ page }) {
        await page.goto('/settings/sources')
        const osv = page.getByRole('switch', { name: OSV_NPM })

        await osv.click()

        // The flip is optimistic, so this only means anything once the round trip has landed — which
        // the error appearing proves.
        await expect(errorAlert(page)).toBeVisible()
        await expect(osv).toHaveAttribute('aria-checked', 'true')
    })

    test('does not persist the refused write', async function ({ page }) {
        await page.goto('/settings/sources')
        await page.getByRole('switch', { name: OSV_NPM }).click()
        await expect(errorAlert(page)).toBeVisible()

        await page.reload()

        await expect(page.getByRole('switch', { name: OSV_NPM })).toHaveAttribute('aria-checked', 'true')
    })

    test('clears the message once a later write succeeds', async function ({ page }) {
        await page.goto('/settings/sources')
        await page.getByRole('switch', { name: OSV_NPM }).click()
        await expect(errorAlert(page)).toBeVisible()

        await page.getByRole('switch', { name: NPM_AUDIT_NPM }).click()
        await expect(page.getByRole('switch', { name: NPM_AUDIT_NPM })).toHaveAttribute('aria-checked', 'true')

        // Per-cell state: the failed cell keeps its message until IT is retried. What must not happen is
        // a stale error outliving the condition that caused it, so retry the same cell and watch it go.
        await page.getByRole('switch', { name: OSV_NPM }).click()
        await expect(errorAlert(page)).toHaveCount(0)
    })
})

test.describe('cache-backed source status', function () {
    // OSV is the only cell the seed enables, and seed-osv.ts pins refreshedAt to a fixed instant, so
    // this block is assertable where a live source's status never would be.
    test('reports the seeded cache as up to date with its record count', async function ({ page }) {
        await page.goto('/settings/sources')

        await expect(page.getByText('Sync status')).toBeVisible()
        await expect(page.getByText('Up to date')).toBeVisible()
        // 35 rows: the five original fixtures plus the thirty bulk advisories.
        await expect(page.getByText('35 advisories cached')).toBeVisible()
    })

    test('acknowledges a refresh request without claiming it has finished', async function ({ page }) {
        await page.goto('/settings/sources')

        await page.getByRole('button', { name: 'Refresh now' }).click()

        // The button only enqueues a worker signal. Saying so is the honest thing for a control whose
        // work happens in another process on its own schedule.
        await expect(page.getByText('Refresh requested — it runs in the background.')).toBeVisible()
    })

    test('shows no sync status for a source that is switched off', async function ({ page }) {
        await page.goto('/settings/sources')

        // gemnasium is off everywhere, so its cells carry the provisioning disclosure instead of a
        // record count — the download has never happened.
        await expect(page.getByRole('switch', { name: 'GitLab gemnasium · npm' })).toHaveAttribute('aria-checked', 'false')
        await expect(page.getByText('advisories cached')).toHaveCount(1)
    })
})
