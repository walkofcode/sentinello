import { seedPortalDatabase } from './seed'

// Entry point for the seeding child process. Kept separate from seed.ts so the module stays
// importable without side effects, and separate from global-setup.ts because this half must run
// under tsx (ESM) rather than Playwright's CJS config loader.
const path = seedPortalDatabase()
console.log('[e2e] seeded portal database at ' + path)
