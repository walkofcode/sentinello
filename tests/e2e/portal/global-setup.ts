import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

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
export default function globalSetup(): void {
    const repoRoot = process.cwd()
    const seedRun = resolve(repoRoot, 'tests', 'e2e', 'portal', 'seed-run.ts')

    execFileSync('pnpm', ['--filter', '@sentinello/worker', 'exec', 'tsx', seedRun], {
        cwd: repoRoot,
        stdio: 'inherit'
    })
}
