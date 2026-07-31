import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test as base, expect, type Locator, type Page } from '@playwright/test'
import { deleteRequest, insertRunningRequest, resetDb } from './admin'
import { E2E_FIXTURE_ROOT } from './paths'

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
    // Rewrites a file inside the fixture tree and puts the original back afterwards.
    writeFixtureFile: (relPath: string, contents: string) => void
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
    },

    // resetDb restores DATABASE rows and nothing else, so a spec that edits the on-disk fixture tree
    // to drive a real rescan would leave every later scan in the run looking at a changed tree. This
    // restores the bytes on teardown, in reverse order, so nested edits unwind correctly.
    writeFixtureFile: async function fixtureFile({}, use) {
        const original: { path: string; contents: string }[] = []
        await use(function write(relPath: string, contents: string) {
            const path = join(E2E_FIXTURE_ROOT, relPath)
            // Read before the first write only. Overwriting the snapshot on a second edit to the same
            // file would restore the intermediate state rather than the fixture's.
            if (!original.some(function seen(o) { return o.path === path })) {
                original.push({ path, contents: readFileSync(path, 'utf8') })
            }
            writeFileSync(path, contents, 'utf8')
        })
        for (const o of original.reverse()) writeFileSync(o.path, o.contents, 'utf8')
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

// The rejected-write message, wherever a settings form renders one.
//
// Never write page.getByRole('alert') directly. Next.js's App Router injects a <next-route-announcer>
// element into every page for screen-reader route changes, it computes as role="alert", and it is
// permanently empty — so a bare getByRole('alert') matches it on a page with no error at all, and
// matches it ALONGSIDE the real one on a page that has one. Filtering on non-whitespace content is
// what separates the form's message from the framework's furniture.
export function errorAlert(page: Page): Locator {
    return page.getByRole('alert').filter({ hasText: /\S/ }).first()
}
