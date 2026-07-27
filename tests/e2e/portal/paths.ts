import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Constants only. This module is imported by playwright.config.ts, which Playwright loads through a
// CJS require — so it must never reach into @sentinello/db, whose ESM graph cannot cross that
// boundary. The seeding itself lives in seed.ts and runs in its own process.

// A fixed path so the setup process and the webServer agree without passing state between them.
export const E2E_DB_PATH = join(tmpdir(), 'sentinello-portal-e2e', 'portal.sqlite')

export const SEEDED = {
    rootId: 'e2e-root',
    rootPath: '/e2e/repos',
    projectId: 'e2e-project-web',
    projectName: 'checkout-service',
    cleanProjectId: 'e2e-project-clean',
    cleanProjectName: 'docs-site'
}
