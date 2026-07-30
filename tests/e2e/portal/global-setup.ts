import { existsSync } from 'node:fs'
import { awaitBaseline } from './admin'
import { assertFreshBuild } from './build-guard'
import {
    E2E_DB_PATH,
    E2E_LOCK_DIR,
    E2E_MANIFEST_PATH,
    FIXTURE_VERSION,
    PORT_AUTH,
    PORT_OPEN,
    SEEDED,
    readFixtureManifest,
    repoRoot
} from './paths'

// What the worker's boot sweep must produce before any test runs. Not a hand-written fixture — these
// are the counts the real scanner emits from the frozen tree (see tests/e2e/portal/fixture-tree.ts):
// three projects, one scan each, and two findings on checkout-service. axios is deliberately absent
// because its advisory is already fixed at the installed version.
const EXPECTED = { projects: 3, scans: 3, findings: 2 }

// Verification only — the seeding itself happens in `pnpm test:e2e:seed`, BEFORE Playwright is
// launched at all.
//
// That ordering is the whole point, and it was not obvious. Playwright starts the webServers BEFORE
// globalSetup, so seeding here was too late: the readiness probe on /api/health opened the database
// first, openDb created the missing file, apps/web cached the connection in its
// globalThis.__sentinelloDb singleton, and the seed then replaced that file with a fresh inode. The
// server kept querying the deleted one and every request failed with "no such table: projects" —
// while /api/health still reported the database as up, because SELECT 1 works fine on an empty one.
//
// Worse, it passed locally and only failed in CI: a previous run left a seeded file behind, so the
// server's stale handle happened to hold the right data. A green run on stale state is the failure
// mode these checks exist to make impossible.
export default async function globalSetup(): Promise<void> {
    // 1. Seeded at all.
    if (!existsSync(E2E_DB_PATH)) {
        throw new Error(
            '[e2e] no seeded database at ' + E2E_DB_PATH + '. Run `pnpm test:e2e` rather than ' +
            '`playwright test` directly — the database must be seeded before the servers start.'
        )
    }
    if (!existsSync(E2E_MANIFEST_PATH)) {
        throw new Error('[e2e] no fixture manifest at ' + E2E_MANIFEST_PATH + '. Re-run `pnpm test:e2e`.')
    }

    // 2. The build being served is not older than the code under test.
    assertFreshBuild(repoRoot())

    // 3. The fixture is the one this checkout expects, and the worker's boot sweep has finished.
    //
    // This REPLACES the old "database is at least 50 KB" heuristic, and the replacement is mandatory
    // rather than an improvement. With a worker in the webServer list an unseeded database now gets
    // MIGRATED at worker boot, which pushes an empty one well past 50,000 bytes — so the size check
    // would go green on a database with no rows in it at all. Content is the only honest signal now.
    const manifest = readFixtureManifest()
    if (manifest.version !== FIXTURE_VERSION) {
        throw new Error(
            '[e2e] fixture manifest is version ' + manifest.version + ' but this checkout expects ' +
            FIXTURE_VERSION + '. A stale temp directory from another branch — re-run `pnpm test:e2e`.'
        )
    }
    const counts = await awaitBaseline(120_000, EXPECTED)
    if (!counts.projects) {
        throw new Error('[e2e] the worker produced no projects. Check the worker output above.')
    }

    // 4. The worker is actually alive and holding its single-instance lock. Without this a worker that
    //    died right after printing its ready line reads as a healthy run with a frozen scan queue.
    if (!existsSync(E2E_LOCK_DIR)) {
        throw new Error(
            '[e2e] the worker is not holding its lock at ' + E2E_LOCK_DIR + '. It printed its ready ' +
            'line and then exited — check the worker output above.'
        )
    }

    // 5. The portal is reading the database that was actually seeded. This is the one-line diagnosis
    //    for the class of bug the [e2e] echo in the webServer command exists to catch: when the server
    //    ends up on a different file, /api/health still reports the database as up and every other
    //    symptom is a misleading locator timeout.
    const html = await (await fetch('http://127.0.0.1:' + PORT_OPEN + '/')).text()
    if (!html.includes(SEEDED.projectName)) {
        throw new Error(
            '[e2e] the portal on :' + PORT_OPEN + ' does not show ' + SEEDED.projectName + '. It is ' +
            'serving a different database than the one seeded at ' + E2E_DB_PATH + '.'
        )
    }

    // 6. The auth server really received the token. isPortalAuthEnabled reads process-level env, so
    //    the only proof that it reached the second process is the gate behaving.
    const gated = await fetch('http://127.0.0.1:' + PORT_AUTH + '/', { redirect: 'manual' })
    if (gated.status < 300 || gated.status >= 400) {
        throw new Error(
            '[e2e] the portal on :' + PORT_AUTH + ' answered ' + gated.status + ' instead of redirecting ' +
            'to /login. SENTINELLO_PORTAL_TOKEN did not reach it, so the auth specs would test nothing.'
        )
    }
}
