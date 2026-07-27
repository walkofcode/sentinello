import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// Unit and integration tests live beside the code they cover (`src/**/*.test.ts`), which means the
// existing per-package `tsconfig` ("include": ["src/**/*.ts"]) typechecks them for free and
// `eslint src` lints them for free. End-to-end suites are NOT run here — they live in tests/e2e and
// are driven by Playwright (portal) or their own vitest invocation (CLI subprocess).
//
// A single project rather than one-per-package: every suite runs under the `node` environment, so
// splitting them would buy nothing but a longer config, and one project yields one merged coverage
// report — which is the number that actually matters for a public repo.
export default defineConfig({
    resolve: {
        alias: {
            // apps/web's tsconfig maps "@/*" to its own root; mirror it so web tests can import the
            // modules under test exactly as the app does.
            '@': fileURLToPath(new URL('./apps/web', import.meta.url))
        }
    },
    test: {
        environment: 'node',
        include: ['{packages,apps}/*/src/**/*.test.ts', 'apps/web/{lib,components}/**/*.test.ts'],
        exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', 'tests/e2e/**'],
        // better-sqlite3 is a native binding and the DB suites open real files; forks keep each
        // test file in its own process so a native handle can never leak across suites.
        pool: 'forks',
        coverage: {
            provider: 'v8',
            reporter: ['text', 'lcov'],
            reportsDirectory: './coverage',
            include: [
                'packages/*/src/**/*.ts',
                'apps/cli/src/**/*.ts',
                'apps/worker/src/**/*.ts',
                'apps/web/lib/**/*.ts',
                'apps/web/components/**/*.ts'
            ],
            exclude: [
                '**/*.test.ts',
                '**/*.d.ts',
                '**/dist/**',
                '**/.next/**',
                '**/drizzle*/**',
                'tests/fixtures/**'
            ],
            // A ratchet, not a target. Each floor sits just under what the suite actually covers
            // today, so coverage can only go up — a change that removes tests fails CI, while there
            // is no arbitrary number to game. Raise these as coverage grows; never lower them to
            // make a build pass.
            //
            // The global figures are held down by three areas that are deliberately not unit-tested
            // yet, each because it needs a seam that does not exist rather than because it was
            // skipped: apps/worker (orchestration), apps/web/lib/actions and lib/mcp (Next server
            // actions, exercised by the Playwright suite against a real build — which v8 coverage
            // here cannot observe), and the npm-audit spawn path in packages/scanners, which needs a
            // real package manager. Closing those is the next meaningful step past ~43%.
            thresholds: {
                statements: 43,
                branches: 43,
                functions: 42,
                lines: 42,
                // Per-path floors for the areas that are now well covered. Without these, a global
                // floor alone would let a well-covered module regress to zero as long as some other
                // area improved enough to compensate.
                'packages/core/src/**': { statements: 97, branches: 91, functions: 92, lines: 98 },
                'packages/scanners/src/resolver/**': { statements: 96, branches: 91, functions: 97, lines: 99 },
                'packages/scanners/src/engine/**': { statements: 94, branches: 86, functions: 99, lines: 96 },
                'packages/notifications/src/render.ts': { statements: 99, branches: 96, functions: 99, lines: 99 },
                'packages/notifications/src/redact.ts': { statements: 99, branches: 99, functions: 99, lines: 99 },
                'packages/notifications/src/ssrf.ts': { statements: 97, branches: 90, functions: 99, lines: 99 },
                'packages/db/src/queries/osv.ts': { statements: 95, branches: 76, functions: 99, lines: 99 },
                'packages/db/src/queries/notifications.ts': { statements: 92, branches: 84, functions: 99, lines: 97 },
                'apps/web/components/findings/**': { statements: 99, branches: 95, functions: 99, lines: 99 },
                // findings.ts and options.ts each have a substantial branch set still uncovered:
                // the finding backfills and list queries here, and applyConfigFile there. Both are
                // next in line, and these floors exist to stop them sliding backwards meanwhile.
                'packages/db/src/queries/findings.ts': { statements: 70, branches: 41, functions: 56, lines: 74 },
                'apps/cli/src/options.ts': { statements: 81, branches: 69, functions: 90, lines: 82 },
                'apps/cli/src/cache/store.ts': { statements: 85, branches: 73, functions: 85, lines: 85 },
                'apps/cli/src/cache/meta.ts': { statements: 97, branches: 96, functions: 99, lines: 97 }
            }
        }
    }
})
