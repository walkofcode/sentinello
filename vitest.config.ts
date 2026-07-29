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
            // A ratchet, not a target. Each floor sits just under what the suite actually covers
            // today, so coverage can only go up — a change that removes tests fails CI, while there
            // is no arbitrary number to game. Raise these as coverage grows; never lower them to
            // make a build pass.
            //
            // Every file this list has ever named as a gap is now covered. use-anchored-panel.ts was
            // the last one at zero and is now at 100% on all four metrics; jsdom and
            // @testing-library/react are installed for it, and the suite reaches them through a
            // per-file `// @vitest-environment jsdom` docblock rather than a config change here,
            // because every other suite wants the `node` default above.
            //
            // FUNCTIONS ARE EFFECTIVELY DONE (99.7%). Three remain, all in files whose other
            // functions are covered; there is no untested module left in the repo.
            //
            // What is left is branch residue, and it falls into two kinds. Knowing which kind you are
            // looking at saves the most time:
            //
            //  1. UNREACHABLE defensive arms, which no test can reach through the public API and
            //     which should NOT be chased. The recurring shape is
            //     `err instanceof Error && err.message || String(err)` sitting behind a collaborator
            //     that only ever throws Errors — node:fs and better-sqlite3 both do. Named examples:
            //     worker.ts:184 (assertDataDirWritable's catch), runtime.ts:42 (the graceTimer's
            //     `if (settled) return`, which the allSettled path clears the timer before reaching),
            //     scan-request-poller.ts:53 (a `stopped` guard that clearInterval already prevents),
            //     npm-audit.ts:296 and :375 (a stdin write no caller passes, and an empty-command
            //     guard pickAuditCommand cannot produce).
            //  2. Genuinely reachable arms that simply cost more setup than they have been worth so
            //     far — mostly non-Error rejection paths and rarely-taken query filters. Those are
            //     fair game.
            //
            // Two things worth knowing before chasing the last few points:
            //
            //  - The v8 text reporter OMITS files at 100% on all four metrics, so a file vanishing
            //    from the table is success, not absence. Check coverage/lcov.info to confirm.
            //  - jsdom has NO LAYOUT ENGINE. getBoundingClientRect returns zeros, so any new test of
            //    positioning logic must stub it — otherwise the test passes while asserting nothing,
            //    since every branch computes the same numbers from zeros.
            thresholds: {
                statements: 98,
                branches: 94,
                functions: 99,
                lines: 99,
                // Per-path floors for the areas that are now well covered. Without these, a global
                // floor alone would let a well-covered module regress to zero as long as some other
                // area improved enough to compensate.
                'packages/core/src/**': { statements: 98, branches: 93, functions: 97, lines: 99 },
                'packages/scanners/src/resolver/**': { statements: 98, branches: 95, functions: 98, lines: 99 },
                'packages/scanners/src/engine/**': { statements: 98, branches: 95, functions: 99, lines: 99 },
                'packages/notifications/src/render.ts': { statements: 99, branches: 97, functions: 99, lines: 99 },
                'packages/notifications/src/redact.ts': { statements: 99, branches: 99, functions: 99, lines: 99 },
                'packages/notifications/src/ssrf.ts': { statements: 98, branches: 91, functions: 99, lines: 99 },
                // The outbound transports. These are where the SSRF guard and secret redaction meet
                // the wire, so they carry floors individually rather than as a directory average.
                'packages/notifications/src/webhook.ts': { statements: 99, branches: 95, functions: 99, lines: 99 },
                'packages/notifications/src/slack.ts': { statements: 99, branches: 95, functions: 99, lines: 99 },
                'packages/notifications/src/telegram.ts': { statements: 99, branches: 96, functions: 99, lines: 99 },
                'packages/notifications/src/resolve.ts': { statements: 99, branches: 99, functions: 99, lines: 99 },
                'packages/db/src/queries/osv.ts': { statements: 96, branches: 77, functions: 99, lines: 99 },
                'packages/db/src/queries/notifications.ts': { statements: 93, branches: 85, functions: 99, lines: 98 },
                // The gemnasium path, end to end: normalizer, cache, and scanner. A regression in the
                // range parsing or the purge logic is silent, so each gets its own floor.
                'packages/feeds/src/gemnasium/normalize.ts': { statements: 98, branches: 93, functions: 99, lines: 99 },
                'packages/db/src/queries/gemnasium.ts': { statements: 97, branches: 85, functions: 99, lines: 99 },
                'packages/db/src/gemnasium-client.ts': { statements: 94, branches: 87, functions: 99, lines: 94 },
                'packages/scanners/src/gemnasium.ts': { statements: 97, branches: 94, functions: 99, lines: 99 },
                // Produces the "upgrade to this version" advice shown next to every finding.
                'packages/scanners/src/version-fix.ts': { statements: 97, branches: 89, functions: 99, lines: 99 },
                // The MCP bearer check is the only thing in front of an endpoint that can mute
                // findings and request scans. Branches sit at 93 rather than 99 for one unreachable
                // else: `match[1] ?? ''` exists because noUncheckedIndexedAccess types the capture as
                // possibly-undefined, but /^Bearer\s+(.+)$/ always fills group 1 when it matches at
                // all. Every branch a request can actually take is covered.
                'apps/web/lib/mcp/auth.ts': { statements: 99, branches: 93, functions: 99, lines: 99 },
                // Every mutation the portal can make. These run against a real schema via the
                // globalThis.__sentinelloDb seam, so the floors are near-total: the only stubs are
                // revalidatePath (which cannot work outside a render request) and the outbound
                // notification sender (the one action that would make a real HTTP call).
                'apps/web/lib/actions/**': { statements: 99, branches: 98, functions: 99, lines: 99 },
                // The MCP tool surface — the same mutations, reachable by an agent. Driven through a
                // real McpServer/Client pair so the declared zod input schemas are exercised too; a
                // schema that stops matching its handler fails here rather than in front of an agent.
                'apps/web/lib/mcp/tools/**': { statements: 99, branches: 97, functions: 99, lines: 99 },
                // Branches sit at 84 for the `root?.label || root?.path || 'unknown root'` fallback:
                // projects.root_id is a foreign key, so a project whose root row is missing cannot be
                // inserted, and the undefined-root arms are unreachable from any state the database
                // will hold. The naming, mute and dedup branches are all covered.
                'apps/web/lib/project-advisory-export.ts': { statements: 99, branches: 84, functions: 99, lines: 99 },
                'apps/web/components/findings/**': { statements: 99, branches: 96, functions: 99, lines: 99 },
                // The worker's orchestration core. runner owns scanner ordering and cross-scanner
                // dedup; notifier owns the record-attempt-before-send rule; config-loader owns the
                // first-boot guard that stops a restart reverting the operator's portal edits.
                'apps/worker/src/runner.ts': { statements: 99, branches: 97, functions: 99, lines: 99 },
                'apps/worker/src/notifier.ts': { statements: 96, branches: 85, functions: 99, lines: 99 },
                'apps/worker/src/config-loader.ts': { statements: 97, branches: 96, functions: 99, lines: 99 },
                'apps/worker/src/runtime.ts': { statements: 96, branches: 83, functions: 99, lines: 99 },
                // The worker's boot/scheduling shell. Every one of these decides WHETHER work happens
                // rather than what it produces, so their failure mode is silence: a sweep that never
                // fires, a request stuck in 'running', a source that stays unauditable. Each is driven
                // through a node-cron / chokidar double against a real migrated database.
                //
                // discovery and watcher carry total floors because both sit at 100%: discovery is the
                // only thing that hard-deletes a project (and its scans, findings and mutes), and the
                // watcher is the one component contractually forbidden from calling the runner.
                'apps/worker/src/discovery.ts': { statements: 99, branches: 99, functions: 99, lines: 99 },
                'apps/worker/src/watcher.ts': { statements: 99, branches: 99, functions: 99, lines: 99 },
                'apps/worker/src/scheduler.ts': { statements: 97, branches: 96, functions: 99, lines: 97 },
                'apps/worker/src/scan-request-poller.ts': { statements: 99, branches: 97, functions: 99, lines: 99 },
                'apps/worker/src/mute-expiry.ts': { statements: 99, branches: 88, functions: 99, lines: 99 },
                // The two advisory-source runtimes: lazy cache open, per-batch scanner selection, and
                // the scanner closures that gate matching on the live (source, ecosystem) cell AND the
                // normalizer stamp. A regression there silently reports "no vulnerabilities".
                'apps/worker/src/osv-runtime.ts': { statements: 99, branches: 92, functions: 99, lines: 99 },
                'apps/worker/src/gemnasium-runtime.ts': { statements: 99, branches: 91, functions: 99, lines: 99 },
                // Their persistence halves, where an ordering mistake corrupts the operator's cache:
                // invalidate only once the download is live, purge only after the full stream succeeds,
                // advance the cursor/sha only on success.
                'apps/worker/src/osv-sync.ts': { statements: 99, branches: 97, functions: 99, lines: 99 },
                'apps/worker/src/gemnasium-sync.ts': { statements: 99, branches: 94, functions: 99, lines: 99 },
                // The dispatch decision: every filter that decides whether an operator gets paged.
                'packages/db/src/queries/notification-deliveries.ts': { statements: 93, branches: 83, functions: 99, lines: 97 },
                // The feed HTTP client. Its retry policy decides whether a transient upstream failure
                // costs one round trip or silently leaves a source unauditable for the whole run.
                'packages/feeds/src/http.ts': { statements: 98, branches: 98, functions: 99, lines: 99 },
                // The read paths behind the portal's numbers and the triage views. Each applies the
                // same blast-radius rules (open episodes, unmuted, active source cells); a regression
                // shows an operator findings they silenced or hides ones they have not.
                'packages/db/src/queries/dashboard.ts': { statements: 96, branches: 86, functions: 99, lines: 96 },
                'packages/db/src/queries/libraries.ts': { statements: 99, branches: 66, functions: 99, lines: 99 },
                'packages/db/src/queries/projects.ts': { statements: 93, branches: 78, functions: 99, lines: 99 },
                'packages/db/src/queries/scans.ts': { statements: 99, branches: 93, functions: 99, lines: 99 },
                'packages/db/src/queries/config.ts': { statements: 99, branches: 99, functions: 99, lines: 99 },
                'packages/db/src/queries/ecosystem-backfill.ts': { statements: 96, branches: 85, functions: 99, lines: 99 },
                // Owns finding-episode lifecycle: which episode continues, which closes, and which of
                // several duplicate rows survives a collapse (the earliest-detected one, so a finding's
                // age is not silently reset). Was the weakest floor in this list at 70/41/56/74.
                'packages/db/src/queries/findings.ts': { statements: 98, branches: 89, functions: 99, lines: 99 },
                // applyConfigFile is the remaining uncovered branch set in options.ts.
                'apps/cli/src/options.ts': { statements: 99, branches: 99, functions: 99, lines: 99 },
                'apps/cli/src/cache/store.ts': { statements: 99, branches: 94, functions: 99, lines: 99 },
                'apps/cli/src/cache/meta.ts': { statements: 98, branches: 97, functions: 99, lines: 97 },
                // The advisory-feed downloaders. Both are driven through a real ZIP generated in
                // memory (packages/feeds/src/zip.fixture.ts) so unzipper, the entry filter and the
                // normalizers all run for real. The trap they guard is silent rather than loud:
                // gemnasium's rootOffset and OSV's canonical-vs-lowercase feed directory both match
                // NOTHING when wrong, which reads as a clean upstream rather than a bug.
                'packages/feeds/src/osv/feed.ts': { statements: 97, branches: 97, functions: 99, lines: 96 },
                'packages/feeds/src/gemnasium/feed.ts': { statements: 96, branches: 92, functions: 99, lines: 96 },
                // The CLI's terminal and cache layers. ui.ts writes exclusively to stderr because
                // stdout carries the advisory document a user may pipe straight into an agent, and
                // confirmSeed refuses on a non-TTY rather than pulling ~100 MB onto a build machine
                // unattended. sync.ts owns seed-vs-refresh, where a wrong answer costs either a
                // needless full re-download or a silently stale cache.
                'apps/cli/src/ui.ts': { statements: 99, branches: 94, functions: 99, lines: 99 },
                'apps/cli/src/doctor.ts': { statements: 99, branches: 99, functions: 99, lines: 99 },
                'apps/cli/src/cache/sync.ts': { statements: 96, branches: 93, functions: 99, lines: 98 },
                'apps/cli/src/cache/lookup.ts': { statements: 99, branches: 99, functions: 99, lines: 99 },
                'apps/cli/src/scan.ts': { statements: 93, branches: 93, functions: 99, lines: 94 },
                // The optional portal login gate — the only thing in front of the whole portal when it
                // is enabled. Total floors: the cookie must never contain the raw token, and the login
                // and cookie paths must stay distinct HMACs so a cookie is not a valid submission.
                'apps/web/lib/portal-auth.ts': { statements: 99, branches: 99, functions: 99, lines: 99 },
                'apps/web/lib/filter-defaults.ts': { statements: 99, branches: 99, functions: 99, lines: 99 },
                'apps/web/lib/home-url-memory.ts': { statements: 99, branches: 99, functions: 99, lines: 99 },
                // The update check. Its two TTLs are the point: 6h on success, but only 15min on
                // failure so a transient GitHub outage does not lock the check out for six hours.
                'apps/web/lib/version.ts': { statements: 99, branches: 96, functions: 99, lines: 99 },
                // The two entry-point bodies, extracted out of their bins so they could be reached at
                // all. worker.ts owns the boot order — notably that the signal handlers are installed
                // BEFORE the initial sweep, because sweepActiveProjects runs synchronous discovery
                // before its first await and a SIGTERM in that window would otherwise hit a process
                // with no handlers. run.ts owns the exit codes, which are the CLI's CI contract.
                'apps/worker/src/worker.ts': { statements: 99, branches: 98, functions: 99, lines: 99 },
                'apps/cli/src/run.ts': { statements: 97, branches: 90, functions: 99, lines: 98 },
                // The subprocess half of npm-audit. Every branch here returns "no findings", but they
                // mean entirely different things to an operator — pm_missing is "install pnpm",
                // audit_schema_mismatch is "Sentinello needs updating", and ok-with-zero-findings is
                // "your project is clean". Picking the wrong one is silent, because the scan still
                // succeeds, which is what makes these floors worth carrying.
                'packages/scanners/src/npm-audit.ts': { statements: 97, branches: 91, functions: 99, lines: 98 },
                'packages/scanners/src/npm-audit-parse.ts': { statements: 98, branches: 94, functions: 99, lines: 99 },
                // The five modules that had no test file at all until wave 8. schema.ts is the literal
                // contract between apps/web and apps/worker, and its floors are total for a reason: the
                // suite asserts each foreign key against a REALLY migrated database, so a column added
                // here without a generated migration fails there rather than as "no such column" in the
                // portal at runtime. client.ts owns the path resolution tying both apps to one file —
                // when it disagrees between them nothing errors, each app just opens its own private
                // database and the Scan button silently does nothing.
                'packages/db/src/schema.ts': { statements: 99, branches: 99, functions: 99, lines: 99 },
                'packages/db/src/client.ts': { statements: 99, branches: 99, functions: 99, lines: 99 },
                'packages/scanners/src/index.ts': { statements: 99, branches: 99, functions: 99, lines: 99 },
                'apps/web/lib/db.ts': { statements: 99, branches: 99, functions: 99, lines: 99 },
                'apps/web/lib/cn.ts': { statements: 99, branches: 99, functions: 99, lines: 99 },
                // Collapses the one-row-per-(scanner, advisory, dep-path) table into what the operator
                // sees. Both directions are dangerous: merging too eagerly HIDES a vulnerability,
                // merging too little shows the same thing three times.
                'apps/web/lib/merge-findings.ts': { statements: 99, branches: 92, functions: 99, lines: 99 },
                // Walks read-only mounts it does not control, so its unreadable-path handling is not
                // padding: one bad permission must not abort the scan of every other project under the
                // same root.
                'packages/scanners/src/discovery.ts': { statements: 97, branches: 97, functions: 99, lines: 98 },
                // The DOM-dependent hook, and the only place in the repo that needs jsdom. Total floors
                // because it went from zero to 100% in one pass and there is no reason for it to slip:
                // its flip-above and clamp-to-viewport branches are what stop a panel opening
                // off-screen, and its capture-phase scroll guard is what stops a panel with a scrolling
                // list inside it closing itself the moment that list is scrolled.
                'apps/web/components/ui/**': { statements: 99, branches: 99, functions: 99, lines: 99 }
            }
        }
    }
})
