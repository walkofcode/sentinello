import { expect, test } from './test-fixtures'
import { adminState, findingAges } from './admin'
import { readFixtureManifest, SEEDED } from './paths'

const FIXTURE = readFixtureManifest()
const PROJECT_ID = FIXTURE.projects[SEEDED.projectName]

// The scan lifecycle, end to end, against a REAL worker.
//
// This is the one thing no amount of unit testing reaches: the portal enqueues a row, a separate
// process claims it, runs the scanners and writes the result back, and the page reflects it.
//
// Note what is deliberately NOT asserted: the transient "Scanning…" state after a click. The claim
// window is up to POLL_INTERVAL_MS (5s), but an OSV scan of these fixtures takes milliseconds and the
// page only re-renders every 5s, so the in-flight state is frequently never observable. Asserting it
// here would be a flaky test pretending to be a thorough one. It gets its own deterministic test
// below, driven from a row inserted already-running.

test.describe('requesting a scan', function () {
    test('the worker claims it and a new scan appears in the history', async function ({ page }) {
        const before = await adminState()

        await page.goto('/projects/' + PROJECT_ID)
        await page.getByRole('button', { name: 'Scan now' }).click()

        // The whole round trip: enqueue -> poller tick (<=5s) -> claim -> scan -> mark done. Budgeted
        // generously because the poll interval, not the scan, dominates.
        await expect(async function scanned() {
            const now = await adminState()
            expect(now.counts.scans).toBe(before.counts.scans + 1)
            expect(now.inFlight).toBe(0)
        }).toPass({ timeout: 60_000 })
    })

    // The assertion only a real worker can justify, and the reason running one is worth the cost.
    //
    // A rescan finds the same two vulnerabilities. mergeFindingsForScan must REFRESH the open episode
    // rather than close it and open a new one — if it did the latter, every finding's age would reset
    // on every scan and "detected 3 months ago" would silently become "detected just now", which is
    // the number an operator uses to judge how long they have been exposed.
    test('a rescan refreshes the open episode rather than restarting a finding\'s age', async function ({ page }) {
        const before = await adminState()
        expect(before.counts.findings).toBe(2)
        const agesBefore = await findingAges()

        await page.goto('/projects/' + PROJECT_ID)
        await page.getByRole('button', { name: 'Scan now' }).click()
        await expect(async function scanned() {
            const now = await adminState()
            expect(now.counts.scans).toBe(before.counts.scans + 1)
            expect(now.inFlight).toBe(0)
        }).toPass({ timeout: 60_000 })

        // Still two findings, not four: the rescan matched the existing episodes rather than opening
        // new ones alongside them.
        const after = await adminState()
        expect(after.counts.findings).toBe(2)

        // Read from the database rather than the page, because the portal renders this as a relative
        // string ("3 days ago") that would look identical either side of the bug this pins.
        expect(await findingAges()).toEqual(agesBefore)
    })
})

test.describe('a scan already in flight', function () {
    // Driven from a row inserted at status 'running' with a fresh heartbeat. The poller only ever
    // claims 'pending', so the worker will never touch it, and SCAN_HEARTBEAT_STALE_MS keeps it
    // in-flight for a full minute — long enough to assert against without racing anything.
    test('disables the scan control while it runs', async function ({ page, inFlightScan }) {
        await inFlightScan(PROJECT_ID)
        await page.goto('/projects/' + PROJECT_ID)
        await expect(page.getByRole('button', { name: 'Scanning…' })).toBeDisabled()
    })
})
