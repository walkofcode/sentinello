import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// Constants, and one function that reads a file. This module is imported by playwright.config.ts,
// which Playwright loads through a CJS require — so it must never reach into @sentinello/db, whose
// ESM graph cannot cross that boundary. The seeding itself lives in seed.ts and runs in its own
// process under tsx.
//
// That rule generalises across the harness and is worth stating once: anything Playwright's own
// loader touches (this file, admin.ts, build-guard.ts, global-setup.ts, every *.spec.ts) may import
// only node:* builtins. Anything tsx runs (seed*.ts, db-admin*.ts, fixture-tree.ts) may import
// packages/*/src/** by relative path.

// Walks up for the workspace marker rather than deriving from import.meta.url.
//
// That distinction is load-bearing, not stylistic: Playwright loads this module and everything it
// touches through a CJS require, where `import.meta` is a syntax-level error — it fails as
// "exports is not defined in ES module scope" pointing at the import line, which names neither the
// real file nor the real cause. tsx loads the same modules as ESM, where __dirname does not exist.
// Walking from cwd is the one form that works under both loaders.
export function repoRoot(): string {
    let dir = process.cwd()
    for (;;) {
        if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
        const parent = dirname(dir)
        if (parent === dir) throw new Error('[e2e] no pnpm-workspace.yaml above ' + process.cwd())
        dir = parent
    }
}

export const E2E_TMP_ROOT = join(tmpdir(), 'sentinello-portal-e2e')

// The database lives one level down in data/ rather than at the top of the temp root, because
// packages/db/src/osv-client.ts defines the OSV cache as the SIBLING of the primary database and
// packages/db/src/client.ts does the same for the worker's lock. Putting all three in their own
// directory keeps the on-disk fixture tree out of the way of anything that resolves by sibling.
export const E2E_DATA_DIR = join(E2E_TMP_ROOT, 'data')
export const E2E_DB_PATH = join(E2E_DATA_DIR, 'portal.sqlite')
export const E2E_OSV_DB_PATH = join(E2E_DATA_DIR, 'osv.db')

// proper-lockfile appends '.lock' to the path it is given and creates it as a DIRECTORY whose mtime
// it refreshes for as long as the lock is held. That makes this path a liveness signal, which
// seed-run.ts uses to refuse to run while a worker from a previous run is still alive.
export const E2E_LOCK_DIR = join(E2E_DATA_DIR, 'sentinello.worker.lock.lock')

// The root the worker actually walks. Real directories with real lockfiles, generated per run — the
// same shape `pnpm demo:gen` produces for manual testing, but built from the frozen fixtures under
// tests/fixtures so it needs no network and its findings never drift.
export const E2E_FIXTURE_ROOT = join(E2E_TMP_ROOT, 'roots', 'e2e')

export const E2E_MANIFEST_PATH = join(E2E_TMP_ROOT, 'fixture.json')
export const E2E_BASELINE_PATH = join(E2E_TMP_ROOT, 'baseline.json')

// Two portals: one open (the default self-hosted posture) and one with a token set. The gate is read
// from process-level env by lib/portal-auth.ts, so testing both states needs two processes.
export const PORT_OPEN = 3899
export const PORT_AUTH = 3898
export const E2E_PORTAL_TOKEN = 'e2e-portal-token'

// Bumped whenever seed.ts changes what it produces, so a stale temp directory from an older checkout
// fails the content guard in global-setup.ts loudly instead of running tests against the wrong shape.
export const FIXTURE_VERSION = 2

// Printed by apps/worker/src/worker.ts once the scheduler, poller and mute-expiry sweep are armed.
// Playwright waits on this line to know the worker is up — it exposes no HTTP to probe. A contract
// test in tests/e2e/portal/worker-ready-line.test.ts asserts the worker still prints it, because the
// failure mode of an edited log message is a silent 60s timeout rather than an obvious error.
export const WORKER_READY_LINE = '[worker] scheduler + scan-request poller + mute-expiry running'

export const SEEDED = {
    rootId: 'e2e-root',
    rootLabel: 'E2E fixtures',
    // Names are the directory basenames, because discovery derives a project's name from its
    // directory and overwrites whatever else is in the row. Hand-writing a name that disagreed with
    // the directory is exactly the bug this harness was reshaped to make impossible.
    projectName: 'checkout-service',
    cleanProjectName: 'docs-site',
    unauditableProjectName: 'legacy-yarn',
    // Exists for one reason: apps/web/components/ui/pagination.tsx returns null at or below its page
    // size, so with only checkout-service's two findings NO pagination control renders anywhere in the
    // portal and four paginated sections are unreachable. 30 findings clears the 25-row page size on
    // both findings tabs and, once resolved, on the resolved table too.
    bulkProjectName: 'bulk-deps'
}

// Every dependency of bulk-deps is a PRODUCTION dependency, and that is load-bearing rather than
// incidental: the built-in filter default is depType 'prod' (apps/web/lib/filter-defaults.ts), so a
// dev-typed subset would drop the default view under 26 rows and the pagination control would vanish
// again. Dep-type filtering is covered by checkout-service, which has one of each.
export const BULK_DEP_COUNT = 30

// Matches the generated advisories in tests/fixtures/advisories/osv-npm.ndjson: fixture-pkg-01..30 at
// 1.0.0, each with one advisory fixed in 2.0.0.
export function bulkDeps(): Record<string, string> {
    const deps: Record<string, string> = {}
    for (let i = 1; i <= BULK_DEP_COUNT; i++) deps['fixture-pkg-' + String(i).padStart(2, '0')] = '1.0.0'
    return deps
}

// The multi-dependency form of fixture-tree.ts's soloLock. Hand-written for the same reason: resolving
// a real one needs the network and drifts over time. It lives here rather than beside soloLock because
// findings.resolved.write.spec.ts writes a replacement lockfile at test time, and specs cannot import
// fixture-tree.ts across Playwright's CJS loader.
export function bulkLock(name: string, deps: Record<string, string>): string {
    const packages: Record<string, unknown> = {
        '': { name, version: '1.0.0', dependencies: deps }
    }
    for (const [dep, version] of Object.entries(deps)) packages['node_modules/' + dep] = { version }
    return JSON.stringify({ name, version: '1.0.0', lockfileVersion: 3, requires: true, packages }, null, 4) + '\n'
}

// What bulk-deps' lockfile is swapped to in order to reach the resolved table's pagination. Every
// vulnerable package is gone, so the next scan matches none of the open identities and resolves all
// BULK_DEP_COUNT of them in one pass. One innocuous dependency remains rather than none, so the
// project still resolves as auditable rather than changing category mid-test.
export function bulkLockResolved(name: string): string {
    return bulkLock(name, { 'fixture-pkg-safe': '1.0.0' })
}

// package.json for the same swap. Discovery reads the manifest as well as the lockfile, so leaving the
// original 30 dependencies declared while the lockfile lists one would be an inconsistent tree.
export function bulkManifestResolved(name: string): string {
    return JSON.stringify({
        name,
        version: '1.0.0',
        private: true,
        dependencies: { 'fixture-pkg-safe': '1.0.0' }
    }, null, 4) + '\n'
}

export type FixtureManifest = {
    version: number
    rootId: string
    rootPath: string
    seededAt: number
    // Project ids as computed by packages/db/src/identity.ts, written by the seed rather than
    // recomputed here. Duplicating a two-line sha256 in a file that cannot import the real one is a
    // drift risk with no upside.
    projects: Record<string, string>
}

// A function, never a top-level read: playwright.config.ts imports this module before the seed has
// necessarily run, and a module-level readFileSync would make the config itself unloadable.
export function readFixtureManifest(): FixtureManifest {
    return JSON.parse(readFileSync(E2E_MANIFEST_PATH, 'utf8')) as FixtureManifest
}
