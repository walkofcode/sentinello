import { openDb } from '../../../packages/db/src/client'
import { seedPortalDatabase } from './seed'
import { E2E_DB_PATH, E2E_FIXTURE_ROOT } from './paths'

// Entry point for the seeding child process. Kept separate from seed.ts so the module stays
// importable without side effects, and separate from global-setup.ts because this half must run
// under tsx (ESM) rather than Playwright's CJS config loader.
//
// Reads back through a FRESH connection before reporting. Asserting on the same handle that wrote the
// rows would prove nothing about what a second process — the portal, and now the worker — will
// actually see once the WAL is checkpointed.
const summary = seedPortalDatabase()

const { db, sqlite } = openDb({ dbPath: E2E_DB_PATH })
const roots = sqlite.prepare('select count(*) as n from roots').get() as { n: number }
const config = sqlite.prepare('select count(*) as n from app_config').get() as { n: number }
const projects = sqlite.prepare('select count(*) as n from projects').get() as { n: number }
sqlite.close()
void db

// projects=0 is CORRECT here and worth printing rather than hiding. The worker's boot sweep discovers
// and scans the tree; global-setup.ts waits for that and is what asserts the baseline arrived. Seeing
// a zero here and a non-zero there is the difference between "the seed is wrong" and "the worker
// never came up", which is the first question anyone debugging this will have.
console.log(
    '[e2e] seeded ' + summary +
    ' roots=' + roots.n + ' config=' + config.n + ' projects=' + projects.n + ' (worker discovers)' +
    '\n[e2e] fixture tree at ' + E2E_FIXTURE_ROOT
)
