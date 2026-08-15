import { errorAlert, expect, test } from './test-fixtures'

// Settings → Sources: the per-ecosystem switches, and the reference table that explains each source.
//
// Only 'stable' ecosystems are offered, and npm is the only one today, so the page renders one
// Node.js block of three cells. Preview ecosystems have no switch at all — that is the point of
// EcosystemStatus, so there is nothing here to assert about PyPI/Go/crates.io.
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

        // The accessible name stays 'label · ecosystem' even while npm is the only ecosystem offered:
        // the label alone stops identifying a cell the moment a second one is promoted, and a name
        // that changes shape on promotion is a name every assertion here has to be rewritten around.
        await expect(page.getByRole('switch', { name: OSV_NPM })).toHaveAttribute('aria-checked', 'true')
        await expect(page.getByRole('switch', { name: NPM_AUDIT_NPM })).toHaveAttribute('aria-checked', 'false')
        await expect(page.getByRole('switch')).toHaveCount(3)
    })

    // The controls say whether a source is on; this table is the only place that says what it IS.
    // Losing it would leave an operator toggling a 204 MB download with nothing explaining the cost.
    test('explains every source in the reference table, apart from the switches', async function ({ page }) {
        await page.goto('/settings/sources')

        const table = page.getByRole('table')
        await expect(table.getByRole('row')).toHaveCount(4)
        await expect(table.getByText('registry.npmjs.org')).toBeVisible()
        await expect(table.getByText('osv-vulnerabilities.storage.googleapis.com')).toBeVisible()
        await expect(table.getByText('gitlab.com')).toBeVisible()
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

        await expect(page.getByText('Up to date')).toBeVisible()
        // 35 rows: the five original fixtures plus the thirty bulk advisories.
        await expect(page.getByText('35 advisories cached')).toBeVisible()
    })

    // Refresh is an icon-only control now, so its accessible name is the ONLY thing naming it. If
    // that aria-label is ever dropped the button becomes unreachable to a screen reader, and this
    // getByRole is what notices.
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
