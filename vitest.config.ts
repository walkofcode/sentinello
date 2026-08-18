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
            // FUNCTIONS ARE DONE: 1011/1011, and the global floor above is set to 100 to keep them
            // that way — WITHIN THE `include` GLOBS ABOVE, which is narrower than "the repository" and
            // must not be quoted as if it were. Not instrumented, and therefore not ratcheted at all:
            // apps/homepage in its entirety, apps/web/app/** (every route handler and page — MCP,
            // health, version, login), and — least obvious, because the directory IS named above —
            // every .tsx under apps/web/components, since the glob is `**/*.ts`. That last one means
            // the `apps/web/components/**` floors below measure exactly three files, not eighty-one.
            // A new untested function in any of those places passes CI. Broadening the globs is a
            // real option but a separate piece of work: it would pull ~150 uninstrumented files into
            // the denominator at once, which is a coverage project, not a config edit. Until then the
            // honest phrasing is "the unit-tested surface", and README.md now says exactly that.
            //
            // Lines and statements are effectively done too. What is left is branch residue — 98 arms
            // of 4044, so 97.57%.
            //
            // CORRECTION, WAVE 12 — kind 2 below was declared empty in wave 11 and was not. Six more
            // reachable arms were found by re-reading the residue rather than trusting that sentence,
            // and all six are now covered: config-loader.ts:152-153 (a plain file and a dot-entry in
            // /roots, whose IDENTICAL twin in discoverDockerRoots was already covered — the tell was
            // right there), gemnasium-client.ts:35 (the first-boot mkdir, byte-identical to the one
            // wave 11 had just covered in osv-client.ts), scheduler.ts:108 (a sweep of a second or
            // more), cache/meta.ts:91 (`sources.osv ?? {}`, whose sibling on the very NEXT line was
            // already covered) and render.ts:12 (a truncated `error:` signature). Four of those six
            // sat next to an already-covered twin, which is the cheapest tell there is and was missed
            // anyway.
            //
            // AND THEN A SEVENTH, found in review of the very commit that wrote the paragraph above:
            // osv-sync.ts:159, the false arm of `if (changed.etag)`. fetchOsvChangedIds types etag as
            // `string | null` because a server need not send one, so the guard's whole purpose is a
            // case the tests never produced — every existing case passed a string. Covered now, with
            // the assertion that matters: a stored etag SURVIVES a response carrying none. Writing
            // null over it would silently downgrade every later sync from a conditional request to a
            // full manifest download, erroring nowhere.
            //
            // WHETHER 100% IS REACHABLE IS NOT SETTLED, and this file should stop implying otherwise.
            // Two different claims keep getting merged into one:
            //
            //   ESTABLISHED — each arm named under the shapes below has been traced to a call site
            //   that forecloses it. Those are individual findings, and they hold up.
            //
            //   NOT ESTABLISHED — that the list is COMPLETE. It has been declared complete three
            //   times and falsified three times: wave 11 said so, wave 12 said so while missing six,
            //   and wave 12's correction said so while missing a seventh. Every miss was an arm the
            //   list never named.
            //
            // "I cannot see how to reach this" and "this cannot be reached" are different statements,
            // and only the second belongs here — attached to a quoted call site. So the honest
            // position is: no route to 100% is currently known, several arms are individually proven
            // unreachable, and the completeness of that set is an open question the recipe below
            // exists to attack.
            //
            // What IS settled is the other half: reaching a literal 100% by SUPPRESSION would be
            // dishonest here specifically. `/* v8 ignore */` blinds a whole LINE, and shape (e)
            // documents lines where one expression is unreachable while its sibling on the same line
            // is reachable — so a 100% badge earned that way would be hiding a live arm. That is an
            // argument about the tool, not about the residue, and it does not depend on the list
            // above being complete.
            //
            // The residue falls into two kinds, and knowing which kind you are looking at is worth more
            // than any other single fact in this file:
            //
            //  1. Defensive arms CONFIRMED unreachable — each traced to a call site that forecloses it, and
            //     which should NOT be chased. Seven recurring shapes, with confirmed examples:
            //
            //     a. `err instanceof Error && err.message || String(err)` behind a collaborator that
            //        only ever throws Errors — node:fs and better-sqlite3 both do. worker.ts:184
            //        (assertDataDirWritable's catch), mute-expiry.ts:32, runner.ts:232. Where the
            //        collaborator IS mocked the same shape is reachable and is now covered, which is
            //        why both sync runtimes came off this list. Wave 11 added two more:
            //        actions/settings.ts:131 (behind a real readdir) and cli/cache/store.ts:63, whose
            //        collaborator is a node stream pipeline — it rejects with an Error or not at all.
            //        The reachable HALF of that same writer IS now covered: store.ts:67 re-throws the
            //        captured failure from the next write, which is what tells a caller its cache
            //        directory is gone at the row it pushes rather than only at commit.
            //     b. `x[i] ?? fallback` / `!x` guards that exist only to satisfy
            //        noUncheckedIndexedAccess. ssrf.ts:65-68 is the clearest: the four octet
            //        defaults in ipv4ToInt, which is only reached via isBlockedIpv4, which
            //        isBlockedAddress only calls after isIP(addr) === 4 — all four always exist.
            //        Also graph.ts:17 (`stack.pop()` inside `while (stack.length > 0)`),
            //        npm-audit-parse.ts:381, version-fix.ts:38/52/76/82 (a Range's comparators carry
            //        versions that already passed valid()), npm-audit.ts:70 (`!entry` on a key just
            //        read off Object.keys), version.ts:48-49 (whose own comment says so),
            //        findings.ts:285, db/queries/gemnasium.ts:162 and db/queries/osv.ts:150
            //        (`row?.count ?? 0` — a COUNT(*) always returns a row) and
            //        findings.ts:224 (`if (!best) throw` — the loop above assigns on its first pass).
            //        Wave 11: core/advisory-export.ts:336 (`if (!finding) break` inside
            //        `for (let i = offset; i < sorted.length; i++)`) and core/releases.ts:1352
            //        (`RELEASES[0] || null` — RELEASES is a literal array in the same file, and an
            //        empty one would mean the product has shipped no releases).
            //     c. A guard a caller upstream already made impossible. gemnasium/normalize.ts:329
            //        (parseComparatorForm's empty-token check — the disjunct split filters empty
            //        entries before it). Only the `tokens.length === 0` HALF of that line is the
            //        unreachable one: it now reads `!tokens || tokens.length === 0`, and the first
            //        arm — bindOperators refusing a disjunct whose operator has no version to bind
            //        to — is reachable and covered. Same line, opposite verdicts, which is shape (e)'s
            //        lesson arriving in a second file; gemnasium/feed.ts:166
            //        (advisoryIdFromPath's empty-id ternary — the `dot > 0` split cannot produce
            //        one); cli/ui.ts:60 (formatDuration's ms branch, whose only call site is guarded
            //        by `remaining > 1` second, so the argument is always over 1000);
            //        npm-audit.ts:296 and :375; runtime.ts:42; scan-request-poller.ts:53.
            //        Wave 10 added five more, all confirmed rather than assumed:
            //        notifier.ts:132 (dispatchGroup's `if (!project) return` — its ONE call site
            //        passes the project notifyForCompletedScan already null-checked at :52);
            //        notifier.ts:332 (webhookRoot(null) — projects.root_id is a RESTRICT foreign key
            //        and the client sets `foreign_keys = ON`, so a project whose root row is missing
            //        cannot exist); mcp/tools/actions.ts:165 and :166 (`advisoryId || null` inside
            //        the non-project branch, which the `scope === 'finding'` guard above already
            //        rejected — and the zod enum admits only project|finding, so there is no third
            //        scope to arrive with them absent); notification-deliveries.ts:187-188
            //        (`targetRootIds.get(id) || []` — the loop immediately above sets an entry for
            //        every row's target id, and an empty array is truthy anyway).
            //        Wave 11 added eight, every one confirmed by reading the single call site:
            //        notification-target-roots.ts:36 and notification-target-projects.ts:34 — the SAME
            //        pre-seeded-map shape as notification-deliveries.ts:187 above, and the reason is
            //        worth restating because the code reads like the fallback obviously fires: the loop
            //        seeds `out.set(id, [])` for every requested id and the query is
            //        `WHERE targetId IN (those ids)`, so `.get()` always hits, and `[]` is truthy;
            //        engine/matcher.ts:185 (rangesToDisplay's `: '*'` — its only caller, matcher.ts:90,
            //        sits behind the `hasVersionData` guard at :69, so `parts` always gets at least one
            //        push, and the no-version malware path hardcodes '*' at :77 rather than routing
            //        through it, which makes that arm vestigial);
            //        scanners/osv.ts:112 (`acceptedRangeTypesForEcosystem(ecosystem) ?? []`, whose own
            //        comment says it guards a comparator shipping without an accepted-types entry);
            //        cli/scan.ts:138 (pick's cross-ecosystem guard — matchPackages skips an ecosystem
            //        via isEnabled BEFORE it calls lookup, and the CLI's isEnabled is the very same
            //        `ecosystem === setup.ecosystem` equality pick re-checks);
            //        resolver/pnpm.ts:109 (`!existing.depPaths.includes(key)` — sourceKeys comes from
            //        Object.keys, so no key repeats) and :133 (`!version` — parseDepKey already returns
            //        null for an empty version at graph.ts:100);
            //        discovery.ts:162 (`!rel || rel.startsWith('..')` in classifySkip — its one caller
            //        at :131 passes `join(currentDir, entry.name)` while every layer's baseDir is
            //        currentDir or an ancestor, so rel is always a non-empty descendant path).
            //        Two more in discovery.ts are the same story from the other direction: :258
            //        (basenameOf's `|| abs` needs `resolve(dir) === '/'`, and its one caller passes a
            //        discovered project directory) and :330 (isFile's catch — both call sites, :245 and
            //        :302, test existsSync first, and existsSync swallows the errors statSync would
            //        throw). The sibling catch at :322 IS reachable and is now covered: an unreadable
            //        `.git` POINTER FILE, which is how a worktree or submodule stores it.
            //     d. A build-time define. help.ts:7 returns __SENTINELLO_VERSION__, which tsup
            //        injects into the published bundle and vitest never defines — under test it is
            //        always undefined, which is the dev path the env fallback exists for.
            //     e. A `?? default` on a column the schema declares NOT NULL DEFAULT <that same
            //        default>. The fallback duplicates a constraint SQLite already enforces, so no
            //        row can reach it: `row.ecosystem ?? 'npm'` in findings.ts:341 and :402,
            //        dashboard.ts:387 and libraries.ts:90 — findings.ecosystem is
            //        `.notNull().default('npm')` (schema.ts:150). Same for libraries.ts:94's
            //        `(row.severities || '')`: severity is `.notNull()` (schema.ts:157), and
            //        GROUP_CONCAT under a GROUP BY never returns NULL for a non-null column.
            //        CHECK THE SCHEMA, NOT THE CODE — the sibling `row.source ?? row.scanner` on the
            //        very same lines IS reachable, because findings.source is nullable for the window
            //        between the Phase 2 migration and the boot backfill. Identical expression shape,
            //        opposite verdict, and reading the code alone gets it wrong in both directions.
            //     f. A JS fallback duplicating a COALESCE in the query that produced the row.
            //        libraries.ts:174-175: listLibraryUsage selects
            //        `COALESCE(f.source, f.scanner)` and `COALESCE(f.ecosystem, 'npm')`, so SQLite has
            //        already substituted by the time the mapper runs. Contrast dashboard.ts:386,
            //        which selects `f.*` — the same expression there IS reachable and is now covered.
            //        A legacy-row test through this path is still worth having (libraries.test.ts has
            //        one) but it pins the two COALESCEs, not this arm; the comment there says so.
            //     g. A guard the GRAMMAR forecloses: the regex that already matched constrains what the
            //        capture can hold. Reads exactly like shape (b) at the call site but is a different
            //        check — the type system knows nothing about the pattern, so the guard is redundant
            //        to the regex and NOT to TypeScript, and deleting it would not compile.
            //        engine/comparators/pep440.ts is the whole family: :50 (`!g.release`, but PEP440_RE
            //        cannot match without the release group), :54 (the NaN guard, but release is
            //        `[0-9]+(?:\.[0-9]+)*`, so parseInt cannot return NaN), and :115/:116
            //        (`PRE_RANK[letter] ?? 0`, but the pattern admits only a|b|c|rc|alpha|beta|pre|
            //        preview and foldPreLetter maps every one of those onto a PRE_RANK key). Also
            //        discovery.ts:284, and — already noted under apps/web/lib/mcp/auth.ts's floor
            //        below — `match[1] ?? ''` on a regex that fills group 1 whenever it matches at all.
            //
            //     h. An arm a REGISTRY CONSTANT currently forecloses, which a one-line edit restores.
            //        Distinct from (c) because nothing about the call site is wrong and nothing should be
            //        deleted: the code is correct, general, and will be reached again the moment the
            //        constant changes. scanners/discovery.ts:234-237, detectEcosystems' non-npm arm —
            //        it iterates STABLE_ECOSYSTEMS, npm `continue`s at :232, and npm is the only entry
            //        while PyPI/Go/crates.io sit at status 'preview' in core/src/ecosystems.ts. Promote
            //        one and the arm is live again with no change here beyond raising this file's floors
            //        back. THIS SHAPE IS A TRAP: an entry here ages badly, because it is unreachable for
            //        a reason that is expected to stop being true. Anything filed under (h) must name the
            //        constant AND the value that revives it, so the next reader can check in one grep
            //        rather than re-deriving it.
            //
            //  2. Genuinely reachable arms that cost more setup than they have been worth so far.
            //     Believed empty. That sentence has now been wrong three times running (see the
            //     correction above), so it is recorded here as a claim awaiting falsification rather
            //     than a result. The lcov recipe below takes about a minute; run it and read a call
            //     site before believing this line. If you find one, it belongs in shape (a)-(g) with
            //     the call site quoted, or covered — not left unclassified, which is where all seven
            //     of the misses came from.
            //     Wave 11's own dispositions, kept because each records a call site someone verified:
            //     osv-client.ts:25/36 covered (that module had no test file at all — both resolution
            //     fallbacks and the first-boot mkdir were cold); cache/store.ts split into a covered
            //     half (:67) and shape (a) (:63); scan.ts:141 covered and :138 moved to shape (c);
            //     discovery.ts:162/258/284 all moved to shape (c)/(g) — the previous note here, that
            //     :284 was a reachable "HEAD ref that is whitespace", was WRONG, and :322 turned out to
            //     be the reachable one in that file; cli/cache/sync.ts's seven stay shape (c) per wave
            //     10. Wave 11 closed this bucket by advising that the next arm anyone reaches for be
            //     "assumed unreachable until the call site says otherwise". That advice is WITHDRAWN:
            //     it is what produced all seven subsequent misses, and it contradicts the rule below
            //     that an unnamed arm is unclassified. Assume nothing — go read the call site.
            //
            // Six things worth knowing before chasing the last few points:
            //
            //  - The shapes above cite CONFIRMED EXAMPLES, not all 98 arms — the list would rot into a
            //    lie the first time one moved. An arm the list does not name is therefore UNCLASSIFIED,
            //    not unreachable; wave 12's six all came from that gap. To find one, ask lcov which files
            //    still have a gap and go read the call site:
            //      awk -F: '/^SF:/{f=$2} /^BRF:/{a=$2} /^BRH:/{b=$2} /^end_of_record/{if(a>b) print a-b, f}' \
            //        coverage/lcov.info | sort -rn
            //    Swap BRF/BRH for LF/LH to do the same for lines. Anything that turns out reachable is a
            //    test worth writing; anything that does not belongs above, with the call site quoted.
            //  - A GREEN SUITE IS NOT EVIDENCE A TEST REACHES WHAT ITS NAME CLAIMS. That, not a product
            //    bug, was wave 11's find, twice over. scan.test.ts had a test called "serves nothing
            //    when the scanner asks about a different ecosystem" that passed an empty cache and no
            //    resolvedGraph — so the scanner returned no_lockfile and never called lookup, and the
            //    guard in its name never ran. store.test.ts asserted that a pipeline failure is
            //    "re-thrown from the next write" by checking that write-write-commit rejects, which
            //    commit() alone satisfies. Both passed for years; both now say what they actually pin,
            //    and the behaviour each one claimed has its own test. The uncovered arm is what exposed
            //    them, which is the argument for reading this file's list rather than the suite's names.
            //  - The v8 text reporter OMITS files at 100% on all four metrics, so a file vanishing
            //    from the table is success, not absence. Check coverage/lcov.info to confirm.
            //  - v8 reports STATEMENTS and LINES as separate numbers and they are not equal. Deriving
            //    one from the other silently mis-sets floors; read each from its own column in the text
            //    reporter's table. Note that the two reporters configured above produce neither
            //    coverage-summary.json nor coverage-final.json — for per-file numbers to compute a floor
            //    from, ask for one: `pnpm vitest run --coverage --coverage.reporter=json`. lcov.info is
            //    always there, but it carries LINES and BRANCHES only, never statements.
            //  - jsdom has NO LAYOUT ENGINE. getBoundingClientRect returns zeros, so any new test of
            //    positioning logic must stub it — otherwise the test passes while asserting nothing,
            //    since every branch computes the same numbers from zeros.
            //  - Grinding these arms is how every real bug on this branch was found: a JSON `null` in
            //    source_scope_json that threw instead of failing open, a decode crash in parseDepPath,
            //    a discovery pass that hard-deleted every project under an unmounted root, a config
            //    file accepted as a JSON ARRAY, and — from wave 10 — a lockfile cross-check that
            //    coerced a version RANGE into a version and silently deleted every npm-audit finding
            //    for a project whose package-lock could not be read. Every one of them reported
            //    success while doing nothing. FIVE, not seven: a go.sum `/go.mod` version and
            //    deleteRoot's notification_target_roots cascade were both listed here for a while and
            //    neither was ever broken — addModuleParts already rejected the empty version, and
            //    deleteRoot already ran that delete inline. Their tests are worth keeping as
            //    regression pins; they were not fixes, and counting them as such is how a test suite
            //    starts overstating what it caught. If a case here is awkward to reach, ask whether
            //    the code is right before assuming the test is wrong. Waves 11 and 12 both found no
            //    new product bug, which is the useful signal: what remains are guards, not gaps.
            //
            // README.md and apps/cli/README.md carry a coverage badge showing the STATEMENTS floor
            // below. It is honest precisely because this is a CI-enforced ratchet — so when you
            // raise that number, bump both badges in the same commit.
            thresholds: {
                statements: 99,
                branches: 97,
                // 100, not 99. Every function in every measured file is executed by the suite, and
                // this is the one metric where "all of them" is a state worth keeping rather than a
                // number to approach: at 100 a new function with no test fails CI on the spot, which
                // is a far clearer signal than watching a percentage drift down.
                functions: 100,
                lines: 99,
                // Per-path floors for the areas that are now well covered. Without these, a global
                // floor alone would let a well-covered module regress to zero as long as some other
                // area improved enough to compensate.
                'packages/core/src/**': { statements: 99, branches: 98, functions: 99, lines: 99 },
                'packages/scanners/src/resolver/**': { statements: 99, branches: 99, functions: 99, lines: 99 },
                'packages/scanners/src/engine/**': { statements: 99, branches: 98, functions: 99, lines: 99 },
                // The PyPI comparator, carried individually because it is the one comparator that is a
                // reimplementation rather than a delegation: semver ordering comes from `semver`, but
                // PEP 440's epochs, implicit-zero padding, pre/post/dev spellings and local versions are
                // ordered by hand here. A mistake mis-ORDERS rather than throws, so a Python advisory
                // silently stops matching. Branches sit at 97 for the shape (g) residue: four guards the
                // PEP440 grammar itself forecloses.
                'packages/scanners/src/engine/comparators/pep440.ts': { statements: 98, branches: 97, functions: 99, lines: 99 },
                'packages/notifications/src/render.ts': { statements: 99, branches: 99, functions: 99, lines: 99 },
                'packages/notifications/src/redact.ts': { statements: 99, branches: 99, functions: 99, lines: 99 },
                'packages/notifications/src/ssrf.ts': { statements: 98, branches: 91, functions: 99, lines: 99 },
                // The outbound transports. These are where the SSRF guard and secret redaction meet
                // the wire, so they carry floors individually rather than as a directory average.
                'packages/notifications/src/webhook.ts': { statements: 99, branches: 95, functions: 99, lines: 99 },
                'packages/notifications/src/slack.ts': { statements: 99, branches: 95, functions: 99, lines: 99 },
                'packages/notifications/src/telegram.ts': { statements: 99, branches: 96, functions: 99, lines: 99 },
                'packages/notifications/src/resolve.ts': { statements: 99, branches: 99, functions: 99, lines: 99 },
                'packages/db/src/queries/osv.ts': { statements: 99, branches: 93, functions: 99, lines: 99 },
                'packages/db/src/queries/notifications.ts': { statements: 99, branches: 95, functions: 99, lines: 99 },
                // Version and range semantics: what a bound MEANS. A wrong answer here is a false
                // positive on a clean version or a missed vulnerable one, and neither announces itself —
                // npm/rc 1.2.8 was reported as critical malware for exactly this reason. These floors are
                // the highest in the repo because the differential test against node-semver
                // (feeds/gemnasium/range-fidelity.test.ts) can only check what the parser produces; the
                // bound evaluator and the formatters need their own.
                'packages/versions/src/range.ts': { statements: 100, branches: 100, functions: 100, lines: 100 },
                'packages/versions/src/match.ts': { statements: 100, branches: 100, functions: 100, lines: 100 },
                'packages/versions/src/parse.ts': { statements: 100, branches: 100, functions: 100, lines: 100 },
                // The dialect layer: what a range STRING means (canonicaliseRange) and what a parsed
                // interval may never be (canMatchSomething). Total floors for the same reason as its three
                // siblings above, and one of its own — this is the file every advisory source now routes
                // through, so a gap here is a gap in all of them at once. Its dangerous direction is
                // WIDENING: node-semver answers "any version" for several strings that mean "this field is
                // empty" in an advisory, and the guards refusing those are the difference between a dropped
                // record and a critical finding against every release a package ever published.
                'packages/versions/src/dialect.ts': { statements: 100, branches: 100, functions: 100, lines: 100 },
                // The gemnasium path, end to end: normalizer, cache, and scanner. A regression in the
                // range parsing or the purge logic is silent, so each gets its own floor.
                //
                // BOTH NORMALIZERS SIT AT A TOTAL 100, and they are the right files to hold there rather
                // than near it. Every range defect this project has shipped lived in one of these two, and
                // each was invisible in exactly the way an uncovered branch is: the suite stayed green, the
                // cache filled with rows that reported the wrong thing, and nobody found out until a user
                // did. 99 leaves room for precisely the arm nobody exercised.
                //
                // It is also a live ratchet rather than a formality. Canonicalising npm ranges upstream of
                // this parser SILENTLY MOVED a guard's coverage — `1.0.0 - 2.0.0` used to reach the
                // bare-token check as an npm range and now resolves before it, leaving PyPI, Go and
                // crates.io as its only remaining callers. Nothing was broken and no test failed; the
                // coverage number is the only thing that noticed, and it bought a whole block of tests for
                // the three dialects that get no canonicalisation and had almost none.
                // OSV's is a TOTAL 100 and stays there. gemnasium's is 100 on functions and lines and 99 on
                // the other two, for exactly ONE arm — normalize.ts:362, `if (tokens.length > 1) return
                // null`, which refuses a disjunct where a bare version stands beside other comparators.
                //
                // That arm is unreachable from upstream data, and this was measured rather than assumed:
                // across all ELEVEN package types in gemnasium-db (not just the four Sentinello scans) no
                // record produces it. The 18 npm ranges whose raw text has a bare token beside another are
                // the spaced operators — `< 0.5.2` — and bindOperators rejoins those before this line sees
                // them. Canonicalising npm ranges through node-semver removed the last route to it: the
                // hyphen range `1.0.0 - 2.0.0` used to arrive here and now resolves to `>=1.0.0 <=2.0.0`
                // upstream.
                //
                // It is NOT deleted, and the reason is worth stating because it inverts the usual argument
                // for deleting an unreachable guard. Without it, a bare token returns its pin immediately
                // and discards every comparator after it — `1.0.0 - 2.0.0` would cache as "only 1.0.0 is
                // affected", a plausible-looking row that under-reports two majors' worth of versions and
                // that nothing downstream can detect. With it, the same input is REFUSED, and refusal is
                // what range-fidelity.test.ts's readability sweep watches for: it asserts that zero ranges
                // in the frozen 12,472-range corpus are refused, so an unreadable shape appearing upstream
                // fails the build by name. The guard is the tripwire that sweep reads. Its true arm is
                // uncovered precisely because the tripwire has never been stood on.
                //
                // The alternative was a test feeding it a hyphen range no ecosystem has ever written, which
                // would have bought the last 0.7% by asserting that dropping an imagined record is correct
                // behaviour. The corpus sweep is the stronger guarantee and it is the one being kept.
                'packages/feeds/src/gemnasium/normalize.ts': { statements: 100, branches: 100, functions: 100, lines: 100 },
                'packages/feeds/src/osv/normalize.ts': { statements: 100, branches: 100, functions: 100, lines: 100 },
                // 96 → 94 is NOT a relaxation of what is tested. parseRanges' field-by-field rebuild moved
                // out of this file into packages/versions/src/parse.ts (where it is pinned at 100 above,
                // and where a shared implementation can no longer silently drop a field one store adds).
                // Those branches were covered, so removing them shrank the denominator and left the file's
                // one deliberately-unreachable arm — the `row?.count ?? 0` at :162, inventoried above — as
                // a larger share of it. Nothing here became untested.
                'packages/db/src/queries/gemnasium.ts': { statements: 99, branches: 94, functions: 99, lines: 99 },
                'packages/db/src/gemnasium-client.ts': { statements: 99, branches: 99, functions: 99, lines: 99 },
                'packages/scanners/src/gemnasium.ts': { statements: 97, branches: 94, functions: 99, lines: 99 },
                // Produces the "upgrade to this version" advice shown next to every finding.
                'packages/scanners/src/version-fix.ts': { statements: 97, branches: 95, functions: 99, lines: 99 },
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
                'apps/web/lib/actions/**': { statements: 99, branches: 99, functions: 99, lines: 99 },
                // The MCP tool surface — the same mutations, reachable by an agent. Driven through a
                // real McpServer/Client pair so the declared zod input schemas are exercised too; a
                // schema that stops matching its handler fails here rather than in front of an agent.
                'apps/web/lib/mcp/tools/**': { statements: 99, branches: 98, functions: 99, lines: 99 },
                // Branches sit at 84 for the `root?.label || root?.path || 'unknown root'` fallback:
                // projects.root_id is a foreign key, so a project whose root row is missing cannot be
                // inserted, and the undefined-root arms are unreachable from any state the database
                // will hold. The naming, mute and dedup branches are all covered.
                'apps/web/lib/project-advisory-export.ts': { statements: 99, branches: 84, functions: 99, lines: 99 },
                'apps/web/components/findings/**': { statements: 99, branches: 99, functions: 99, lines: 99 },
                // The worker's orchestration core. runner owns scanner ordering and cross-scanner
                // dedup; notifier owns the record-attempt-before-send rule; config-loader owns the
                // first-boot guard that stops a restart reverting the operator's portal edits.
                'apps/worker/src/runner.ts': { statements: 99, branches: 97, functions: 99, lines: 99 },
                'apps/worker/src/notifier.ts': { statements: 97, branches: 95, functions: 99, lines: 99 },
                'apps/worker/src/config-loader.ts': { statements: 99, branches: 99, functions: 99, lines: 99 },
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
                'apps/worker/src/scheduler.ts': { statements: 99, branches: 99, functions: 99, lines: 99 },
                'apps/worker/src/scan-request-poller.ts': { statements: 99, branches: 97, functions: 99, lines: 99 },
                'apps/worker/src/mute-expiry.ts': { statements: 99, branches: 88, functions: 99, lines: 99 },
                // The two advisory-source runtimes: lazy cache open, per-batch scanner selection, and
                // the scanner closures that gate matching on the live (source, ecosystem) cell AND the
                // normalizer stamp. A regression there silently reports "no vulnerabilities".
                'apps/worker/src/osv-runtime.ts': { statements: 99, branches: 96, functions: 99, lines: 99 },
                'apps/worker/src/gemnasium-runtime.ts': { statements: 99, branches: 97, functions: 99, lines: 99 },
                // Their persistence halves, where an ordering mistake corrupts the operator's cache:
                // invalidate only once the download is live, purge only after the full stream succeeds,
                // advance the cursor/sha only on success.
                'apps/worker/src/osv-sync.ts': { statements: 99, branches: 99, functions: 99, lines: 99 },
                'apps/worker/src/gemnasium-sync.ts': { statements: 99, branches: 94, functions: 99, lines: 99 },
                // The dispatch decision: every filter that decides whether an operator gets paged.
                'packages/db/src/queries/notification-deliveries.ts': { statements: 99, branches: 91, functions: 99, lines: 99 },
                // Its inputs: the per-target root and project allow-lists. Zero rows means "everything",
                // so the dangerous regression is a WRITE that drops a row — the scope silently widens
                // from one root to all of them and the operator is paged for projects they excluded.
                // Branches sit at 83 for one arm per file, both the pre-seeded-map shape (c) above.
                'packages/db/src/queries/notification-target-*.ts': { statements: 99, branches: 83, functions: 99, lines: 99 },
                // The feed HTTP client. Its retry policy decides whether a transient upstream failure
                // costs one round trip or silently leaves a source unauditable for the whole run.
                'packages/feeds/src/http.ts': { statements: 99, branches: 99, functions: 99, lines: 99 },
                // The read paths behind the portal's numbers and the triage views. Each applies the
                // same blast-radius rules (open episodes, unmuted, active source cells); a regression
                // shows an operator findings they silenced or hides ones they have not.
                'packages/db/src/queries/dashboard.ts': { statements: 99, branches: 93, functions: 99, lines: 99 },
                'packages/db/src/queries/libraries.ts': { statements: 99, branches: 66, functions: 99, lines: 99 },
                'packages/db/src/queries/projects.ts': { statements: 99, branches: 99, functions: 99, lines: 99 },
                'packages/db/src/queries/scans.ts': { statements: 99, branches: 93, functions: 99, lines: 99 },
                'packages/db/src/queries/config.ts': { statements: 99, branches: 99, functions: 99, lines: 99 },
                'packages/db/src/queries/ecosystem-backfill.ts': { statements: 96, branches: 85, functions: 99, lines: 99 },
                // Owns finding-episode lifecycle: which episode continues, which closes, and which of
                // several duplicate rows survives a collapse (the earliest-detected one, so a finding's
                // age is not silently reset). Was the weakest floor in this list at 70/41/56/74.
                'packages/db/src/queries/findings.ts': { statements: 98, branches: 91, functions: 99, lines: 99 },
                // applyConfigFile is the remaining uncovered branch set in options.ts.
                'apps/cli/src/options.ts': { statements: 99, branches: 99, functions: 99, lines: 99 },
                'apps/cli/src/cache/store.ts': { statements: 99, branches: 97, functions: 99, lines: 99 },
                'apps/cli/src/cache/meta.ts': { statements: 98, branches: 99, functions: 99, lines: 97 },
                // The advisory-feed downloaders. Both are driven through a real ZIP generated in
                // memory (packages/feeds/src/zip.fixture.ts) so unzipper, the entry filter and the
                // normalizers all run for real. The trap they guard is silent rather than loud:
                // gemnasium's rootOffset and OSV's canonical-vs-lowercase feed directory both match
                // NOTHING when wrong, which reads as a clean upstream rather than a bug.
                'packages/feeds/src/osv/feed.ts': { statements: 99, branches: 99, functions: 99, lines: 99 },
                'packages/feeds/src/gemnasium/feed.ts': { statements: 99, branches: 98, functions: 99, lines: 99 },
                // The CLI's terminal and cache layers. ui.ts writes exclusively to stderr because
                // stdout carries the advisory document a user may pipe straight into an agent, and
                // confirmSeed refuses on a non-TTY rather than pulling ~100 MB onto a build machine
                // unattended. sync.ts owns seed-vs-refresh, where a wrong answer costs either a
                // needless full re-download or a silently stale cache.
                'apps/cli/src/ui.ts': { statements: 99, branches: 99, functions: 99, lines: 99 },
                'apps/cli/src/doctor.ts': { statements: 99, branches: 99, functions: 99, lines: 99 },
                // Renders the advisory document itself. Total floors because stdout is a data channel a
                // user pipes into an agent: resolvePrompt deciding wrongly prepends several hundred words
                // of agent instructions to a document the caller asked to contain findings alone.
                'apps/cli/src/report.ts': { statements: 99, branches: 99, functions: 99, lines: 99 },
                'apps/cli/src/cache/sync.ts': { statements: 96, branches: 93, functions: 99, lines: 98 },
                'apps/cli/src/cache/lookup.ts': { statements: 99, branches: 99, functions: 99, lines: 99 },
                'apps/cli/src/scan.ts': { statements: 98, branches: 96, functions: 99, lines: 99 },
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
                'apps/cli/src/run.ts': { statements: 98, branches: 97, functions: 99, lines: 98 },
                // The subprocess half of npm-audit. Every branch here returns "no findings", but they
                // mean entirely different things to an operator — pm_missing is "install pnpm",
                // audit_schema_mismatch is "Sentinello needs updating", and ok-with-zero-findings is
                // "your project is clean". Picking the wrong one is silent, because the scan still
                // succeeds, which is what makes these floors worth carrying.
                'packages/scanners/src/npm-audit.ts': { statements: 98, branches: 96, functions: 99, lines: 98 },
                'packages/scanners/src/npm-audit-parse.ts': { statements: 98, branches: 98, functions: 99, lines: 99 },
                // Total floors, and the newest entry in this list. It decides which npm-audit findings
                // are FALSE positives already fixed by an override — so every bug here deletes real
                // findings and reports the project clean. Wave 10 found one: it coerced a version RANGE
                // into a version, so any project whose package-lock could not yield an installed-version
                // snapshot (lockfileVersion 1, unreadable, or schema-rejected) had every finding
                // silently dropped. Its contract is fail-open, and the floors are total to keep it that way.
                'packages/scanners/src/lockfile-cross-check.ts': { statements: 99, branches: 99, functions: 99, lines: 99 },
                // The five modules that had no test file at all until wave 8. schema.ts is the literal
                // contract between apps/web and apps/worker, and its floors are total for a reason: the
                // suite asserts each foreign key against a REALLY migrated database, so a column added
                // here without a generated migration fails there rather than as "no such column" in the
                // portal at runtime. client.ts owns the path resolution tying both apps to one file —
                // when it disagrees between them nothing errors, each app just opens its own private
                // database and the Scan button silently does nothing.
                'packages/db/src/schema.ts': { statements: 99, branches: 99, functions: 99, lines: 99 },
                'packages/db/src/client.ts': { statements: 99, branches: 99, functions: 99, lines: 99 },
                // The OSV cache's own path resolution — client.ts's problem a second time, for a second
                // file. osv.db is defined as the SIBLING of whatever sentinello.sqlite resolves to, and
                // when that rule disagrees between the worker and the scanner nothing errors: one process
                // seeds advisories into its osv.db and the other opens an empty one and reports every
                // project clean. Total floors, and it had no test file at all until wave 11.
                'packages/db/src/osv-client.ts': { statements: 99, branches: 99, functions: 99, lines: 99 },
                'packages/scanners/src/index.ts': { statements: 99, branches: 99, functions: 99, lines: 99 },
                'apps/web/lib/db.ts': { statements: 99, branches: 99, functions: 99, lines: 99 },
                'apps/web/lib/cn.ts': { statements: 99, branches: 99, functions: 99, lines: 99 },
                // Collapses the one-row-per-(scanner, advisory, dep-path) table into what the operator
                // sees. Both directions are dangerous: merging too eagerly HIDES a vulnerability,
                // merging too little shows the same thing three times.
                'apps/web/lib/merge-findings.ts': { statements: 99, branches: 99, functions: 99, lines: 99 },
                // Walks read-only mounts it does not control, so its unreadable-path handling is not
                // padding: one bad permission must not abort the scan of every other project under the
                // same root.
                //
                // 98/97/99 → 95/94/95 is NOT a relaxation of what is tested; no test was removed and no
                // behaviour went uncovered. detectEcosystems now iterates STABLE_ECOSYSTEMS, and with
                // PyPI/Go/crates.io at status 'preview' that list holds npm alone — whose arm `continue`s
                // before the resolver-kinds loop at :234-237, leaving a correct, general block that
                // nothing can reach. It is inventoried as shape (h) above. RAISE THESE BACK in the same
                // commit that promotes any ecosystem to 'stable': the arm goes live again, and leaving
                // the floors low would let a real regression in it pass unnoticed.
                'packages/scanners/src/discovery.ts': { statements: 95, branches: 94, functions: 99, lines: 95 },
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
