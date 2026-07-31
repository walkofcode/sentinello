import { defineConfig, devices } from '@playwright/test'
import {
    E2E_DB_PATH,
    E2E_OSV_DB_PATH,
    E2E_PORTAL_TOKEN,
    PORT_AUTH,
    PORT_OPEN,
    WORKER_READY_LINE
} from './tests/e2e/portal/paths'

// Portal end-to-end. Runs against a real production build served by `next start`, not the dev server,
// so what is exercised is what ships — and alongside a REAL apps/worker process, so a queued scan is
// actually claimed, executed and completed rather than sitting pending forever.
//
// Hermetic by construction rather than by mocking:
//   - the worker walks a generated fixture tree of frozen projects under $TMPDIR (fixture-tree.ts)
//   - scanning goes through OSV only, against a hand-seeded local cache (seed-osv.ts). npm audit
//     spawns the package manager and needs the registry; OSV reads a lockfile and SQLite.
//   - every advisory feed is switched off, so no sync ever reaches the network
//   - notifications are in dry-run, because a real worker dispatches after EVERY completed scan
//
// See tests/e2e/portal/paths.ts for the import rule that governs which files may touch packages/*.

const OPEN = 'http://127.0.0.1:' + PORT_OPEN
const AUTH = 'http://127.0.0.1:' + PORT_AUTH

function escapeRe(literal: string): string {
    return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const SHARED_ENV = {
    SENTINELLO_DB_PATH: E2E_DB_PATH,
    // Explicit even though the sibling rule in packages/db/src/osv-client.ts would agree: an
    // implicitly-resolved cache that lands one directory off reports every project clean, silently.
    SENTINELLO_OSV_DB_PATH: E2E_OSV_DB_PATH,
    SENTINELLO_UPDATE_FEED_URL: 'off',
    SENTINELLO_OSV_FEED_URL: 'off',
    SENTINELLO_GEMNASIUM_FEED_URL: 'off',
    // Belt and braces on top of the dryRunNotify config the seed writes: blocks private ranges
    // outright if a target ever escapes the dry-run flag.
    SENTINELLO_WEBHOOK_STRICT: '1',
    // The poller claims one request per tick, so its 5s production default sets the floor on every
    // scan assertion in the suite — and makes the 21 scans that scan.history.write.spec.ts needs to
    // reach a pagination control take 105s, past the write project's own timeout. The scans themselves
    // are ~3ms against these fixtures; this only removes the wait for the tick.
    SENTINELLO_SCAN_POLL_INTERVAL_MS: '200'
}

export default defineConfig({
    testDir: './tests/e2e/portal',
    testMatch: /.*\.spec\.ts/,
    globalSetup: './tests/e2e/portal/global-setup.ts',
    forbidOnly: Boolean(process.env.CI),
    retries: process.env.CI ? 1 : 0,
    workers: process.env.CI ? 1 : undefined,
    reporter: process.env.CI ? 'list' : [['list'], ['html', { open: 'never' }]],
    use: { baseURL: OPEN, trace: 'on-first-retry' },

    projects: [
        // Read-only specs. They share one database and never write to it, so they parallelise freely.
        {
            name: 'read',
            testMatch: /.*\.read\.spec\.ts/,
            fullyParallel: true,
            timeout: 30_000,
            use: { ...devices['Desktop Chrome'], baseURL: OPEN }
        },
        // Mutating specs. One database, one worker, no write isolation — so exactly one mutating test
        // runs at a time. fullyParallel:false keeps declaration order WITHIN a file; workers:1 is what
        // serialises ACROSS files, which is what makes a per-test reset safe.
        {
            name: 'write',
            testMatch: /.*\.write\.spec\.ts/,
            fullyParallel: false,
            workers: 1,
            dependencies: ['read'],
            timeout: 90_000,
            use: { ...devices['Desktop Chrome'], baseURL: OPEN }
        },
        // The auth gate, against the second server. Its own port because the token is read from
        // process-level env by lib/portal-auth.ts.
        {
            name: 'auth',
            testMatch: /.*\.auth\.spec\.ts/,
            fullyParallel: true,
            timeout: 30_000,
            use: { ...devices['Desktop Chrome'], baseURL: AUTH }
        }
    ],

    webServer: [
        {
            name: 'worker',
            // Launched directly rather than through `pnpm --filter`, matching ecosystem.config.js: a
            // shell wrapper is how SIGTERM gets swallowed and a worker outlives its runner.
            command: 'node --import tsx src/index.ts',
            cwd: './apps/worker',
            // The worker exposes no HTTP, so there is nothing to probe — Playwright's stdout wait is
            // what makes it startable as a webServer at all. Supplying `wait` with neither url nor
            // port is legal; the "either port or url" error fires only when BOTH are given.
            wait: { stdout: new RegExp(escapeRe(WORKER_READY_LINE)) },
            stdout: 'pipe',
            stderr: 'pipe',
            timeout: 60_000,
            // Below the worker's own 30s grace period plus its 5s force-exit, so a wedged worker is
            // killed rather than adding 35s to every failing run. Fixture scans take milliseconds.
            gracefulShutdown: { signal: 'SIGTERM', timeout: 20_000 },
            env: SHARED_ENV
        },
        {
            // The echo is deliberate and permanent. When the server ends up on a different database
            // than the one that was seeded, every symptom is misleading — /api/health still reports the
            // database as up, because openDb creates the missing file and `SELECT 1` succeeds against
            // an empty one. Printing the path the server actually received turns a baffling wall of
            // locator timeouts into a one-line diagnosis.
            name: 'portal',
            command: 'node -e "console.error(\'[e2e] open server SENTINELLO_DB_PATH=\' + process.env.SENTINELLO_DB_PATH)" && pnpm --filter @sentinello/web start',
            url: OPEN + '/api/health',
            // Not cosmetic: the seed deletes and recreates the data directory, so any server left over
            // from a previous run is holding a DELETED inode. Reusing it is the exact failure
            // global-setup.ts documents, and it would present as "no such table: projects".
            reuseExistingServer: false,
            timeout: 180_000,
            env: { ...SHARED_ENV, PORT: String(PORT_OPEN) }
        },
        {
            name: 'portal-auth',
            command: 'pnpm --filter @sentinello/web start',
            // /api/health is in EXEMPT_PREFIXES (apps/web/proxy.ts), so it stays probe-able with the
            // gate on — every other route would answer 307 to /login and never look ready.
            url: AUTH + '/api/health',
            reuseExistingServer: false,
            timeout: 180_000,
            env: { ...SHARED_ENV, PORT: String(PORT_AUTH), SENTINELLO_PORTAL_TOKEN: E2E_PORTAL_TOKEN }
        }
    ]
})
