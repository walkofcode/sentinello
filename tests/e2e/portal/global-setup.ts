import { existsSync, statSync } from 'node:fs'
import { E2E_DB_PATH } from './paths'

// Verification only — the seeding itself happens in `pnpm test:e2e:seed`, BEFORE Playwright is
// launched at all.
//
// That ordering is the whole point, and it was not obvious. Playwright starts the webServer BEFORE
// globalSetup, so seeding here was too late: the readiness probe on /api/health opened the database
// first, openDb created the missing file, apps/web cached the connection in its
// globalThis.__sentinelloDb singleton, and the seed then replaced that file with a fresh inode. The
// server kept querying the deleted one and every request failed with "no such table: projects" —
// while /api/health still reported the database as up, because SELECT 1 works fine on an empty one.
//
// Worse, it passed locally and only failed in CI: a previous run left a seeded file behind, so the
// server's stale handle happened to hold the right data. A green run on stale state is the failure
// mode this check exists to make impossible.
export default function globalSetup(): void {
    if (!existsSync(E2E_DB_PATH)) {
        throw new Error(
            '[e2e] no seeded database at ' + E2E_DB_PATH + '. Run `pnpm test:e2e` rather than ' +
            '`playwright test` directly — the database must be seeded before the server starts.'
        )
    }

    // A database created by the server rather than the seeder is a few KB of empty schema-less file.
    const size = statSync(E2E_DB_PATH).size
    if (size < 50_000) {
        throw new Error(
            '[e2e] the database at ' + E2E_DB_PATH + ' is only ' + size + ' bytes, which means the ' +
            'server created an empty one before the seed ran. Re-run `pnpm test:e2e`.'
        )
    }
}
