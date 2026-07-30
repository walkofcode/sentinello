import { test as base, expect, type Locator, type Page } from '@playwright/test'
import { deleteRequest, insertRunningRequest, resetDb } from './admin'

// The base test for MUTATING specs (*.write.spec.ts). Read-only specs import @playwright/test
// directly and never touch the database.
//
// Every test starts from the baseline the worker's boot sweep produced, restored in place. There is
// no write isolation between Playwright workers — one SQLite file, one portal, one worker — so the
// `write` project runs workers:1 and that is what makes an unconditional per-test reset safe.

type Fixtures = {
    // Auto-used: the reset happens before the test body whether or not the test names it.
    resetDb: void
    // A scan request already in the running state, for asserting the in-flight UI deterministically.
    inFlightScan: (projectId: string) => Promise<void>
}

export const test = base.extend<Fixtures>({
    resetDb: [
        async function reset({}, use) {
            await resetDb()
            await use()
        },
        { auto: true }
    ],

    inFlightScan: async function inFlight({}, use) {
        const created: string[] = []
        await use(async function start(projectId: string) {
            created.push(await insertRunningRequest(projectId))
        })
        // Removed here rather than left to the reset, so a failure inside the test does not leave the
        // scan buttons disabled for whatever runs before the next reset lands.
        for (const id of created) await deleteRequest(id)
    }
})

export { expect }

// The portal renders card and table variants of the same data and hides one by viewport, so a bare
// getByText().first() can resolve to the hidden copy. Always assert against the visible one.
export function visible(page: Page, text: string | RegExp): Locator {
    return page.getByText(text).filter({ visible: true }).first()
}

// The role twin of visible(). Every duplicated table duplicates its BUTTONS too — the desktop table
// and the md:hidden card list both render a MuteDialog with the same accessible name — so getByRole
// is exactly as ambiguous as getByText and needs the same filter.
export function visibleRole(page: Page, role: Parameters<Page['getByRole']>[0], name: string | RegExp): Locator {
    return page.getByRole(role, { name }).filter({ visible: true }).first()
}
