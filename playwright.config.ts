import { defineConfig, devices } from '@playwright/test'
import { E2E_DB_PATH } from './tests/e2e/portal/paths'

// Portal end-to-end. Runs against a real production build served by `next start`, not the dev
// server, so what is exercised is what ships.
//
// Hermetic by env:
//   SENTINELLO_DB_PATH        points at the seeded temp database (globalSetup builds it)
//   SENTINELLO_UPDATE_FEED_URL=off  kills the GitHub releases lookup the update banner performs
//   SENTINELLO_PORTAL_TOKEN   left UNSET, so auth is fully off and every route is reachable;
//                             the auth-gate spec starts its own server with it set.
const PORT = 3899

export default defineConfig({
    testDir: './tests/e2e/portal',
    testMatch: /.*\.spec\.ts/,
    globalSetup: './tests/e2e/portal/global-setup.ts',
    fullyParallel: true,
    forbidOnly: Boolean(process.env.CI),
    retries: process.env.CI ? 1 : 0,
    workers: process.env.CI ? 1 : undefined,
    reporter: process.env.CI ? 'list' : [['list'], ['html', { open: 'never' }]],
    use: {
        baseURL: 'http://127.0.0.1:' + PORT,
        trace: 'on-first-retry'
    },
    projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
    webServer: {
        command: 'pnpm --filter @sentinello/web start',
        url: 'http://127.0.0.1:' + PORT + '/api/health',
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
        env: {
            PORT: String(PORT),
            SENTINELLO_DB_PATH: E2E_DB_PATH,
            SENTINELLO_UPDATE_FEED_URL: 'off'
        }
    }
})
