import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { E2E_DB_PATH } from './paths'

// Seeds the database the portal will read. The portal never migrates its own database — apps/web
// deliberately leaves the lifecycle to the worker — so the harness stands in for the worker.
//
// Two constraints shape this file, both from Playwright loading it through a CJS require:
//   - No `import.meta`. Its presence forces the file to be treated as ESM, and the transpiled CJS
//     output then fails with `exports is not defined in ES module scope`. Paths come from
//     process.cwd(), which Playwright sets to the config's directory (the repo root).
//   - No importing @sentinello/db. It is ESM all the way down to better-sqlite3's bindings, so it
//     cannot cross the same boundary. The seeding runs in a child process under tsx instead, inside
//     a workspace that already depends on db — which also gets module resolution right for free.
//
// The database path is computed ONCE here and handed to the child, rather than recomputed on both
// sides. Two independent os.tmpdir() calls in two processes are two chances to disagree, and when
// they do the failure is silent and baffling: openDb creates the missing file, `SELECT 1` succeeds
// so /api/health reports the database as up, and only the content queries fail with
// "no such table: projects".
export default function globalSetup(): void {
    const repoRoot = process.cwd()
    const seedRun = resolve(repoRoot, 'tests', 'e2e', 'portal', 'seed-run.ts')

    const output = execFileSync('pnpm', ['--filter', '@sentinello/worker', 'exec', 'tsx', seedRun], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...process.env, SENTINELLO_E2E_DB_PATH: E2E_DB_PATH }
    })

    process.stdout.write(output)

    // Fail here, loudly and in the right place, rather than letting every content assertion time
    // out five minutes later with a locator error that says nothing about the real cause.
    if (!output.includes('projects=2') || !output.includes('findings=2')) {
        throw new Error('[e2e] seeding did not produce the expected rows at ' + E2E_DB_PATH + '\n' + output)
    }
}
