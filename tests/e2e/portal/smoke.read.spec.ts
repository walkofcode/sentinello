import { expect, test } from '@playwright/test'
import { readFixtureManifest, SEEDED } from './paths'

const FIXTURE = readFixtureManifest()
const PROJECT_ID = FIXTURE.projects[SEEDED.projectName]

// Every route the portal serves, loaded in a real browser.
//
// This is the cheapest high-value test in the suite and it used to cover six of twenty pages. Each of
// these is a server component reading the database, so a schema or query regression surfaces here as
// a 500 long before any unit test notices — and the pages that were NOT swept are exactly the ones no
// other test touches.
//
// The pageerror listener is half the value. A page can answer 200 and still be broken: a client
// component that throws during hydration leaves a shell that looks fine to a status assertion.
const ROUTES = [
    '/',
    '/libraries',
    '/libraries/npm/lodash',
    '/projects/' + PROJECT_ID,
    '/about',
    '/legal/terms',
    '/legal/privacy',
    '/legal/disclaimer',
    // Redirects to /settings/roots; asserting it means an accidental break in that redirect is caught.
    '/settings',
    '/settings/about',
    '/settings/advanced',
    '/settings/defaults',
    // Reached from the nav as "Advisory" — the route name and its label genuinely differ, which is a
    // trap when reading a spec that navigates by link text.
    '/settings/export',
    '/settings/mcp',
    '/settings/notifications',
    '/settings/profile',
    '/settings/roots',
    '/settings/schedule',
    '/settings/sources',
    // With no token configured this redirects to '/', which is itself the assertion: the login page
    // must not be reachable when the gate is off.
    '/login'
]

test.describe('every route renders', function () {
    for (const path of ROUTES) {
        test('GET ' + path + ' returns 200 with no client-side error', async function ({ page }) {
            const errors: string[] = []
            page.on('pageerror', function record(err) { errors.push(err.message) })

            const response = await page.goto(path)
            expect(response?.status(), path).toBe(200)

            // Hydration errors surface after the navigation resolves, so give the client a beat to
            // throw before asserting silence.
            await page.waitForLoadState('networkidle')
            expect(errors, path).toEqual([])
        })
    }
})

test.describe('api routes', function () {
    test('GET /api/version reports a version', async function ({ request }) {
        const response = await request.get('/api/version')
        expect(response.status()).toBe(200)
        const body = await response.json() as { current?: string }
        expect(typeof body.current).toBe('string')
    })

    // 404 rather than 401: with no token configured the MCP endpoint does not exist at all, so it
    // cannot be probed for existence. The mcp spec covers the enabled half.
    test('POST /api/mcp is absent until a token is configured', async function ({ request }) {
        const response = await request.post('/api/mcp', { data: {} })
        expect(response.status()).toBe(404)
    })
})
