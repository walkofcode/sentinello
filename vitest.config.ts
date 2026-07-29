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
                'tests/fixtures/**'
            ],
            // A ratchet, not a target. Each floor sits just under what the suite actually covers
            // today, so coverage can only go up — a change that removes tests fails CI, while there
            // is no arbitrary number to game. Raise these as coverage grows; never lower them to
            // make a build pass.
            //
            // What still holds the global figures down, and what it would actually take to move each:
            //
            //  - apps/worker/src/index.ts, now the only uncovered file left in the worker. Unlike the
            //    rest of the shell it needs a refactor rather than a stub: the module calls main() as
            //    an import side effect, then acquires the single-instance lockfile, installs SIGTERM/
            //    SIGINT handlers and calls process.exit — none of which a test process can host.
            //    Covering it means exporting main() and makeShutdown() instead of running them on
            //    import.
            //  - The npm-audit spawn path. This one is a genuine seam problem, but a small one:
            //    spawnAndCapture() is already a single private function, so lifting it into a deps
            //    object (mirroring createOsvScanner) opens the whole result-shaping surface.
            //  - apps/cli's ui/sync/doctor layer, which closes over process.stderr and isTTY.
            //  - The two feed.ts downloaders (osv, gemnasium) and apps/web/lib/version.ts, whose
            //    uncovered half is the GitHub update-check — both are network clients whose HTTP
            //    layer (packages/feeds/src/http.ts) is already covered beneath them.
            thresholds: {
                statements: 76,
                branches: 72,
                functions: 79,
                lines: 76,
                // Per-path floors for the areas that are now well covered. Without these, a global
                // floor alone would let a well-covered module regress to zero as long as some other
                // area improved enough to compensate.
                'packages/core/src/**': { statements: 97, branches: 91, functions: 92, lines: 98 },
                'packages/scanners/src/resolver/**': { statements: 96, branches: 91, functions: 97, lines: 99 },
                'packages/scanners/src/engine/**': { statements: 94, branches: 86, functions: 99, lines: 96 },
                'packages/notifications/src/render.ts': { statements: 99, branches: 96, functions: 99, lines: 99 },
                'packages/notifications/src/redact.ts': { statements: 99, branches: 99, functions: 99, lines: 99 },
                'packages/notifications/src/ssrf.ts': { statements: 97, branches: 90, functions: 99, lines: 99 },
                // The outbound transports. These are where the SSRF guard and secret redaction meet
                // the wire, so they carry floors individually rather than as a directory average.
                'packages/notifications/src/webhook.ts': { statements: 99, branches: 95, functions: 99, lines: 99 },
                'packages/notifications/src/slack.ts': { statements: 99, branches: 95, functions: 99, lines: 99 },
                'packages/notifications/src/telegram.ts': { statements: 99, branches: 96, functions: 99, lines: 99 },
                'packages/notifications/src/resolve.ts': { statements: 99, branches: 99, functions: 99, lines: 99 },
                'packages/db/src/queries/osv.ts': { statements: 95, branches: 76, functions: 99, lines: 99 },
                'packages/db/src/queries/notifications.ts': { statements: 92, branches: 84, functions: 99, lines: 97 },
                // The gemnasium path, end to end: normalizer, cache, and scanner. A regression in the
                // range parsing or the purge logic is silent, so each gets its own floor.
                'packages/feeds/src/gemnasium/normalize.ts': { statements: 98, branches: 93, functions: 99, lines: 99 },
                'packages/db/src/queries/gemnasium.ts': { statements: 97, branches: 85, functions: 99, lines: 99 },
                'packages/db/src/gemnasium-client.ts': { statements: 94, branches: 74, functions: 99, lines: 94 },
                'packages/scanners/src/gemnasium.ts': { statements: 97, branches: 94, functions: 99, lines: 99 },
                // Produces the "upgrade to this version" advice shown next to every finding.
                'packages/scanners/src/version-fix.ts': { statements: 95, branches: 85, functions: 99, lines: 99 },
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
                'apps/web/lib/actions/**': { statements: 99, branches: 97, functions: 99, lines: 99 },
                // The MCP tool surface — the same mutations, reachable by an agent. Driven through a
                // real McpServer/Client pair so the declared zod input schemas are exercised too; a
                // schema that stops matching its handler fails here rather than in front of an agent.
                'apps/web/lib/mcp/tools/**': { statements: 99, branches: 96, functions: 99, lines: 99 },
                // Branches sit at 84 for the `root?.label || root?.path || 'unknown root'` fallback:
                // projects.root_id is a foreign key, so a project whose root row is missing cannot be
                // inserted, and the undefined-root arms are unreachable from any state the database
                // will hold. The naming, mute and dedup branches are all covered.
                'apps/web/lib/project-advisory-export.ts': { statements: 99, branches: 84, functions: 99, lines: 99 },
                'apps/web/components/findings/**': { statements: 99, branches: 95, functions: 99, lines: 99 },
                // The worker's orchestration core. runner owns scanner ordering and cross-scanner
                // dedup; notifier owns the record-attempt-before-send rule; config-loader owns the
                // first-boot guard that stops a restart reverting the operator's portal edits.
                'apps/worker/src/runner.ts': { statements: 91, branches: 83, functions: 88, lines: 91 },
                'apps/worker/src/notifier.ts': { statements: 89, branches: 83, functions: 99, lines: 92 },
                'apps/worker/src/config-loader.ts': { statements: 97, branches: 96, functions: 99, lines: 99 },
                'apps/worker/src/runtime.ts': { statements: 92, branches: 66, functions: 99, lines: 99 },
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
                'apps/worker/src/scan-request-poller.ts': { statements: 92, branches: 79, functions: 92, lines: 93 },
                'apps/worker/src/mute-expiry.ts': { statements: 99, branches: 88, functions: 99, lines: 99 },
                // The two advisory-source runtimes: lazy cache open, per-batch scanner selection, and
                // the scanner closures that gate matching on the live (source, ecosystem) cell AND the
                // normalizer stamp. A regression there silently reports "no vulnerabilities".
                'apps/worker/src/osv-runtime.ts': { statements: 99, branches: 92, functions: 99, lines: 99 },
                'apps/worker/src/gemnasium-runtime.ts': { statements: 99, branches: 91, functions: 99, lines: 99 },
                // Their persistence halves, where an ordering mistake corrupts the operator's cache:
                // invalidate only once the download is live, purge only after the full stream succeeds,
                // advance the cursor/sha only on success.
                'apps/worker/src/osv-sync.ts': { statements: 95, branches: 93, functions: 85, lines: 95 },
                'apps/worker/src/gemnasium-sync.ts': { statements: 95, branches: 92, functions: 80, lines: 95 },
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
                'packages/db/src/queries/projects.ts': { statements: 93, branches: 78, functions: 99, lines: 93 },
                'packages/db/src/queries/scans.ts': { statements: 99, branches: 93, functions: 99, lines: 99 },
                'packages/db/src/queries/config.ts': { statements: 99, branches: 99, functions: 99, lines: 99 },
                'packages/db/src/queries/ecosystem-backfill.ts': { statements: 96, branches: 85, functions: 99, lines: 96 },
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
