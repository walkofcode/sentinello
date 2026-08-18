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
        // .tsx as well as .ts: component suites that render real JSX (dialog.test.tsx) live beside the
        // components, and without the extension they are silently collected by nothing and never run.
        include: [
            '{packages,apps}/*/src/**/*.test.ts',
            'apps/web/{lib,components}/**/*.test.ts',
            'apps/web/{lib,components}/**/*.test.tsx'
        ],
        exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', 'tests/e2e/**'],
        // better-sqlite3 is a native binding and the DB suites open real files; forks keep each
        // test file in its own process so a native handle can never leak across suites.
        pool: 'forks',
        coverage: {
            provider: 'v8',
            reporter: ['text', 'lcov'],
            reportsDirectory: './coverage',
            // What is measured. This list is now the ONLY dial in this file — see the thresholds note
            // below — so adding a path here is a commitment to bring it to 100% in the same change.
            include: [
                'packages/*/src/**/*.ts',
                'apps/cli/src/**/*.ts',
                'apps/worker/src/**/*.ts',
                'apps/web/lib/**/*.ts',
                'apps/web/components/**/*.ts'
            ],
            exclude: [
                '**/*.test.ts',
                // Shared test harnesses that live beside the code they set up (so they can import
                // `@sentinello/db` and `@/lib/*` exactly as the modules under test do) rather than
                // under tests/. They are test scaffolding, not shipped code — measuring them would
                // credit coverage to the harness itself.
                '**/*.fixture.ts',
                '**/*.d.ts',
                '**/dist/**',
                '**/.next/**',
                '**/drizzle*/**',
                'tests/fixtures/**',
                // The two process entry points. Each is now a bin that does nothing but import its
                // sibling and run it — worker.ts and run.ts respectively, both of which are covered.
                // They are excluded rather than tested because importing either one IS the side
                // effect: apps/worker/src/index.ts boots a worker (takes the single-instance lock,
                // opens the database, arms cron) and apps/cli/src/cli.ts parses process.argv and sets
                // the process exit code. Their filenames cannot move — ecosystem.config.js launches
                // src/index.ts directly and tsup's entry is src/cli.ts — so the bodies moved instead.
                'apps/worker/src/index.ts',
                'apps/cli/src/cli.ts'
            ],
            // 100 on all four metrics, everywhere in `include`. One number, and it replaced ~530 lines:
            // a table of 80 per-file floors plus a running inventory of which uncovered branches were
            // believed unreachable.
            //
            // The table existed only because the global floor was below 100 — its whole job was stopping
            // a well-covered module regressing while some other area improved enough to compensate. At
            // 100 that cannot happen: an aggregate of 100% is arithmetically impossible unless every
            // measured file is already at 100%, so every entry became redundant by construction.
            //
            // It also could not be trusted, and its failure mode was silence in both directions. A
            // threshold glob matching NO files reports 100% and passes — istanbul's percent() returns
            // 100.0 when the total is 0 — so the floor for engine/comparators/pep440.ts kept passing for
            // however long it took anyone to notice the file had moved to packages/versions, by which
            // time it had four uncovered branches and nothing enforcing anything. In the other
            // direction, scan-retention.ts was simply never added, and carried five uncovered arms while
            // all fourteen of its sibling worker modules had floors. A list maintained by hand protects
            // what someone remembered to type.
            //
            // The inventory beside it had the same problem. It recorded that its own completeness claim
            // had been falsified three times; closing the remaining 109 arms falsified it twice more,
            // and fifteen of those arms were plain untested code rather than unreachable guards.
            //
            // HOW TO KEEP THIS AT 100 — the rule is that an unreachable branch gets REMOVED, never
            // suppressed. There are no `/* v8 ignore */` comments in this repository and adding one is
            // not the fix; it blinds a whole LINE, and the arms here routinely share a line with a live
            // sibling, so a green number earned that way would be hiding real code. The patterns that
            // closed the last 109, in the order worth trying:
            //
            //   - Route error coercion through errText/asError (@sentinello/core). Ten arms were the
            //     same inlined `err instanceof Error && err.message || String(err)` behind a collaborator
            //     that only ever throws Error — dead at every call site, live in one shared helper.
            //   - Delete a `?? default` whose column is NOT NULL, or whose query already COALESCEd it.
            //     Check the schema and the SELECT, not the expression: `row.source ?? row.scanner` and
            //     `row.ecosystem ?? 'npm'` sit on adjacent lines with opposite verdicts.
            //   - Fix the hand-written row type instead of guarding it. A `string | null` field over a
            //     raw SELECT is what forces most of these, and the WHERE clause usually already excludes
            //     the NULL.
            //   - Remove the indexed access rather than guarding it: Object.entries over Object.keys, a
            //     reduce over parts[0..3], `basename()` over a split, a non-empty tuple type over an
            //     array, a Record keyed by a literal union (noUncheckedIndexedAccess does not apply to
            //     one). `for (let n = stack.pop(); n !== undefined; n = stack.pop())` turns an
            //     unreachable guard into a loop condition that is exercised every time.
            //   - Drop a re-entrancy flag whose clearInterval/clearTimeout is the real mechanism, and
            //     rely on resolve() being idempotent.
            //   - Compute a value so the edge case cannot arise. ssrf.ts builds its CIDR mask from the
            //     host-bit count precisely so /0 needs no special case.
            //   - Where the guard genuinely must stay — a tripwire, a defence against a state the
            //     database should not reach — export it and test it directly, or manufacture the state
            //     (a module mock, `PRAGMA foreign_keys = OFF`, a blank-but-not-null column). That is how
            //     the last handful were covered, and each of those tests pins a real property.
            //
            // perFile only changes the failure message: it names the offending file instead of reporting
            // one global percentage. The pass/fail set is identical at 100.
            thresholds: {
                100: true,
                perFile: true
            }
        }
    }
})
