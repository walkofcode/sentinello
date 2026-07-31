import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test as base, expect, type Locator, type Page } from '@playwright/test'
import { deleteRequest, insertRunningRequest, resetDb } from './admin'
import { E2E_FIXTURE_ROOT } from './paths'

// The base test for MUTATING specs (*.write.spec.ts). Read-only specs use `readTest` below, which
// shares the hydration handling and nothing else.
//
// Every test starts from the baseline the worker's boot sweep produced, restored in place. There is
// no write isolation between Playwright workers — one SQLite file, one portal, one worker — so the
// `write` project runs workers:1 and that is what makes an unconditional per-test reset safe.

// Injected into the DOM by the App Router's client runtime on mount, and absent from the server HTML
// — verified with curl against `next start`, not assumed. That makes its arrival the moment React has
// taken over the page.
const HYDRATION_MARKER = 'next-route-announcer'

// page.goto resolves on 'load', which is BEFORE React hydrates. Every interaction in the window
// between the two is silently lost, and the resulting failure never names the cause: a fill() writes
// to a DOM node React then overwrites from its own initial state, and a click on a server-rendered
// <form>'s submit button runs a NATIVE submission — the form carries no action attribute, so the
// browser simply reloads the page and the write never happens.
//
// It reproduced as roughly one failure in three across settings.export.write.spec.ts, moving between
// tests run to run, which is exactly the shape that gets written off as "flaky CI".
//
// Patching goto/reload rather than exporting a helper each spec must remember: there are well over a
// hundred navigations across this suite, and a helper that is right only when someone recalls it is
// not a fix. Both are patched because a reload re-runs hydration in full.
function hydrateOnNavigation(page: Page): void {
    const goto = page.goto.bind(page)
    page.goto = async function gotoThenHydrate(url, options) {
        const response = await goto(url, options)
        await page.waitForSelector(HYDRATION_MARKER, { state: 'attached' })
        return response
    }
    const reload = page.reload.bind(page)
    page.reload = async function reloadThenHydrate(options) {
        const response = await reload(options)
        await page.waitForSelector(HYDRATION_MARKER, { state: 'attached' })
        return response
    }
}

type Fixtures = {
    // Auto-used: the reset happens before the test body whether or not the test names it.
    resetDb: void
    // A scan request already in the running state, for asserting the in-flight UI deterministically.
    inFlightScan: (projectId: string) => Promise<void>
    // Rewrites a file inside the fixture tree and puts the original back afterwards.
    writeFixtureFile: (relPath: string, contents: string) => void
}

// Read-only specs that INTERACT with the page need the hydration handling too — a filter dropdown is
// as unclickable before hydration as a submit button. Specs that only assert server-rendered content
// can keep importing @playwright/test directly.
export const readTest = base.extend({
    page: async function hydratedPage({ page }, use) {
        hydrateOnNavigation(page)
        await use(page)
    }
})

export const test = base.extend<Fixtures>({
    page: async function hydratedPage({ page }, use) {
        hydrateOnNavigation(page)
        await use(page)
    },

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

// fill() that survives hydration. Use it for every controlled input in a write spec.
//
// Playwright's fill() clears the field and types into the DOM node. If React hydrates that component
// in the moment between the clear and the type, it restores the value from its OWN state — and the
// field ends up holding what you typed CONCATENATED with what was already there. Caught in the act:
// filling '   ' into the export prompt produced a 10,224-character value, three spaces followed by the
// entire default prompt, which then saved successfully and made a test asserting a rejection fail.
//
// It is not fixable by waiting on a document-level hydration signal, because App Router hydration is
// progressive — the shell can be live while this island is not, and no marker announces the island.
// Retrying until the field holds exactly what was asked for is what actually converges.
export async function fillStable(field: Locator, text: string): Promise<void> {
    await expect(async function typed() {
        await field.fill(text)
        expect(await field.inputValue()).toBe(text)
    }).toPass({ timeout: 15_000 })
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
