import { openDb } from '../../../packages/db/src/client'
import { seedPortalDatabase } from './seed'

// Entry point for the seeding child process. Kept separate from seed.ts so the module stays
// importable without side effects, and separate from global-setup.ts because this half must run
// under tsx (ESM) rather than Playwright's CJS config loader.
//
// Reads the row counts back through a FRESH connection before reporting. Writing rows and then
// asserting on the same handle would prove nothing about what a second process — the portal — will
// actually see once the WAL is checkpointed.
const path = seedPortalDatabase()

const { db, sqlite } = openDb({ dbPath: path })
const projects = sqlite.prepare('select count(*) as n from projects').get() as { n: number }
const findings = sqlite.prepare('select count(*) as n from findings').get() as { n: number }
sqlite.close()
void db

console.log('[e2e] seeded ' + path + ' projects=' + projects.n + ' findings=' + findings.n)
