import { type Locale } from './types'

export type ReleaseEntry = {
    version: string
    date: string
}

export type ReleaseCopy = {
    title: string
    items: string[]
}

function stripVPrefix(value: string): string {
    return (value.startsWith('v') && value.slice(1)) || value
}

// Newest first. The locale-independent version index. Adding a release = one entry here plus a
// RELEASE_COPY entry in every locale below. See CLAUDE.md for the release-please version-sync flow.
export const RELEASES: ReleaseEntry[] = [
    { version: '3.3.1', date: '2026-08-15' },
    { version: '3.3.0', date: '2026-08-15' },
    { version: '3.2.0', date: '2026-08-15' },
    { version: '3.1.1', date: '2026-08-14' },
    { version: '3.1.0', date: '2026-08-13' },
    { version: '3.0.1', date: '2026-08-04' },
    { version: '3.0.0', date: '2026-08-03' },
    { version: '2.6.0', date: '2026-07-29' },
    { version: '2.5.0', date: '2026-07-28' },
    { version: '2.4.3', date: '2026-07-26' },
    { version: '2.4.2', date: '2026-07-25' },
    { version: '2.4.1', date: '2026-07-25' },
    { version: '2.4.0', date: '2026-07-25' },
    { version: '2.3.0', date: '2026-06-09' },
    { version: '2.2.0', date: '2026-06-09' },
    { version: '2.1.0', date: '2026-06-06' },
    { version: '2.0.1', date: '2026-06-04' },
    { version: '2.0.0', date: '2026-06-04' },
    { version: '1.4.0', date: '2026-05-29' },
    { version: '1.3.1', date: '2026-05-28' },
    { version: '1.3.0', date: '2026-05-28' },
    { version: '1.2.0', date: '2026-05-24' },
    { version: '1.1.2', date: '2026-05-24' },
    { version: '1.1.0', date: '2026-05-23' },
    { version: '1.0.1', date: '2026-05-23' },
    { version: '1.0.0', date: '2026-05-23' }
]

// Localized highlights, keyed by locale then version. Dots in the version keys are fine here —
// this is plain TS data, not a next-intl message key (next-intl forbids '.' in keys).
export const RELEASE_COPY: Record<Locale, Record<string, ReleaseCopy>> = {
    en: {
        '3.3.1': {
            title: 'Same release as 3.3.0, with a Docker image that builds',
            items: [
                '3.3.0 published to npm and GitHub, but its container image failed to build, so at release time there was no 3.3.0 on GHCR or Docker Hub. The Dockerfile lists each workspace package it installs, and one of them — the version-comparison package — had never been listed. Nothing in the image imported it until this release, so the omission had never once mattered. A corrected 3.3.0 image has since been published, built from 3.3.0’s own application code, so <code>docker pull sentinello:3.3.0</code> works again. 3.3.1 carries the same fix in the source tree. If you use the CLI, 3.3.0 was already correct.'
            ]
        },
        '3.3.0': {
            title: 'Only the ecosystems that actually work — and notifications you can trust',
            items: [
                'A notification could arrive empty. One operator received a Telegram message reading “Sentinello found vulnerabilities in woc-ide” with nothing under it. Dispatch is scoped to the project but ran once per scanner, so npm audit’s pass was handed two pending OSV events, matched neither, and rendered the headline over an empty list anyway. It then marked both events delivered — so the two findings it never named were recorded as notified, and nothing revisits a delivered event. An event is now dispatched only if it can be described, and one that cannot stays pending and is reconsidered on the next scan',
                'A finding is reported at the worst grade any source gave it, and that escalation was reaching the dashboard, project totals and the CLI’s <code>--fail-on</code> gate — but not notification thresholds. Notification ran before corroboration, so the event was stamped with the surviving source’s own grade and never rewritten. On one instance 135 open findings carried an event severity below the finding’s real one, <strong>41 of them recording a critical as low, high or moderate</strong>. A target filtered to critical and high would never have been paged for any of them, permanently',
                'Scan schedules stopped at midnight instead of wrapping. “Every 3 hours from 07:00” ran at 07, 10, 13, 16, 19 and 22 and then not again until 07:00 — six scans a day rather than eight, with a nine-hour blind window every night — while Settings went on reporting the interval you picked. “Every 6 hours from 20:00” managed one scan a day. The slots now wrap',
                '<strong>Python, Go and Rust have been withdrawn.</strong> This is not caution about rough edges: their failures reported as clean. Fix derivation and version ordering are semver-only, so an OSV Django advisory recommended “upgrade to 3.2.23” against an installed 4.2; OSV’s PyPI package names are not PEP 503-canonicalized, so they never joined the resolver’s; and gemnasium’s range parser cannot read PEP 440 comma intersections. A source that answers “no vulnerabilities” for the wrong reason is worse than one that is not offered, so they are gone from the product surface entirely — no switch, no discovery, no download. <strong>Findings you already collected under them stay visible and mutable; nothing is deleted.</strong> The npm ecosystem is now labelled <strong>Node.js</strong>, which names the package ecosystem actually scanned rather than a language',
                '<strong>Settings → Sources</strong> has been rebuilt around that. Every source used to restate its own explanation beside its own switch, and each cache-backed one carried a five-row status panel with its own full-size “Refresh now” button — even though that button enqueues one shared signal per source however many times it appears. The switches now say only whether a source is on; what each one adds, what it downloads and from where, and when it runs moved into a single reference table beneath them, and sync state collapsed to one line',
                'Packages that npm’s own lockfile says are reachable from production were being demoted to dev-only. A lockfile omitting <code>dev: true</code> is npm asserting the package IS reachable from production — a stronger statement than the root manifest can make — but the resolver overrode it whenever the name also appeared under <code>devDependencies</code>, which is exactly when npm was right. Measured across 130 real projects: 142 packages demoted in 97 of them — lodash, semver, postcss, tailwindcss, @babel/runtime — hiding seven open findings from the production-only filter on one instance',
                'Any package pinned to a version like <code>0.0.0-20180523222229-09b5706aa936</code> matched <strong>no advisory at all</strong>, not even an open-ended one, and the scan reported ok with zero findings. An advisory bound of <code>introduced: 0</code> was compared as the release 0.0.0, and under semver a prerelease sorts below its release. 330 of the 19,085 comparable ranges in a real cache were stored as intervals nothing could satisfy',
                'An interrupted OSV sync could erase an advisory permanently. The incremental path deleted an advisory’s rows and then fetched the replacement inside a try/catch, so any timeout, 5xx or shutdown removed it outright — then advanced the cursor anyway, putting the id permanently behind it. The loss was silent, survived until the next full re-seed, and happened on a sync that reported success. The <code>npx sentinello</code> cache eroded the same way on every flaky run. Both now fetch first and replace second',
                'The CLI’s <code>--dep-type dev</code> meant “reachable from dev at all” while the portal means “reachable <em>only</em> from dev”, so a package reachable from both appeared in one view and not the other — 177 open findings differ between the two readings on one instance. The CLI now uses the portal’s rule, and it honours OSV’s <code>withdrawn</code> field, which it was structurally incapable of reading before: 585 rows of a real npm cache carry one, and every one of them was being reported as a live finding',
                'A gemnasium advisory that says a vulnerability begins <em>after</em> a version — <code>&gt;1.2.8</code> rather than <code>&gt;=1.2.8</code> — was being read as though the boundary version itself were affected. The 2021 hijack of the <code>rc</code> package is written exactly that way, and 1.2.8 is its last clean release: the very version the advisory’s own remediation note tells you to stay on. Every project with <code>rc</code> installed was shown a critical malware finding, with no fix available, against a version that was never compromised. Bounds are now kept exactly as the advisory states them, and false criticals of this shape disappear',
                'The same rounding ran in the other direction and was hiding real findings. An advisory bounded by <code>&lt;=2.0.0</code> was stored as “below 2.0.0”, so 2.0.0 — the version it is most explicit about — went unreported, and an advisory naming exactly one affected version collapsed into an empty range and was discarded whole. Expect a small number of new findings that were always present and simply invisible',
                'Advisory ranges written with syntax Sentinello does not implement — <code>^1.0.0</code>, <code>~1.0.0</code> — used to be stored as an exact-version pin on the literal text, which could never match anything for as long as it stayed cached: a live-looking advisory that was incapable of firing. Those records are now refused rather than kept in a form that cannot work, and advisories whose upper bound carries no clean fix version finally get an upgrade suggestion',
                'The helper that masks a webhook URL or bot token before it reaches a log line was printing short ones in full. It rejected values of six characters or fewer but then kept an eight-character head and a four-character tail, and nothing checked that those two halves did not meet — so every secret between 7 and 12 characters came back complete. It now hides at least eight characters or redacts the value entirely'
            ]
        },
        '3.2.0': {
            title: 'Findings now show which sources agree — and retracted advisories stop being reported',
            items: [
                'When more than one advisory database reports the same vulnerability, Sentinello has always kept a single finding — reporting one flaw three times because three databases know about it is noise. What it used to do was discard everything about the sources it collapsed, so a vulnerability confirmed independently by npm audit, OSV and GitLab gemnasium looked exactly like one that a single database had ever heard of. On a real instance that is two thirds of all findings. Each finding now carries the other sources that reported it, and their badges appear alongside the surviving one',
                'A finding is reported at the WORST severity any source assigned it. The databases genuinely disagree — gemnasium computes severity from the CVSS vector while npm audit takes GitHub’s bucket — and for a scanner the cautious reading is the one worth acting on. This is not cosmetic: an escalated finding moves between severity buckets on the dashboard, in project totals, in the CLI’s <code>--fail-on</code> gate and in notification thresholds. Expect some counts to shift on the first scan after upgrading; nothing new was detected, the same findings are being graded more carefully',
                'Where the sources disagree, the finding shows a control next to its severity that opens what each one actually said — its own advisory id and its own grade. It appears only when there is a disagreement to explain, so a finding everyone grades alike stays uncluttered',
                'OSV records a withdrawal in a dedicated field and GitHub removes withdrawn advisories before <code>npm audit</code> ever sees them, but GitLab gemnasium has no such field in its schema. It retracts an advisory by rewriting the record in place — the title becomes “False Positive”, “Withdrawn Advisory: …” or “Duplicate Advisory: …” — while leaving the versions it used to name exactly where they were. Sentinello was reading those versions and reporting findings GitLab had explicitly taken back: 383 records across JavaScript, Python, Go and Rust, including one that reported <code>express</code> under the title “False Positive”. All of them are now dropped, which also removes a whole class of duplicate findings, since 278 of the 383 are advisories withdrawn for being duplicates of another one',
                'The check matches the retraction markers exactly rather than searching for the words anywhere, so a genuine advisory that happens to be *about* a false positive still reports — Cosign’s CVE-2026-39395, titled “Cosign’s verify-blob-attestation reports false positive when payload parsing fails”, is unaffected',
                'The gemnasium cache rebuilds itself on its first sync after this upgrade, so the retracted advisories disappear then. Nothing to do — it happens on the daily schedule, or immediately from Settings → Sources → Refresh'
            ]
        },
        '3.1.1': {
            title: 'Advisory version ranges are right in both directions',
            items: [
                'Some GitLab gemnasium advisories ship no machine-readable version range at all — 698 of the 10,777 JavaScript ones. Sentinello had been filling that gap by assuming every version below the first listed fix was affected, but that list is unordered and holds one fix per release branch, so the guess regularly landed on the wrong branch. protobufjs 7.6.5 was reported as a critical remote code execution even though that branch was patched in 7.5.5, and three separate advisories each claimed every version of vite below 8.0.5 was vulnerable. Sentinello no longer invents a range. It recovers the real one from the same advisory as published under its other identifier, from the advisory’s own description, or — only if you have OSV switched on — from the OSV copy already on your machine, and it discards the record rather than guessing when none of those can answer. Expect some criticals to disappear',
                'OSV describes an advisory fixed on several release branches as a separate entry per branch, and Sentinello was keeping the first and discarding the rest — 1,927 vulnerable version ranges for JavaScript alone, every one of them a real vulnerability it could no longer see. The minimatch advisory covers eight branches and only one survived, so an installed minimatch 3.0.4 or 9.0.0 went unreported; next and ua-parser-js lost branches the same way. Every branch is kept now. Expect some new findings to appear — those vulnerabilities were always present, they were simply invisible',
                'Both advisory caches rebuild themselves the first time they sync after this upgrade, because the ranges they hold were produced by the old code. There is nothing to do — it happens on the daily schedule, or immediately from Settings → Sources → Refresh if you would rather not wait'
            ]
        },
        '3.1.0': {
            title: 'Muted findings get out of the way — and the database stops growing forever',
            items: [
                'A muted finding is a decision you already made, so it now leaves the project page entirely instead of sitting there greyed out. That is not just tidier: every number on the page — the heading count, both tab badges, the pagination, the per-library totals, the export button — is counted from the same rows, so the page finally agrees with the dashboard, the MCP tools and the advisory export, all of which were already leaving muted findings out. A “Show muted” toggle brings them back whenever you want them, including on a project whose findings are *all* muted',
                'Typing in a dialog no longer loses focus after a single character. That bug made the mute dialog’s Reason field — required, and the only thing that makes a mute auditable months later — effectively impossible to fill in. The same dialog also stopped inheriting the alignment of whatever table row it was opened from, which is why muting a finding gave you a right-aligned dialog while muting a project did not',
                'Scan history no longer grows forever. Nothing had ever deleted a scan row by age, so a project that stayed on disk accumulated one row per source per sweep indefinitely — a real instance reached 2.2 GB in under three months. Settings → Advanced now carries a retention window, 90 days by default, and the worker prunes past it hourly while always keeping the 100 most recent scans of every project. Findings, mutes and notification history are never touched; only the scan log is. At 90 days an instance upgrading into this deletes nothing on its first pass — trimming starts only once history is genuinely older than the window, or once you lower it yourself',
                'The bulk of that growth was `npm audit`’s raw output, stored in full on every successful scan and read by nothing at all — 98.7% of that instance’s database. Scans now record a short summary instead, taking a row from roughly 79 KB to about 100 bytes, with a hard ceiling so no scanner can do this again',
                'Over MCP, `get_dashboard_summary` now states that a project you have muted leaves its totals while `list_projects` still returns it. The two count different populations on purpose, and an agent comparing them was reading that as a bug. `list_scans` also stopped returning each scan’s raw scanner output, which could reach around 16 MB in a single response'
            ]
        },
        '3.0.1': {
            title: 'The gemnasium download works again — and the CLI gives the terminal back',
            items: [
                'GitLab gemnasium failed to download on 3.0.0 with `HTTP 406`, for everyone. Node’s built-in fetch attaches a `Sec-Fetch-Mode: cors` header that a program is not permitted to remove, and GitLab refuses any repository archive request carrying it — so this was never about your network, your IP, or how many times you retried. The download uses a plain HTTPS request now, and succeeds',
                'The archive is fetched by commit id rather than by branch name, so everyone updating from the same upstream commit shares one cached copy instead of each asking GitLab to build a fresh 60 MB archive. A first download that took nearly seven minutes now finishes in seconds',
                'The CLI used to finish its entire run — advisory written, summary printed — and then never return the terminal. The connection carrying the download was left open behind it, which kept the process alive; it is now closed as soon as the archive has been read',
                'A feed that refuses a download no longer stalls for three minutes before saying so. It reports in seconds and, in a terminal, offers to try again — retrying only the source that actually failed',
                '`--fail-on` is honest in both directions. It refuses a run whose advisory source could not be consulted, rather than reporting a clean scan it never performed; and it no longer fails a run over a source you switched off yourself with `SENTINELLO_OSV_FEED_URL=off` or `SENTINELLO_GEMNASIUM_FEED_URL=off` and never downloaded'
            ]
        },
        '3.0.0': {
            title: 'Sentinello now runs without a portal at all',
            items: [
                'The scanners ship as a CLI on npm. `npx sentinello` walks a folder, finds every project underneath, checks them against npm audit, OSV and GitLab gemnasium, and writes a markdown advisory with a remediation prompt attached — no install, no account, no database, and nothing about your code leaves the machine',
                'Piped, the advisory is the only thing on stdout, so `npx sentinello | claude -p "$(cat -)"` hands an agent a complete work list without anything corrupting the document',
                'A first run no longer loses the gemnasium source to a refused download. GitLab declines its archive for a minute or two at a time, and the old retry gave up after thirteen seconds; the CLI now waits it out, says why it is waiting, and takes `--feed-wait` if the default of three minutes is wrong for you',
                'Both download estimates were measured rather than guessed: the OSV npm export is quoted at 204 MB rather than 196, and the gemnasium archive at 52 MB rather than 80. The consent prompt marks an estimate with a tilde so it is never mistaken for a size the server reported',
                'A value that looks like a flag is now rejected instead of taken literally — `--out --` used to write an advisory to a file named `--` inside your project and report success',
                'The What’s new panel no longer runs off the bottom of the window when a release has a lot to say'
            ]
        },
        '2.6.0': {
            title: 'The advisory document actually arrives — and counts what you mean',
            items: [
                'get_project_advisory now returns the advisory document itself. Connected clients previously received only its metadata — a filename and a count — and never the document, despite the tool describing it as a complete work list',
                'The advisory export now holds one entry per distinct advisory with its sources merged, instead of one per scanner row: a vulnerability that npm audit and OSV both report is a single work item carrying both advisory IDs, not two near-identical ones. This applies to the portal’s Download .md as well, and the count now matches the dashboard',
                'A project too large to fit in one MCP response is now paginated — the document states that it is incomplete and gives the exact follow-up call to fetch the rest, instead of being silently cut off where an agent would read the remainder as clean',
                'Every input on every MCP tool now carries a description, and a new list_mutes tool exposes the mute IDs that unmute needs — previously obtainable only by creating the mute in the same session',
                'Fixed a gap in the severity counts: a finding whose severity was not one of the five known values was counted as a finding but placed in no severity bucket, so a project whose only finding had one appeared completely clean'
            ]
        },
        '2.5.0': {
            title: 'The advisory export, straight over MCP',
            items: [
                'Connected MCP clients can pull a project’s full Markdown advisory with the new get_project_advisory tool — the same document as the portal’s Download .md, without copying it out of the browser',
                'Muted findings are now excluded from the project advisory export, so an agent is never handed work whose risk you have already accepted',
                'Note: because the advisory contains your export prompt, an MCP client can now read whatever you have written in Settings → Export'
            ]
        },
        '2.4.3': {
            title: 'Unclipped popups, stricter export prompt',
            items: [
                'Dropdowns, the dependency-path popover, and the advisory export menu no longer get clipped by the table or dialog they sit in — they render above the page and flip above the trigger when there is no room below',
                'The default advisory-export prompt now asks the agent to plan before editing anything, group findings that share a single fix, and spell out the code impact of each version bump — and it targets zero findings while ruling out the shortcuts to a fake zero: muting, widening ranges, or narrowing the scan, with anything genuinely unfixable listed in a dated residual table'
            ]
        },
        '2.4.2': {
            title: 'Branch in its own column',
            items: [
                'The git branch a project was scanned on now has a column of its own in the project list — plain text, no icon — instead of sitting under the project name'
            ]
        },
        '2.4.1': {
            title: 'Clean shutdowns',
            items: [
                'Restarting the container no longer kills a scan that is midway through writing, and the worker now starts immediately instead of retrying for ~30 seconds first',
                'Set stop_grace_period: 60s (or --stop-timeout 60) in your compose file to give it room — the README and Docker docs now cover this'
            ]
        },
        '2.4.0': {
            title: 'Polyglot scanning — Python, Go, and Rust join npm',
            items: [
                'Sentinello now scans Python, Go, and Rust projects alongside npm — lockfiles are resolved entirely offline, and every project reports its scan coverage (full, partial, or unauditable) so gaps are visible instead of silent',
                'GitLab’s gemnasium database joins npm audit and OSV as an offline advisory source, deduplicated against the others by CVE/GHSA alias; Settings → Sources is now a Languages × Sources matrix with per-cell notification scope, and npm audit itself can be turned off as long as one source stays active',
                'Findings now record the git branch they came from, shown in the project list, the project header, and every notification',
                'Project rows carry their own actions — scan now, copy or download the advisory, mute or unmute, and edit tags — so a triage pass no longer needs a trip into each project',
                'The projects dashboard went from ~3.3s to ~0.03s, and navigation now shows loading states instead of appearing frozen',
                'Security: 25 dependency advisories cleared, including libvips CVEs that were live in the portal’s image optimizer and nine Next.js advisories affecting the shipped portal',
                'The default advisory-export prompt now covers minimum release age, lockfile verification, and stale overrides'
            ]
        },
        '2.3.0': {
            title: 'Simpler MCP setup — no environment variables',
            items: [
                'Set up MCP entirely in Settings → MCP: generate a token to turn the /api/mcp endpoint on, clear it to turn it off — the SENTINELLO_MCP_ENABLED and SENTINELLO_MCP_API_TOKEN environment variables are gone (an existing env token is imported once on upgrade)',
                'Ready-to-paste connection snippets for Claude Code, Codex, Cursor, and Claude Desktop, pre-filled with your token',
                'When SENTINELLO_PORTAL_BASE_URL is set in the environment it’s shown read-only in Settings → Advanced, since it stays authoritative and is re-applied on every boot'
            ]
        },
        '2.2.0': {
            title: 'Fewer false alarms and self-cleaning findings',
            items: [
                'Malware advisories now match the exact compromised version — a clean or already-remediated version of a once-compromised package is no longer flagged',
                'Duplicate findings now resolve themselves on the next scan, so old or stranded entries clear out automatically',
                'Production and development labels are now computed one consistent way across every source (npm and OSV)'
            ]
        },
        '2.1.0': {
            title: 'A cleaner project header and consistent filters',
            items: [
                'Streamlined the project header — rename inline beside the title, with mute and tags as one-tap icons',
                'Filter findings by source (npm / OSV) from a new dropdown beside the dependency-type filter',
                'Unified, consistent dropdowns across the app, with type-to-search on long lists like time zones'
            ]
        },
        '2.0.1': {
            title: 'Clearer upgrade guidance',
            items: [
                'Expanded upgrade steps for the 2.0 breaking changes',
                'README notes the localhost-only port binding'
            ]
        },
        '2.0.0': {
            title: 'Multi-source scanning and a hardened, secure-by-default install',
            items: [
                'OSV as an opt-in second source (Settings → Sources, off by default) with malicious-package detection, matched against the public OSV database in a local cache',
                'Findings now merge across sources — one row per vulnerability, every source tagged, the best available fix, and the union of dependency paths, with a source filter and a dependency-path popover',
                'Security hardening: the MCP endpoint is off by default and requires a token, webhook delivery is guarded against SSRF, an optional portal login gate, and the container runs as an unprivileged user',
                'Settings is now a top-level section with a sidebar and a Profile page'
            ]
        },
        '1.4.0': {
            title: 'MCP integration & what’s-new',
            items: [
                'MCP server at /api/mcp for Claude Desktop, Cursor, and other clients',
                'New Settings → MCP section with server URL and token management',
                'What’s-new pill plus a Release notes history'
            ]
        },
        '1.3.1': { title: 'Footer version fix', items: ['The running version renders cleanly in the footer'] },
        '1.3.0': {
            title: 'Notification improvements',
            items: [
                'Filter notifications by environment',
                'Simpler notification-target edit form',
                'Duplicate an existing notification target'
            ]
        },
        '1.2.0': {
            title: 'Projects and Libraries pages',
            items: ['The home view is split into dedicated Projects and Libraries pages']
        },
        '1.1.2': {
            title: 'Live schedule reload',
            items: ['The worker reloads the scan schedule the moment you save changes in the portal']
        },
        '1.1.0': {
            title: 'Safer deletes & a clearer update banner',
            items: [
                'Confirmation prompts before deleting roots and notification targets',
                'Update notice moved to a dismissible top banner',
                'Worker prunes stale roots when a host mount disappears'
            ]
        },
        '1.0.1': {
            title: 'Scanner accuracy fixes',
            items: [
                'Drop audit findings whose installed version isn’t actually in the vulnerable range',
                'Allow deleting a notification target that has delivery history'
            ]
        },
        '1.0.0': { title: 'Initial open-source release', items: ['The first public release of Sentinello'] }
    },
    es: {
        '3.3.1': {
            title: 'La misma versión que 3.3.0, con una imagen de Docker que sí compila',
            items: [
                '3.3.0 se publicó en npm y GitHub, pero su imagen de contenedor falló al compilar, así que al momento del lanzamiento no había 3.3.0 en GHCR ni en Docker Hub. El Dockerfile enumera cada paquete del workspace que instala, y uno de ellos —el de comparación de versiones— nunca había estado en la lista. Nada dentro de la imagen lo importaba hasta esta versión, así que la omisión jamás había importado. Desde entonces se publicó una imagen 3.3.0 corregida, construida con el mismo código de aplicación de 3.3.0, así que <code>docker pull sentinello:3.3.0</code> vuelve a funcionar. 3.3.1 lleva esa misma corrección en el árbol de código. Si usás la CLI, 3.3.0 ya estaba bien.'
            ]
        },
        '3.3.0': {
            title: 'Solo los ecosistemas que realmente funcionan — y notificaciones en las que podés confiar',
            items: [
                'Una notificación podía llegar vacía. Un operador recibió un mensaje de Telegram que anunciaba vulnerabilidades en un proyecto y no listaba ninguna. El envío está delimitado por proyecto pero corría una vez por escáner, así que la pasada de npm audit recibió dos eventos pendientes de OSV, no coincidió con ninguno y aun así renderizó el encabezado sobre una lista vacía. Después marcó ambos eventos como entregados — así que los dos hallazgos que nunca nombró quedaron registrados como notificados, y nada vuelve a revisar un evento entregado. Ahora un evento solo se envía si puede describirse, y el que no puede queda pendiente y se reconsidera en el siguiente escaneo',
                'Un hallazgo se reporta con la peor calificación que le haya dado cualquier fuente, y esa escalada llegaba al panel, a los totales por proyecto y a la compuerta <code>--fail-on</code> de la CLI — pero no a los umbrales de notificación. La notificación corría antes de la corroboración, así que el evento quedaba sellado con la calificación de la fuente sobreviviente y nunca se reescribía. En una instancia real, 135 hallazgos abiertos tenían una severidad de evento por debajo de la real, <strong>41 de ellos registrando un crítico como bajo, alto o moderado</strong>. Un destino filtrado a crítico y alto nunca habría sido alertado por ninguno de ellos, de forma permanente',
                'Los escaneos programados se detenían a medianoche en lugar de continuar. “Cada 3 horas desde las 07:00” corría a las 07, 10, 13, 16, 19 y 22 y después recién a las 07:00 — seis escaneos por día en lugar de ocho, con una ventana ciega de nueve horas cada noche — mientras Configuración seguía informando el intervalo que elegiste. “Cada 6 horas desde las 20:00” lograba un escaneo por día. Ahora los horarios continúan al día siguiente',
                '<strong>Python, Go y Rust fueron retirados.</strong> No es cautela ante asperezas: sus fallas se reportaban como limpio. La derivación de correcciones y el ordenamiento de versiones son solo semver, así que un aviso de OSV sobre Django recomendaba “actualizar a 3.2.23” contra un 4.2 instalado; los nombres de paquetes PyPI de OSV no están canonicalizados según PEP 503, así que nunca coincidían con los del resolutor; y el parser de rangos de gemnasium no puede leer intersecciones con coma de PEP 440. Una fuente que responde “sin vulnerabilidades” por los motivos equivocados es peor que una que no se ofrece, así que desaparecieron por completo de la superficie del producto — sin interruptor, sin descubrimiento, sin descarga. <strong>Los hallazgos que ya recolectaste con ellos siguen visibles y se pueden silenciar; no se borra nada.</strong> El ecosistema npm ahora se llama <strong>Node.js</strong>, que nombra el ecosistema de paquetes realmente escaneado en lugar de un lenguaje',
                '<strong>Configuración → Fuentes</strong> se rediseñó en torno a eso. Cada fuente repetía su propia explicación junto a su propio interruptor, y cada una respaldada por caché llevaba un panel de estado de cinco filas con su propio botón “Actualizar ahora” de tamaño completo — aunque ese botón encola una sola señal compartida por fuente sin importar cuántas veces aparezca. Ahora los interruptores solo dicen si una fuente está activa; qué aporta cada una, qué descarga y desde dónde, y cuándo se ejecuta pasó a una única tabla de referencia debajo, y el estado de sincronización se redujo a una línea',
                'Paquetes que el propio lockfile de npm declara alcanzables desde producción estaban siendo degradados a solo desarrollo. Un lockfile que omite <code>dev: true</code> es npm afirmando que el paquete SÍ es alcanzable desde producción — una afirmación más fuerte que la que puede hacer el manifiesto raíz — pero el resolutor la sobrescribía cada vez que el nombre también aparecía en <code>devDependencies</code>, que es justo cuando npm tenía razón. Medido en 130 proyectos reales: 142 paquetes degradados en 97 de ellos — lodash, semver, postcss, tailwindcss, @babel/runtime — ocultando siete hallazgos abiertos del filtro de solo producción en una instancia',
                'Cualquier paquete fijado a una versión como <code>0.0.0-20180523222229-09b5706aa936</code> no coincidía con <strong>ningún aviso</strong>, ni siquiera con uno abierto, y el escaneo reportaba ok con cero hallazgos. Un límite de aviso <code>introduced: 0</code> se comparaba como la release 0.0.0, y bajo semver una prerelease ordena por debajo de su release. 330 de los 19.085 rangos comparables de una caché real estaban almacenados como intervalos que nada podía satisfacer',
                'Una sincronización de OSV interrumpida podía borrar un aviso de forma permanente. La ruta incremental eliminaba las filas de un aviso y después buscaba el reemplazo dentro de un try/catch, así que cualquier timeout, 5xx o apagado lo quitaba por completo — y luego avanzaba el cursor igual, dejando el id permanentemente atrás. La pérdida era silenciosa, sobrevivía hasta el siguiente resembrado completo y ocurría en una sincronización que reportaba éxito. La caché de <code>npx sentinello</code> se erosionaba igual en cada ejecución inestable. Ahora ambas buscan primero y reemplazan después',
                'El <code>--dep-type dev</code> de la CLI significaba “alcanzable desde dev en absoluto” mientras que el portal significa “alcanzable <em>solo</em> desde dev”, así que un paquete alcanzable desde ambos aparecía en una vista y no en la otra — 177 hallazgos abiertos difieren entre ambas lecturas en una instancia. La CLI ahora usa la regla del portal, y respeta el campo <code>withdrawn</code> de OSV, que antes era estructuralmente incapaz de leer: 585 filas de una caché npm real llevan uno, y todas se reportaban como hallazgos vigentes',
                'Un aviso de gemnasium que indica que una vulnerabilidad empieza <em>después</em> de una versión — <code>&gt;1.2.8</code> en lugar de <code>&gt;=1.2.8</code> — se leía como si la versión del límite estuviera afectada. El secuestro del paquete <code>rc</code> en 2021 está escrito justo así, y 1.2.8 es su última versión limpia: precisamente la que la propia nota de remediación del aviso te dice que conserves. Todo proyecto con <code>rc</code> instalado veía un hallazgo crítico de malware, sin solución disponible, contra una versión que nunca estuvo comprometida. Ahora los límites se conservan tal y como los declara el aviso, y los falsos críticos de esta forma desaparecen',
                'El mismo redondeo actuaba en sentido contrario y ocultaba hallazgos reales. Un aviso limitado por <code>&lt;=2.0.0</code> se guardaba como «por debajo de 2.0.0», así que 2.0.0 —la versión sobre la que es más explícito— no se reportaba, y un aviso que nombraba exactamente una versión afectada se convertía en un rango vacío y se descartaba entero. Espera unos pocos hallazgos nuevos que siempre estuvieron ahí, simplemente invisibles',
                'Los rangos escritos con sintaxis que Sentinello no implementa — <code>^1.0.0</code>, <code>~1.0.0</code> — se guardaban como una versión exacta fijada al texto literal, que nunca podía coincidir con nada mientras siguiera en la caché: un aviso con aspecto activo pero incapaz de dispararse. Ahora esos registros se rechazan en vez de guardarse en una forma que no puede funcionar, y los avisos cuyo límite superior no trae una versión corregida limpia por fin reciben una sugerencia de actualización',
                'El helper que enmascara una URL de webhook o un token de bot antes de que llegue a una línea de log imprimía los cortos completos. Rechazaba valores de seis caracteres o menos pero luego conservaba una cabecera de ocho caracteres y una cola de cuatro, y nada verificaba que esas dos mitades no se tocaran — así que todo secreto de entre 7 y 12 caracteres volvía completo. Ahora oculta al menos ocho caracteres o redacta el valor por completo'
            ]
        },
        '3.2.0': {
            title: 'Los hallazgos muestran qué fuentes coinciden, y los avisos retirados dejan de reportarse',
            items: [
                'Cuando más de una base de datos de avisos reporta la misma vulnerabilidad, Sentinello siempre ha mantenido un único hallazgo: reportar un mismo fallo tres veces porque lo conocen tres bases de datos es ruido. Lo que hacía antes era descartar todo sobre las fuentes que colapsaba, así que una vulnerabilidad confirmada de forma independiente por npm audit, OSV y GitLab gemnasium se veía igual que otra que solo conocía una base de datos. En una instancia real eso son dos tercios de los hallazgos. Ahora cada hallazgo lleva las demás fuentes que lo reportaron, y sus etiquetas aparecen junto a la superviviente',
                'Un hallazgo se reporta con la severidad MÁS ALTA que le haya asignado cualquier fuente. Las bases de datos discrepan de verdad —gemnasium calcula la severidad a partir del vector CVSS mientras que npm audit toma la categoría de GitHub— y para un escáner la lectura prudente es la que conviene aplicar. Esto no es cosmético: un hallazgo escalado cambia de categoría en el panel, en los totales del proyecto, en la barrera <code>--fail-on</code> de la CLI y en los umbrales de notificación. Es de esperar que algunos recuentos cambien en el primer escaneo tras actualizar; no se detectó nada nuevo, los mismos hallazgos se clasifican con más cautela',
                'Cuando las fuentes discrepan, el hallazgo muestra un control junto a su severidad que abre lo que dijo cada una: su propio identificador de aviso y su propia clasificación. Solo aparece cuando hay una discrepancia que explicar, de modo que un hallazgo en el que todas coinciden se mantiene despejado',
                'OSV registra la retirada en un campo específico y GitHub elimina los avisos retirados antes de que <code>npm audit</code> los vea, pero GitLab gemnasium no tiene ese campo en su esquema. Retira un aviso reescribiendo el registro: el título pasa a ser «False Positive», «Withdrawn Advisory: …» o «Duplicate Advisory: …», y deja intactas las versiones que nombraba antes. Sentinello leía esas versiones y reportaba hallazgos que GitLab había retirado explícitamente: 383 registros en JavaScript, Python, Go y Rust, incluido uno que reportaba <code>express</code> bajo el título «False Positive». Todos se descartan ahora, lo que además elimina toda una clase de hallazgos duplicados, ya que 278 de los 383 son avisos retirados por duplicar a otro',
                'La comprobación busca los marcadores de retirada de forma exacta, no en cualquier parte del texto, así que un aviso legítimo que trate *sobre* un falso positivo se sigue reportando: el CVE-2026-39395 de Cosign, titulado «Cosign’s verify-blob-attestation reports false positive when payload parsing fails», no se ve afectado',
                'La caché de gemnasium se reconstruye sola en su primera sincronización tras esta actualización, y entonces desaparecen los avisos retirados. No hay que hacer nada: ocurre en la sincronización diaria, o al instante desde Ajustes → Fuentes → Actualizar'
            ]
        },
        '3.1.1': {
            title: 'Los rangos de versiones de los avisos son correctos en ambos sentidos',
            items: [
                'Algunos avisos de GitLab gemnasium no incluyen ningún rango de versiones legible por máquina: 698 de los 10.777 de JavaScript. Sentinello rellenaba ese hueco suponiendo que todas las versiones por debajo de la primera corrección listada estaban afectadas, pero esa lista no está ordenada y contiene una corrección por rama de publicación, así que la suposición caía a menudo en la rama equivocada. protobufjs 7.6.5 se reportaba como ejecución remota de código crítica aunque esa rama se corrigió en 7.5.5, y tres avisos distintos afirmaban que todas las versiones de vite por debajo de 8.0.5 eran vulnerables. Sentinello ya no inventa rangos: recupera el real del mismo aviso publicado con su otro identificador, de la propia descripción del aviso o —solo si tienes OSV activado— de la copia de OSV que ya está en tu máquina, y descarta el registro en lugar de adivinar cuando ninguna de esas vías responde. Es de esperar que desaparezcan algunos críticos',
                'OSV describe un aviso corregido en varias ramas como una entrada separada por rama, y Sentinello se quedaba con la primera y descartaba el resto: 1.927 rangos de versiones vulnerables solo en JavaScript, cada uno una vulnerabilidad real que ya no podía ver. El aviso de minimatch cubre ocho ramas y solo sobrevivía una, de modo que un minimatch 3.0.4 o 9.0.0 instalado no se reportaba; next y ua-parser-js perdían ramas del mismo modo. Ahora se conservan todas. Es de esperar que aparezcan hallazgos nuevos: esas vulnerabilidades siempre estuvieron ahí, simplemente eran invisibles',
                'Ambas cachés de avisos se reconstruyen solas la primera vez que se sincronizan tras esta actualización, porque los rangos que contienen los produjo el código anterior. No hay nada que hacer: ocurre en la sincronización diaria, o al instante desde Ajustes → Fuentes → Actualizar si prefieres no esperar'
            ]
        },
        '3.1.0': {
            title: 'Los hallazgos silenciados se apartan, y la base de datos deja de crecer sin fin',
            items: [
                'Un hallazgo silenciado es una decisión que ya tomaste, así que ahora desaparece por completo de la página del proyecto en lugar de quedarse ahí atenuado. No es solo cuestión de orden: todos los números de la página — el recuento del encabezado, las insignias de ambas pestañas, la paginación, los totales por biblioteca, el botón de exportar — se calculan a partir de las mismas filas, así que la página por fin coincide con el panel, las herramientas MCP y la exportación de avisos, que ya dejaban fuera los hallazgos silenciados. Un interruptor «Mostrar silenciados» los devuelve cuando los necesites, incluso en un proyecto cuyos hallazgos están *todos* silenciados',
                'Escribir en un diálogo ya no pierde el foco tras un solo carácter. Ese fallo hacía prácticamente imposible rellenar el campo Motivo del diálogo de silenciado — obligatorio, y lo único que permite auditar un silenciado meses después. El mismo diálogo también dejó de heredar la alineación de la fila de tabla desde la que se abría, que es la razón por la que silenciar un hallazgo daba un diálogo alineado a la derecha y silenciar un proyecto no',
                'El historial de escaneos ya no crece indefinidamente. Nada había borrado nunca una fila de escaneo por antigüedad, así que un proyecto que seguía en disco acumulaba una fila por fuente y por barrido sin límite — una instancia real llegó a 2,2 GB en menos de tres meses. Ajustes → Avanzado incorpora ahora un periodo de retención, 90 días de forma predeterminada, y el worker depura más allá de ese punto cada hora conservando siempre los 100 escaneos más recientes de cada proyecto. Los hallazgos, los silenciamientos y el historial de notificaciones no se tocan nunca; solo el registro de escaneos. Con 90 días, una instancia que se actualice no borra nada en su primera pasada: la limpieza empieza cuando el historial supera de verdad ese periodo, o cuando tú lo reduces',
                'La mayor parte de ese crecimiento era la salida en bruto de `npm audit`, guardada íntegra en cada escaneo correcto y leída por nada en absoluto: el 98,7 % de la base de datos de aquella instancia. Ahora los escaneos guardan un resumen breve, lo que reduce una fila de unos 79 KB a unos 100 bytes, con un límite máximo para que ningún escáner pueda repetirlo',
                'En MCP, `get_dashboard_summary` indica ahora que un proyecto silenciado sale de sus totales mientras `list_projects` lo sigue devolviendo. Los dos cuentan poblaciones distintas a propósito, y un agente que los comparaba lo interpretaba como un error. `list_scans` también dejó de devolver la salida en bruto del escáner de cada escaneo, que podía alcanzar unos 16 MB en una sola respuesta'
            ]
        },
        '3.0.1': {
            title: 'La descarga de gemnasium vuelve a funcionar, y la CLI devuelve la terminal',
            items: [
                'La descarga de GitLab gemnasium fallaba en 3.0.0 con `HTTP 406`, para todo el mundo. El fetch integrado de Node añade una cabecera `Sec-Fetch-Mode: cors` que un programa no puede eliminar, y GitLab rechaza cualquier petición de archivo del repositorio que la lleve — así que nunca tuvo que ver con tu red, tu IP ni con cuántas veces reintentaras. Ahora la descarga usa una petición HTTPS normal y funciona',
                'El archivo se descarga por id de commit en lugar de por nombre de rama, así que todos los que actualizan desde el mismo commit comparten una copia en caché en vez de pedirle a GitLab que genere un archivo de 60 MB cada uno. Una primera descarga que tardaba casi siete minutos ahora termina en segundos',
                'La CLI terminaba todo su trabajo — informe escrito, resumen impreso — y luego no devolvía la terminal. La conexión de la descarga quedaba abierta detrás, manteniendo vivo el proceso; ahora se cierra en cuanto se ha leído el archivo',
                'Una fuente que rechaza una descarga ya no se queda tres minutos esperando antes de decirlo. Lo informa en segundos y, en una terminal, ofrece reintentar — reintentando solo la fuente que realmente falló',
                '`--fail-on` es honesto en ambos sentidos. Rechaza una ejecución cuya fuente de avisos no se pudo consultar, en lugar de informar de un análisis limpio que nunca hizo; y ya no falla por una fuente que desactivaste tú con `SENTINELLO_OSV_FEED_URL=off` o `SENTINELLO_GEMNASIUM_FEED_URL=off` y nunca descargaste'
            ]
        },
        '3.0.0': {
            title: 'Sentinello ya funciona sin portal alguno',
            items: [
                'Los escáneres se distribuyen como CLI en npm. `npx sentinello` recorre una carpeta, encuentra todos los proyectos que contiene, los contrasta con npm audit, OSV y GitLab gemnasium, y escribe un informe markdown con un prompt de remediación adjunto: sin instalación, sin cuenta, sin base de datos y sin que nada de tu código salga de la máquina',
                'Canalizado, el informe es lo único que sale por stdout, así que `npx sentinello | claude -p "$(cat -)"` entrega a un agente una lista de trabajo completa sin que nada corrompa el documento',
                'Una primera ejecución ya no pierde la fuente gemnasium por una descarga rechazada. GitLab rechaza su archivo durante uno o dos minutos seguidos, y el reintento anterior se rendía a los trece segundos; ahora la CLI espera a que pase, explica por qué espera y acepta `--feed-wait` si los tres minutos por defecto no te sirven',
                'Ambas estimaciones de descarga se midieron en lugar de suponerse: la exportación npm de OSV se indica como 204 MB en vez de 196, y el archivo de gemnasium como 52 MB en vez de 80. El aviso de consentimiento marca las estimaciones con una tilde para que nunca se confundan con un tamaño informado por el servidor',
                'Un valor con aspecto de opción ahora se rechaza en lugar de tomarse literalmente: `--out --` escribía un informe en un archivo llamado `--` dentro de tu proyecto e informaba de éxito',
                'El panel de Novedades ya no se sale por la parte inferior de la ventana cuando una versión tiene mucho que contar'
            ]
        },
        '2.6.0': {
            title: 'El documento de vulnerabilidades por fin llega — y cuenta lo que debe',
            items: [
                'get_project_advisory ahora devuelve el documento en sí. Hasta ahora los clientes conectados solo recibían sus metadatos —un nombre de archivo y un recuento— y nunca el documento, pese a que la herramienta lo describía como una lista de trabajo completa',
                'El informe de vulnerabilidades incluye ahora una entrada por cada aviso distinto, con sus fuentes combinadas, en lugar de una por fila de escáner: una vulnerabilidad que reportan npm audit y OSV es un único elemento de trabajo con ambos identificadores, no dos casi idénticos. Esto vale también para el botón Descargar .md del portal, y el recuento ya coincide con el del panel',
                'Un proyecto demasiado grande para caber en una sola respuesta MCP ahora se pagina: el documento indica que está incompleto y da la llamada exacta para obtener el resto, en vez de cortarse en silencio donde un agente leería lo que falta como limpio',
                'Cada parámetro de cada herramienta MCP tiene ahora una descripción, y la nueva herramienta list_mutes expone los identificadores de silenciamiento que necesita unmute — antes solo se conseguían creando el silenciamiento en la misma sesión',
                'Corregido un fallo en los recuentos de severidad: un hallazgo cuya severidad no era uno de los cinco valores conocidos se contaba como hallazgo pero no entraba en ninguna categoría, así que un proyecto cuyo único hallazgo fuera ese aparecía como completamente limpio'
            ]
        },
        '2.5.0': {
            title: 'El informe de vulnerabilidades, directo por MCP',
            items: [
                'Los clientes MCP conectados pueden obtener el informe Markdown completo de un proyecto con la nueva herramienta get_project_advisory: el mismo documento que el botón Descargar .md del portal, sin copiarlo desde el navegador',
                'Los hallazgos silenciados ya no se incluyen en el informe del proyecto, así que a un agente nunca se le encarga trabajo cuyo riesgo ya has aceptado',
                'Nota: como el informe contiene tu prompt de exportación, un cliente MCP ahora puede leer lo que hayas escrito en Ajustes → Exportar'
            ]
        },
        '2.4.3': {
            title: 'Ventanas emergentes sin recortes y un prompt de exportación más estricto',
            items: [
                'Los desplegables, el popover de ruta de dependencias y el menú de exportación de avisos ya no quedan recortados por la tabla o el diálogo que los contiene: se dibujan por encima de la página y se abren hacia arriba cuando no hay espacio debajo',
                'El prompt de exportación de avisos por defecto ahora pide al agente que planifique antes de editar nada, que agrupe los hallazgos que comparten una misma corrección y que detalle el impacto en el código de cada cambio de versión; además fija como objetivo cero hallazgos y descarta los atajos hacia un cero falso —silenciar, ampliar rangos o reducir el alcance del análisis—, dejando lo realmente irresoluble en una tabla de residuos fechada'
            ]
        },
        '2.4.2': {
            title: 'La rama en su propia columna',
            items: [
                'La rama de git en la que se analizó cada proyecto ahora tiene su propia columna en la lista de proyectos —texto simple, sin icono— en lugar de aparecer debajo del nombre del proyecto'
            ]
        },
        '2.4.1': {
            title: 'Apagados limpios',
            items: [
                'Reiniciar el contenedor ya no interrumpe un análisis a mitad de escritura, y el worker arranca de inmediato en lugar de reintentar durante ~30 segundos',
                'Define stop_grace_period: 60s (o --stop-timeout 60) en tu archivo compose para darle margen: el README y la documentación de Docker ya lo explican'
            ]
        },
        '2.4.0': {
            title: 'Análisis políglota: Python, Go y Rust se suman a npm',
            items: [
                'Sentinello ahora analiza proyectos de Python, Go y Rust además de npm: los archivos de bloqueo se resuelven totalmente sin conexión y cada proyecto informa su cobertura de análisis (completa, parcial o no auditable), de modo que las lagunas quedan visibles en lugar de silenciosas',
                'La base de datos gemnasium de GitLab se suma a npm audit y OSV como fuente de avisos sin conexión, deduplicada frente a las demás por alias CVE/GHSA; Configuración → Fuentes es ahora una matriz de Lenguajes × Fuentes con alcance de notificaciones por celda, y npm audit ya se puede desactivar siempre que quede una fuente activa',
                'Los hallazgos ahora registran la rama de git de la que provienen, visible en la lista de proyectos, el encabezado del proyecto y todas las notificaciones',
                'Las filas de proyecto incluyen sus propias acciones: analizar ahora, copiar o descargar el aviso, silenciar o reactivar y editar etiquetas, así una ronda de triaje ya no exige entrar en cada proyecto',
                'El panel de proyectos pasó de ~3,3 s a ~0,03 s, y la navegación ahora muestra estados de carga en lugar de parecer congelada',
                'Seguridad: 25 avisos de dependencias resueltos, incluidos CVE de libvips que estaban activos en el optimizador de imágenes del portal y nueve avisos de Next.js que afectaban al portal distribuido',
                'El prompt de exportación de avisos por defecto ahora cubre la antigüedad mínima de publicación, la verificación del archivo de bloqueo y los overrides obsoletos'
            ]
        },
        '2.3.0': {
            title: 'Configuración de MCP más simple, sin variables de entorno',
            items: [
                'Configura MCP por completo en Configuración → MCP: genera un token para activar el endpoint /api/mcp y bórralo para desactivarlo — las variables de entorno SENTINELLO_MCP_ENABLED y SENTINELLO_MCP_API_TOKEN ya no existen (un token de entorno existente se importa una vez al actualizar)',
                'Fragmentos de conexión listos para pegar para Claude Code, Codex, Cursor y Claude Desktop, con tu token ya incluido',
                'Cuando SENTINELLO_PORTAL_BASE_URL se define en el entorno, se muestra de solo lectura en Configuración → Avanzado, ya que sigue siendo autoritativa y se reaplica en cada arranque'
            ]
        },
        '2.2.0': {
            title: 'Menos falsas alarmas y hallazgos que se limpian solos',
            items: [
                'Los avisos de malware ahora coinciden con la versión comprometida exacta: una versión limpia o ya corregida de un paquete que estuvo comprometido deja de marcarse',
                'Los hallazgos duplicados ahora se resuelven solos en el siguiente análisis, de modo que las entradas antiguas o huérfanas se eliminan automáticamente',
                'Las etiquetas de producción y desarrollo ahora se calculan de una sola forma coherente en todas las fuentes (npm y OSV)'
            ]
        },
        '2.1.0': {
            title: 'Un encabezado de proyecto más limpio y filtros coherentes',
            items: [
                'Encabezado de proyecto simplificado: renombra junto al título, con silenciar y etiquetas como iconos',
                'Filtra los hallazgos por fuente (npm / OSV) desde un nuevo desplegable junto al filtro de tipo de dependencia',
                'Desplegables unificados y coherentes en toda la app, con búsqueda al escribir en listas largas como las zonas horarias'
            ]
        },
        '2.0.1': {
            title: 'Guía de actualización más clara',
            items: [
                'Pasos de actualización ampliados para los cambios incompatibles de 2.0',
                'El README indica el enlace de puerto solo en localhost'
            ]
        },
        '2.0.0': {
            title: 'Análisis multi-fuente y una instalación reforzada y segura por defecto',
            items: [
                'OSV como segunda fuente opcional (Configuración → Fuentes, desactivada por defecto) con detección de paquetes maliciosos, cotejada con la base de datos pública de OSV en una caché local',
                'Los hallazgos ahora se combinan entre fuentes: una fila por vulnerabilidad, con cada fuente etiquetada, la mejor corrección disponible y la unión de las rutas de dependencia, con filtro por fuente y un popover de ruta de dependencia',
                'Refuerzo de seguridad: el endpoint MCP está desactivado por defecto y requiere un token, la entrega de webhooks está protegida contra SSRF, una puerta de inicio de sesión opcional del portal, y el contenedor se ejecuta como usuario sin privilegios',
                'Configuración ahora es una sección de nivel superior con barra lateral y una página de Perfil'
            ]
        },
        '1.4.0': {
            title: 'Integración MCP y novedades',
            items: [
                'Servidor MCP en /api/mcp para Claude Desktop, Cursor y otros clientes',
                'Nueva sección Configuración → MCP con URL del servidor y gestión de tokens',
                'Píldora de novedades e historial de notas de versión'
            ]
        },
        '1.3.1': {
            title: 'Corrección de la versión en el pie',
            items: ['La versión en ejecución se muestra correctamente en el pie de página']
        },
        '1.3.0': {
            title: 'Mejoras en las notificaciones',
            items: [
                'Filtrar notificaciones por entorno',
                'Formulario de edición de destinos más simple',
                'Duplicar un destino de notificación existente'
            ]
        },
        '1.2.0': {
            title: 'Páginas de Proyectos y Bibliotecas',
            items: ['La vista de inicio se divide en páginas dedicadas de Proyectos y Bibliotecas']
        },
        '1.1.2': {
            title: 'Recarga de la programación en vivo',
            items: ['El worker recarga la programación de escaneo en cuanto guardas cambios en el portal']
        },
        '1.1.0': {
            title: 'Borrados más seguros y un aviso de actualización más claro',
            items: [
                'Confirmación antes de eliminar raíces y destinos de notificación',
                'El aviso de actualización pasa a un banner superior descartable',
                'El worker elimina raíces obsoletas cuando desaparece su montaje'
            ]
        },
        '1.0.1': {
            title: 'Correcciones de precisión del escáner',
            items: [
                'Descarta hallazgos cuya versión instalada no está realmente en el rango vulnerable',
                'Permite eliminar un destino de notificación con historial de envíos'
            ]
        },
        '1.0.0': { title: 'Primera versión de código abierto', items: ['El primer lanzamiento público de Sentinello'] }
    },
    fr: {
        '3.3.1': {
            title: 'La même version que 3.3.0, avec une image Docker qui se construit',
            items: [
                '3.3.0 a été publiée sur npm et GitHub, mais son image de conteneur n’a pas pu être construite : au moment de la sortie, il n’y avait donc pas de 3.3.0 sur GHCR ni sur Docker Hub. Le Dockerfile énumère chaque paquet du workspace qu’il installe, et l’un d’eux — celui de comparaison de versions — n’y avait jamais figuré. Rien dans l’image ne l’importait avant cette version, si bien que l’oubli n’avait jamais eu de conséquence. Une image 3.3.0 corrigée a depuis été publiée, construite à partir du code applicatif de 3.3.0 lui-même : <code>docker pull sentinello:3.3.0</code> fonctionne de nouveau. La 3.3.1 porte le même correctif dans l’arbre des sources. Si vous utilisez la CLI, 3.3.0 était déjà correcte.'
            ]
        },
        '3.3.0': {
            title: 'Uniquement les écosystèmes qui fonctionnent vraiment — et des notifications fiables',
            items: [
                'Une notification pouvait arriver vide. Un opérateur a reçu un message Telegram annonçant des vulnérabilités dans un projet, sans en lister aucune. L’envoi est délimité par projet mais s’exécutait une fois par scanner : la passe de npm audit s’est vu remettre deux événements OSV en attente, n’en a fait correspondre aucun, et a tout de même affiché le titre au-dessus d’une liste vide. Elle a ensuite marqué les deux événements comme livrés — les deux résultats jamais nommés ont donc été enregistrés comme notifiés, et rien ne revient sur un événement livré. Un événement n’est désormais envoyé que s’il peut être décrit ; sinon il reste en attente et est réexaminé au prochain scan',
                'Un résultat est signalé au pire niveau attribué par une source, et cette escalade atteignait le tableau de bord, les totaux par projet et la barrière <code>--fail-on</code> de la CLI — mais pas les seuils de notification. La notification s’exécutait avant la corroboration : l’événement portait donc le niveau de la source survivante et n’était jamais réécrit. Sur une instance réelle, 135 résultats ouverts portaient une sévérité d’événement inférieure à la vraie, <strong>dont 41 enregistrant un critique en faible, élevé ou moyen</strong>. Une cible filtrée sur critique et élevé n’aurait jamais été alertée pour aucun d’entre eux, définitivement',
                'Les analyses planifiées s’arrêtaient à minuit au lieu de repartir. « Toutes les 3 heures à partir de 07:00 » s’exécutait à 07, 10, 13, 16, 19 et 22, puis plus rien jusqu’à 07:00 — six analyses par jour au lieu de huit, avec une fenêtre aveugle de neuf heures chaque nuit — pendant que les Paramètres continuaient d’afficher l’intervalle choisi. « Toutes les 6 heures à partir de 20:00 » n’en faisait qu’une par jour. Les créneaux repassent désormais au jour suivant',
                '<strong>Python, Go et Rust ont été retirés.</strong> Ce n’est pas de la prudence face à des aspérités : leurs défaillances se signalaient comme « sain ». La dérivation des correctifs et l’ordonnancement des versions sont uniquement semver, si bien qu’un avis OSV sur Django recommandait « passer à 3.2.23 » contre un 4.2 installé ; les noms de paquets PyPI d’OSV ne sont pas canonicalisés selon PEP 503 et ne rejoignaient donc jamais ceux du résolveur ; et l’analyseur de plages de gemnasium ne sait pas lire les intersections à virgule de PEP 440. Une source qui répond « aucune vulnérabilité » pour de mauvaises raisons est pire qu’une source non proposée : elles ont donc entièrement disparu de la surface du produit — pas de bouton, pas de découverte, pas de téléchargement. <strong>Les résultats déjà collectés avec elles restent visibles et peuvent être mis en sourdine ; rien n’est supprimé.</strong> L’écosystème npm s’appelle désormais <strong>Node.js</strong>, ce qui nomme l’écosystème de paquets réellement analysé plutôt qu’un langage',
                '<strong>Paramètres → Sources</strong> a été refait en conséquence. Chaque source répétait sa propre explication à côté de son propre interrupteur, et chaque source à cache portait un panneau d’état de cinq lignes avec son propre bouton « Actualiser » en pleine taille — alors que ce bouton met en file un unique signal partagé par source, quel que soit le nombre d’occurrences. Les interrupteurs ne disent plus que si une source est active ; ce que chacune apporte, ce qu’elle télécharge et depuis où, et quand elle s’exécute sont passés dans un tableau de référence unique en dessous, et l’état de synchronisation tient désormais sur une ligne',
                'Des paquets que le lockfile de npm lui-même déclare atteignables depuis la production étaient rétrogradés en dev seulement. Un lockfile qui omet <code>dev: true</code>, c’est npm affirmant que le paquet EST atteignable depuis la production — une affirmation plus forte que ce que le manifeste racine peut dire — mais le résolveur l’écrasait dès que le nom apparaissait aussi sous <code>devDependencies</code>, c’est-à-dire précisément quand npm avait raison. Mesuré sur 130 projets réels : 142 paquets rétrogradés dans 97 d’entre eux — lodash, semver, postcss, tailwindcss, @babel/runtime — masquant sept résultats ouverts au filtre production seule sur une instance',
                'Tout paquet épinglé à une version comme <code>0.0.0-20180523222229-09b5706aa936</code> ne correspondait à <strong>aucun avis</strong>, pas même un avis ouvert, et l’analyse signalait « ok » avec zéro résultat. Une borne d’avis <code>introduced: 0</code> était comparée à la release 0.0.0, et en semver une préversion se classe sous sa release. 330 des 19 085 plages comparables d’un cache réel étaient stockées comme des intervalles que rien ne pouvait satisfaire',
                'Une synchronisation OSV interrompue pouvait effacer un avis définitivement. Le chemin incrémental supprimait les lignes d’un avis puis récupérait le remplacement dans un try/catch : le moindre timeout, 5xx ou arrêt le supprimait purement et simplement — puis le curseur avançait quand même, laissant l’identifiant définitivement derrière lui. La perte était silencieuse, survivait jusqu’au prochain réamorçage complet, et se produisait lors d’une synchronisation signalée comme réussie. Le cache de <code>npx sentinello</code> s’érodait de la même façon à chaque exécution instable. Les deux récupèrent maintenant avant de remplacer',
                'Le <code>--dep-type dev</code> de la CLI signifiait « atteignable depuis dev, d’une manière ou d’une autre », alors que le portail signifie « atteignable <em>uniquement</em> depuis dev » : un paquet atteignable depuis les deux apparaissait dans une vue et pas dans l’autre — 177 résultats ouverts diffèrent entre les deux lectures sur une instance. La CLI applique désormais la règle du portail, et respecte le champ <code>withdrawn</code> d’OSV, qu’elle était structurellement incapable de lire : 585 lignes d’un cache npm réel en portent un, et toutes étaient signalées comme des résultats actifs',
                'Un avis gemnasium indiquant qu’une vulnérabilité commence <em>après</em> une version — <code>&gt;1.2.8</code> et non <code>&gt;=1.2.8</code> — était lu comme si la version limite elle-même était touchée. Le détournement du paquet <code>rc</code> en 2021 est écrit exactement ainsi, et 1.2.8 en est la dernière version saine : précisément celle que la note de remédiation de l’avis vous dit de conserver. Tout projet ayant <code>rc</code> installé voyait une alerte critique de malware, sans correctif disponible, sur une version qui n’a jamais été compromise. Les bornes sont désormais conservées telles que l’avis les énonce, et les faux critiques de cette forme disparaissent',
                'Le même arrondi jouait dans l’autre sens et masquait de vraies détections. Un avis borné par <code>&lt;=2.0.0</code> était stocké comme « en dessous de 2.0.0 », donc 2.0.0 — la version sur laquelle il est le plus explicite — n’était pas signalée, et un avis ne nommant qu’une seule version affectée devenait un intervalle vide et était rejeté en entier. Attendez-vous à quelques détections nouvelles, présentes depuis toujours mais invisibles',
                'Les plages écrites avec une syntaxe que Sentinello n’implémente pas — <code>^1.0.0</code>, <code>~1.0.0</code> — étaient stockées comme une version exacte figée sur le texte littéral, incapable de correspondre à quoi que ce soit tant qu’elle restait en cache : un avis d’apparence active mais qui ne pouvait jamais se déclencher. Ces enregistrements sont désormais refusés plutôt que conservés sous une forme inopérante, et les avis dont la borne supérieure n’a pas de version corrigée nette reçoivent enfin une suggestion de mise à niveau',
                'L’assistant qui masque une URL de webhook ou un jeton de bot avant qu’il n’atteigne une ligne de log affichait les courts en entier. Il rejetait les valeurs de six caractères ou moins, mais conservait ensuite une tête de huit caractères et une queue de quatre, et rien ne vérifiait que ces deux moitiés ne se rejoignaient pas — tout secret de 7 à 12 caractères revenait donc complet. Il masque désormais au moins huit caractères, ou expurge la valeur entièrement'
            ]
        },
        '3.2.0': {
            title: 'Les résultats indiquent quelles sources concordent, et les avis retirés ne sont plus signalés',
            items: [
                'Lorsque plusieurs bases d’avis signalent la même vulnérabilité, Sentinello n’a jamais conservé qu’un seul résultat : signaler trois fois la même faille parce que trois bases la connaissent, c’est du bruit. Mais tout ce qui concernait les sources fusionnées était jusqu’ici écarté, si bien qu’une vulnérabilité confirmée indépendamment par npm audit, OSV et GitLab gemnasium ressemblait exactement à une que seule une base avait jamais signalée. Sur une instance réelle, cela représente deux tiers des résultats. Chaque résultat porte désormais les autres sources qui l’ont signalé, et leurs badges apparaissent à côté de celui qui a survécu',
                'Un résultat est signalé avec la sévérité LA PLUS ÉLEVÉE attribuée par une source. Les bases divergent réellement — gemnasium calcule la sévérité à partir du vecteur CVSS tandis que npm audit reprend la catégorie de GitHub — et pour un scanner, c’est la lecture prudente qu’il faut retenir. Ce n’est pas cosmétique : un résultat réévalué change de catégorie sur le tableau de bord, dans les totaux du projet, dans la barrière <code>--fail-on</code> de la CLI et dans les seuils de notification. Attendez-vous à des décomptes différents lors du premier scan après la mise à jour ; rien de nouveau n’a été détecté, les mêmes résultats sont simplement évalués avec plus de prudence',
                'Là où les sources divergent, le résultat affiche à côté de sa sévérité un contrôle qui ouvre ce que chacune a réellement dit : son propre identifiant d’avis et sa propre évaluation. Il n’apparaît que lorsqu’il y a un désaccord à expliquer, de sorte qu’un résultat évalué de la même façon par tous reste épuré',
                'OSV consigne un retrait dans un champ dédié et GitHub supprime les avis retirés avant même que <code>npm audit</code> ne les voie, mais GitLab gemnasium n’a pas ce champ dans son schéma. Il retire un avis en réécrivant l’enregistrement : le titre devient « False Positive », « Withdrawn Advisory: … » ou « Duplicate Advisory: … », tandis que les versions qu’il désignait restent en place. Sentinello lisait ces versions et signalait des résultats que GitLab avait explicitement retirés : 383 enregistrements pour JavaScript, Python, Go et Rust, dont un qui signalait <code>express</code> sous le titre « False Positive ». Tous sont désormais écartés, ce qui supprime aussi toute une catégorie de doublons, puisque 278 des 383 sont des avis retirés parce qu’ils faisaient doublon',
                'La détection compare les marqueurs de retrait exactement plutôt que de chercher les mots n’importe où, si bien qu’un avis authentique portant *sur* un faux positif continue d’être signalé : le CVE-2026-39395 de Cosign, intitulé « Cosign’s verify-blob-attestation reports false positive when payload parsing fails », n’est pas affecté',
                'Le cache gemnasium se reconstruit de lui-même à sa première synchronisation après cette mise à jour ; les avis retirés disparaissent alors. Rien à faire : cela se produit lors de la synchronisation quotidienne, ou immédiatement depuis Paramètres → Sources → Actualiser'
            ]
        },
        '3.1.1': {
            title: 'Les plages de versions des avis sont justes dans les deux sens',
            items: [
                'Certains avis GitLab gemnasium ne fournissent aucune plage de versions exploitable — 698 des 10 777 avis JavaScript. Sentinello comblait ce vide en supposant que toutes les versions antérieures au premier correctif listé étaient touchées, mais cette liste n’est pas triée et contient un correctif par branche de publication : la supposition tombait donc souvent sur la mauvaise branche. protobufjs 7.6.5 était signalé comme exécution de code à distance critique alors que cette branche avait été corrigée en 7.5.5, et trois avis distincts affirmaient chacun que toutes les versions de vite antérieures à 8.0.5 étaient vulnérables. Sentinello n’invente plus de plage : il récupère la vraie depuis le même avis publié sous son autre identifiant, depuis la description de l’avis, ou — uniquement si OSV est activé — depuis la copie OSV déjà présente sur votre machine, et il écarte l’enregistrement plutôt que de deviner lorsque aucune de ces sources ne répond. Attendez-vous à voir disparaître certains critiques',
                'OSV décrit un avis corrigé sur plusieurs branches par une entrée distincte pour chaque branche, et Sentinello gardait la première en écartant les autres — 1 927 plages de versions vulnérables pour le seul JavaScript, chacune une vulnérabilité réelle devenue invisible. L’avis minimatch couvre huit branches et une seule survivait : un minimatch 3.0.4 ou 9.0.0 installé n’était pas signalé ; next et ua-parser-js perdaient des branches de la même façon. Toutes les branches sont désormais conservées. Attendez-vous à voir apparaître de nouveaux résultats — ces vulnérabilités étaient déjà là, simplement invisibles',
                'Les deux caches d’avis se reconstruisent d’eux-mêmes à leur première synchronisation après cette mise à jour, car les plages qu’ils contiennent ont été produites par l’ancien code. Rien à faire : cela se produit lors de la synchronisation quotidienne, ou immédiatement depuis Paramètres → Sources → Actualiser si vous préférez ne pas attendre'
            ]
        },
        '3.1.0': {
            title: 'Les résultats masqués s’effacent, et la base de données cesse de grossir sans fin',
            items: [
                'Un résultat masqué est une décision que vous avez déjà prise : il quitte donc entièrement la page du projet au lieu d’y rester grisé. Ce n’est pas qu’une question de propreté — tous les chiffres de la page (le total du titre, les badges des deux onglets, la pagination, les totaux par bibliothèque, le bouton d’export) sont calculés à partir des mêmes lignes, si bien que la page s’accorde enfin avec le tableau de bord, les outils MCP et l’export d’avis, qui excluaient déjà les résultats masqués. Une case « Afficher les masqués » les ramène quand vous le souhaitez, y compris sur un projet dont *tous* les résultats sont masqués',
                'Taper dans une boîte de dialogue ne fait plus perdre le focus au bout d’un seul caractère. Ce défaut rendait le champ Motif du dialogue de masquage — obligatoire, et seul élément qui rende un masquage vérifiable des mois plus tard — pratiquement impossible à remplir. Ce même dialogue n’hérite plus non plus de l’alignement de la ligne de tableau depuis laquelle il était ouvert, ce qui explique qu’un masquage de vulnérabilité s’affichait aligné à droite alors qu’un masquage de projet non',
                'L’historique des analyses ne grossit plus indéfiniment. Rien n’avait jamais supprimé une ligne d’analyse selon son âge : un projet resté sur le disque accumulait donc une ligne par source et par passage, sans limite — une instance réelle a atteint 2,2 Go en moins de trois mois. Paramètres → Avancé propose désormais une durée de conservation, 90 jours par défaut, et le worker purge au-delà toutes les heures en gardant toujours les 100 analyses les plus récentes de chaque projet. Les résultats, les masquages et l’historique des notifications ne sont jamais touchés ; seul le journal d’analyse l’est. À 90 jours, une instance qui se met à jour ne supprime rien lors de son premier passage : la purge ne commence que lorsque l’historique dépasse réellement cette durée, ou lorsque vous l’abaissez vous-même',
                'L’essentiel de cette croissance venait de la sortie brute de `npm audit`, conservée intégralement à chaque analyse réussie et lue par absolument rien : 98,7 % de la base de données de cette instance. Les analyses enregistrent désormais un court résumé, ce qui fait passer une ligne d’environ 79 Ko à une centaine d’octets, avec un plafond strict pour qu’aucun scanner ne puisse recommencer',
                'Côté MCP, `get_dashboard_summary` précise maintenant qu’un projet que vous avez masqué sort de ses totaux alors que `list_projects` le renvoie toujours. Les deux comptent volontairement des populations différentes, et un agent qui les comparait y voyait un défaut. `list_scans` a également cessé de renvoyer la sortie brute du scanner pour chaque analyse, qui pouvait atteindre environ 16 Mo dans une seule réponse'
            ]
        },
        '3.0.1': {
            title: 'Le téléchargement gemnasium fonctionne de nouveau, et la CLI rend la main',
            items: [
                'Le téléchargement de GitLab gemnasium échouait en 3.0.0 avec `HTTP 406`, pour tout le monde. Le fetch intégré de Node ajoute un en-tête `Sec-Fetch-Mode: cors` qu’un programme n’a pas le droit de retirer, et GitLab refuse toute requête d’archive de dépôt qui le porte — cela n’a donc jamais eu de rapport avec votre réseau, votre IP ou le nombre de tentatives. Le téléchargement utilise désormais une simple requête HTTPS, et aboutit',
                'L’archive est récupérée par identifiant de commit plutôt que par nom de branche : tous ceux qui partent du même commit amont partagent une copie mise en cache au lieu de demander chacun à GitLab de construire une archive de 60 Mo. Un premier téléchargement qui prenait près de sept minutes se termine maintenant en quelques secondes',
                'La CLI terminait tout son travail — rapport écrit, résumé affiché — puis ne rendait jamais le terminal. La connexion du téléchargement restait ouverte derrière elle et maintenait le processus en vie ; elle est désormais fermée dès que l’archive a été lue',
                'Une source qui refuse un téléchargement ne bloque plus trois minutes avant de le signaler. Elle le signale en quelques secondes et, dans un terminal, propose de réessayer — en ne réessayant que la source réellement en échec',
                '`--fail-on` est honnête dans les deux sens. Il refuse une exécution dont une source d’avis n’a pas pu être consultée, au lieu d’annoncer une analyse propre qu’il n’a jamais faite ; et il ne fait plus échouer une exécution à cause d’une source que vous avez vous-même désactivée avec `SENTINELLO_OSV_FEED_URL=off` ou `SENTINELLO_GEMNASIUM_FEED_URL=off` et jamais téléchargée'
            ]
        },
        '3.0.0': {
            title: 'Sentinello fonctionne désormais sans portail du tout',
            items: [
                'Les scanners sont publiés en CLI sur npm. `npx sentinello` parcourt un dossier, trouve tous les projets qu’il contient, les confronte à npm audit, OSV et GitLab gemnasium, et écrit un avis markdown accompagné d’un prompt de remédiation — sans installation, sans compte, sans base de données, et rien de votre code ne quitte la machine',
                'En pipe, l’avis est la seule chose sur stdout : `npx sentinello | claude -p "$(cat -)"` remet à un agent une liste de travail complète sans que rien ne corrompe le document',
                'Une première exécution ne perd plus la source gemnasium à cause d’un téléchargement refusé. GitLab refuse son archive une à deux minutes d’affilée, et l’ancienne logique abandonnait au bout de treize secondes ; la CLI patiente désormais, explique pourquoi, et accepte `--feed-wait` si les trois minutes par défaut ne conviennent pas',
                'Les deux estimations de téléchargement ont été mesurées plutôt que devinées : l’export npm d’OSV est annoncé à 204 Mo au lieu de 196, et l’archive gemnasium à 52 Mo au lieu de 80. L’invite de consentement marque une estimation d’un tilde pour qu’elle ne soit jamais prise pour une taille annoncée par le serveur',
                'Une valeur ressemblant à une option est désormais rejetée plutôt que prise au pied de la lettre — `--out --` écrivait un avis dans un fichier nommé `--` au sein de votre projet, en signalant une réussite',
                'Le panneau Nouveautés ne déborde plus du bas de la fenêtre quand une version a beaucoup à dire'
            ]
        },
        '2.6.0': {
            title: 'Le document d’avis arrive enfin — et compte ce qu’il faut',
            items: [
                'get_project_advisory renvoie désormais le document lui-même. Les clients connectés ne recevaient jusqu’ici que ses métadonnées — un nom de fichier et un décompte — et jamais le document, alors que l’outil le présentait comme une liste de travail complète',
                'L’export d’avis contient désormais une entrée par avis distinct, sources fusionnées, au lieu d’une par ligne de scanner : une vulnérabilité signalée à la fois par npm audit et OSV devient un seul élément de travail portant les deux identifiants, et non deux quasi identiques. Cela vaut aussi pour le bouton Télécharger .md du portail, et le décompte correspond maintenant à celui du tableau de bord',
                'Un projet trop volumineux pour tenir dans une seule réponse MCP est désormais paginé : le document indique qu’il est incomplet et donne l’appel exact pour récupérer la suite, au lieu d’être tronqué en silence là où un agent lirait le reste comme sain',
                'Chaque paramètre de chaque outil MCP est désormais décrit, et le nouvel outil list_mutes expose les identifiants de mise en sourdine dont unmute a besoin — auparavant accessibles uniquement en créant la mise en sourdine dans la même session',
                'Correction d’une faille dans les décomptes de gravité : un signalement dont la gravité ne faisait pas partie des cinq valeurs connues était compté comme signalement mais rangé dans aucune catégorie, si bien qu’un projet dont c’était le seul signalement paraissait parfaitement sain'
            ]
        },
        '2.5.0': {
            title: 'L’export d’avis, directement via MCP',
            items: [
                'Les clients MCP connectés peuvent récupérer l’avis Markdown complet d’un projet avec le nouvel outil get_project_advisory — le même document que le bouton Télécharger .md du portail, sans le copier depuis le navigateur',
                'Les découvertes masquées sont désormais exclues de l’export d’avis du projet : un agent ne se voit donc jamais confier un travail dont vous avez déjà accepté le risque',
                'Remarque : comme l’avis contient votre prompt d’export, un client MCP peut désormais lire ce que vous avez écrit dans Paramètres → Export'
            ]
        },
        '2.4.3': {
            title: 'Des popups qui ne sont plus rognés et un prompt d’export plus strict',
            items: [
                'Les menus déroulants, le popover de chemin de dépendance et le menu d’export d’avis ne sont plus rognés par le tableau ou la boîte de dialogue qui les contient : ils s’affichent au-dessus de la page et basculent vers le haut lorsqu’il n’y a pas de place en dessous',
                'Le prompt d’export d’avis par défaut demande désormais à l’agent de planifier avant toute modification, de regrouper les résultats qui partagent un même correctif et de détailler l’impact sur le code de chaque montée de version ; il vise zéro résultat tout en écartant les raccourcis vers un faux zéro — mise en sourdine, élargissement des plages ou réduction du périmètre d’analyse — et fait figurer ce qui reste réellement bloqué dans un tableau de résidus daté'
            ]
        },
        '2.4.2': {
            title: 'La branche dans sa propre colonne',
            items: [
                'La branche git sur laquelle un projet a été analysé occupe désormais sa propre colonne dans la liste des projets — texte brut, sans icône — au lieu d’être placée sous le nom du projet'
            ]
        },
        '2.4.1': {
            title: 'Arrêts propres',
            items: [
                'Redémarrer le conteneur n’interrompt plus une analyse en cours d’écriture, et le worker démarre immédiatement au lieu de réessayer pendant environ 30 secondes',
                'Définissez stop_grace_period : 60s (ou --stop-timeout 60) dans votre fichier compose pour lui laisser la place — le README et la documentation Docker l’expliquent désormais'
            ]
        },
        '2.4.0': {
            title: 'Analyse polyglotte — Python, Go et Rust rejoignent npm',
            items: [
                'Sentinello analyse désormais les projets Python, Go et Rust en plus de npm — les fichiers de verrouillage sont résolus entièrement hors ligne, et chaque projet indique sa couverture d’analyse (complète, partielle ou non auditable) afin que les lacunes soient visibles plutôt que silencieuses',
                'La base gemnasium de GitLab rejoint npm audit et OSV comme source d’avis hors ligne, dédupliquée par rapport aux autres via les alias CVE/GHSA ; Paramètres → Sources devient une matrice Langages × Sources avec une portée de notification par cellule, et npm audit peut désormais être désactivé tant qu’une source reste active',
                'Les résultats enregistrent désormais la branche git dont ils proviennent, affichée dans la liste des projets, l’en-tête du projet et chaque notification',
                'Les lignes de projet portent leurs propres actions — analyser maintenant, copier ou télécharger l’avis, mettre en sourdine ou réactiver, et modifier les tags — si bien qu’une passe de triage n’oblige plus à ouvrir chaque projet',
                'Le tableau de bord des projets est passé d’environ 3,3 s à 0,03 s, et la navigation affiche désormais des états de chargement au lieu de paraître figée',
                'Sécurité : 25 avis de dépendances corrigés, dont des CVE libvips actives dans l’optimiseur d’images du portail et neuf avis Next.js affectant le portail livré',
                'Le prompt d’export d’avis par défaut couvre désormais l’âge minimal de publication, la vérification du fichier de verrouillage et les overrides obsolètes'
            ]
        },
        '2.3.0': {
            title: 'Configuration MCP simplifiée, sans variables d’environnement',
            items: [
                'Configurez MCP entièrement dans Paramètres → MCP : générez un jeton pour activer le point de terminaison /api/mcp, effacez-le pour le désactiver — les variables d’environnement SENTINELLO_MCP_ENABLED et SENTINELLO_MCP_API_TOKEN ont disparu (un jeton d’environnement existant est importé une fois lors de la mise à niveau)',
                'Extraits de connexion prêts à coller pour Claude Code, Codex, Cursor et Claude Desktop, pré-remplis avec votre jeton',
                'Lorsque SENTINELLO_PORTAL_BASE_URL est définie dans l’environnement, elle s’affiche en lecture seule dans Paramètres → Avancé, car elle reste prioritaire et est réappliquée à chaque démarrage'
            ]
        },
        '2.2.0': {
            title: 'Moins de fausses alertes et des résultats qui se nettoient seuls',
            items: [
                'Les avis de malware correspondent désormais à la version compromise exacte — une version saine ou déjà corrigée d’un paquet autrefois compromis n’est plus signalée',
                'Les résultats en double se résolvent désormais d’eux-mêmes au prochain scan, si bien que les entrées anciennes ou orphelines disparaissent automatiquement',
                'Les étiquettes production et développement sont désormais calculées d’une seule façon cohérente pour toutes les sources (npm et OSV)'
            ]
        },
        '2.1.0': {
            title: 'Un en-tête de projet plus épuré et des filtres cohérents',
            items: [
                'En-tête de projet simplifié — renommez à côté du titre, avec la mise en sourdine et les tags en icônes',
                'Filtrez les résultats par source (npm / OSV) depuis un nouveau menu déroulant à côté du filtre de type de dépendance',
                'Menus déroulants unifiés et cohérents dans toute l’application, avec recherche instantanée sur les longues listes comme les fuseaux horaires'
            ]
        },
        '2.0.1': {
            title: 'Conseils de mise à niveau plus clairs',
            items: [
                'Étapes de mise à niveau détaillées pour les changements incompatibles de la 2.0',
                'Le README indique la liaison du port en localhost uniquement'
            ]
        },
        '2.0.0': {
            title: 'Analyse multi-source et une installation renforcée, sécurisée par défaut',
            items: [
                'OSV comme deuxième source optionnelle (Paramètres → Sources, désactivée par défaut) avec détection des paquets malveillants, comparée à la base de données publique OSV dans un cache local',
                'Les résultats sont désormais fusionnés entre sources — une ligne par vulnérabilité, chaque source étiquetée, le meilleur correctif disponible et l’union des chemins de dépendances, avec un filtre par source et une infobulle de chemin de dépendance',
                'Renforcement de la sécurité : le point de terminaison MCP est désactivé par défaut et requiert un jeton, la livraison des webhooks est protégée contre le SSRF, une page de connexion optionnelle au portail, et le conteneur s’exécute en utilisateur non privilégié',
                'Les Paramètres forment désormais une section de premier niveau avec une barre latérale et une page Profil'
            ]
        },
        '1.4.0': {
            title: 'Intégration MCP et nouveautés',
            items: [
                'Serveur MCP sur /api/mcp pour Claude Desktop, Cursor et d’autres clients',
                'Nouvelle section Paramètres → MCP avec URL du serveur et gestion des jetons',
                'Pastille de nouveautés et historique des notes de version'
            ]
        },
        '1.3.1': {
            title: 'Correction de la version dans le pied de page',
            items: ['La version en cours s’affiche correctement dans le pied de page']
        },
        '1.3.0': {
            title: 'Améliorations des notifications',
            items: [
                'Filtrer les notifications par environnement',
                'Formulaire d’édition des cibles simplifié',
                'Dupliquer une cible de notification existante'
            ]
        },
        '1.2.0': {
            title: 'Pages Projets et Bibliothèques',
            items: ['La vue d’accueil est divisée en pages Projets et Bibliothèques dédiées']
        },
        '1.1.2': {
            title: 'Rechargement du planning en direct',
            items: [
                'Le worker recharge le planning d’analyse dès que vous enregistrez des modifications dans le portail'
            ]
        },
        '1.1.0': {
            title: 'Suppressions plus sûres et bannière de mise à jour plus claire',
            items: [
                'Confirmation avant la suppression de racines et de cibles de notification',
                'L’avis de mise à jour devient une bannière supérieure que l’on peut fermer',
                'Le worker supprime les racines obsolètes quand leur montage disparaît'
            ]
        },
        '1.0.1': {
            title: 'Corrections de précision du scanner',
            items: [
                'Écarte les résultats dont la version installée n’est pas réellement dans la plage vulnérable',
                'Permet de supprimer une cible de notification ayant un historique d’envois'
            ]
        },
        '1.0.0': { title: 'Première version open source', items: ['La première version publique de Sentinello'] }
    },
    de: {
        '3.3.1': {
            title: 'Dieselbe Version wie 3.3.0, mit einem Docker-Image, das baut',
            items: [
                '3.3.0 wurde auf npm und GitHub veröffentlicht, doch sein Container-Image ließ sich nicht bauen — zum Zeitpunkt der Veröffentlichung gab es auf GHCR und Docker Hub kein 3.3.0. Das Dockerfile listet jedes Workspace-Paket auf, das es installiert, und eines davon — das Paket für den Versionsvergleich — fehlte dort seit jeher. Bis zu dieser Version importierte es nichts im Image, deshalb fiel es nie auf. Inzwischen wurde ein korrigiertes 3.3.0-Image veröffentlicht, gebaut aus dem Anwendungscode von 3.3.0 selbst, sodass <code>docker pull sentinello:3.3.0</code> wieder funktioniert. 3.3.1 trägt dieselbe Korrektur im Quellbaum. Für die CLI war 3.3.0 bereits korrekt.'
            ]
        },
        '3.3.0': {
            title: 'Nur die Ökosysteme, die wirklich funktionieren — und Benachrichtigungen, denen Sie trauen können',
            items: [
                'Eine Benachrichtigung konnte leer ankommen. Ein Operator erhielt eine Telegram-Nachricht, die Schwachstellen in einem Projekt ankündigte und keine einzige auflistete. Der Versand ist auf das Projekt begrenzt, lief aber einmal pro Scanner: Der Durchlauf von npm audit bekam zwei offene OSV-Ereignisse, fand für keines eine Entsprechung und rendered die Überschrift trotzdem über einer leeren Liste. Danach markierte er beide Ereignisse als zugestellt — die zwei nie genannten Funde galten damit als benachrichtigt, und ein zugestelltes Ereignis wird nie erneut betrachtet. Ein Ereignis wird jetzt nur noch versendet, wenn es beschrieben werden kann; andernfalls bleibt es offen und wird beim nächsten Scan erneut geprüft',
                'Ein Fund wird mit der schlechtesten Bewertung gemeldet, die ihm irgendeine Quelle gegeben hat, und diese Eskalation erreichte das Dashboard, die Projektsummen und das <code>--fail-on</code>-Tor der CLI — nur nicht die Benachrichtigungsschwellen. Die Benachrichtigung lief vor der Bestätigung, sodass das Ereignis die Bewertung der überlebenden Quelle trug und nie überschrieben wurde. Auf einer echten Instanz trugen 135 offene Funde eine Ereignis-Schwere unterhalb der tatsächlichen, <strong>41 davon führten ein Kritisch als Niedrig, Hoch oder Mittel</strong>. Ein auf Kritisch und Hoch gefiltertes Ziel wäre für keinen von ihnen jemals alarmiert worden, dauerhaft',
                'Geplante Scans hörten um Mitternacht auf, statt weiterzulaufen. „Alle 3 Stunden ab 07:00“ lief um 07, 10, 13, 16, 19 und 22 und danach erst wieder um 07:00 — sechs Scans pro Tag statt acht, mit einem neunstündigen blinden Fenster jede Nacht — während die Einstellungen weiterhin das gewählte Intervall anzeigten. „Alle 6 Stunden ab 20:00“ schaffte einen Scan pro Tag. Die Zeitfenster laufen jetzt über den Tageswechsel hinweg',
                '<strong>Python, Go und Rust wurden zurückgezogen.</strong> Das ist keine Vorsicht wegen rauer Kanten: Ihre Fehler meldeten sich als sauber. Fix-Ableitung und Versionsordnung sind ausschließlich semver, weshalb ein OSV-Advisory zu Django gegen ein installiertes 4.2 „auf 3.2.23 aktualisieren“ empfahl; OSVs PyPI-Paketnamen sind nicht nach PEP 503 kanonisiert und trafen daher nie auf die des Resolvers; und gemnasiums Bereichsparser kann PEP-440-Komma-Schnittmengen nicht lesen. Eine Quelle, die aus den falschen Gründen „keine Schwachstellen“ antwortet, ist schlechter als eine, die gar nicht angeboten wird — sie sind daher vollständig aus der Produktoberfläche verschwunden: kein Schalter, keine Erkennung, kein Download. <strong>Bereits gesammelte Funde bleiben sichtbar und stummschaltbar; nichts wird gelöscht.</strong> Das npm-Ökosystem heißt jetzt <strong>Node.js</strong> und benennt damit das tatsächlich gescannte Paket-Ökosystem statt einer Sprache',
                '<strong>Einstellungen → Quellen</strong> wurde darum herum neu gebaut. Jede Quelle wiederholte ihre eigene Erklärung neben ihrem eigenen Schalter, und jede cache-gestützte trug ein fünfzeiliges Statuspanel mit eigenem „Jetzt aktualisieren“-Button in voller Größe — obwohl dieser Button pro Quelle genau ein gemeinsames Signal einreiht, egal wie oft er erscheint. Die Schalter sagen jetzt nur noch, ob eine Quelle aktiv ist; was jede beiträgt, was sie woher herunterlädt und wann sie läuft, ist in eine einzige Referenztabelle darunter gewandert, und der Sync-Status passt in eine Zeile',
                'Pakete, die npms eigenes Lockfile als aus der Produktion erreichbar ausweist, wurden auf reines Dev herabgestuft. Ein Lockfile ohne <code>dev: true</code> ist npms Aussage, dass das Paket aus der Produktion erreichbar IST — eine stärkere Aussage, als das Wurzelmanifest treffen kann — doch der Resolver überschrieb sie, sobald der Name auch unter <code>devDependencies</code> auftauchte, also genau dann, wenn npm recht hatte. Gemessen über 130 echte Projekte: 142 Pakete in 97 davon herabgestuft — lodash, semver, postcss, tailwindcss, @babel/runtime — wodurch auf einer Instanz sieben offene Funde aus dem Nur-Produktion-Filter verschwanden',
                'Jedes Paket, das auf eine Version wie <code>0.0.0-20180523222229-09b5706aa936</code> festgelegt ist, traf auf <strong>gar kein Advisory</strong>, nicht einmal auf ein offenes, und der Scan meldete ok mit null Funden. Eine Advisory-Grenze <code>introduced: 0</code> wurde als Release 0.0.0 verglichen, und unter semver sortiert eine Vorabversion unter ihrem Release. 330 der 19.085 vergleichbaren Bereiche eines echten Caches waren als Intervalle gespeichert, die nichts erfüllen konnte',
                'Ein unterbrochener OSV-Sync konnte ein Advisory dauerhaft löschen. Der inkrementelle Pfad entfernte die Zeilen eines Advisories und holte den Ersatz erst danach innerhalb eines try/catch — jeder Timeout, 5xx oder Shutdown löschte es damit ganz — und schob den Cursor trotzdem weiter, sodass die ID dauerhaft dahinter lag. Der Verlust war stumm, überlebte bis zum nächsten vollständigen Neuaufbau und geschah bei einem Sync, der Erfolg meldete. Der Cache von <code>npx sentinello</code> erodierte bei jedem instabilen Lauf auf dieselbe Weise. Beide holen jetzt zuerst und ersetzen danach',
                'Das <code>--dep-type dev</code> der CLI bedeutete „überhaupt aus dev erreichbar“, während das Portal „<em>nur</em> aus dev erreichbar“ meint — ein aus beidem erreichbares Paket erschien in der einen Ansicht und in der anderen nicht: 177 offene Funde unterscheiden sich auf einer Instanz zwischen beiden Lesarten. Die CLI verwendet jetzt die Regel des Portals und beachtet OSVs <code>withdrawn</code>-Feld, das sie zuvor strukturell nicht lesen konnte: 585 Zeilen eines echten npm-Caches tragen eines, und alle wurden als aktive Funde gemeldet',
                'Ein gemnasium-Advisory, das besagt, eine Schwachstelle beginne <em>nach</em> einer Version — <code>&gt;1.2.8</code> statt <code>&gt;=1.2.8</code> —, wurde gelesen, als sei die Grenzversion selbst betroffen. Die Übernahme des Pakets <code>rc</code> im Jahr 2021 ist genau so formuliert, und 1.2.8 ist dessen letzte saubere Version: genau jene, die der Behebungshinweis des Advisories selbst empfiehlt. Jedes Projekt mit installiertem <code>rc</code> bekam einen kritischen Malware-Befund ohne verfügbare Korrektur — gegen eine Version, die nie kompromittiert war. Grenzen werden jetzt exakt so übernommen, wie das Advisory sie angibt, und falsche Kritische dieser Form verschwinden',
                'Dieselbe Rundung wirkte auch in die andere Richtung und verbarg echte Befunde. Ein durch <code>&lt;=2.0.0</code> begrenztes Advisory wurde als „unterhalb von 2.0.0“ gespeichert, sodass 2.0.0 — die Version, zu der es sich am deutlichsten äußert — nicht gemeldet wurde; ein Advisory, das genau eine betroffene Version nennt, wurde zu einem leeren Intervall und ganz verworfen. Rechnen Sie mit einigen neuen Befunden, die immer schon vorhanden, aber unsichtbar waren',
                'Bereiche mit Syntax, die Sentinello nicht implementiert — <code>^1.0.0</code>, <code>~1.0.0</code> —, wurden als exakte Version auf den wörtlichen Text festgelegt und konnten daher nie etwas treffen, solange sie im Cache lagen: ein aktiv wirkendes Advisory, das gar nicht auslösen konnte. Solche Datensätze werden nun abgelehnt statt in einer nicht funktionsfähigen Form gespeichert, und Advisories, deren Obergrenze keine saubere Fix-Version trägt, erhalten endlich einen Upgrade-Vorschlag',
                'Die Hilfsfunktion, die eine Webhook-URL oder ein Bot-Token maskiert, bevor es in eine Logzeile gelangt, gab kurze vollständig aus. Sie wies Werte mit sechs Zeichen oder weniger ab, behielt dann aber einen achtstelligen Kopf und einen vierstelligen Schwanz, und nichts prüfte, ob sich diese beiden Hälften berühren — jedes Geheimnis zwischen 7 und 12 Zeichen kam damit vollständig zurück. Sie verbirgt jetzt mindestens acht Zeichen oder schwärzt den Wert ganz'
            ]
        },
        '3.2.0': {
            title: 'Befunde zeigen jetzt, welche Quellen übereinstimmen — und zurückgezogene Advisories werden nicht mehr gemeldet',
            items: [
                'Wenn mehrere Advisory-Datenbanken dieselbe Schwachstelle melden, hat Sentinello immer nur EINEN Befund behalten — dieselbe Lücke dreimal zu melden, weil drei Datenbanken sie kennen, ist Rauschen. Verworfen wurde bislang aber auch alles über die zusammengeführten Quellen, sodass eine von npm audit, OSV und GitLab gemnasium unabhängig bestätigte Schwachstelle genauso aussah wie eine, die nur eine einzige Datenbank je gemeldet hat. Auf einer realen Instanz sind das zwei Drittel aller Befunde. Jeder Befund führt nun die weiteren Quellen mit, die ihn gemeldet haben, und ihre Badges erscheinen neben der verbliebenen',
                'Ein Befund wird mit der HÖCHSTEN Schwere gemeldet, die ihm irgendeine Quelle gegeben hat. Die Datenbanken widersprechen sich tatsächlich — gemnasium berechnet die Schwere aus dem CVSS-Vektor, npm audit übernimmt GitHubs Einstufung — und für einen Scanner ist die vorsichtige Lesart die maßgebliche. Das ist nicht kosmetisch: Ein hochgestufter Befund wechselt die Kategorie im Dashboard, in den Projektsummen, im <code>--fail-on</code>-Gate der CLI und in den Benachrichtigungsschwellen. Beim ersten Scan nach dem Update werden sich einige Zahlen verschieben; es wurde nichts Neues gefunden, dieselben Befunde werden nur vorsichtiger bewertet',
                'Wo die Quellen sich widersprechen, zeigt der Befund neben seiner Schwere ein Bedienelement, das öffnet, was jede Quelle tatsächlich gesagt hat — ihre eigene Advisory-Kennung und ihre eigene Einstufung. Es erscheint nur, wenn es einen Widerspruch zu erklären gibt, sodass ein einhellig bewerteter Befund unaufgeräumt bleibt',
                'OSV vermerkt einen Rückzug in einem eigenen Feld, und GitHub entfernt zurückgezogene Advisories, bevor <code>npm audit</code> sie überhaupt sieht — GitLab gemnasium hat ein solches Feld in seinem Schema jedoch nicht. Es zieht ein Advisory zurück, indem es den Eintrag umschreibt: Der Titel wird zu „False Positive“, „Withdrawn Advisory: …“ oder „Duplicate Advisory: …“, während die zuvor genannten Versionen unverändert stehen bleiben. Sentinello las diese Versionen und meldete Befunde, die GitLab ausdrücklich zurückgenommen hatte: 383 Einträge über JavaScript, Python, Go und Rust hinweg, darunter einer, der <code>express</code> unter dem Titel „False Positive“ meldete. Alle werden nun verworfen, was zugleich eine ganze Klasse doppelter Befunde beseitigt — 278 der 383 sind Advisories, die als Duplikat eines anderen zurückgezogen wurden',
                'Die Prüfung vergleicht die Rückzugsmarker exakt, statt die Wörter irgendwo im Text zu suchen. Ein echtes Advisory, das *von* einem False Positive handelt, wird daher weiterhin gemeldet: Cosigns CVE-2026-39395 mit dem Titel „Cosign’s verify-blob-attestation reports false positive when payload parsing fails“ bleibt unberührt',
                'Der gemnasium-Cache baut sich bei der ersten Synchronisierung nach diesem Update selbst neu auf; dann verschwinden die zurückgezogenen Advisories. Es ist nichts zu tun: Es geschieht im täglichen Lauf oder sofort über Einstellungen → Quellen → Aktualisieren'
            ]
        },
        '3.1.1': {
            title: 'Versionsbereiche in Advisories stimmen in beide Richtungen',
            items: [
                'Manche GitLab-gemnasium-Advisories enthalten überhaupt keinen maschinenlesbaren Versionsbereich — 698 der 10.777 JavaScript-Einträge. Sentinello füllte diese Lücke mit der Annahme, alle Versionen unterhalb der ersten aufgeführten Korrektur seien betroffen. Diese Liste ist jedoch unsortiert und enthält eine Korrektur pro Release-Zweig, sodass die Annahme regelmäßig den falschen Zweig traf. protobufjs 7.6.5 wurde als kritische Remote-Code-Ausführung gemeldet, obwohl dieser Zweig in 7.5.5 behoben wurde, und drei verschiedene Advisories behaupteten jeweils, jede vite-Version unterhalb von 8.0.5 sei verwundbar. Sentinello erfindet keine Bereiche mehr: Es rekonstruiert den echten aus demselben Advisory unter seiner anderen Kennung, aus der Beschreibung des Advisories oder — nur wenn OSV aktiviert ist — aus der bereits lokal vorhandenen OSV-Kopie, und verwirft den Eintrag, statt zu raten, wenn nichts davon greift. Einige kritische Befunde werden verschwinden',
                'OSV beschreibt ein über mehrere Release-Zweige behobenes Advisory als je einen Eintrag pro Zweig, und Sentinello behielt den ersten und verwarf den Rest — allein für JavaScript 1.927 verwundbare Versionsbereiche, jeder davon eine echte Schwachstelle, die dadurch unsichtbar wurde. Das minimatch-Advisory umfasst acht Zweige, von denen nur einer überlebte: ein installiertes minimatch 3.0.4 oder 9.0.0 wurde nicht gemeldet; next und ua-parser-js verloren Zweige auf dieselbe Weise. Jetzt bleiben alle Zweige erhalten. Es werden neue Befunde auftauchen — diese Schwachstellen waren immer da, nur unsichtbar',
                'Beide Advisory-Caches bauen sich bei der ersten Synchronisierung nach diesem Update selbst neu auf, weil ihre gespeicherten Bereiche vom alten Code stammen. Es ist nichts zu tun: Es geschieht im täglichen Lauf oder sofort über Einstellungen → Quellen → Aktualisieren, wenn Sie nicht warten möchten'
            ]
        },
        '3.1.0': {
            title: 'Stummgeschaltete Funde treten zurück — und die Datenbank wächst nicht mehr endlos',
            items: [
                'Ein stummgeschalteter Fund ist eine Entscheidung, die Sie bereits getroffen haben. Deshalb verschwindet er nun vollständig von der Projektseite, statt dort ausgegraut stehen zu bleiben. Das ist nicht nur aufgeräumter: Jede Zahl auf der Seite — die Überschrift, beide Tab-Badges, die Seitennummerierung, die Summen je Bibliothek, der Export-Button — wird aus denselben Zeilen berechnet. Damit stimmt die Seite endlich mit dem Dashboard, den MCP-Tools und dem Advisory-Export überein, die stummgeschaltete Funde ohnehin schon ausließen. Ein Schalter „Stummgeschaltete anzeigen“ holt sie jederzeit zurück, auch bei einem Projekt, dessen Funde *alle* stummgeschaltet sind',
                'Beim Tippen in einem Dialog geht der Fokus nicht mehr nach einem einzigen Zeichen verloren. Dieser Fehler machte das Feld „Begründung“ im Stummschalt-Dialog praktisch unausfüllbar — obwohl es Pflicht ist und als Einziges eine Stummschaltung Monate später nachvollziehbar macht. Derselbe Dialog übernimmt außerdem nicht mehr die Ausrichtung der Tabellenzeile, aus der er geöffnet wurde: Deshalb war der Dialog beim Stummschalten eines Fundes rechtsbündig, beim Stummschalten eines Projekts dagegen nicht',
                'Der Scan-Verlauf wächst nicht mehr unbegrenzt. Bislang hat nichts jemals eine Scan-Zeile nach Alter gelöscht, sodass ein Projekt, das auf der Platte blieb, unbegrenzt eine Zeile pro Quelle und Durchlauf ansammelte — eine reale Instanz erreichte in weniger als drei Monaten 2,2 GB. Einstellungen → Erweitert bietet nun einen Aufbewahrungszeitraum, standardmäßig 90 Tage; der Worker räumt stündlich alles Ältere ab und behält dabei immer die 100 neuesten Scans jedes Projekts. Funde, Stummschaltungen und der Benachrichtigungsverlauf bleiben unangetastet — nur das Scan-Protokoll nicht. Bei 90 Tagen löscht eine Instanz beim Update im ersten Durchlauf nichts: Bereinigt wird erst, wenn der Verlauf tatsächlich älter ist als der Zeitraum, oder wenn Sie ihn selbst verkürzen',
                'Der Großteil dieses Wachstums war die Rohausgabe von `npm audit`, bei jedem erfolgreichen Scan vollständig gespeichert und von nichts gelesen — 98,7 % der Datenbank jener Instanz. Scans speichern nun stattdessen eine kurze Zusammenfassung, was eine Zeile von rund 79 KB auf etwa 100 Byte bringt, mit einer harten Obergrenze, damit kein Scanner das wiederholen kann',
                'Über MCP sagt `get_dashboard_summary` jetzt, dass ein von Ihnen stummgeschaltetes Projekt aus seinen Summen herausfällt, während `list_projects` es weiterhin zurückgibt. Beide zählen absichtlich unterschiedliche Grundgesamtheiten, und ein Agent, der sie verglich, hielt das für einen Fehler. `list_scans` gibt zudem nicht mehr die Rohausgabe des Scanners je Scan zurück, die in einer einzigen Antwort rund 16 MB erreichen konnte'
            ]
        },
        '3.0.1': {
            title: 'Der gemnasium-Download funktioniert wieder — und die CLI gibt das Terminal frei',
            items: [
                'Der Download von GitLab gemnasium schlug in 3.0.0 bei allen mit `HTTP 406` fehl. Das eingebaute fetch von Node setzt einen Header `Sec-Fetch-Mode: cors`, den ein Programm nicht entfernen darf, und GitLab weist jede Repository-Archivanfrage damit ab — es lag also nie an Ihrem Netzwerk, Ihrer IP oder der Zahl der Wiederholungen. Der Download nutzt jetzt eine einfache HTTPS-Anfrage und gelingt',
                'Das Archiv wird über die Commit-ID statt über den Branch-Namen geholt. Alle, die vom selben Upstream-Commit aktualisieren, teilen sich damit eine zwischengespeicherte Kopie, statt dass jeder GitLab ein frisches 60-MB-Archiv bauen lässt. Ein erster Download, der fast sieben Minuten dauerte, ist jetzt in Sekunden fertig',
                'Die CLI beendete ihren gesamten Lauf — Bericht geschrieben, Zusammenfassung ausgegeben — und gab das Terminal danach nie zurück. Die Verbindung des Downloads blieb dahinter offen und hielt den Prozess am Leben; sie wird jetzt geschlossen, sobald das Archiv gelesen ist',
                'Eine Quelle, die einen Download verweigert, blockiert nicht mehr drei Minuten, bevor sie es meldet. Sie meldet es in Sekunden und bietet im Terminal einen erneuten Versuch an — und wiederholt nur die Quelle, die tatsächlich fehlgeschlagen ist',
                '`--fail-on` ist in beide Richtungen ehrlich. Es verweigert einen Lauf, dessen Advisory-Quelle nicht abgefragt werden konnte, statt einen sauberen Scan zu melden, den es nie durchgeführt hat; und es lässt einen Lauf nicht mehr an einer Quelle scheitern, die Sie selbst mit `SENTINELLO_OSV_FEED_URL=off` oder `SENTINELLO_GEMNASIUM_FEED_URL=off` abgeschaltet und nie heruntergeladen haben'
            ]
        },
        '3.0.0': {
            title: 'Sentinello läuft jetzt ganz ohne Portal',
            items: [
                'Die Scanner erscheinen als CLI auf npm. `npx sentinello` durchläuft einen Ordner, findet jedes Projekt darunter, prüft sie gegen npm audit, OSV und GitLab gemnasium und schreibt ein Markdown-Advisory mit angehängtem Remediation-Prompt — ohne Installation, ohne Konto, ohne Datenbank, und nichts von deinem Code verlässt die Maschine',
                'In einer Pipe ist das Advisory das Einzige auf stdout, sodass `npx sentinello | claude -p "$(cat -)"` einem Agenten eine vollständige Arbeitsliste übergibt, ohne dass irgendetwas das Dokument beschädigt',
                'Ein erster Lauf verliert die Quelle gemnasium nicht mehr an einen abgelehnten Download. GitLab verweigert sein Archiv ein bis zwei Minuten am Stück, und der alte Retry gab nach dreizehn Sekunden auf; die CLI wartet es nun aus, sagt warum sie wartet, und nimmt `--feed-wait`, falls die drei Minuten Standard für dich falsch sind',
                'Beide Download-Schätzungen wurden gemessen statt geraten: der npm-Export von OSV wird mit 204 MB statt 196 angegeben, das gemnasium-Archiv mit 52 MB statt 80. Die Zustimmungsabfrage kennzeichnet eine Schätzung mit einer Tilde, damit sie nie mit einer vom Server gemeldeten Größe verwechselt wird',
                'Ein Wert, der wie eine Option aussieht, wird jetzt abgelehnt statt wörtlich genommen — `--out --` schrieb ein Advisory in eine Datei namens `--` in deinem Projekt und meldete Erfolg',
                'Das Neuigkeiten-Panel läuft nicht mehr unten aus dem Fenster, wenn ein Release viel zu erzählen hat'
            ]
        },
        '2.6.0': {
            title: 'Das Advisory-Dokument kommt jetzt wirklich an — und zählt richtig',
            items: [
                'get_project_advisory liefert jetzt das Dokument selbst. Verbundene Clients erhielten bisher nur dessen Metadaten — einen Dateinamen und eine Anzahl — und nie das Dokument, obwohl das Werkzeug es als vollständige Arbeitsliste beschrieb',
                'Der Advisory-Export enthält jetzt einen Eintrag je eindeutigem Advisory mit zusammengeführten Quellen statt einen je Scanner-Zeile: Eine Schwachstelle, die npm audit und OSV beide melden, ist ein einziger Arbeitspunkt mit beiden Advisory-IDs statt zwei fast identischen. Das gilt auch für „.md herunterladen“ im Portal, und die Anzahl stimmt nun mit dem Dashboard überein',
                'Ein Projekt, das nicht in eine einzelne MCP-Antwort passt, wird jetzt paginiert: Das Dokument weist darauf hin, dass es unvollständig ist, und nennt den genauen Folgeaufruf für den Rest — statt still abgeschnitten zu werden, wo ein Agent den Rest für sauber hielte',
                'Jeder Parameter jedes MCP-Werkzeugs ist jetzt beschrieben, und das neue Werkzeug list_mutes liefert die Stummschaltungs-IDs, die unmute benötigt — bisher nur erhältlich, wenn man die Stummschaltung in derselben Sitzung angelegt hatte',
                'Eine Lücke in den Schweregrad-Zählungen behoben: Ein Fund, dessen Schweregrad keiner der fünf bekannten Werte war, wurde als Fund gezählt, aber keiner Kategorie zugeordnet — ein Projekt mit genau diesem einen Fund wirkte dadurch völlig sauber'
            ]
        },
        '2.5.0': {
            title: 'Der Advisory-Export, direkt über MCP',
            items: [
                'Verbundene MCP-Clients können das vollständige Markdown-Advisory eines Projekts über das neue Tool get_project_advisory abrufen — dasselbe Dokument wie der Portal-Button „.md herunterladen“, ohne es aus dem Browser zu kopieren',
                'Stummgeschaltete Funde werden nicht mehr in den Advisory-Export des Projekts aufgenommen, sodass ein Agent nie Arbeit erhält, deren Risiko Sie bereits akzeptiert haben',
                'Hinweis: Da das Advisory Ihren Export-Prompt enthält, kann ein MCP-Client jetzt lesen, was Sie unter Einstellungen → Export hinterlegt haben'
            ]
        },
        '2.4.3': {
            title: 'Popups ohne Abschneiden und ein strengerer Export-Prompt',
            items: [
                'Dropdowns, das Abhängigkeitspfad-Popover und das Advisory-Export-Menü werden nicht mehr von der Tabelle oder dem Dialog abgeschnitten, in dem sie sitzen — sie werden über der Seite gerendert und klappen nach oben, wenn darunter kein Platz ist',
                'Der Standard-Prompt für den Advisory-Export verlangt jetzt, dass der Agent plant, bevor er etwas ändert, Funde mit gemeinsamem Fix gruppiert und die Code-Auswirkung jedes Versionssprungs benennt; er zielt auf null Funde und schließt dabei die Abkürzungen zu einer geschönten Null aus — Stummschalten, Ranges aufweiten oder den Scan-Umfang verkleinern —, während wirklich Offenes in einer datierten Restposten-Tabelle landet'
            ]
        },
        '2.4.2': {
            title: 'Der Branch in eigener Spalte',
            items: [
                'Der git-Branch, auf dem ein Projekt gescannt wurde, hat jetzt eine eigene Spalte in der Projektliste — reiner Text, kein Icon — statt unter dem Projektnamen zu stehen'
            ]
        },
        '2.4.1': {
            title: 'Sauberes Herunterfahren',
            items: [
                'Ein Neustart des Containers bricht keinen Scan mehr mitten im Schreibvorgang ab, und der Worker startet sofort, statt es zuerst ~30 Sekunden lang erneut zu versuchen',
                'Setze stop_grace_period: 60s (oder --stop-timeout 60) in deiner Compose-Datei, damit er den nötigen Spielraum hat — README und Docker-Doku beschreiben das jetzt'
            ]
        },
        '2.4.0': {
            title: 'Polyglotte Analyse — Python, Go und Rust kommen zu npm dazu',
            items: [
                'Sentinello analysiert jetzt neben npm auch Python-, Go- und Rust-Projekte — Lockfiles werden vollständig offline aufgelöst, und jedes Projekt meldet seine Analyseabdeckung (vollständig, teilweise oder nicht prüfbar), sodass Lücken sichtbar statt stillschweigend sind',
                'GitLabs gemnasium-Datenbank ergänzt npm audit und OSV als Offline-Advisory-Quelle, dedupliziert über CVE-/GHSA-Aliase; Einstellungen → Quellen ist jetzt eine Sprachen-×-Quellen-Matrix mit Benachrichtigungsbereich pro Zelle, und npm audit selbst lässt sich abschalten, solange eine Quelle aktiv bleibt',
                'Funde halten jetzt den git-Branch fest, aus dem sie stammen — sichtbar in der Projektliste, im Projektkopf und in jeder Benachrichtigung',
                'Projektzeilen haben eigene Aktionen — jetzt scannen, Advisory kopieren oder herunterladen, stummschalten oder reaktivieren und Tags bearbeiten — ein Triage-Durchgang erfordert also keinen Abstecher in jedes Projekt mehr',
                'Das Projekt-Dashboard ging von ~3,3 s auf ~0,03 s zurück, und die Navigation zeigt jetzt Ladezustände, statt eingefroren zu wirken',
                'Sicherheit: 25 Abhängigkeits-Advisories behoben, darunter libvips-CVEs, die im Bildoptimierer des Portals aktiv waren, und neun Next.js-Advisories, die das ausgelieferte Portal betrafen',
                'Der Standard-Prompt für den Advisory-Export deckt jetzt Mindestveröffentlichungsalter, Lockfile-Prüfung und veraltete Overrides ab'
            ]
        },
        '2.3.0': {
            title: 'Einfachere MCP-Einrichtung — ohne Umgebungsvariablen',
            items: [
                'MCP wird jetzt vollständig unter Einstellungen → MCP eingerichtet: Token generieren, um den Endpunkt /api/mcp einzuschalten, löschen, um ihn auszuschalten — die Umgebungsvariablen SENTINELLO_MCP_ENABLED und SENTINELLO_MCP_API_TOKEN entfallen (ein vorhandenes Umgebungs-Token wird beim Upgrade einmalig importiert)',
                'Fertige Verbindungs-Snippets zum Einfügen für Claude Code, Codex, Cursor und Claude Desktop, bereits mit deinem Token ausgefüllt',
                'Wenn SENTINELLO_PORTAL_BASE_URL in der Umgebung gesetzt ist, wird sie unter Einstellungen → Erweitert schreibgeschützt angezeigt, da sie maßgeblich bleibt und bei jedem Start erneut angewendet wird'
            ]
        },
        '2.2.0': {
            title: 'Weniger Fehlalarme und selbstbereinigende Funde',
            items: [
                'Malware-Hinweise stimmen jetzt mit der genau betroffenen Version überein — eine saubere oder bereits behobene Version eines einst kompromittierten Pakets wird nicht mehr markiert',
                'Doppelte Funde lösen sich jetzt beim nächsten Scan von selbst auf, sodass alte oder verwaiste Einträge automatisch verschwinden',
                'Produktions- und Entwicklungs-Kennzeichnungen werden jetzt über alle Quellen (npm und OSV) auf eine einheitliche Weise berechnet'
            ]
        },
        '2.1.0': {
            title: 'Ein aufgeräumter Projekt-Header und einheitliche Filter',
            items: [
                'Verschlankter Projekt-Header — Umbenennen direkt neben dem Titel, Stummschalten und Tags als Icon-Buttons',
                'Funde nach Quelle filtern (npm / OSV) über ein neues Dropdown neben dem Abhängigkeitstyp-Filter',
                'Einheitliche Dropdowns in der gesamten App, mit Tippsuche für lange Listen wie Zeitzonen'
            ]
        },
        '2.0.1': {
            title: 'Klarere Upgrade-Hinweise',
            items: [
                'Erweiterte Upgrade-Schritte für die Breaking Changes von 2.0',
                'Die README weist auf die nur-localhost-Portbindung hin'
            ]
        },
        '2.0.0': {
            title: 'Multi-Quellen-Scan und eine gehärtete, standardmäßig sichere Installation',
            items: [
                'OSV als optionale zweite Quelle (Einstellungen → Quellen, standardmäßig aus) mit Erkennung schädlicher Pakete, abgeglichen mit der öffentlichen OSV-Datenbank in einem lokalen Cache',
                'Funde werden jetzt quellenübergreifend zusammengeführt — eine Zeile pro Schwachstelle, jede Quelle markiert, der beste verfügbare Fix und die Vereinigung der Abhängigkeitspfade, mit Quellenfilter und einem Abhängigkeitspfad-Popover',
                'Sicherheitshärtung: der MCP-Endpunkt ist standardmäßig aus und erfordert ein Token, die Webhook-Zustellung ist gegen SSRF abgesichert, ein optionales Portal-Login, und der Container läuft als unprivilegierter Benutzer',
                'Einstellungen sind jetzt ein Bereich der obersten Ebene mit Seitenleiste und einer Profilseite'
            ]
        },
        '1.4.0': {
            title: 'MCP-Integration & Neuigkeiten',
            items: [
                'MCP-Server unter /api/mcp für Claude Desktop, Cursor und andere Clients',
                'Neuer Bereich Einstellungen → MCP mit Server-URL und Token-Verwaltung',
                'Neuigkeiten-Symbol und ein Verlauf der Versionshinweise'
            ]
        },
        '1.3.1': {
            title: 'Korrektur der Version in der Fußzeile',
            items: ['Die laufende Version wird in der Fußzeile sauber dargestellt']
        },
        '1.3.0': {
            title: 'Verbesserungen bei Benachrichtigungen',
            items: [
                'Benachrichtigungen nach Umgebung filtern',
                'Einfacheres Formular zum Bearbeiten von Zielen',
                'Ein vorhandenes Benachrichtigungsziel duplizieren'
            ]
        },
        '1.2.0': {
            title: 'Seiten für Projekte und Bibliotheken',
            items: ['Die Startansicht ist in eigene Seiten für Projekte und Bibliotheken aufgeteilt']
        },
        '1.1.2': {
            title: 'Live-Neuladen des Zeitplans',
            items: ['Der Worker lädt den Scan-Zeitplan neu, sobald du Änderungen im Portal speicherst']
        },
        '1.1.0': {
            title: 'Sichereres Löschen & ein klareres Update-Banner',
            items: [
                'Bestätigung vor dem Löschen von Roots und Benachrichtigungszielen',
                'Update-Hinweis als schließbares Banner oben',
                'Der Worker entfernt veraltete Roots, wenn ihr Host-Mount verschwindet'
            ]
        },
        '1.0.1': {
            title: 'Korrekturen der Scanner-Genauigkeit',
            items: [
                'Verwirft Funde, deren installierte Version nicht wirklich im verwundbaren Bereich liegt',
                'Ermöglicht das Löschen eines Benachrichtigungsziels mit Versandverlauf'
            ]
        },
        '1.0.0': {
            title: 'Erste Open-Source-Version',
            items: ['Die erste öffentliche Veröffentlichung von Sentinello']
        }
    },
    'pt-BR': {
        '3.3.1': {
            title: 'A mesma versão da 3.3.0, com uma imagem Docker que compila',
            items: [
                'A 3.3.0 foi publicada no npm e no GitHub, mas sua imagem de contêiner falhou ao compilar, então no momento do lançamento não existia 3.3.0 no GHCR nem no Docker Hub. O Dockerfile lista cada pacote do workspace que instala, e um deles — o de comparação de versões — nunca havia sido listado. Nada dentro da imagem o importava até esta versão, então a omissão jamais tinha feito diferença. Desde então foi publicada uma imagem 3.3.0 corrigida, construída a partir do próprio código de aplicação da 3.3.0, de modo que <code>docker pull sentinello:3.3.0</code> volta a funcionar. A 3.3.1 carrega a mesma correção na árvore de código. Se você usa a CLI, a 3.3.0 já estava correta.'
            ]
        },
        '3.3.0': {
            title: 'Apenas os ecossistemas que realmente funcionam — e notificações em que você pode confiar',
            items: [
                'Uma notificação podia chegar vazia. Um operador recebeu uma mensagem do Telegram anunciando vulnerabilidades em um projeto e sem listar nenhuma. O envio é delimitado por projeto, mas rodava uma vez por scanner: a passagem do npm audit recebeu dois eventos pendentes do OSV, não correspondeu a nenhum e ainda assim renderizou o título sobre uma lista vazia. Depois marcou ambos os eventos como entregues — então as duas ocorrências que nunca nomeou ficaram registradas como notificadas, e nada revisita um evento entregue. Agora um evento só é enviado se puder ser descrito; caso contrário fica pendente e é reconsiderado na próxima varredura',
                'Uma ocorrência é reportada com a pior classificação que qualquer fonte lhe deu, e essa escalada chegava ao painel, aos totais por projeto e ao portão <code>--fail-on</code> da CLI — mas não aos limiares de notificação. A notificação rodava antes da corroboração, então o evento ficava carimbado com a classificação da fonte sobrevivente e nunca era reescrito. Em uma instância real, 135 ocorrências abertas carregavam uma severidade de evento abaixo da real, <strong>41 delas registrando uma crítica como baixa, alta ou moderada</strong>. Um destino filtrado para crítica e alta nunca teria sido alertado por nenhuma delas, permanentemente',
                'Varreduras agendadas paravam à meia-noite em vez de continuar. “A cada 3 horas a partir das 07:00” rodava às 07, 10, 13, 16, 19 e 22 e só voltava às 07:00 — seis varreduras por dia em vez de oito, com uma janela cega de nove horas toda noite — enquanto as Configurações continuavam informando o intervalo escolhido. “A cada 6 horas a partir das 20:00” conseguia uma varredura por dia. Os horários agora atravessam a virada do dia',
                '<strong>Python, Go e Rust foram retirados.</strong> Não é cautela com arestas: suas falhas se reportavam como limpo. A derivação de correções e a ordenação de versões são apenas semver, então um aviso do OSV sobre Django recomendava “atualizar para 3.2.23” contra um 4.2 instalado; os nomes de pacotes PyPI do OSV não são canonicalizados conforme a PEP 503, então nunca coincidiam com os do resolvedor; e o parser de intervalos do gemnasium não consegue ler interseções com vírgula da PEP 440. Uma fonte que responde “sem vulnerabilidades” pelos motivos errados é pior do que uma que não é oferecida, então elas sumiram por completo da superfície do produto — sem chave, sem descoberta, sem download. <strong>As ocorrências que você já coletou com elas continuam visíveis e podem ser silenciadas; nada é excluído.</strong> O ecossistema npm agora se chama <strong>Node.js</strong>, que nomeia o ecossistema de pacotes de fato varrido em vez de uma linguagem',
                '<strong>Configurações → Fontes</strong> foi reconstruída em torno disso. Cada fonte repetia a própria explicação ao lado da própria chave, e cada uma apoiada em cache trazia um painel de estado de cinco linhas com o próprio botão “Atualizar agora” em tamanho cheio — mesmo que esse botão enfileire um único sinal compartilhado por fonte, não importa quantas vezes apareça. As chaves agora dizem apenas se uma fonte está ativa; o que cada uma acrescenta, o que baixa e de onde, e quando roda foi para uma única tabela de referência abaixo delas, e o estado de sincronização virou uma linha',
                'Pacotes que o próprio lockfile do npm declara alcançáveis a partir da produção estavam sendo rebaixados para somente desenvolvimento. Um lockfile que omite <code>dev: true</code> é o npm afirmando que o pacote É alcançável a partir da produção — uma afirmação mais forte do que o manifesto raiz pode fazer — mas o resolvedor a sobrescrevia sempre que o nome também aparecia em <code>devDependencies</code>, exatamente quando o npm estava certo. Medido em 130 projetos reais: 142 pacotes rebaixados em 97 deles — lodash, semver, postcss, tailwindcss, @babel/runtime — escondendo sete ocorrências abertas do filtro somente-produção em uma instância',
                'Qualquer pacote fixado em uma versão como <code>0.0.0-20180523222229-09b5706aa936</code> não correspondia a <strong>nenhum aviso</strong>, nem mesmo a um aberto, e a varredura reportava ok com zero ocorrências. Um limite de aviso <code>introduced: 0</code> era comparado como o release 0.0.0, e em semver uma prerelease ordena abaixo do seu release. 330 dos 19.085 intervalos comparáveis de um cache real estavam armazenados como intervalos que nada podia satisfazer',
                'Uma sincronização do OSV interrompida podia apagar um aviso permanentemente. O caminho incremental excluía as linhas de um aviso e só então buscava a substituição dentro de um try/catch, então qualquer timeout, 5xx ou desligamento o removia por inteiro — e ainda avançava o cursor, deixando o id permanentemente para trás. A perda era silenciosa, sobrevivia até a próxima ressemeadura completa e acontecia em uma sincronização que reportava sucesso. O cache do <code>npx sentinello</code> se erodia do mesmo jeito a cada execução instável. Ambos agora buscam primeiro e substituem depois',
                'O <code>--dep-type dev</code> da CLI significava “alcançável a partir de dev de algum modo”, enquanto o portal significa “alcançável <em>somente</em> a partir de dev”, então um pacote alcançável pelos dois aparecia em uma visão e não na outra — 177 ocorrências abertas diferem entre as duas leituras em uma instância. A CLI agora usa a regra do portal e respeita o campo <code>withdrawn</code> do OSV, que ela era estruturalmente incapaz de ler: 585 linhas de um cache npm real carregam um, e todas eram reportadas como ocorrências ativas',
                'Um aviso do gemnasium que diz que uma vulnerabilidade começa <em>depois</em> de uma versão — <code>&gt;1.2.8</code> em vez de <code>&gt;=1.2.8</code> — era lido como se a própria versão do limite fosse afetada. O sequestro do pacote <code>rc</code> em 2021 está escrito exatamente assim, e 1.2.8 é sua última versão limpa: justamente a que a nota de remediação do próprio aviso manda manter. Todo projeto com <code>rc</code> instalado via um achado crítico de malware, sem correção disponível, contra uma versão que nunca foi comprometida. Os limites agora são preservados exatamente como o aviso os declara, e os falsos críticos desse tipo desaparecem',
                'O mesmo arredondamento agia no sentido inverso e escondia achados reais. Um aviso limitado por <code>&lt;=2.0.0</code> era guardado como “abaixo de 2.0.0”, então 2.0.0 — a versão sobre a qual ele é mais explícito — não era reportada, e um aviso que nomeava exatamente uma versão afetada virava um intervalo vazio e era descartado por inteiro. Espere alguns achados novos que sempre estiveram lá, apenas invisíveis',
                'Intervalos escritos com sintaxe que o Sentinello não implementa — <code>^1.0.0</code>, <code>~1.0.0</code> — eram guardados como versão exata presa ao texto literal, incapaz de casar com qualquer coisa enquanto permanecesse em cache: um aviso com aparência ativa que jamais poderia disparar. Esses registros agora são recusados em vez de guardados numa forma que não funciona, e avisos cujo limite superior não traz uma versão corrigida limpa finalmente recebem sugestão de atualização',
                'O auxiliar que mascara uma URL de webhook ou um token de bot antes de chegar a uma linha de log imprimia os curtos por inteiro. Ele rejeitava valores de seis caracteres ou menos, mas então mantinha uma cabeça de oito caracteres e uma cauda de quatro, e nada verificava se essas duas metades se encontravam — então todo segredo entre 7 e 12 caracteres voltava completo. Agora ele esconde ao menos oito caracteres ou redige o valor por inteiro'
            ]
        },
        '3.2.0': {
            title: 'Os achados mostram quais fontes concordam, e avisos retirados deixam de ser reportados',
            items: [
                'Quando mais de uma base de avisos reporta a mesma vulnerabilidade, o Sentinello sempre manteve um único achado: reportar a mesma falha três vezes porque três bases a conhecem é ruído. O que ele fazia antes era descartar tudo sobre as fontes que unificava, então uma vulnerabilidade confirmada de forma independente pelo npm audit, pelo OSV e pelo GitLab gemnasium parecia idêntica a uma que só uma base jamais reportou. Numa instância real isso são dois terços dos achados. Agora cada achado carrega as demais fontes que o reportaram, e seus selos aparecem ao lado do sobrevivente',
                'Um achado é reportado com a PIOR severidade atribuída por qualquer fonte. As bases realmente discordam — o gemnasium calcula a severidade a partir do vetor CVSS enquanto o npm audit adota a categoria do GitHub — e, para um scanner, a leitura cautelosa é a que vale agir. Isto não é cosmético: um achado elevado muda de categoria no painel, nos totais do projeto, na barreira <code>--fail-on</code> da CLI e nos limiares de notificação. Espere alguns números mudarem na primeira varredura após a atualização; nada novo foi detectado, os mesmos achados estão sendo classificados com mais cautela',
                'Onde as fontes discordam, o achado exibe ao lado da severidade um controle que abre o que cada uma realmente disse: o identificador de aviso dela e a classificação dela. Ele só aparece quando há divergência a explicar, de modo que um achado avaliado igualmente por todas permanece limpo',
                'O OSV registra a retirada em um campo próprio e o GitHub remove avisos retirados antes que o <code>npm audit</code> sequer os veja, mas o GitLab gemnasium não tem esse campo em seu esquema. Ele retira um aviso reescrevendo o registro: o título passa a ser “False Positive”, “Withdrawn Advisory: …” ou “Duplicate Advisory: …”, enquanto as versões que ele citava continuam ali. O Sentinello lia essas versões e reportava achados que o GitLab havia retirado explicitamente: 383 registros em JavaScript, Python, Go e Rust, incluindo um que reportava o <code>express</code> sob o título “False Positive”. Todos são descartados agora, o que também elimina toda uma classe de achados duplicados, já que 278 dos 383 são avisos retirados por duplicarem outro',
                'A verificação compara os marcadores de retirada de forma exata, em vez de procurar as palavras em qualquer lugar, então um aviso legítimo que trate *sobre* um falso positivo continua sendo reportado: o CVE-2026-39395 do Cosign, intitulado “Cosign’s verify-blob-attestation reports false positive when payload parsing fails”, não é afetado',
                'O cache do gemnasium se reconstrói sozinho na primeira sincronização após esta atualização, e então os avisos retirados desaparecem. Não há nada a fazer: acontece na sincronização diária, ou imediatamente em Configurações → Fontes → Atualizar'
            ]
        },
        '3.1.1': {
            title: 'Os intervalos de versão dos avisos estão corretos nos dois sentidos',
            items: [
                'Alguns avisos do GitLab gemnasium não trazem nenhum intervalo de versões legível por máquina — 698 dos 10.777 de JavaScript. O Sentinello preenchia essa lacuna presumindo que todas as versões abaixo da primeira correção listada estavam afetadas, mas essa lista não é ordenada e contém uma correção por ramo de lançamento, então o palpite caía com frequência no ramo errado. O protobufjs 7.6.5 era reportado como execução remota de código crítica embora aquele ramo tenha sido corrigido em 7.5.5, e três avisos distintos afirmavam que toda versão do vite abaixo de 8.0.5 era vulnerável. O Sentinello não inventa mais intervalos: recupera o real do mesmo aviso publicado sob seu outro identificador, da própria descrição do aviso ou — somente se você tiver o OSV ativado — da cópia do OSV já presente na sua máquina, e descarta o registro em vez de adivinhar quando nenhuma dessas vias responde. Espere que alguns críticos desapareçam',
                'O OSV descreve um aviso corrigido em vários ramos como uma entrada separada por ramo, e o Sentinello ficava com a primeira e descartava as demais — 1.927 intervalos de versões vulneráveis só em JavaScript, cada um deles uma vulnerabilidade real que deixou de ser vista. O aviso do minimatch cobre oito ramos e apenas um sobrevivia, de modo que um minimatch 3.0.4 ou 9.0.0 instalado não era reportado; next e ua-parser-js perdiam ramos do mesmo jeito. Agora todos os ramos são mantidos. Espere que apareçam novos achados — essas vulnerabilidades sempre estiveram lá, apenas invisíveis',
                'Os dois caches de avisos se reconstroem sozinhos na primeira sincronização após esta atualização, porque os intervalos que guardam foram produzidos pelo código antigo. Não há nada a fazer: acontece na sincronização diária, ou imediatamente em Configurações → Fontes → Atualizar, se preferir não esperar'
            ]
        },
        '3.1.0': {
            title: 'As constatações silenciadas saem do caminho, e o banco de dados para de crescer sem fim',
            items: [
                'Uma constatação silenciada é uma decisão que você já tomou, então agora ela sai por completo da página do projeto em vez de ficar ali esmaecida. Não é só arrumação: todos os números da página — a contagem do título, os selos das duas abas, a paginação, os totais por biblioteca, o botão de exportar — são calculados a partir das mesmas linhas, de modo que a página finalmente concorda com o painel, com as ferramentas MCP e com a exportação de alertas, que já deixavam as silenciadas de fora. Um controle “Mostrar silenciados” as traz de volta quando você quiser, inclusive num projeto cujas constatações estão *todas* silenciadas',
                'Digitar em uma caixa de diálogo não perde mais o foco depois de um único caractere. Esse defeito tornava praticamente impossível preencher o campo Motivo do diálogo de silenciamento — obrigatório, e a única coisa que torna um silenciamento auditável meses depois. O mesmo diálogo também deixou de herdar o alinhamento da linha de tabela de onde foi aberto, e é por isso que silenciar uma constatação produzia um diálogo alinhado à direita enquanto silenciar um projeto não',
                'O histórico de varreduras não cresce mais para sempre. Nada jamais havia excluído uma linha de varredura por idade, então um projeto que permanecia em disco acumulava uma linha por fonte a cada passagem, indefinidamente — uma instância real chegou a 2,2 GB em menos de três meses. Configurações → Avançado agora traz um período de retenção, 90 dias por padrão, e o worker limpa o que passar disso a cada hora, sempre mantendo as 100 varreduras mais recentes de cada projeto. Constatações, silenciamentos e histórico de notificações nunca são tocados; apenas o registro de varreduras. Com 90 dias, uma instância que se atualiza não apaga nada na primeira passagem: a limpeza só começa quando o histórico realmente ultrapassa esse período, ou quando você mesmo o reduz',
                'A maior parte desse crescimento era a saída bruta do `npm audit`, guardada por inteiro a cada varredura bem-sucedida e lida por absolutamente nada — 98,7% do banco daquela instância. As varreduras agora registram um resumo curto, o que leva uma linha de cerca de 79 KB para uns 100 bytes, com um teto rígido para que nenhum scanner repita isso',
                'No MCP, `get_dashboard_summary` agora informa que um projeto silenciado sai dos seus totais enquanto `list_projects` continua a retorná-lo. Os dois contam populações diferentes de propósito, e um agente que os comparava lia isso como um defeito. `list_scans` também parou de devolver a saída bruta do scanner de cada varredura, que podia chegar a uns 16 MB numa única resposta'
            ]
        },
        '3.0.1': {
            title: 'O download do gemnasium volta a funcionar — e a CLI devolve o terminal',
            items: [
                'O download do GitLab gemnasium falhava na 3.0.0 com `HTTP 406`, para todo mundo. O fetch nativo do Node adiciona um cabeçalho `Sec-Fetch-Mode: cors` que um programa não pode remover, e o GitLab recusa qualquer requisição de arquivo do repositório que o carregue — então nunca teve a ver com sua rede, seu IP ou quantas vezes você tentou. Agora o download usa uma requisição HTTPS comum e funciona',
                'O arquivo é buscado pelo id do commit em vez do nome do branch, então todos que atualizam a partir do mesmo commit compartilham uma cópia em cache em vez de cada um pedir ao GitLab que gere um arquivo de 60 MB. Um primeiro download que levava quase sete minutos agora termina em segundos',
                'A CLI terminava todo o trabalho — relatório escrito, resumo impresso — e depois nunca devolvia o terminal. A conexão do download ficava aberta por trás, mantendo o processo vivo; agora ela é fechada assim que o arquivo é lido',
                'Uma fonte que recusa um download não trava mais por três minutos antes de avisar. Ela avisa em segundos e, num terminal, oferece tentar de novo — repetindo apenas a fonte que realmente falhou',
                '`--fail-on` é honesto nos dois sentidos. Ele recusa uma execução cuja fonte de avisos não pôde ser consultada, em vez de relatar uma varredura limpa que nunca fez; e não falha mais por causa de uma fonte que você mesmo desligou com `SENTINELLO_OSV_FEED_URL=off` ou `SENTINELLO_GEMNASIUM_FEED_URL=off` e nunca baixou'
            ]
        },
        '3.0.0': {
            title: 'O Sentinello agora roda sem portal nenhum',
            items: [
                'Os scanners saem como CLI no npm. `npx sentinello` percorre uma pasta, encontra todos os projetos abaixo, confere contra npm audit, OSV e GitLab gemnasium, e escreve um parecer em markdown com um prompt de remediação anexado — sem instalação, sem conta, sem banco de dados, e nada do seu código sai da máquina',
                'Em pipe, o parecer é a única coisa no stdout, então `npx sentinello | claude -p "$(cat -)"` entrega a um agente uma lista de trabalho completa sem nada corromper o documento',
                'A primeira execução não perde mais a fonte gemnasium por um download recusado. O GitLab recusa seu arquivo por um ou dois minutos seguidos, e a repetição antiga desistia em treze segundos; agora a CLI espera passar, diz por que está esperando, e aceita `--feed-wait` se os três minutos padrão não servirem',
                'As duas estimativas de download foram medidas, não chutadas: o export npm do OSV é informado como 204 MB em vez de 196, e o arquivo do gemnasium como 52 MB em vez de 80. O aviso de consentimento marca uma estimativa com um til para que nunca seja confundida com um tamanho informado pelo servidor',
                'Um valor com cara de flag agora é recusado em vez de aceito ao pé da letra — `--out --` escrevia um parecer em um arquivo chamado `--` dentro do seu projeto e relatava sucesso',
                'O painel de Novidades não escapa mais pela parte de baixo da janela quando uma versão tem muito a dizer'
            ]
        },
        '2.6.0': {
            title: 'O documento de parecer realmente chega — e conta o que você quer dizer',
            items: [
                'get_project_advisory agora retorna o próprio documento de parecer. Antes, os clientes conectados recebiam só os metadados — um nome de arquivo e uma contagem — e nunca o documento, embora a ferramenta o descrevesse como uma lista de trabalho completa',
                'A exportação de pareceres agora tem uma entrada por parecer distinto, com suas fontes mescladas, em vez de uma por linha de scanner: uma vulnerabilidade que npm audit e OSV relatam é um único item de trabalho carregando os dois IDs, não dois quase idênticos. Isso vale também para o Download .md do portal, e a contagem agora bate com o painel',
                'Um projeto grande demais para caber em uma resposta MCP agora é paginado — o documento informa que está incompleto e dá a chamada exata para buscar o resto, em vez de ser cortado em silêncio onde um agente leria o restante como limpo',
                'Toda entrada de toda ferramenta MCP agora tem uma descrição, e uma nova ferramenta list_mutes expõe os IDs de silenciamento de que unmute precisa — antes só obteníveis criando o silenciamento na mesma sessão',
                'Corrigida uma falha nas contagens de severidade: um achado cuja severidade não fosse um dos cinco valores conhecidos era contado como achado mas não entrava em nenhum balde de severidade, então um projeto cujo único achado tivesse isso parecia completamente limpo'
            ]
        },
        '2.5.0': {
            title: 'O relatório de vulnerabilidades, direto pelo MCP',
            items: [
                'Clientes MCP conectados podem obter o relatório Markdown completo de um projeto com a nova ferramenta get_project_advisory — o mesmo documento do botão Baixar .md do portal, sem copiá-lo do navegador',
                'Descobertas silenciadas não entram mais no relatório do projeto, então um agente nunca recebe um trabalho cujo risco você já aceitou',
                'Observação: como o relatório contém o seu prompt de exportação, um cliente MCP agora consegue ler o que você escreveu em Configurações → Exportação'
            ]
        },
        '2.4.3': {
            title: 'Popups sem corte e um prompt de exportação mais rigoroso',
            items: [
                'Os menus suspensos, o popover de caminho de dependência e o menu de exportação de avisos não são mais cortados pela tabela ou pelo diálogo em que ficam — eles são renderizados acima da página e abrem para cima quando não há espaço embaixo',
                'O prompt padrão de exportação de avisos agora pede que o agente planeje antes de editar qualquer coisa, agrupe os achados que compartilham uma mesma correção e detalhe o impacto no código de cada mudança de versão; ele mira zero achados e descarta os atalhos para um zero falso — silenciar, ampliar intervalos ou reduzir o escopo da análise —, deixando o que é realmente irredutível em uma tabela de resíduos datada'
            ]
        },
        '2.4.2': {
            title: 'O branch em sua própria coluna',
            items: [
                'O branch do git em que o projeto foi analisado agora tem uma coluna própria na lista de projetos — texto simples, sem ícone — em vez de ficar embaixo do nome do projeto'
            ]
        },
        '2.4.1': {
            title: 'Desligamentos limpos',
            items: [
                'Reiniciar o contêiner não interrompe mais uma análise no meio da gravação, e o worker inicia imediatamente em vez de tentar de novo por ~30 segundos',
                'Defina stop_grace_period: 60s (ou --stop-timeout 60) no seu arquivo compose para dar espaço a ele — o README e a documentação do Docker agora explicam isso'
            ]
        },
        '2.4.0': {
            title: 'Análise poliglota — Python, Go e Rust se juntam ao npm',
            items: [
                'O Sentinello agora analisa projetos Python, Go e Rust além de npm — os arquivos de bloqueio são resolvidos totalmente offline e cada projeto informa sua cobertura de análise (completa, parcial ou não auditável), de modo que as lacunas fiquem visíveis em vez de silenciosas',
                'O banco gemnasium do GitLab se junta ao npm audit e ao OSV como fonte de avisos offline, deduplicada em relação às demais por alias CVE/GHSA; Configurações → Fontes agora é uma matriz Linguagens × Fontes com escopo de notificação por célula, e o próprio npm audit pode ser desativado desde que uma fonte permaneça ativa',
                'Os achados agora registram o branch do git de onde vieram, exibido na lista de projetos, no cabeçalho do projeto e em todas as notificações',
                'As linhas de projeto trazem suas próprias ações — analisar agora, copiar ou baixar o aviso, silenciar ou reativar e editar tags — assim uma rodada de triagem não exige mais entrar em cada projeto',
                'O painel de projetos passou de ~3,3 s para ~0,03 s, e a navegação agora mostra estados de carregamento em vez de parecer travada',
                'Segurança: 25 avisos de dependências resolvidos, incluindo CVEs do libvips que estavam ativos no otimizador de imagens do portal e nove avisos do Next.js que afetavam o portal distribuído',
                'O prompt padrão de exportação de avisos agora cobre idade mínima de publicação, verificação do arquivo de bloqueio e overrides obsoletos'
            ]
        },
        '2.3.0': {
            title: 'Configuração de MCP mais simples, sem variáveis de ambiente',
            items: [
                'Configure o MCP inteiramente em Configurações → MCP: gere um token para ativar o endpoint /api/mcp e limpe-o para desativá-lo — as variáveis de ambiente SENTINELLO_MCP_ENABLED e SENTINELLO_MCP_API_TOKEN foram removidas (um token de ambiente existente é importado uma vez na atualização)',
                'Trechos de conexão prontos para colar para Claude Code, Codex, Cursor e Claude Desktop, já preenchidos com o seu token',
                'Quando SENTINELLO_PORTAL_BASE_URL é definida no ambiente, ela aparece como somente leitura em Configurações → Avançado, pois continua sendo autoritativa e é reaplicada a cada inicialização'
            ]
        },
        '2.2.0': {
            title: 'Menos alarmes falsos e achados que se limpam sozinhos',
            items: [
                'Os avisos de malware agora correspondem à versão comprometida exata — uma versão limpa ou já corrigida de um pacote que esteve comprometido deixa de ser sinalizada',
                'Achados duplicados agora se resolvem sozinhos na próxima varredura, de modo que entradas antigas ou órfãs são removidas automaticamente',
                'Os rótulos de produção e desenvolvimento agora são calculados de uma única forma consistente em todas as fontes (npm e OSV)'
            ]
        },
        '2.1.0': {
            title: 'Um cabeçalho de projeto mais limpo e filtros consistentes',
            items: [
                'Cabeçalho de projeto simplificado — renomeie ao lado do título, com silenciar e tags como ícones',
                'Filtre as ocorrências por fonte (npm / OSV) em um novo menu suspenso ao lado do filtro de tipo de dependência',
                'Menus suspensos unificados e consistentes em todo o app, com busca ao digitar em listas longas como fusos horários'
            ]
        },
        '2.0.1': {
            title: 'Orientações de atualização mais claras',
            items: [
                'Passos de atualização ampliados para as alterações incompatíveis da 2.0',
                'O README indica a vinculação de porta somente em localhost'
            ]
        },
        '2.0.0': {
            title: 'Varredura multi-fonte e uma instalação reforçada e segura por padrão',
            items: [
                'OSV como segunda fonte opcional (Configurações → Fontes, desativada por padrão) com detecção de pacotes maliciosos, comparada com o banco de dados público do OSV em um cache local',
                'Os achados agora são mesclados entre fontes — uma linha por vulnerabilidade, cada fonte marcada, a melhor correção disponível e a união dos caminhos de dependência, com filtro por fonte e um popover de caminho de dependência',
                'Reforço de segurança: o endpoint MCP está desativado por padrão e exige um token, a entrega de webhooks é protegida contra SSRF, uma porta de login opcional do portal, e o contêiner é executado como usuário sem privilégios',
                'Configurações agora é uma seção de nível superior com barra lateral e uma página de Perfil'
            ]
        },
        '1.4.0': {
            title: 'Integração MCP e novidades',
            items: [
                'Servidor MCP em /api/mcp para Claude Desktop, Cursor e outros clientes',
                'Nova seção Configurações → MCP com URL do servidor e gerenciamento de tokens',
                'Etiqueta de novidades e um histórico de notas de versão'
            ]
        },
        '1.3.1': {
            title: 'Correção da versão no rodapé',
            items: ['A versão em execução é exibida corretamente no rodapé']
        },
        '1.3.0': {
            title: 'Melhorias nas notificações',
            items: [
                'Filtrar notificações por ambiente',
                'Formulário de edição de destinos mais simples',
                'Duplicar um destino de notificação existente'
            ]
        },
        '1.2.0': {
            title: 'Páginas de Projetos e Bibliotecas',
            items: ['A tela inicial é dividida em páginas dedicadas de Projetos e Bibliotecas']
        },
        '1.1.2': {
            title: 'Recarregamento da agenda em tempo real',
            items: ['O worker recarrega a agenda de varredura assim que você salva alterações no portal']
        },
        '1.1.0': {
            title: 'Exclusões mais seguras e um aviso de atualização mais claro',
            items: [
                'Confirmação antes de excluir raízes e destinos de notificação',
                'Aviso de atualização movido para um banner superior dispensável',
                'O worker remove raízes obsoletas quando o ponto de montagem desaparece'
            ]
        },
        '1.0.1': {
            title: 'Correções de precisão do scanner',
            items: [
                'Descarta achados cuja versão instalada não está realmente na faixa vulnerável',
                'Permite excluir um destino de notificação com histórico de envios'
            ]
        },
        '1.0.0': { title: 'Primeira versão de código aberto', items: ['O primeiro lançamento público do Sentinello'] }
    },
    it: {
        '3.3.1': {
            title: 'La stessa release della 3.3.0, con un’immagine Docker che si costruisce',
            items: [
                'La 3.3.0 è stata pubblicata su npm e GitHub, ma la sua immagine container non si è costruita: al momento del rilascio su GHCR e Docker Hub non esisteva una 3.3.0. Il Dockerfile elenca ogni pacchetto del workspace che installa, e uno di essi — quello per il confronto delle versioni — non era mai stato elencato. Fino a questa release nulla nell’immagine lo importava, quindi l’omissione non aveva mai avuto effetto. Da allora è stata pubblicata un’immagine 3.3.0 corretta, costruita dal codice applicativo della 3.3.0 stessa, così <code>docker pull sentinello:3.3.0</code> funziona di nuovo. La 3.3.1 porta la stessa correzione nell’albero dei sorgenti. Se usi la CLI, la 3.3.0 era già corretta.'
            ]
        },
        '3.3.0': {
            title: 'Solo gli ecosistemi che funzionano davvero — e notifiche di cui fidarsi',
            items: [
                'Una notifica poteva arrivare vuota. Un operatore ha ricevuto un messaggio Telegram che annunciava vulnerabilità in un progetto senza elencarne nessuna. L’invio è delimitato per progetto ma girava una volta per scanner: il passaggio di npm audit si è visto consegnare due eventi OSV in sospeso, non ne ha fatto corrispondere nessuno e ha comunque reso il titolo sopra un elenco vuoto. Poi ha segnato entrambi gli eventi come consegnati — quindi i due risultati mai nominati sono stati registrati come notificati, e nulla ritorna su un evento consegnato. Ora un evento viene inviato solo se può essere descritto; altrimenti resta in sospeso e viene riconsiderato alla scansione successiva',
                'Un risultato è segnalato con il voto peggiore che una qualsiasi fonte gli ha dato, e quell’escalation raggiungeva la dashboard, i totali per progetto e il cancello <code>--fail-on</code> della CLI — ma non le soglie di notifica. La notifica girava prima della corroborazione, quindi l’evento portava il voto della fonte sopravvissuta e non veniva mai riscritto. Su un’istanza reale, 135 risultati aperti portavano una severità dell’evento inferiore a quella vera, <strong>41 dei quali registravano un critico come basso, alto o moderato</strong>. Un destinatario filtrato su critico e alto non sarebbe mai stato allertato per nessuno di essi, in modo permanente',
                'Le scansioni pianificate si fermavano a mezzanotte invece di proseguire. “Ogni 3 ore dalle 07:00” girava alle 07, 10, 13, 16, 19 e 22 e poi solo alle 07:00 — sei scansioni al giorno invece di otto, con una finestra cieca di nove ore ogni notte — mentre le Impostazioni continuavano a riportare l’intervallo scelto. “Ogni 6 ore dalle 20:00” arrivava a una scansione al giorno. Ora gli orari proseguono oltre il cambio di giorno',
                '<strong>Python, Go e Rust sono stati ritirati.</strong> Non è prudenza verso qualche spigolo: i loro difetti si riportavano come puliti. La derivazione delle correzioni e l’ordinamento delle versioni sono solo semver, così un advisory OSV su Django consigliava di “aggiornare a 3.2.23” contro un 4.2 installato; i nomi dei pacchetti PyPI di OSV non sono canonicalizzati secondo PEP 503 e quindi non incontravano mai quelli del resolver; e il parser di intervalli di gemnasium non sa leggere le intersezioni con virgola di PEP 440. Una fonte che risponde “nessuna vulnerabilità” per i motivi sbagliati è peggio di una che non viene offerta, quindi sono sparite del tutto dalla superficie del prodotto — nessun interruttore, nessuna scoperta, nessun download. <strong>I risultati già raccolti con esse restano visibili e silenziabili; nulla viene eliminato.</strong> L’ecosistema npm ora si chiama <strong>Node.js</strong>, che nomina l’ecosistema di pacchetti realmente analizzato anziché un linguaggio',
                '<strong>Impostazioni → Fonti</strong> è stata ricostruita intorno a questo. Ogni fonte ripeteva la propria spiegazione accanto al proprio interruttore, e ognuna basata su cache portava un pannello di stato di cinque righe con un proprio pulsante “Aggiorna ora” a grandezza piena — anche se quel pulsante accoda un unico segnale condiviso per fonte, per quante volte appaia. Gli interruttori ora dicono solo se una fonte è attiva; cosa aggiunge ciascuna, cosa scarica e da dove, e quando viene eseguita sono passati in un’unica tabella di riferimento sotto di essi, e lo stato di sincronizzazione si è ridotto a una riga',
                'Pacchetti che il lockfile di npm stesso dichiara raggiungibili dalla produzione venivano declassati a solo sviluppo. Un lockfile che omette <code>dev: true</code> è npm che afferma che il pacchetto È raggiungibile dalla produzione — un’affermazione più forte di quella che il manifest radice può fare — ma il resolver la sovrascriveva ogni volta che il nome compariva anche sotto <code>devDependencies</code>, cioè esattamente quando npm aveva ragione. Misurato su 130 progetti reali: 142 pacchetti declassati in 97 di essi — lodash, semver, postcss, tailwindcss, @babel/runtime — nascondendo sette risultati aperti dal filtro solo-produzione su un’istanza',
                'Qualsiasi pacchetto fissato a una versione come <code>0.0.0-20180523222229-09b5706aa936</code> non corrispondeva a <strong>nessun advisory</strong>, nemmeno a uno aperto, e la scansione riportava ok con zero risultati. Un limite di advisory <code>introduced: 0</code> veniva confrontato come la release 0.0.0, e in semver una prerelease si ordina sotto la sua release. 330 dei 19.085 intervalli confrontabili di una cache reale erano memorizzati come intervalli che nulla poteva soddisfare',
                'Una sincronizzazione OSV interrotta poteva cancellare un advisory in modo permanente. Il percorso incrementale eliminava le righe di un advisory e solo dopo recuperava la sostituzione dentro un try/catch, quindi qualsiasi timeout, 5xx o spegnimento lo rimuoveva del tutto — e poi faceva avanzare comunque il cursore, lasciando l’id permanentemente indietro. La perdita era silenziosa, sopravviveva fino al successivo riseed completo e avveniva in una sincronizzazione che riportava successo. La cache di <code>npx sentinello</code> si erodeva allo stesso modo a ogni esecuzione instabile. Entrambe ora recuperano prima e sostituiscono poi',
                'Il <code>--dep-type dev</code> della CLI significava “raggiungibile da dev in qualche modo”, mentre il portale intende “raggiungibile <em>solo</em> da dev”, quindi un pacchetto raggiungibile da entrambi compariva in una vista e non nell’altra — 177 risultati aperti differiscono tra le due letture su un’istanza. La CLI ora usa la regola del portale e rispetta il campo <code>withdrawn</code> di OSV, che era strutturalmente incapace di leggere: 585 righe di una cache npm reale ne portano uno, e tutte venivano riportate come risultati attivi',
                'Un advisory di gemnasium che dice che una vulnerabilità inizia <em>dopo</em> una versione — <code>&gt;1.2.8</code> anziché <code>&gt;=1.2.8</code> — veniva letto come se la versione di confine fosse essa stessa interessata. Il dirottamento del pacchetto <code>rc</code> nel 2021 è scritto proprio così, e 1.2.8 è la sua ultima versione pulita: esattamente quella che la nota di rimedio dell’advisory stesso invita a mantenere. Ogni progetto con <code>rc</code> installato vedeva un rilevamento critico di malware, senza correzione disponibile, contro una versione mai compromessa. Ora i limiti vengono mantenuti esattamente come l’advisory li dichiara e i falsi critici di questa forma spariscono',
                'Lo stesso arrotondamento agiva nella direzione opposta e nascondeva rilevamenti reali. Un advisory delimitato da <code>&lt;=2.0.0</code> veniva memorizzato come «sotto 2.0.0», così 2.0.0 — la versione su cui è più esplicito — non veniva segnalata, e un advisory che nominava esattamente una versione interessata diventava un intervallo vuoto e veniva scartato del tutto. Aspettati qualche nuovo rilevamento che c’era da sempre, semplicemente invisibile',
                'Gli intervalli scritti con sintassi che Sentinello non implementa — <code>^1.0.0</code>, <code>~1.0.0</code> — venivano memorizzati come versione esatta fissata sul testo letterale, incapace di corrispondere a qualsiasi cosa finché restava in cache: un advisory dall’aspetto attivo ma che non poteva scattare. Ora quei record vengono rifiutati invece di essere conservati in una forma che non può funzionare, e gli advisory il cui limite superiore non porta una versione corretta pulita ricevono finalmente un suggerimento di aggiornamento',
                'L’helper che maschera un URL di webhook o un token di bot prima che finisca in una riga di log stampava per intero quelli corti. Rifiutava valori di sei caratteri o meno, ma poi teneva una testa di otto caratteri e una coda di quattro, e nulla verificava che quelle due metà non si toccassero — così ogni segreto tra 7 e 12 caratteri tornava completo. Ora nasconde almeno otto caratteri oppure oscura del tutto il valore'
            ]
        },
        '3.2.0': {
            title: 'I risultati mostrano quali fonti concordano e gli advisory ritirati non vengono più segnalati',
            items: [
                'Quando più database di advisory segnalano la stessa vulnerabilità, Sentinello ha sempre mantenuto UN solo risultato: segnalare tre volte lo stesso difetto perché lo conoscono tre database è rumore. Finora però scartava tutto ciò che riguardava le fonti accorpate, così una vulnerabilità confermata in modo indipendente da npm audit, OSV e GitLab gemnasium appariva identica a una che un solo database avesse mai segnalato. Su un’istanza reale si tratta di due terzi dei risultati. Ora ogni risultato porta con sé le altre fonti che lo hanno segnalato, e i loro badge compaiono accanto a quello sopravvissuto',
                'Un risultato viene segnalato con la severità PIÙ ALTA assegnata da una qualsiasi fonte. I database non concordano davvero — gemnasium calcola la severità dal vettore CVSS mentre npm audit adotta la categoria di GitHub — e per uno scanner la lettura prudente è quella su cui agire. Non è un dettaglio estetico: un risultato innalzato cambia categoria nella dashboard, nei totali di progetto, nel gate <code>--fail-on</code> della CLI e nelle soglie di notifica. Aspettati che alcuni conteggi si spostino alla prima scansione dopo l’aggiornamento: non è stato rilevato nulla di nuovo, gli stessi risultati vengono valutati con più prudenza',
                'Dove le fonti divergono, il risultato mostra accanto alla severità un controllo che apre ciò che ciascuna ha effettivamente detto: il proprio identificativo di advisory e la propria valutazione. Compare solo quando c’è un disaccordo da spiegare, così un risultato valutato allo stesso modo da tutti resta pulito',
                'OSV registra un ritiro in un campo dedicato e GitHub rimuove gli advisory ritirati prima che <code>npm audit</code> li veda, ma GitLab gemnasium non ha quel campo nel proprio schema. Ritira un advisory riscrivendo il record: il titolo diventa «False Positive», «Withdrawn Advisory: …» o «Duplicate Advisory: …», mentre le versioni che indicava restano al loro posto. Sentinello leggeva quelle versioni e segnalava risultati che GitLab aveva esplicitamente ritirato: 383 record tra JavaScript, Python, Go e Rust, incluso uno che segnalava <code>express</code> con il titolo «False Positive». Ora vengono tutti scartati, il che elimina anche un’intera classe di risultati duplicati, dato che 278 dei 383 sono advisory ritirati perché duplicati di un altro',
                'Il controllo confronta i marcatori di ritiro in modo esatto anziché cercare le parole ovunque, così un advisory autentico che parla *di* un falso positivo continua a essere segnalato: il CVE-2026-39395 di Cosign, intitolato «Cosign’s verify-blob-attestation reports false positive when payload parsing fails», non è interessato',
                'La cache di gemnasium si ricostruisce da sola alla prima sincronizzazione dopo questo aggiornamento e gli advisory ritirati spariscono. Non c’è nulla da fare: avviene con la sincronizzazione quotidiana, o subito da Impostazioni → Sorgenti → Aggiorna'
            ]
        },
        '3.1.1': {
            title: 'Gli intervalli di versione degli advisory sono corretti in entrambe le direzioni',
            items: [
                'Alcuni advisory di GitLab gemnasium non contengono alcun intervallo di versioni leggibile dalla macchina — 698 dei 10.777 per JavaScript. Sentinello colmava quel vuoto assumendo che tutte le versioni precedenti alla prima correzione elencata fossero interessate, ma quell’elenco non è ordinato e contiene una correzione per ramo di rilascio, così l’ipotesi finiva spesso sul ramo sbagliato. protobufjs 7.6.5 veniva segnalato come esecuzione di codice remoto critica benché quel ramo fosse stato corretto in 7.5.5, e tre advisory distinti sostenevano ciascuno che ogni versione di vite inferiore a 8.0.5 fosse vulnerabile. Sentinello non inventa più intervalli: recupera quello reale dallo stesso advisory pubblicato con l’altro identificatore, dalla descrizione dell’advisory stesso oppure — solo se hai OSV attivo — dalla copia di OSV già presente sulla tua macchina, e scarta il record anziché tirare a indovinare quando nessuna di queste vie risponde. Aspettati che alcuni critici spariscano',
                'OSV descrive un advisory corretto su più rami di rilascio come una voce separata per ciascun ramo, e Sentinello teneva la prima scartando le altre — 1.927 intervalli di versioni vulnerabili per il solo JavaScript, ognuno una vulnerabilità reale diventata invisibile. L’advisory di minimatch copre otto rami e ne sopravviveva uno solo, così un minimatch 3.0.4 o 9.0.0 installato non veniva segnalato; next e ua-parser-js perdevano rami allo stesso modo. Ora vengono mantenuti tutti. Aspettati la comparsa di nuovi risultati: quelle vulnerabilità c’erano da sempre, erano solo invisibili',
                'Entrambe le cache degli advisory si ricostruiscono da sole alla prima sincronizzazione dopo questo aggiornamento, perché gli intervalli che contengono sono stati prodotti dal codice precedente. Non c’è nulla da fare: avviene con la sincronizzazione quotidiana, o subito da Impostazioni → Sorgenti → Aggiorna se preferisci non aspettare'
            ]
        },
        '3.1.0': {
            title: 'I risultati silenziati si tolgono di mezzo, e il database smette di crescere all’infinito',
            items: [
                'Un risultato silenziato è una decisione che hai già preso, quindi ora sparisce del tutto dalla pagina del progetto invece di restare lì in grigio. Non è solo ordine: ogni numero della pagina — il conteggio nel titolo, i badge di entrambe le schede, la paginazione, i totali per libreria, il pulsante di esportazione — viene calcolato dalle stesse righe, così la pagina finalmente concorda con la dashboard, con gli strumenti MCP e con l’esportazione degli advisory, che già escludevano i risultati silenziati. Un interruttore «Mostra silenziati» li riporta quando ti servono, anche su un progetto i cui risultati sono *tutti* silenziati',
                'Digitare in una finestra di dialogo non fa più perdere il focus dopo un solo carattere. Quel difetto rendeva di fatto impossibile compilare il campo Motivo della finestra di silenziamento — obbligatorio, e l’unica cosa che rende un silenziamento verificabile mesi dopo. La stessa finestra ha inoltre smesso di ereditare l’allineamento della riga di tabella da cui veniva aperta: è il motivo per cui silenziare un risultato dava una finestra allineata a destra mentre silenziare un progetto no',
                'La cronologia delle scansioni non cresce più senza fine. Niente aveva mai eliminato una riga di scansione in base all’età, quindi un progetto rimasto su disco accumulava una riga per fonte a ogni passaggio, all’infinito — un’istanza reale ha raggiunto 2,2 GB in meno di tre mesi. Impostazioni → Avanzate ora offre un periodo di conservazione, 90 giorni per impostazione predefinita, e il worker ripulisce ogni ora ciò che lo supera, mantenendo sempre le 100 scansioni più recenti di ogni progetto. Risultati, silenziamenti e cronologia delle notifiche non vengono mai toccati; solo il registro delle scansioni. A 90 giorni un’istanza che si aggiorna non cancella nulla al primo passaggio: la pulizia inizia solo quando la cronologia supera davvero quel periodo, o quando sei tu ad abbassarlo',
                'Gran parte di quella crescita era l’output grezzo di `npm audit`, salvato per intero a ogni scansione riuscita e letto da nulla — il 98,7% del database di quell’istanza. Le scansioni ora registrano un breve riepilogo, portando una riga da circa 79 KB a un centinaio di byte, con un tetto massimo perché nessuno scanner possa ripetere la cosa',
                'Su MCP, `get_dashboard_summary` ora dichiara che un progetto che hai silenziato esce dai suoi totali mentre `list_projects` continua a restituirlo. I due contano popolazioni diverse di proposito, e un agente che li confrontava lo leggeva come un difetto. Anche `list_scans` ha smesso di restituire l’output grezzo dello scanner per ogni scansione, che in una sola risposta poteva raggiungere circa 16 MB'
            ]
        },
        '3.0.1': {
            title: 'Il download di gemnasium funziona di nuovo — e la CLI restituisce il terminale',
            items: [
                'Il download di GitLab gemnasium falliva nella 3.0.0 con `HTTP 406`, per tutti. Il fetch integrato di Node aggiunge un header `Sec-Fetch-Mode: cors` che un programma non può rimuovere, e GitLab rifiuta qualsiasi richiesta di archivio del repository che lo contenga — quindi non è mai dipeso dalla vostra rete, dal vostro IP o da quanti tentativi avete fatto. Ora il download usa una normale richiesta HTTPS e riesce',
                'L’archivio viene scaricato per id di commit anziché per nome del branch, così chi aggiorna dallo stesso commit condivide una copia in cache invece di chiedere a GitLab di generare un archivio da 60 MB ciascuno. Un primo download che richiedeva quasi sette minuti ora finisce in pochi secondi',
                'La CLI completava tutto il lavoro — report scritto, riepilogo stampato — e poi non restituiva mai il terminale. La connessione del download restava aperta dietro di essa, tenendo vivo il processo; ora viene chiusa non appena l’archivio è stato letto',
                'Una sorgente che rifiuta un download non resta più ferma tre minuti prima di dirlo. Lo segnala in pochi secondi e, in un terminale, propone di riprovare — ritentando solo la sorgente che ha davvero fallito',
                '`--fail-on` è onesto in entrambe le direzioni. Rifiuta un’esecuzione la cui sorgente di avvisi non è stata consultabile, invece di riportare una scansione pulita mai eseguita; e non fa più fallire un’esecuzione per una sorgente che avete disattivato voi con `SENTINELLO_OSV_FEED_URL=off` o `SENTINELLO_GEMNASIUM_FEED_URL=off` e mai scaricato'
            ]
        },
        '3.0.0': {
            title: 'Sentinello ora funziona anche senza portale',
            items: [
                'Gli scanner arrivano come CLI su npm. `npx sentinello` attraversa una cartella, trova ogni progetto al suo interno, li confronta con npm audit, OSV e GitLab gemnasium, e scrive un advisory markdown con un prompt di remediation allegato — nessuna installazione, nessun account, nessun database, e nulla del tuo codice lascia la macchina',
                'In pipe, l’advisory è l’unica cosa su stdout, così `npx sentinello | claude -p "$(cat -)"` consegna a un agente un elenco di lavoro completo senza che nulla corrompa il documento',
                'Una prima esecuzione non perde più la fonte gemnasium per un download rifiutato. GitLab rifiuta il suo archivio per uno o due minuti alla volta, e il vecchio retry si arrendeva dopo tredici secondi; ora la CLI aspetta che passi, spiega perché sta aspettando, e accetta `--feed-wait` se i tre minuti predefiniti non vanno bene',
                'Entrambe le stime di download sono state misurate anziché ipotizzate: l’export npm di OSV è indicato a 204 MB invece di 196, e l’archivio gemnasium a 52 MB invece di 80. Il prompt di consenso segna una stima con una tilde perché non venga mai scambiata per una dimensione dichiarata dal server',
                'Un valore che sembra un’opzione ora viene rifiutato invece di essere preso alla lettera — `--out --` scriveva un advisory in un file chiamato `--` dentro il tuo progetto e riportava successo',
                'Il pannello Novità non esce più dal fondo della finestra quando una release ha molto da dire'
            ]
        },
        '2.6.0': {
            title: 'Il documento degli avvisi arriva davvero — e conta ciò che serve',
            items: [
                'get_project_advisory ora restituisce il documento vero e proprio. Finora i client collegati ricevevano solo i suoi metadati — un nome file e un conteggio — e mai il documento, benché lo strumento lo descrivesse come un elenco di lavoro completo',
                'L’export degli avvisi contiene ora una voce per ogni avviso distinto, con le fonti unite, invece di una per riga dello scanner: una vulnerabilità segnalata sia da npm audit sia da OSV è un unico elemento di lavoro con entrambi gli identificativi, non due quasi identici. Vale anche per il pulsante Scarica .md del portale, e il conteggio ora coincide con quello della dashboard',
                'Un progetto troppo grande per stare in una sola risposta MCP viene ora paginato: il documento dichiara di essere incompleto e indica la chiamata esatta per ottenere il resto, invece di essere troncato in silenzio dove un agente leggerebbe il resto come pulito',
                'Ogni parametro di ogni strumento MCP ha ora una descrizione, e il nuovo strumento list_mutes espone gli identificativi di silenziamento richiesti da unmute — prima ottenibili solo creando il silenziamento nella stessa sessione',
                'Corretta una falla nei conteggi di gravità: un rilevamento la cui gravità non era uno dei cinque valori noti veniva contato ma non finiva in alcuna categoria, così un progetto con quel solo rilevamento appariva completamente pulito'
            ]
        },
        '2.5.0': {
            title: 'L’export degli avvisi, direttamente via MCP',
            items: [
                'I client MCP collegati possono scaricare l’avviso Markdown completo di un progetto con il nuovo strumento get_project_advisory — lo stesso documento del pulsante Scarica .md del portale, senza copiarlo dal browser',
                'I risultati silenziati non sono più inclusi nell’export degli avvisi del progetto, quindi a un agente non viene mai affidato un lavoro il cui rischio hai già accettato',
                'Nota: poiché l’avviso contiene il tuo prompt di export, un client MCP può ora leggere ciò che hai scritto in Impostazioni → Export'
            ]
        },
        '2.4.3': {
            title: 'Popup non più tagliati e un prompt di esportazione più severo',
            items: [
                'I menu a discesa, il popover del percorso delle dipendenze e il menu di esportazione degli avvisi non vengono più tagliati dalla tabella o dalla finestra di dialogo che li contiene: sono disegnati sopra la pagina e si aprono verso l’alto quando sotto non c’è spazio',
                'Il prompt predefinito di esportazione degli avvisi ora chiede all’agente di pianificare prima di modificare qualsiasi cosa, di raggruppare i risultati che condividono la stessa correzione e di descrivere l’impatto sul codice di ogni cambio di versione; punta a zero risultati escludendo le scorciatoie verso uno zero fittizio — silenziare, allargare gli intervalli o restringere l’ambito dell’analisi — e lascia ciò che è davvero irrisolvibile in una tabella dei residui con data'
            ]
        },
        '2.4.2': {
            title: 'Il branch in una colonna dedicata',
            items: [
                'Il branch git su cui è stato analizzato un progetto ha ora una colonna dedicata nell’elenco dei progetti — testo semplice, senza icona — invece di comparire sotto il nome del progetto'
            ]
        },
        '2.4.1': {
            title: 'Arresti puliti',
            items: [
                'Riavviare il container non interrompe più un’analisi a metà scrittura e il worker parte subito invece di riprovare per ~30 secondi',
                'Imposta stop_grace_period: 60s (o --stop-timeout 60) nel tuo file compose per dargli spazio: il README e la documentazione Docker ora lo spiegano'
            ]
        },
        '2.4.0': {
            title: 'Analisi poliglotta — Python, Go e Rust si aggiungono a npm',
            items: [
                'Sentinello ora analizza progetti Python, Go e Rust oltre a npm — i lockfile sono risolti interamente offline e ogni progetto dichiara la propria copertura di analisi (completa, parziale o non verificabile), così le lacune sono visibili invece che silenziose',
                'Il database gemnasium di GitLab si affianca a npm audit e OSV come sorgente di avvisi offline, deduplicata rispetto alle altre tramite alias CVE/GHSA; Impostazioni → Sorgenti è ora una matrice Linguaggi × Sorgenti con ambito di notifica per cella, e npm audit stesso può essere disattivato purché resti attiva una sorgente',
                'I risultati registrano ora il branch git da cui provengono, mostrato nell’elenco dei progetti, nell’intestazione del progetto e in ogni notifica',
                'Le righe dei progetti hanno azioni proprie — analizza ora, copia o scarica l’avviso, silenzia o riattiva e modifica i tag — così un giro di triage non richiede più di entrare in ogni progetto',
                'La dashboard dei progetti è passata da ~3,3 s a ~0,03 s e la navigazione mostra ora stati di caricamento invece di sembrare bloccata',
                'Sicurezza: risolti 25 avvisi sulle dipendenze, inclusi CVE di libvips attivi nell’ottimizzatore di immagini del portale e nove avvisi Next.js che riguardavano il portale distribuito',
                'Il prompt predefinito di esportazione degli avvisi copre ora l’età minima di pubblicazione, la verifica del lockfile e gli override obsoleti'
            ]
        },
        '2.3.0': {
            title: 'Configurazione MCP più semplice, senza variabili d’ambiente',
            items: [
                'Configura MCP interamente in Impostazioni → MCP: genera un token per attivare l’endpoint /api/mcp, cancellalo per disattivarlo — le variabili d’ambiente SENTINELLO_MCP_ENABLED e SENTINELLO_MCP_API_TOKEN non esistono più (un token d’ambiente esistente viene importato una volta durante l’aggiornamento)',
                'Frammenti di connessione pronti da incollare per Claude Code, Codex, Cursor e Claude Desktop, già compilati con il tuo token',
                'Quando SENTINELLO_PORTAL_BASE_URL è impostata nell’ambiente, viene mostrata in sola lettura in Impostazioni → Avanzate, poiché resta autoritativa e viene riapplicata a ogni avvio'
            ]
        },
        '2.2.0': {
            title: 'Meno falsi allarmi e risultati che si ripuliscono da soli',
            items: [
                'Gli avvisi di malware ora corrispondono alla versione compromessa esatta — una versione pulita o già corretta di un pacchetto un tempo compromesso non viene più segnalata',
                'I risultati duplicati ora si risolvono da soli alla scansione successiva, così le voci vecchie o orfane vengono eliminate automaticamente',
                'Le etichette di produzione e sviluppo ora vengono calcolate in un unico modo coerente su tutte le sorgenti (npm e OSV)'
            ]
        },
        '2.1.0': {
            title: 'Un’intestazione di progetto più pulita e filtri coerenti',
            items: [
                'Intestazione di progetto semplificata — rinomina accanto al titolo, con silenzia e tag come icone',
                'Filtra i risultati per fonte (npm / OSV) da un nuovo menu a discesa accanto al filtro per tipo di dipendenza',
                'Menu a discesa unificati e coerenti in tutta l’app, con ricerca durante la digitazione per elenchi lunghi come i fusi orari'
            ]
        },
        '2.0.1': {
            title: 'Indicazioni di aggiornamento più chiare',
            items: [
                'Passaggi di aggiornamento ampliati per le modifiche incompatibili della 2.0',
                'Il README segnala il binding della porta solo su localhost'
            ]
        },
        '2.0.0': {
            title: 'Scansione multi-sorgente e un’installazione rafforzata e sicura per impostazione predefinita',
            items: [
                'OSV come seconda sorgente opzionale (Impostazioni → Fonti, disattivata per impostazione predefinita) con rilevamento di pacchetti dannosi, confrontata con il database pubblico OSV in una cache locale',
                'I risultati ora vengono uniti tra le sorgenti — una riga per vulnerabilità, ogni sorgente etichettata, la migliore correzione disponibile e l’unione dei percorsi di dipendenza, con un filtro per sorgente e un popover del percorso di dipendenza',
                'Rafforzamento della sicurezza: l’endpoint MCP è disattivato per impostazione predefinita e richiede un token, la consegna dei webhook è protetta da SSRF, un gate di accesso opzionale al portale, e il contenitore viene eseguito come utente senza privilegi',
                'Impostazioni è ora una sezione di primo livello con barra laterale e una pagina Profilo'
            ]
        },
        '1.4.0': {
            title: 'Integrazione MCP e novità',
            items: [
                'Server MCP su /api/mcp per Claude Desktop, Cursor e altri client',
                'Nuova sezione Impostazioni → MCP con URL del server e gestione dei token',
                'Badge delle novità e una cronologia delle note di rilascio'
            ]
        },
        '1.3.1': {
            title: 'Correzione della versione nel piè di pagina',
            items: ['La versione in esecuzione viene mostrata correttamente nel piè di pagina']
        },
        '1.3.0': {
            title: 'Miglioramenti alle notifiche',
            items: [
                'Filtra le notifiche per ambiente',
                'Modulo di modifica delle destinazioni più semplice',
                'Duplica una destinazione di notifica esistente'
            ]
        },
        '1.2.0': {
            title: 'Pagine Progetti e Librerie',
            items: ['La schermata iniziale è divisa in pagine dedicate Progetti e Librerie']
        },
        '1.1.2': {
            title: 'Ricaricamento della pianificazione in tempo reale',
            items: ['Il worker ricarica la pianificazione della scansione non appena salvi le modifiche nel portale']
        },
        '1.1.0': {
            title: 'Eliminazioni più sicure e un avviso di aggiornamento più chiaro',
            items: [
                'Conferma prima di eliminare radici e destinazioni di notifica',
                'L’avviso di aggiornamento diventa un banner superiore richiudibile',
                'Il worker rimuove le radici obsolete quando il loro mount scompare'
            ]
        },
        '1.0.1': {
            title: 'Correzioni di precisione dello scanner',
            items: [
                'Scarta i risultati la cui versione installata non è realmente nell’intervallo vulnerabile',
                'Consente di eliminare una destinazione di notifica con cronologia di invio'
            ]
        },
        '1.0.0': { title: 'Prima versione open source', items: ['La prima versione pubblica di Sentinello'] }
    },
    ja: {
        '3.3.1': {
            title: '3.3.0 と同じリリース、ただしビルドできる Docker イメージ付き',
            items: [
                '3.3.0 は npm と GitHub には公開されましたが、コンテナイメージのビルドに失敗したため、リリース時点では GHCR にも Docker Hub にも 3.3.0 がありませんでした。Dockerfile はインストールするワークスペースパッケージを 1 つずつ列挙しますが、そのうちバージョン比較のパッケージだけが最初から記載されていませんでした。今回のリリースまでイメージ内の何もそれを import していなかったため、この欠落は一度も表面化しませんでした。その後、3.3.0 自身のアプリケーションコードから修正済みの 3.3.0 イメージを公開したので、<code>docker pull sentinello:3.3.0</code> は再び動作します。3.3.1 は同じ修正をソースツリーに取り込んだものです。CLI を使っている場合は 3.3.0 のままで問題ありません。'
            ]
        },
        '3.3.0': {
            title: '本当に動くエコシステムだけを — そして信頼できる通知',
            items: [
                '通知が空のまま届くことがありました。あるオペレーターは、プロジェクトに脆弱性があると告げながら一件も列挙していない Telegram メッセージを受け取りました。配信はプロジェクト単位で絞り込まれる一方、実行はスキャナーごとだったため、npm audit のパスは OSV の未配信イベントを 2 件渡され、どれとも一致しないまま見出しだけを空のリストの上に描画していました。さらに両イベントを配信済みとして記録したため、一度も言及されなかった 2 件の検出結果が通知済みとして扱われ、配信済みイベントは二度と見直されません。今は説明できるイベントだけを配信し、説明できないものは保留のまま次回スキャンで再検討されます',
                '検出結果は、いずれかのソースが付けた最も重い評価で報告されます。このエスカレーションはダッシュボード、プロジェクト合計、CLI の <code>--fail-on</code> ゲートには届いていましたが、通知のしきい値には届いていませんでした。通知が裏付け処理より前に走るため、イベントには生き残ったソース自身の評価が刻まれ、その後書き換えられることがなかったのです。実際のインスタンスでは、135 件の未解決の検出結果が本来より低いイベント重大度を持ち、<strong>うち 41 件は critical を low・high・moderate として記録</strong>していました。critical と high に絞った通知先は、そのどれについても永久に呼び出されなかったことになります',
                'スケジュールされたスキャンが日をまたがずに深夜で止まっていました。「07:00 から 3 時間ごと」は 07、10、13、16、19、22 時に実行され、その後は翌日の 07:00 まで動かず — 1 日 8 回のはずが 6 回、毎晩 9 時間の空白ができていました。その間も設定画面は選んだ間隔をそのまま表示し続けます。「20:00 から 6 時間ごと」に至っては 1 日 1 回でした。時刻枠は日付をまたいで続くようになりました',
                '<strong>Python、Go、Rust を取り下げました。</strong> 粗さへの慎重さではありません。これらの不具合は「問題なし」として報告されていました。修正版の導出とバージョン順序が semver 専用のため、OSV の Django アドバイザリはインストール済みの 4.2 に対して「3.2.23 へ更新」を勧めていました。OSV の PyPI パッケージ名は PEP 503 で正規化されておらず、リゾルバ側の名前と決して一致しません。gemnasium の範囲パーサーは PEP 440 のカンマ交差を読めません。誤った理由で「脆弱性なし」と答えるソースは、そもそも提供しないソースより有害です。したがって製品面から完全に取り除きました — スイッチも、検出も、ダウンロードもありません。<strong>すでに収集済みの検出結果は引き続き表示・ミュートでき、何も削除されません。</strong> npm エコシステムの表示名は <strong>Node.js</strong> になりました。言語ではなく、実際にスキャンしているパッケージエコシステムを指す名前です',
                '<strong>設定 → ソース</strong> をこれに合わせて作り直しました。以前は各ソースが自分のスイッチの隣で同じ説明を繰り返し、キャッシュを持つソースはそれぞれ 5 行のステータスパネルとフルサイズの「今すぐ更新」ボタンを抱えていました — そのボタンは何度現れてもソースごとに 1 つの共有シグナルを積むだけなのにです。スイッチはソースが有効かどうかだけを示すようになり、各ソースが何を追加し、何をどこからダウンロードし、いつ動くのかは下の 1 つの参照表に移りました。同期状態は 1 行に収まっています',
                'npm 自身のロックファイルが本番から到達可能だと述べているパッケージが、開発専用に降格されていました。ロックファイルに <code>dev: true</code> がないことは、そのパッケージが本番から到達可能だという npm の主張であり、ルートのマニフェストより強い言明です。ところがリゾルバは、名前が <code>devDependencies</code> にも現れるたびにそれを上書きしていました — まさに npm が正しい場面です。実際の 130 プロジェクトで計測したところ、97 プロジェクトで 142 個のパッケージが降格されていました（lodash、semver、postcss、tailwindcss、@babel/runtime）。あるインスタンスでは未解決の検出結果 7 件が本番のみのフィルタから隠れていました',
                '<code>0.0.0-20180523222229-09b5706aa936</code> のようなバージョンに固定されたパッケージは、<strong>どのアドバイザリにも一致しません</strong>でした。上限のないものにさえ一致せず、スキャンは検出 0 件で ok と報告していました。アドバイザリの下限 <code>introduced: 0</code> がリリース 0.0.0 として比較され、semver ではプレリリースがリリースより下に並ぶためです。実際のキャッシュにある比較可能な 19,085 個の範囲のうち 330 個が、何も満たせない区間として保存されていました',
                '中断された OSV 同期がアドバイザリを永久に消すことがありました。増分パスはアドバイザリの行を削除してから置き換えを try/catch の中で取得していたため、タイムアウト・5xx・シャットダウンのいずれでも丸ごと消えてしまい、そのうえカーソルは無条件に進んで ID を永久に後方へ置き去りにしていました。損失は無言で、次のフル再シードまで残り、しかも成功と報告された同期の中で起きます。<code>npx sentinello</code> のキャッシュも不安定な実行のたびに同じように削られていました。どちらも先に取得し、後で置き換えるようになりました',
                'CLI の <code>--dep-type dev</code> は「dev から到達可能であればよい」を意味していましたが、ポータルは「dev <em>だけ</em>から到達可能」を意味します。そのため両方から到達できるパッケージは一方のビューに現れ、もう一方には現れませんでした — あるインスタンスでは 2 つの解釈で 177 件の未解決の検出結果が食い違います。CLI はポータルの規則を使うようになり、OSV の <code>withdrawn</code> フィールドも尊重します。以前は構造上それを読めませんでした。実際の npm キャッシュでは 585 行がこの値を持ち、そのすべてが有効な検出結果として報告されていました',
                '脆弱性がある版<em>より後</em>から始まると述べる gemnasium のアドバイザリ、つまり <code>&gt;=1.2.8</code> ではなく <code>&gt;1.2.8</code> が、境界の版そのものも影響を受けるかのように読まれていました。2021 年の <code>rc</code> パッケージ乗っ取りはまさにこの書き方で、1.2.8 は最後のクリーンなリリース、つまりアドバイザリ自身の対処方法が「留まれ」と指示している版です。<code>rc</code> を導入しているすべてのプロジェクトに、修正版なしの重大なマルウェア検出が、一度も侵害されていない版に対して表示されていました。境界はアドバイザリの記述どおりに保持されるようになり、この形の誤検出は消えます',
                '同じ丸めは逆方向にも働き、本物の検出を隠していました。<code>&lt;=2.0.0</code> で区切られたアドバイザリは「2.0.0 未満」として保存されていたため、最も明示的に指し示されている 2.0.0 が報告されず、影響を受ける版をちょうど一つだけ挙げるアドバイザリは空の範囲になって丸ごと破棄されていました。以前から存在していたのに見えていなかった検出がいくつか新たに現れます',
                'Sentinello が実装していない構文で書かれた範囲、たとえば <code>^1.0.0</code> や <code>~1.0.0</code> は、その文字列そのものを厳密な版として保存していたため、キャッシュに残っている限り何にも一致できませんでした。有効に見えて決して発火しないアドバイザリです。こうしたレコードは、機能しない形で保存する代わりに拒否するようになりました。また、上限に明確な修正版を持たないアドバイザリにも、ようやくアップグレードの提案が出ます',
                'Webhook URL やボットトークンをログ行に届く前にマスクするヘルパーが、短いものをそのまま出力していました。6 文字以下の値は拒否する一方で、先頭 8 文字と末尾 4 文字を残しており、その 2 つが重ならないことを誰も確認していなかったのです — つまり 7〜12 文字の秘密情報はすべて丸ごと返っていました。今は少なくとも 8 文字を隠すか、値を完全に伏せます'
            ]
        },
        '3.2.0': {
            title: '検出結果にどのソースが一致したかを表示し、撤回済みアドバイザリの報告を停止しました',
            items: [
                '複数のアドバイザリデータベースが同じ脆弱性を報告する場合、Sentinello は常に検出結果を 1 件にまとめてきました。3 つのデータベースが知っているからといって同じ欠陥を 3 回報告するのはノイズだからです。しかし従来は統合されたソースの情報をすべて破棄していたため、npm audit・OSV・GitLab gemnasium が独立に確認した脆弱性が、1 つのデータベースしか報告していないものとまったく同じに見えていました。実際のインスタンスではこれが全検出結果の 3 分の 2 にあたります。今後は各検出結果がそれを報告した他のソースを保持し、残った 1 件のバッジと並べて表示します',
                '検出結果は、いずれかのソースが付けた最も高い深刻度で報告されます。データベース間の評価は実際に食い違います（gemnasium は CVSS ベクトルから算出し、npm audit は GitHub の区分を採用します）。スキャナーにとっては慎重な読み方こそ行動の基準です。これは見た目だけの変更ではありません。引き上げられた検出結果は、ダッシュボード、プロジェクト合計、CLI の <code>--fail-on</code> ゲート、通知しきい値のいずれでも区分が変わります。アップグレード後の最初のスキャンで件数が動くことがありますが、新たに検出されたものはなく、同じ検出結果をより慎重に評価しているだけです',
                'ソース間で評価が分かれている場合、検出結果の深刻度の横に、各ソースが実際に何と述べたか（そのソース独自のアドバイザリ ID と評価）を開くコントロールが表示されます。説明すべき不一致があるときだけ表示されるため、全ソースの評価が一致する検出結果は簡潔なままです',
                'OSV は撤回を専用のフィールドに記録し、GitHub は撤回されたアドバイザリを <code>npm audit</code> に届く前に取り除きますが、GitLab gemnasium のスキーマにはそのようなフィールドがありません。gemnasium はレコードを書き換えることで撤回します。タイトルが「False Positive」「Withdrawn Advisory: …」「Duplicate Advisory: …」に変わる一方で、それまで挙げていたバージョンはそのまま残ります。Sentinello はそのバージョンを読み取り、GitLab が明確に取り下げた検出結果を報告していました。JavaScript・Python・Go・Rust を通じて 383 件のレコードが該当し、その中には「False Positive」というタイトルで <code>express</code> を報告するものもありました。これらはすべて破棄されます。383 件のうち 278 件は他のアドバイザリと重複するため撤回されたものなので、重複した検出結果の一群も同時に解消されます',
                'この判定は撤回マーカーを完全一致で照合し、語句を本文中から探すことはしません。そのため、偽陽性そのものを扱う正当なアドバイザリは引き続き報告されます。「Cosign’s verify-blob-attestation reports false positive when payload parsing fails」という題の Cosign の CVE-2026-39395 は影響を受けません',
                'gemnasium のキャッシュはこのアップグレード後の最初の同期で自動的に再構築され、その時点で撤回済みアドバイザリは消えます。操作は不要で、毎日の同期で実行されます。「設定 → ソース → 更新」からすぐに実行することもできます'
            ]
        },
        '3.1.1': {
            title: 'アドバイザリのバージョン範囲が両方向で正しくなりました',
            items: [
                'GitLab gemnasium のアドバイザリの中には、機械可読なバージョン範囲をまったく持たないものがあります（JavaScript では 10,777 件中 698 件）。Sentinello はその空白を「列挙された最初の修正版より前のすべてが影響を受ける」と仮定して埋めていましたが、この一覧は順不同でリリースブランチごとに 1 つの修正版を含むため、その推測はしばしば誤ったブランチを指していました。protobufjs 7.6.5 は当該ブランチが 7.5.5 で修正済みであるにもかかわらず重大なリモートコード実行として報告され、3 件の別々のアドバイザリがそれぞれ 8.0.5 未満のすべての vite を脆弱だと主張していました。Sentinello はもう範囲を捏造しません。別の識別子で公開された同一のアドバイザリ、アドバイザリ自身の説明文、または OSV を有効にしている場合に限りお使いのマシン上にある OSV のコピーから本来の範囲を復元し、いずれでも判明しない場合は推測せずにそのレコードを破棄します。いくつかの重大な検出結果が消えるはずです',
                'OSV は複数のリリースブランチで修正されたアドバイザリを、ブランチごとに個別のエントリとして記述します。Sentinello は最初の 1 件だけを残して他を破棄していました。JavaScript だけで 1,927 件の脆弱なバージョン範囲が失われ、そのすべてが見えなくなった実際の脆弱性です。minimatch のアドバイザリは 8 つのブランチを対象としますが 1 つしか残らず、インストール済みの minimatch 3.0.4 や 9.0.0 は報告されませんでした。next や ua-parser-js も同様にブランチを失っていました。現在はすべてのブランチが保持されます。新しい検出結果が現れるはずですが、それらの脆弱性は以前から存在しており、単に見えていなかっただけです',
                'このアップグレード後の最初の同期で、2 つのアドバイザリキャッシュはいずれも自動的に再構築されます。保持されている範囲が以前のコードで生成されたものだからです。操作は不要で、毎日の同期で実行されます。待ちたくない場合は「設定 → ソース → 更新」からすぐに実行できます'
            ]
        },
        '3.1.0': {
            title: 'ミュートした検出結果は視界から外れ、データベースは無限には増えなくなりました',
            items: [
                'ミュートした検出結果は、すでにあなたが下した判断です。そのためグレー表示で残るのではなく、プロジェクトページから完全に外れるようになりました。見た目が整うだけではありません。見出しの件数、両方のタブのバッジ、ページ送り、ライブラリごとの合計、エクスポートボタン — ページ上のあらゆる数値が同じ行から算出されるため、ダッシュボード、MCP ツール、アドバイザリのエクスポート（いずれも以前からミュート分を除外していました）とページの数字がようやく一致します。「ミュート済みを表示」を切り替えればいつでも戻せます。検出結果が*すべて*ミュートされているプロジェクトでも同様です',
                'ダイアログでの入力が、1文字でフォーカスを失うことはなくなりました。この不具合により、ミュートダイアログの「理由」欄 — 入力必須で、数か月後にミュートの妥当性を確認できる唯一の手がかり — が事実上入力不能になっていました。同じダイアログが、開いた元のテーブル行の配置を引き継ぐこともなくなりました。検出結果のミュートでは右寄せのダイアログになるのに、プロジェクトのミュートではならなかったのはこれが原因です',
                'スキャン履歴が際限なく増えることはなくなりました。これまで古さを理由にスキャン行が削除されたことは一度もなく、ディスク上に残るプロジェクトはスイープごとにソース単位で行を無制限に積み上げていました — 実際の環境では3か月足らずで 2.2 GB に達しました。「設定 → 詳細設定」に保持期間（既定は90日）が追加され、ワーカーが毎時それより古いものを削除します。各プロジェクトの最新100件は常に保持されます。検出結果、ミュート、通知履歴が削除されることはありません。対象はスキャンログだけです。90日という既定値なら、アップデートした環境が初回実行で何かを削除することはありません。履歴が実際にその期間を超えたとき、またはご自身で短くしたときに初めて削除が始まります',
                'その増加の大半は `npm audit` の生出力でした。成功したスキャンごとにそのまま保存されながら、どこからも読まれていません — その環境のデータベースの 98.7% がこれでした。現在は短い要約だけを記録するため、1行あたり約 79 KB から 100 バイト程度になります。上限も設けたので、どのスキャナーも同じことを繰り返せません',
                'MCP では、ミュートしたプロジェクトが `get_dashboard_summary` の集計から外れる一方で `list_projects` は引き続き返すことを明記しました。両者は意図的に異なる母集団を数えており、それを比較したエージェントが不具合と受け取っていました。`list_scans` も各スキャンのスキャナー生出力を返さなくなりました。1回の応答で 16 MB 前後に達することがあったためです'
            ]
        },
        '3.0.1': {
            title: 'gemnasium のダウンロードが復旧し、CLI がターミナルを返すようになりました',
            items: [
                '3.0.0 では GitLab gemnasium のダウンロードが全ユーザーで `HTTP 406` により失敗していました。Node 組み込みの fetch はプログラムから削除できない `Sec-Fetch-Mode: cors` ヘッダーを付与し、GitLab はそれを含むリポジトリアーカイブ要求をすべて拒否します。つまりネットワークや IP、再試行回数とは無関係でした。ダウンロードは通常の HTTPS 要求を使うようになり、成功します',
                'アーカイブはブランチ名ではなくコミット ID で取得するようになりました。同じ上流コミットから更新する全員がキャッシュされた 1 つのコピーを共有するため、各自が GitLab に 60 MB のアーカイブを生成させる必要がありません。7 分近くかかっていた初回ダウンロードが数秒で完了します',
                'CLI は処理をすべて終えても — レポートを書き、サマリーを表示しても — ターミナルを返しませんでした。ダウンロードの接続が背後で開いたままプロセスを生かしていたためです。アーカイブを読み終えた時点で閉じるようになりました',
                'ダウンロードを拒否されたソースが、報告するまで 3 分間止まることはなくなりました。数秒で報告し、ターミナルでは再試行を提案します。再試行するのは実際に失敗したソースだけです',
                '`--fail-on` は双方向で正直になりました。アドバイザリソースを参照できなかった実行は、実施していないクリーンなスキャンとして報告せず拒否します。また `SENTINELLO_OSV_FEED_URL=off` や `SENTINELLO_GEMNASIUM_FEED_URL=off` で自分が無効にし一度もダウンロードしていないソースを理由に失敗することはなくなりました'
            ]
        },
        '3.0.0': {
            title: 'Sentinello はポータルなしでも動くようになりました',
            items: [
                'スキャナーが npm 上の CLI として提供されます。`npx sentinello` はフォルダーを走査して配下のすべてのプロジェクトを見つけ、npm audit・OSV・GitLab gemnasium と照合し、修正プロンプトを添えた markdown のアドバイザリを書き出します。インストール不要、アカウント不要、データベース不要で、コードがマシンの外に出ることもありません',
                'パイプで渡すと stdout にはアドバイザリだけが流れるため、`npx sentinello | claude -p "$(cat -)"` は文書を壊すことなく完全な作業リストをエージェントに渡せます',
                '初回実行でダウンロードを拒否されて gemnasium ソースを失うことがなくなりました。GitLab はアーカイブを 1〜2 分ほどまとめて拒否しますが、以前の再試行は 13 秒で諸めていました。CLI は待機して待ち、待っている理由を表示し、既定の 3 分が合わない場合は `--feed-wait` を受け付けます',
                'ダウンロード見積もりはどちらも推測ではなく実測しました。OSV の npm エクスポートは 196 MB ではなく 204 MB、gemnasium のアーカイブは 80 MB ではなく 52 MB と表示します。確認プロンプトは見積もりにチルダを付け、サーバーが報告したサイズと取り違えられないようにしています',
                'オプションのように見える値は、そのまま解釈せず拒否するようになりました。`--out --` は以前、プロジェクト内に `--` という名前のファイルへアドバイザリを書き出し、成功と報告していました',
                'リリースの内容が多いときに「新着情報」パネルがウィンドウ下部からはみ出さなくなりました'
            ]
        },
        '2.6.0': {
            title: 'アドバイザリ文書が実際に届くように — 集計も正確に',
            items: [
                'get_project_advisory が文書そのものを返すようになりました。これまで接続クライアントにはファイル名と件数などのメタデータだけが渡され、完全な作業リストと説明されていたにもかかわらず文書本体は届いていませんでした',
                'アドバイザリの書き出しが、スキャナーの行ごとではなくアドバイザリごとに 1 件へ統合されました。npm audit と OSV の両方が報告する脆弱性は、両方の ID を持つ 1 件の作業項目になります。ポータルの「.md をダウンロード」にも同じ変更が適用され、件数がダッシュボードと一致するようになりました',
                'MCP の 1 回の応答に収まらない大きなプロジェクトはページ分割されます。文書が未完であることを明示し、残りを取得するための正確な呼び出しを示すため、エージェントが残りを「問題なし」と誤読することがありません',
                'すべての MCP ツールのすべての入力に説明が付きました。また、unmute に必要なミュート ID を取得できる list_mutes ツールを追加しました（従来は同じセッションでミュートを作成した場合しか分かりませんでした）',
                '深刻度の集計の抜けを修正しました。既知の 5 段階以外の深刻度を持つ検出は、件数には数えられるのにどの区分にも入らず、その 1 件だけを持つプロジェクトが完全にクリーンに見えていました'
            ]
        },
        '2.5.0': {
            title: 'アドバイザリの書き出しを MCP から直接',
            items: [
                '接続済みの MCP クライアントは、新しい get_project_advisory ツールでプロジェクトの Markdown アドバイザリ全文を取得できます。ポータルの「.md をダウンロード」と同じ文書を、ブラウザからコピーせずに使えます',
                'ミュートした検出結果はプロジェクトのアドバイザリ書き出しに含まれなくなりました。すでにリスクを受け入れた項目がエージェントに渡ることはありません',
                '注意: アドバイザリには書き出しプロンプトが含まれるため、MCP クライアントは設定 → 書き出し に記入した内容を読み取れるようになりました'
            ]
        },
        '2.4.3': {
            title: '切れないポップアップと、より厳格な書き出しプロンプト',
            items: [
                'ドロップダウン、依存パスのポップオーバー、アドバイザリ書き出しメニューが、置かれているテーブルやダイアログに切り取られなくなりました。ページの上に重ねて描画され、下に余裕がない場合は上向きに開きます',
                'アドバイザリ書き出しの既定プロンプトが、何かを編集する前に計画を立てること、同じ修正でまとめて解消できる検出結果をグループ化すること、バージョン変更ごとのコードへの影響を明示することを求めるようになりました。目標はゼロ件ですが、ミュート・バージョン範囲の緩和・スキャン範囲の縮小といった見せかけのゼロへの近道は禁止し、本当に解消できないものは日付入りの残存項目テーブルに残します'
            ]
        },
        '2.4.2': {
            title: 'ブランチを独立した列に',
            items: [
                'プロジェクトをスキャンした git ブランチが、プロジェクト名の下ではなくプロジェクト一覧の独立した列に表示されるようになりました（アイコンなしのテキスト）'
            ]
        },
        '2.4.1': {
            title: 'クリーンな終了',
            items: [
                'コンテナを再起動しても、書き込み途中のスキャンが強制終了されなくなりました。ワーカーは約 30 秒間リトライすることなく、すぐに起動します',
                'compose ファイルに stop_grace_period: 60s（または --stop-timeout 60）を設定して余裕を持たせてください。README と Docker ドキュメントに説明を追加しました'
            ]
        },
        '2.4.0': {
            title: 'ポリグロット解析 — npm に Python・Go・Rust が加わりました',
            items: [
                'Sentinello が npm に加えて Python・Go・Rust のプロジェクトも解析するようになりました。ロックファイルは完全にオフラインで解決され、各プロジェクトが解析カバレッジ（完全・部分的・監査不可）を報告するため、抜け漏れが見えないまま残りません',
                'GitLab の gemnasium データベースが npm audit と OSV に並ぶオフラインのアドバイザリソースとして加わり、CVE/GHSA エイリアスで他ソースと重複排除されます。「設定 → ソース」は「言語 × ソース」のマトリクスになり、セルごとに通知範囲を設定でき、ソースが 1 つ以上有効であれば npm audit 自体も無効にできます',
                '検出結果に、それが得られた git ブランチが記録され、プロジェクト一覧・プロジェクトヘッダー・すべての通知に表示されます',
                'プロジェクトの各行に操作が用意されました。今すぐスキャン、アドバイザリのコピーまたはダウンロード、ミュートと解除、タグ編集ができ、トリアージのたびに各プロジェクトを開く必要がなくなりました',
                'プロジェクトダッシュボードが約 3.3 秒から約 0.03 秒になり、画面遷移では固まったように見える代わりにローディング表示が出るようになりました',
                'セキュリティ: 依存関係のアドバイザリ 25 件を解消しました。ポータルの画像最適化で実際に有効だった libvips の CVE や、配布されるポータルに影響する Next.js の 9 件を含みます',
                'アドバイザリ書き出しの既定プロンプトが、最小公開経過日数・ロックファイルの検証・古い override を扱うようになりました'
            ]
        },
        '2.3.0': {
            title: 'よりシンプルな MCP 設定 — 環境変数は不要',
            items: [
                'MCP の設定はすべて「設定 → MCP」で完結します。トークンを生成すると /api/mcp エンドポイントがオンになり、削除するとオフになります — SENTINELLO_MCP_ENABLED と SENTINELLO_MCP_API_TOKEN の環境変数は廃止されました（既存の環境変数トークンはアップグレード時に一度だけ取り込まれます）',
                'Claude Code、Codex、Cursor、Claude Desktop 向けの貼り付けるだけの接続スニペット。トークンが入力済みです',
                'SENTINELLO_PORTAL_BASE_URL を環境変数で設定している場合、優先され起動のたびに再適用されるため、「設定 → 詳細設定」では読み取り専用で表示されます'
            ]
        },
        '2.2.0': {
            title: '誤検知の低減と、自動で整理される検出結果',
            items: [
                'マルウェアのアドバイザリが、影響を受ける正確なバージョンと照合されるようになりました。かつて侵害されたパッケージでも、クリーンな、または修正済みのバージョンはもう検出されません',
                '重複した検出結果が次回のスキャンで自動的に解決され、古い項目や取り残された項目が自動でクリアされます',
                '本番（production）と開発（development）のラベルが、すべてのソース（npm と OSV）で一貫した単一の方法で算出されるようになりました'
            ]
        },
        '2.1.0': {
            title: 'すっきりしたプロジェクトヘッダーと一貫したフィルター',
            items: [
                'プロジェクトヘッダーを簡素化 — タイトルの横で名前を変更でき、ミュートとタグはアイコンに',
                '依存タイプフィルターの横の新しいドロップダウンから、ソース（npm / OSV）で検出結果を絞り込み',
                'アプリ全体でドロップダウンを統一し、タイムゾーンなどの長いリストでは入力して検索可能に'
            ]
        },
        '2.0.1': {
            title: 'よりわかりやすいアップグレード手順',
            items: [
                '2.0 の破壊的変更に関するアップグレード手順を拡充',
                'README に localhost のみのポートバインドを明記'
            ]
        },
        '2.0.0': {
            title: '複数ソースのスキャンと、デフォルトで安全な堅牢化されたインストール',
            items: [
                '任意の第2ソースとしての OSV（設定 → ソース、デフォルトはオフ）。悪意あるパッケージ検出を備え、ローカルキャッシュ内の公開 OSV データベースと照合します',
                '検出結果がソース間で統合されるようになりました。脆弱性ごとに1行で、各ソースをタグ付けし、利用可能な最良の修正と依存パスの和集合を示し、ソースフィルターと依存パスのポップオーバーを備えます',
                'セキュリティ強化: MCP エンドポイントはデフォルトでオフかつトークンが必要、Webhook 配信は SSRF から保護、任意のポータルログインゲート、コンテナは非特権ユーザーとして実行されます',
                '設定が、サイドバーとプロフィールページを備えたトップレベルのセクションになりました'
            ]
        },
        '1.4.0': {
            title: 'MCP 連携と新着情報',
            items: [
                'Claude Desktop、Cursor などのクライアント向けの /api/mcp の MCP サーバー',
                'サーバー URL とトークン管理を備えた新しい「設定 → MCP」セクション',
                '新着情報バッジとリリースノートの履歴'
            ]
        },
        '1.3.1': {
            title: 'フッターのバージョン表示の修正',
            items: ['実行中のバージョンがフッターに正しく表示されます']
        },
        '1.3.0': {
            title: '通知の改善',
            items: ['環境ごとに通知をフィルタリング', '通知先の編集フォームを簡素化', '既存の通知先を複製']
        },
        '1.2.0': {
            title: 'プロジェクトとライブラリのページ',
            items: ['ホーム画面が専用のプロジェクトページとライブラリページに分割されました']
        },
        '1.1.2': {
            title: 'スケジュールのライブ再読み込み',
            items: ['ポータルで変更を保存すると、ワーカーがスキャンスケジュールをすぐに再読み込みします']
        },
        '1.1.0': {
            title: 'より安全な削除と分かりやすい更新バナー',
            items: [
                'ルートと通知先を削除する前に確認',
                '更新のお知らせが画面上部の閉じられるバナーに変更',
                'ホストのマウントが消えると、ワーカーが古いルートを整理します'
            ]
        },
        '1.0.1': {
            title: 'スキャナーの精度修正',
            items: [
                'インストール済みバージョンが実際には脆弱な範囲にない検出結果を除外',
                '送信履歴のある通知先を削除できるように'
            ]
        },
        '1.0.0': { title: '初のオープンソースリリース', items: ['Sentinello の最初の一般公開リリース'] }
    },
    'zh-CN': {
        '3.3.1': {
            title: '与 3.3.0 相同的版本，但 Docker 镜像可以构建',
            items: [
                '3.3.0 已发布到 npm 和 GitHub，但它的容器镜像构建失败，因此发布时 GHCR 和 Docker Hub 上都没有 3.3.0。Dockerfile 会逐个列出它要安装的工作区包，而其中负责版本比较的那个包一直没有被列进去。在本次发布之前，镜像里没有任何东西 import 它，所以这个遗漏从未产生过影响。此后我们已用 3.3.0 自身的应用代码重新发布了修正后的 3.3.0 镜像，因此 <code>docker pull sentinello:3.3.0</code> 又可以正常使用了。3.3.1 则是把同一处修正带入了源码树。如果你使用 CLI，3.3.0 本来就是正确的。'
            ]
        },
        '3.3.0': {
            title: '只保留真正可用的生态系统 —— 以及值得信赖的通知',
            items: [
                '通知可能会空着送达。一位运维收到一条 Telegram 消息，声称某个项目存在漏洞，却一条也没有列出。派发以项目为范围，运行却是按扫描器进行的：npm audit 那一轮拿到了两个待发的 OSV 事件，一个都没匹配上，仍然在空列表之上渲染了标题。随后它把两个事件都标记为已送达 —— 于是那两条从未被提及的发现被记录为已通知，而已送达的事件不会再被回看。现在只有能够被描述的事件才会派发；无法描述的会保持待处理，并在下次扫描时重新考虑',
                '一条发现会以任一来源给出的最严重等级来上报，而这种升级此前能到达仪表盘、项目汇总和 CLI 的 <code>--fail-on</code> 闸门 —— 唯独到不了通知阈值。通知在互证之前运行，因此事件被打上了幸存来源自己的等级，之后再没有被改写。在一台真实实例上，135 条未解决的发现所带的事件严重程度低于其真实值，<strong>其中 41 条把 critical 记录成了 low、high 或 moderate</strong>。一个筛选到 critical 与 high 的通知目标，将永远不会为其中任何一条被呼叫',
                '计划扫描在午夜停下而不是继续。“从 07:00 起每 3 小时”会在 07、10、13、16、19、22 点运行，然后一直到次日 07:00 才再次运行 —— 每天六次而不是八次，每晚留下九小时的盲区 —— 与此同时设置页仍然显示你选择的间隔。“从 20:00 起每 6 小时”则每天只跑一次。现在时间点会跨过日界继续',
                '<strong>Python、Go 和 Rust 已被撤下。</strong> 这不是对粗糙之处的谨慎：它们的缺陷会以“干净”的形式呈现。修复版本推导与版本排序只支持 semver，因此一条关于 Django 的 OSV 公告会对已安装的 4.2 建议“升级到 3.2.23”；OSV 的 PyPI 包名未按 PEP 503 规范化，因而永远无法与解析器的名称对上；gemnasium 的范围解析器读不了 PEP 440 的逗号交集。一个出于错误原因回答“没有漏洞”的来源，比根本不提供更糟，所以它们已从产品界面上完全消失 —— 没有开关，不做发现，不做下载。<strong>你已经收集到的发现仍然可见、可静默；不会删除任何内容。</strong> npm 生态系统现在显示为 <strong>Node.js</strong>，指的是真正被扫描的包生态系统，而不是一门语言',
                '<strong>设置 → 来源</strong> 也围绕这一点重建。以前每个来源都在自己的开关旁重复自己的说明，每个带缓存的来源还各自带着五行状态面板和一个整尺寸的“立即刷新”按钮 —— 尽管无论出现多少次，该按钮每个来源只会入队一个共享信号。现在开关只说明来源是否启用；每个来源补充什么、从哪里下载什么、何时运行，都移到了下方的一张参考表里，同步状态也收拢成一行',
                'npm 自己的锁文件声明可从生产环境到达的包，却被降级为仅开发。锁文件中没有 <code>dev: true</code>，正是 npm 在断言该包确实可从生产环境到达 —— 这比根清单能作出的断言更强 —— 但只要该名称同时出现在 <code>devDependencies</code> 中，解析器就会覆盖它，而那恰恰是 npm 正确的时候。在 130 个真实项目上测得：97 个项目中有 142 个包被降级 —— lodash、semver、postcss、tailwindcss、@babel/runtime —— 在一台实例上让七条未解决的发现从“仅生产”筛选中消失',
                '任何被固定到类似 <code>0.0.0-20180523222229-09b5706aa936</code> 版本的包，<strong>不会匹配任何公告</strong>，连开放区间的都不会，而扫描却报告 ok 且零发现。公告下界 <code>introduced: 0</code> 被当作发行版 0.0.0 来比较，而在 semver 中预发布版本排在其发行版之下。真实缓存里 19,085 个可比较区间中有 330 个被存成了任何版本都无法满足的区间',
                '一次被中断的 OSV 同步可能永久删除一条公告。增量路径先删除公告的行，再在 try/catch 中获取替代内容，因此任何超时、5xx 或关机都会把它整条抹掉 —— 之后游标仍照常前进，把该 id 永久地留在身后。这种丢失是无声的，会一直持续到下一次完整重新播种，而且发生在一次报告成功的同步中。<code>npx sentinello</code> 的缓存也在每次不稳定的运行中同样被侵蚀。现在两者都先获取、后替换',
                'CLI 的 <code>--dep-type dev</code> 意思是“只要能从 dev 到达”，而门户的意思是“<em>只能</em>从 dev 到达”，因此一个从两边都能到达的包会出现在一个视图里而不出现在另一个里 —— 在一台实例上，两种解读之间相差 177 条未解决的发现。CLI 现在采用门户的规则，并遵守 OSV 的 <code>withdrawn</code> 字段，而它此前在结构上根本无法读取该字段：真实 npm 缓存中有 585 行带有这个值，而它们全都被当作有效发现上报',
                '当 gemnasium 公告表示漏洞从某个版本<em>之后</em>开始时——写作 <code>&gt;1.2.8</code> 而非 <code>&gt;=1.2.8</code>——它却被当作边界版本本身也受影响。2021 年 <code>rc</code> 包被劫持的公告正是这样写的，而 1.2.8 是它最后一个干净的版本：恰恰是该公告自己的修复说明让你保持使用的那个版本。于是每个安装了 <code>rc</code> 的项目都会看到一条严重的恶意代码告警，且没有可用修复，针对的却是一个从未被污染的版本。现在边界会完全按公告的表述保留，这类误报的严重告警随之消失',
                '同样的取整在相反方向上也在发生，并且掩盖了真实的发现。以 <code>&lt;=2.0.0</code> 为界的公告被存成“低于 2.0.0”，因此它表述得最明确的 2.0.0 反而未被报告；而只指明一个受影响版本的公告会塌缩成空区间并被整条丢弃。预计会出现少量新发现——它们一直都在，只是此前不可见',
                '用 Sentinello 未实现的语法书写的范围——<code>^1.0.0</code>、<code>~1.0.0</code>——过去会被当作对字面文本的精确版本锁定，只要还留在缓存里就永远无法匹配任何东西：看起来有效、却根本不可能触发的公告。现在这类记录会被直接拒绝，而不是以无法工作的形式保存；上界没有干净修复版本的公告，也终于能给出升级建议',
                '那个在 webhook URL 或机器人令牌进入日志行之前对其进行掩码的辅助函数，会把短的原样打印出来。它会拒绝六个字符及以下的值，却又保留八个字符的头部和四个字符的尾部，并且没有任何地方检查这两半是否会相接 —— 于是每一个 7 到 12 个字符的密钥都被完整地返回了。现在它至少隐藏八个字符，否则就把整个值完全屏蔽'
            ]
        },
        '3.2.0': {
            title: '结果现在会显示哪些来源意见一致，且已撤回的公告不再被报告',
            items: [
                '当多个公告数据库报告同一个漏洞时，Sentinello 一直只保留一条结果——因为三个数据库都知道就把同一个缺陷报告三次，那是噪音。但此前它会丢弃被合并来源的全部信息，于是一个由 npm audit、OSV 和 GitLab gemnasium 各自独立确认的漏洞，看上去与只有一个数据库听说过的漏洞毫无二致。在真实实例上这占全部结果的三分之二。现在每条结果都会带上其他报告过它的来源，其标记与保留下来的那条并列显示',
                '一条结果会以任一来源给出的最高严重级别来报告。各数据库的评级确实存在分歧——gemnasium 依据 CVSS 向量计算，而 npm audit 采用 GitHub 的分级——对扫描器而言，值得据以行动的是更谨慎的那个读数。这并非只是外观改动：被提升的结果会在仪表盘、项目汇总、CLI 的 <code>--fail-on</code> 门禁以及通知阈值中改变所属级别。升级后的首次扫描可能出现计数变动；并没有检测到新的问题，只是同样的结果被更谨慎地评级了',
                '在来源存在分歧时，结果会在严重级别旁显示一个控件，打开后可查看每个来源的实际说法——它自己的公告编号与自己的评级。它仅在存在需要解释的分歧时出现，因此各来源评级一致的结果仍保持简洁',
                'OSV 用一个专门的字段记录撤回，GitHub 则在 <code>npm audit</code> 看到之前就移除已撤回的公告，但 GitLab gemnasium 的模式中没有这样的字段。它通过就地重写记录来撤回公告——标题变为“False Positive”“Withdrawn Advisory: …”或“Duplicate Advisory: …”，而此前列出的版本原封不动地留在那里。Sentinello 读取了这些版本，报告了 GitLab 已明确收回的结果：涉及 JavaScript、Python、Go 和 Rust 的 383 条记录，其中一条以“False Positive”为标题报告了 <code>express</code>。现在这些记录全部被丢弃，这同时消除了一整类重复结果——383 条中有 278 条正是因与其他公告重复而被撤回的',
                '该判断以精确匹配撤回标记为准，而不是在文本中随处搜索这些词语，因此真正*讨论*误报的公告仍会被报告：标题为“Cosign’s verify-blob-attestation reports false positive when payload parsing fails”的 Cosign CVE-2026-39395 不受影响',
                '升级后首次同步时，gemnasium 缓存会自行重建，届时已撤回的公告随之消失。你无需做任何事：它会在每日同步中完成，也可从“设置 → 来源 → 刷新”立即执行'
            ]
        },
        '3.1.1': {
            title: '公告的版本范围在两个方向上都正确了',
            items: [
                '部分 GitLab gemnasium 公告完全不含机器可读的版本范围——JavaScript 的 10,777 条中有 698 条。Sentinello 此前通过假定“低于所列第一个修复版本的全部版本都受影响”来填补这个空缺，但该列表是无序的，且每个发布分支各有一个修复版本，因此这个猜测经常落在错误的分支上。protobufjs 7.6.5 被报告为严重的远程代码执行，尽管该分支已在 7.5.5 中修复；另有三条公告分别声称低于 8.0.5 的所有 vite 版本都存在漏洞。Sentinello 不再臆造范围：它会从以另一标识符发布的同一条公告、公告自身的描述，或——仅在你启用了 OSV 时——从你机器上已有的 OSV 副本中恢复真实范围；若以上都无法确定，则丢弃该记录而不做猜测。预计会有一些严重级别的结果消失',
                'OSV 将一条在多个发布分支上修复的公告描述为每个分支一条独立条目，而 Sentinello 只保留第一条、丢弃其余——仅 JavaScript 就丢失了 1,927 个存在漏洞的版本范围，每一个都是它再也看不到的真实漏洞。minimatch 的公告涵盖八个分支，却只有一个幸存，因此已安装的 minimatch 3.0.4 或 9.0.0 未被报告；next 和 ua-parser-js 也以同样方式丢失了分支。现在所有分支都会保留。预计会出现一些新的结果——这些漏洞一直都在，只是此前不可见',
                '升级后首次同步时，两个公告缓存都会自行重建，因为它们保存的范围是旧代码生成的。你无需做任何事：它会在每日同步中完成；若不想等待，也可从“设置 → 来源 → 刷新”立即执行'
            ]
        },
        '3.1.0': {
            title: '已静默的发现项彻底让位，数据库也不再无限膨胀',
            items: [
                '已静默的发现项是你早就做出的决定，因此它现在会完全从项目页面移除，而不是灰着留在那里。这不只是为了整洁：页面上的每一个数字——标题计数、两个标签页的角标、分页、各依赖库的合计、导出按钮——都基于同一批数据计算，页面终于与仪表盘、MCP 工具以及通告导出保持一致（后三者本来就已排除静默项）。“显示已静默项”开关可以随时把它们调回来，即使某个项目的发现项*全部*被静默也一样',
                '在对话框中输入不会再打完一个字符就丢失焦点。这个缺陷让静默对话框的“原因”字段几乎无法填写——而它是必填项，也是几个月后追溯一次静默是否合理的唯一依据。同一个对话框也不再继承打开它的表格行的对齐方式，这正是静默某个发现项时对话框内容右对齐、而静默整个项目时却正常的原因',
                '扫描历史不再无限增长。此前从未有任何机制按时间删除扫描记录，因此只要项目还在磁盘上，就会按来源、按每轮扫描无休止地累积记录——某个真实环境在不到三个月内达到了 2.2 GB。“设置 → 高级”中新增了保留期，默认 90 天，工作进程每小时清理超期记录，同时始终保留每个项目最近的 100 次扫描。发现项、静默设置和通知历史绝不会被删除，受影响的只有扫描日志。按 90 天的默认值，升级后的实例首次运行不会删除任何内容：只有当历史确实超过该期限，或你自己调低了它，清理才会开始',
                '这些增长绝大部分来自 `npm audit` 的原始输出：每次成功扫描都被完整保存，却没有任何地方读取它——占了那个环境数据库的 98.7%。现在扫描只记录一份简短摘要，单条记录从约 79 KB 降到 100 字节左右，并设有硬性上限，任何扫描器都无法重演这一幕',
                '在 MCP 方面，`get_dashboard_summary` 现在会说明：被你静默的项目会从它的合计中剔除，而 `list_projects` 仍会返回该项目。两者统计的本就是不同的范围，此前对比二者的智能体会把这当成缺陷。`list_scans` 也不再返回每次扫描的扫描器原始输出——单次响应曾可能达到约 16 MB'
            ]
        },
        '3.0.1': {
            title: 'gemnasium 下载恢复正常，CLI 也会正常退出',
            items: [
                '在 3.0.0 中，所有用户的 GitLab gemnasium 下载都会以 `HTTP 406` 失败。Node 内置的 fetch 会附加程序无法移除的 `Sec-Fetch-Mode: cors` 请求头，而 GitLab 会拒绝任何带该请求头的仓库归档请求 — 所以这与你的网络、IP 或重试次数都无关。下载现已改用普通的 HTTPS 请求，可以成功',
                '归档现在按提交 ID 而不是分支名获取，因此从同一上游提交更新的所有人共享同一份缓存副本，而不必各自让 GitLab 生成一个 60 MB 的归档。原本接近七分钟的首次下载现在几秒即可完成',
                'CLI 过去会完成全部工作 — 写出报告、打印摘要 — 然后再也不把终端交还。下载所用的连接仍在后台保持打开，使进程无法退出；现在读完归档后就会立即关闭',
                '拒绝下载的数据源不再等待三分钟才报告。它会在几秒内报告，并在终端中询问是否重试 — 且只重试真正失败的那个数据源',
                '`--fail-on` 在两个方向上都变得诚实。当某个公告数据源无法访问时，它会拒绝该次运行，而不是报告一次从未真正执行的干净扫描；同时，对于你自己用 `SENTINELLO_OSV_FEED_URL=off` 或 `SENTINELLO_GEMNASIUM_FEED_URL=off` 关闭且从未下载过的数据源，它不再让运行失败'
            ]
        },
        '3.0.0': {
            title: 'Sentinello 现在完全不用门户也能运行',
            items: [
                '扫描器以 CLI 形式发布到 npm。`npx sentinello` 会遍历一个文件夹，找出其下的每个项目，对照 npm audit、OSV 与 GitLab gemnasium 进行核查，并写出一份附带修复提示的 markdown 公告——无需安装、无需账号、无需数据库，你的代码也不会离开本机',
                '通过管道传递时，stdout 上只有公告，因此 `npx sentinello | claude -p "$(cat -)"` 能把一份完整的工作清单交给代理，而不会有任何东西破坏该文档',
                '首次运行不会再因下载被拒而丢掉 gemnasium 来源。GitLab 会一次拒绝其归档一到两分钟，而旧的重试十三秒就放弃了；现在 CLI 会等它过去、说明自己为何在等待，并在默认的三分钟不合适时接受 `--feed-wait`',
                '两个下载大小都是实测而非估猜：OSV 的 npm 导出标为 204 MB 而不是 196，gemnasium 归档标为 52 MB 而不是 80。确认提示会给估算值加上波浪号，以免被误认为服务器报告的大小',
                '看起来像选项的值现在会被拒绝，而不是照单全收——`--out --` 过去会在你的项目里写出一个名为 `--` 的文件并报告成功',
                '当某个版本内容较多时，“新变化”面板不会再溢出到窗口底部之外'
            ]
        },
        '2.6.0': {
            title: '公告文档真的送达了——而且计数与你的理解一致',
            items: [
                'get_project_advisory 现在返回公告文档本身。此前已连接的客户端只能拿到它的元数据——一个文件名和一个计数——始终拿不到文档，尽管该工具把它描述为一份完整的工作清单',
                '公告导出现在按不同公告各占一条、并合并其来源，而不再按扫描器行各占一条：npm audit 与 OSV 同时报告的同一个漏洞，是一个带上两个公告 ID 的工作项，而不是两条几乎相同的记录。这同样适用于门户的“下载 .md”，计数现在也与仪表盘一致',
                '大到无法放进单个 MCP 响应的项目现在会分页——文档会声明自身不完整，并给出获取其余内容的确切后续调用，而不是被静默截断、让代理把剩下的部分读成“干净”',
                '每个 MCP 工具的每个输入现在都带有描述，新增的 list_mutes 工具会公开 unmute 所需的静音 ID——此前只能通过在同一会话中创建静音才能拿到',
                '修复了严重程度计数的一个缺口：严重程度不属于五个已知取值的发现，会被计入发现总数却不落入任何严重程度分组，于是一个仅有该发现的项目看起来完全干净'
            ]
        },
        '2.5.0': {
            title: '通过 MCP 直接获取公告导出',
            items: [
                '已连接的 MCP 客户端可以用新的 get_project_advisory 工具获取项目的完整 Markdown 公告——与门户「下载 .md」按钮生成的文档相同，无需从浏览器复制',
                '被静音的问题不再包含在项目公告导出中，因此代理不会拿到你已经接受风险的工作',
                '注意：公告中包含你的导出提示词，因此 MCP 客户端现在可以读取你在「设置 → 导出」中写下的内容'
            ]
        },
        '2.4.3': {
            title: '不再被裁切的弹出层，以及更严格的导出提示词',
            items: [
                '下拉菜单、依赖路径弹出层和公告导出菜单不再被所处的表格或对话框裁切——它们绘制在页面之上，下方空间不足时会向上弹出',
                '默认的公告导出提示词现在要求代理在改动任何文件前先做计划、把可由同一处修复一并解决的发现归为一组，并说明每次版本变更对代码的具体影响；目标是零发现，同时明确排除通往虚假零值的捷径——静音、放宽版本范围或收窄扫描范围——真正无法解决的项则留在带日期的遗留事项表中'
            ]
        },
        '2.4.2': {
            title: '分支独立成列',
            items: ['扫描项目所用的 git 分支现在在项目列表中独占一列——纯文本、无图标——不再挤在项目名称下方']
        },
        '2.4.1': {
            title: '干净的关闭流程',
            items: [
                '重启容器不会再中断正在写入的扫描，worker 现在会立即启动，而不是先重试约 30 秒',
                '请在 compose 文件中设置 stop_grace_period: 60s（或 --stop-timeout 60）以留出时间——README 和 Docker 文档已补充说明'
            ]
        },
        '2.4.0': {
            title: '多语言扫描——Python、Go 和 Rust 加入 npm',
            items: [
                'Sentinello 现在除 npm 外还扫描 Python、Go 和 Rust 项目——锁文件完全离线解析，并且每个项目都会报告其扫描覆盖情况（完整、部分或无法审计），让盲区可见而不是悄然存在',
                'GitLab 的 gemnasium 数据库加入 npm audit 和 OSV，成为离线公告来源，并通过 CVE/GHSA 别名与其他来源去重；“设置 → 来源”现在是“语言 × 来源”矩阵，可按单元格设置通知范围，并且只要还有一个来源处于启用状态，npm audit 本身也可以关闭',
                '发现结果现在会记录其来源的 git 分支，并显示在项目列表、项目标题栏和每条通知中',
                '项目行自带操作——立即扫描、复制或下载公告、静音或取消静音、编辑标签——因此分诊时不必再逐个进入项目',
                '项目仪表盘从约 3.3 秒降至约 0.03 秒，页面切换现在会显示加载状态，而不是看起来卡住',
                '安全：修复 25 项依赖公告，包括门户图片优化器中真实存在的 libvips CVE，以及影响已发布门户的 9 项 Next.js 公告',
                '默认的公告导出提示词现在涵盖最短发布时长、锁文件校验和过期的 override'
            ]
        },
        '2.3.0': {
            title: '更简单的 MCP 设置——无需环境变量',
            items: [
                '现在完全在“设置 → MCP”中配置 MCP：生成令牌即可开启 /api/mcp 端点，清除令牌即可关闭——SENTINELLO_MCP_ENABLED 和 SENTINELLO_MCP_API_TOKEN 环境变量已移除（升级时会一次性导入已有的环境变量令牌）',
                '面向 Claude Code、Codex、Cursor 和 Claude Desktop 的即贴即用连接片段，已预填你的令牌',
                '当通过环境变量设置 SENTINELLO_PORTAL_BASE_URL 时，它会在“设置 → 高级”中以只读方式显示，因为它具有最高优先级并在每次启动时重新应用'
            ]
        },
        '2.2.0': {
            title: '更少的误报，以及会自我清理的检测结果',
            items: [
                '恶意软件公告现在会与确切的受影响版本进行比对——曾被入侵的包，其干净或已修复的版本不再被标记',
                '重复的检测结果现在会在下次扫描时自我解决，过期或遗留的条目会自动清除',
                '生产（production）和开发（development）标签现在在所有来源（npm 和 OSV）上以统一的单一方式计算'
            ]
        },
        '2.1.0': {
            title: '更简洁的项目页头与一致的筛选器',
            items: [
                '精简的项目页头——在标题旁直接重命名，静音和标签改为图标按钮',
                '在依赖类型筛选器旁新增下拉框，可按来源（npm / OSV）筛选发现',
                '全应用统一一致的下拉框，时区等长列表支持输入即搜索'
            ]
        },
        '2.0.1': {
            title: '更清晰的升级指引',
            items: ['扩充了 2.0 重大变更的升级步骤', 'README 说明了仅限本地（localhost）的端口绑定']
        },
        '2.0.0': {
            title: '多来源扫描，以及默认安全的加固安装',
            items: [
                '将 OSV 作为可选的第二来源（设置 → 来源，默认关闭），具备恶意软件包检测，并与本地缓存中的公开 OSV 数据库进行比对',
                '检测结果现在可跨来源合并——每个漏洞一行，标记每个来源、提供可用的最佳修复方案以及依赖路径的并集，并配有来源筛选和依赖路径弹出框',
                '安全加固：MCP 端点默认关闭并需要令牌，webhook 投递可防御 SSRF，可选的门户登录入口，容器以非特权用户身份运行',
                '“设置”现在是带侧边栏和个人资料页面的顶级板块'
            ]
        },
        '1.4.0': {
            title: 'MCP 集成与新功能',
            items: [
                '面向 Claude Desktop、Cursor 等客户端的 /api/mcp MCP 服务器',
                '全新的“设置 → MCP”板块，提供服务器 URL 和令牌管理',
                '新功能标记以及发行说明历史'
            ]
        },
        '1.3.1': { title: '页脚版本显示修复', items: ['运行中的版本在页脚正确显示'] },
        '1.3.0': { title: '通知改进', items: ['按环境筛选通知', '更简单的通知目标编辑表单', '复制现有的通知目标'] },
        '1.2.0': { title: '项目与库页面', items: ['主页拆分为独立的项目页面和库页面'] },
        '1.1.2': { title: '计划实时重载', items: ['在门户中保存更改后，worker 会立即重新加载扫描计划'] },
        '1.1.0': {
            title: '更安全的删除与更清晰的更新横幅',
            items: [
                '删除根目录和通知目标前进行确认',
                '更新提示改为可关闭的顶部横幅',
                '当主机挂载消失时，worker 会清理过期的根目录'
            ]
        },
        '1.0.1': {
            title: '扫描器准确性修复',
            items: ['丢弃已安装版本实际上不在易受攻击范围内的审计结果', '允许删除有发送历史的通知目标']
        },
        '1.0.0': { title: '首个开源版本', items: ['Sentinello 的首个公开发布版本'] }
    },
    ko: {
        '3.3.1': {
            title: '3.3.0과 같은 릴리스, 다만 빌드되는 Docker 이미지 포함',
            items: [
                '3.3.0은 npm과 GitHub에는 게시되었지만 컨테이너 이미지 빌드가 실패해 릴리스 시점에는 GHCR과 Docker Hub에 3.3.0이 없었습니다. Dockerfile은 설치할 워크스페이스 패키지를 하나씩 나열하는데, 그중 버전 비교 패키지만 처음부터 빠져 있었습니다. 이번 릴리스 전까지는 이미지 안의 어떤 것도 그 패키지를 import하지 않았기 때문에 이 누락이 한 번도 드러나지 않았습니다. 이후 3.3.0 자체의 애플리케이션 코드로 빌드한 수정된 3.3.0 이미지를 게시했으므로 <code>docker pull sentinello:3.3.0</code>은 다시 동작합니다. 3.3.1은 같은 수정을 소스 트리에 반영한 것입니다. CLI를 쓰신다면 3.3.0으로 이미 문제가 없습니다.'
            ]
        },
        '3.3.0': {
            title: '실제로 동작하는 생태계만 — 그리고 믿을 수 있는 알림',
            items: [
                '알림이 비어 있는 채로 도착할 수 있었습니다. 한 운영자는 어떤 프로젝트에 취약점이 있다고 알리면서 하나도 나열하지 않은 텔레그램 메시지를 받았습니다. 발송은 프로젝트 단위로 한정되지만 실행은 스캐너마다 이루어졌기 때문에, npm audit 차례가 대기 중인 OSV 이벤트 두 개를 넘겨받고 어느 것과도 매칭하지 못한 채 빈 목록 위에 제목만 그렸습니다. 그러고는 두 이벤트를 모두 전달됨으로 표시했고 — 한 번도 언급되지 않은 두 건의 발견이 알림 완료로 기록되었으며, 전달된 이벤트는 다시 검토되지 않습니다. 이제 이벤트는 설명할 수 있을 때만 발송되고, 그렇지 못한 이벤트는 대기 상태로 남아 다음 스캔에서 다시 검토됩니다',
                '발견 항목은 어떤 소스든 매긴 가장 높은 등급으로 보고되며, 이 상향은 대시보드와 프로젝트 합계, CLI의 <code>--fail-on</code> 게이트에는 도달했지만 알림 임계값에는 도달하지 못했습니다. 알림이 교차 확인보다 먼저 실행되어, 이벤트에는 살아남은 소스 자신의 등급이 찍힌 뒤 다시 기록되지 않았기 때문입니다. 실제 인스턴스에서 열린 발견 135건이 실제보다 낮은 이벤트 심각도를 갖고 있었고, <strong>그중 41건은 critical을 low·high·moderate로 기록</strong>하고 있었습니다. critical과 high로 필터링한 대상은 그 어떤 것에 대해서도 영구히 호출되지 않았을 것입니다',
                '예약된 스캔이 이어지지 않고 자정에 멈췄습니다. “07:00부터 3시간마다”는 07, 10, 13, 16, 19, 22시에 실행된 뒤 다음 날 07:00까지 멈춰 있었습니다 — 하루 여덟 번이 아니라 여섯 번, 매일 밤 아홉 시간의 사각지대와 함께 — 그동안에도 설정 화면은 선택한 간격을 그대로 보여주었습니다. “20:00부터 6시간마다”는 하루 한 번에 그쳤습니다. 이제 시간대가 날짜를 넘어 이어집니다',
                '<strong>Python, Go, Rust를 철회했습니다.</strong> 거친 부분에 대한 신중함이 아닙니다. 이들의 결함은 “깨끗함”으로 보고되었습니다. 수정 버전 도출과 버전 정렬이 semver 전용이라, Django에 대한 OSV 권고가 설치된 4.2에 “3.2.23으로 업그레이드”를 권했습니다. OSV의 PyPI 패키지 이름은 PEP 503으로 정규화되어 있지 않아 리졸버의 이름과 결코 만나지 못합니다. gemnasium의 범위 파서는 PEP 440의 쉼표 교집합을 읽지 못합니다. 잘못된 이유로 “취약점 없음”이라 답하는 소스는 아예 제공하지 않는 편보다 나쁘므로, 제품 표면에서 완전히 사라졌습니다 — 스위치도, 탐색도, 다운로드도 없습니다. <strong>이미 수집한 발견 항목은 계속 보이고 음소거할 수 있으며, 아무것도 삭제되지 않습니다.</strong> npm 생태계의 표시 이름은 이제 <strong>Node.js</strong>이며, 언어가 아니라 실제로 스캔하는 패키지 생태계를 가리킵니다',
                '<strong>설정 → 소스</strong>도 그에 맞춰 다시 만들었습니다. 이전에는 각 소스가 자기 스위치 옆에서 같은 설명을 반복했고, 캐시 기반 소스는 저마다 다섯 줄짜리 상태 패널과 전체 크기의 “지금 새로 고침” 버튼을 달고 있었습니다 — 그 버튼은 몇 번 나타나든 소스당 하나의 공유 신호만 큐에 넣는데도 말입니다. 이제 스위치는 소스가 켜져 있는지만 말하고, 각 소스가 무엇을 더하는지, 무엇을 어디서 내려받는지, 언제 실행되는지는 그 아래 하나의 참조 표로 옮겼으며, 동기화 상태는 한 줄로 줄었습니다',
                'npm 자신의 lockfile이 프로덕션에서 도달 가능하다고 선언한 패키지가 개발 전용으로 강등되고 있었습니다. lockfile에 <code>dev: true</code>가 없다는 것은 그 패키지가 프로덕션에서 도달 가능하다는 npm의 주장이며, 루트 매니페스트가 할 수 있는 것보다 강한 진술입니다. 그런데 리졸버는 그 이름이 <code>devDependencies</code>에도 나타나기만 하면 이를 덮어썼습니다 — 바로 npm이 옳았던 경우입니다. 실제 프로젝트 130개에서 측정한 결과, 97개 프로젝트에서 142개 패키지가 강등되었습니다 — lodash, semver, postcss, tailwindcss, @babel/runtime — 한 인스턴스에서는 열린 발견 7건이 프로덕션 전용 필터에서 가려졌습니다',
                '<code>0.0.0-20180523222229-09b5706aa936</code> 같은 버전에 고정된 패키지는 <strong>어떤 권고와도 일치하지 않았습니다</strong>. 상한이 열린 권고에도 걸리지 않았고, 스캔은 발견 0건으로 ok를 보고했습니다. 권고의 하한 <code>introduced: 0</code>이 릴리스 0.0.0으로 비교되는데, semver에서는 프리릴리스가 자기 릴리스보다 아래로 정렬되기 때문입니다. 실제 캐시의 비교 가능한 범위 19,085개 중 330개가 무엇으로도 만족할 수 없는 구간으로 저장되어 있었습니다',
                '중단된 OSV 동기화가 권고를 영구히 지울 수 있었습니다. 증분 경로는 권고의 행을 먼저 삭제한 뒤 try/catch 안에서 대체본을 가져왔기 때문에, 타임아웃·5xx·종료 중 무엇이든 그것을 통째로 없앴고 — 그러고도 커서는 그대로 전진해 해당 id를 영구히 뒤에 남겼습니다. 손실은 조용했고 다음 전체 재시딩까지 이어졌으며, 성공으로 보고된 동기화 안에서 일어났습니다. <code>npx sentinello</code>의 캐시도 불안정한 실행마다 같은 방식으로 깎여나갔습니다. 이제 둘 다 먼저 가져오고 나중에 교체합니다',
                'CLI의 <code>--dep-type dev</code>는 “dev에서 도달 가능하기만 하면”을 뜻했지만 포털은 “<em>오직</em> dev에서만 도달 가능”을 뜻합니다. 그래서 양쪽에서 도달 가능한 패키지는 한쪽 화면에만 나타났습니다 — 한 인스턴스에서 두 해석 사이에 열린 발견 177건이 어긋납니다. CLI는 이제 포털의 규칙을 쓰며, 구조적으로 읽을 수 없었던 OSV의 <code>withdrawn</code> 필드도 존중합니다: 실제 npm 캐시의 585개 행이 이 값을 갖고 있었고, 그 전부가 유효한 발견으로 보고되고 있었습니다',
                '취약점이 어떤 버전 <em>이후</em>부터 시작한다고 말하는 gemnasium 권고 — <code>&gt;=1.2.8</code>이 아니라 <code>&gt;1.2.8</code> — 가 경계 버전 자체도 영향을 받는 것처럼 읽히고 있었습니다. 2021년 <code>rc</code> 패키지 탈취 권고가 정확히 그렇게 쓰여 있고, 1.2.8은 그 마지막 깨끗한 릴리스, 즉 권고 자체의 조치 안내가 그대로 머무르라고 말하는 바로 그 버전입니다. 그래서 <code>rc</code>가 설치된 모든 프로젝트에 수정본도 없는 심각 멀웨어 발견이, 한 번도 손상된 적 없는 버전에 대해 표시되었습니다. 이제 경계는 권고가 밝힌 그대로 유지되며 이런 형태의 거짓 심각 항목은 사라집니다',
                '같은 반올림이 반대 방향으로도 작동해 진짜 발견을 감추고 있었습니다. <code>&lt;=2.0.0</code>으로 제한된 권고는 “2.0.0 미만”으로 저장되어, 가장 분명히 지목된 2.0.0이 보고되지 않았고, 영향받는 버전을 정확히 하나만 지목한 권고는 빈 구간이 되어 통째로 버려졌습니다. 늘 존재했지만 보이지 않던 발견이 조금 새로 나타날 것입니다',
                'Sentinello가 구현하지 않은 문법으로 쓰인 범위 — <code>^1.0.0</code>, <code>~1.0.0</code> — 는 그 문자열 자체를 정확한 버전으로 고정해 저장했기 때문에, 캐시에 남아 있는 한 무엇과도 일치할 수 없었습니다. 살아 있어 보이지만 결코 발동하지 못하는 권고였죠. 이제 이런 레코드는 작동할 수 없는 형태로 저장하는 대신 거부하며, 상한에 깨끗한 수정 버전이 없는 권고에도 마침내 업그레이드 제안이 붙습니다',
                'webhook URL이나 봇 토큰이 로그 줄에 닿기 전에 가려주는 헬퍼가 짧은 값을 그대로 출력하고 있었습니다. 여섯 자 이하는 거부하면서도 앞 여덟 자와 뒤 네 자를 남겼고, 그 두 조각이 맞닿지 않는지는 아무도 확인하지 않았습니다 — 그래서 7자에서 12자 사이의 비밀 값은 모두 온전히 되돌아왔습니다. 이제는 최소 여덟 자를 가리거나 값을 통째로 가립니다'
            ]
        },
        '3.2.0': {
            title: '이제 어떤 소스가 일치하는지 보여주고, 철회된 권고는 보고하지 않습니다',
            items: [
                '여러 권고 데이터베이스가 같은 취약점을 보고할 때 Sentinello는 언제나 하나의 결과만 유지해 왔습니다 — 세 데이터베이스가 안다고 해서 같은 결함을 세 번 보고하는 것은 잡음이기 때문입니다. 다만 이전에는 합쳐진 소스에 대한 정보를 모두 버렸기 때문에, npm audit과 OSV, GitLab gemnasium이 각각 독립적으로 확인한 취약점이 한 데이터베이스만 알고 있던 것과 똑같아 보였습니다. 실제 인스턴스에서는 이것이 전체 결과의 3분의 2에 해당합니다. 이제 각 결과는 그것을 보고한 다른 소스들을 함께 지니며, 해당 배지가 살아남은 항목 옆에 표시됩니다',
                '결과는 어떤 소스든 부여한 가장 높은 심각도로 보고됩니다. 데이터베이스들은 실제로 서로 다르게 평가합니다 — gemnasium은 CVSS 벡터로 계산하고 npm audit은 GitHub의 등급을 따릅니다 — 스캐너에게는 신중한 쪽 해석이 행동의 기준이 됩니다. 이는 겉모습만의 변화가 아닙니다. 상향된 결과는 대시보드, 프로젝트 합계, CLI의 <code>--fail-on</code> 게이트, 알림 임계값 모두에서 등급 구간이 바뀝니다. 업그레이드 후 첫 스캔에서 수치가 달라질 수 있지만, 새로 발견된 것은 없고 같은 결과를 더 신중하게 평가한 것입니다',
                '소스 간에 평가가 갈리는 경우, 결과의 심각도 옆에 각 소스가 실제로 무엇이라고 했는지 — 해당 소스의 권고 식별자와 등급 — 를 여는 컨트롤이 나타납니다. 설명할 이견이 있을 때만 표시되므로 모두가 같게 평가한 결과는 깔끔하게 유지됩니다',
                'OSV는 철회를 전용 필드에 기록하고 GitHub은 철회된 권고를 <code>npm audit</code>이 보기도 전에 제거하지만, GitLab gemnasium의 스키마에는 그런 필드가 없습니다. gemnasium은 레코드를 그 자리에서 다시 써서 철회합니다 — 제목이 “False Positive”, “Withdrawn Advisory: …”, “Duplicate Advisory: …”로 바뀌는 한편, 이전에 지목했던 버전은 그대로 남습니다. Sentinello는 그 버전을 읽고 GitLab이 명시적으로 거둬들인 결과를 보고하고 있었습니다. JavaScript, Python, Go, Rust에 걸쳐 383건이며, 그중에는 “False Positive”라는 제목으로 <code>express</code>를 보고한 것도 있습니다. 이제 모두 폐기되며, 383건 중 278건이 다른 권고와 중복되어 철회된 것이므로 중복 결과 한 부류도 함께 사라집니다',
                '이 검사는 철회 표식을 정확히 일치시키며 본문 아무 곳에서나 단어를 찾지 않습니다. 따라서 오탐 자체를 다루는 실제 권고는 계속 보고됩니다 — “Cosign’s verify-blob-attestation reports false positive when payload parsing fails”라는 제목의 Cosign CVE-2026-39395는 영향을 받지 않습니다',
                'gemnasium 캐시는 이번 업그레이드 후 첫 동기화에서 스스로 다시 만들어지며 그때 철회된 권고가 사라집니다. 따로 할 일은 없고 매일 동기화에서 처리되며, 설정 → 소스 → 새로 고침에서 즉시 실행할 수도 있습니다'
            ]
        },
        '3.1.1': {
            title: '권고의 버전 범위가 양방향 모두 정확해졌습니다',
            items: [
                '일부 GitLab gemnasium 권고에는 기계가 읽을 수 있는 버전 범위가 전혀 없습니다 — JavaScript 10,777건 중 698건입니다. Sentinello는 그 공백을 “나열된 첫 번째 수정 버전보다 낮은 모든 버전이 영향을 받는다”고 가정해 메워 왔지만, 이 목록은 정렬되어 있지 않고 릴리스 브랜치마다 수정 버전이 하나씩 들어 있어 그 추측이 자주 엉뚱한 브랜치를 가리켰습니다. protobufjs 7.6.5는 해당 브랜치가 7.5.5에서 수정되었는데도 심각한 원격 코드 실행으로 보고되었고, 서로 다른 세 권고가 각각 8.0.5 미만의 모든 vite 버전이 취약하다고 주장했습니다. 이제 Sentinello는 범위를 지어내지 않습니다. 다른 식별자로 게시된 동일한 권고, 권고 자체의 설명, 또는 OSV를 켜 둔 경우에 한해 사용자 컴퓨터에 이미 있는 OSV 사본에서 실제 범위를 복구하며, 어느 것으로도 확인되지 않으면 추측하지 않고 해당 레코드를 폐기합니다. 일부 심각 등급 결과가 사라질 것입니다',
                'OSV는 여러 릴리스 브랜치에서 수정된 권고를 브랜치마다 별도 항목으로 기술하는데, Sentinello는 첫 번째만 남기고 나머지를 버렸습니다 — JavaScript만으로 1,927개의 취약한 버전 범위이며, 하나하나가 더 이상 보이지 않게 된 실제 취약점입니다. minimatch 권고는 여덟 개 브랜치를 포함하지만 하나만 살아남아, 설치된 minimatch 3.0.4나 9.0.0이 보고되지 않았습니다. next와 ua-parser-js도 같은 방식으로 브랜치를 잃었습니다. 이제 모든 브랜치가 유지됩니다. 새로운 결과가 나타날 텐데, 그 취약점들은 늘 있었고 단지 보이지 않았을 뿐입니다',
                '이번 업그레이드 후 첫 동기화에서 두 권고 캐시 모두 스스로 다시 만들어집니다. 저장된 범위가 이전 코드로 생성된 것이기 때문입니다. 따로 할 일은 없으며 매일 동기화에서 처리됩니다. 기다리고 싶지 않다면 설정 → 소스 → 새로 고침에서 즉시 실행할 수 있습니다'
            ]
        },
        '3.1.0': {
            title: '음소거한 발견 항목이 화면에서 비켜서고, 데이터베이스도 무한정 커지지 않습니다',
            items: [
                '음소거한 발견 항목은 이미 내린 결정입니다. 그래서 이제 흐리게 남아 있지 않고 프로젝트 페이지에서 완전히 빠집니다. 단순히 깔끔해지는 문제가 아닙니다. 제목의 건수, 두 탭의 배지, 페이지 넘김, 라이브러리별 합계, 내보내기 버튼까지 페이지의 모든 숫자가 같은 데이터에서 계산되므로, 페이지가 마침내 대시보드·MCP 도구·권고 내보내기와 일치합니다. 이 셋은 이미 음소거 항목을 제외하고 있었습니다. 필요할 때는 ‘음소거 항목 표시’로 언제든 되돌릴 수 있으며, 발견 항목이 *전부* 음소거된 프로젝트에서도 마찬가지입니다',
                '대화상자에 입력할 때 한 글자 만에 포커스를 잃는 일이 사라졌습니다. 이 결함 때문에 음소거 대화상자의 ‘사유’ 항목을 사실상 채울 수 없었습니다. 필수 항목이자, 몇 달 뒤 그 음소거가 타당했는지 확인할 수 있는 유일한 근거인데도 말입니다. 같은 대화상자가 자신을 연 표 행의 정렬을 물려받는 문제도 해결했습니다. 발견 항목을 음소거할 때는 내용이 오른쪽으로 정렬되고 프로젝트를 음소거할 때는 그렇지 않았던 이유가 이것입니다',
                '스캔 기록이 더 이상 끝없이 쌓이지 않습니다. 지금까지 오래됐다는 이유로 스캔 행을 지우는 장치가 전혀 없었기 때문에, 디스크에 남아 있는 프로젝트는 소스마다 매 스윕마다 행을 무한정 쌓았습니다. 실제 인스턴스는 석 달도 안 되어 2.2 GB에 이르렀습니다. 이제 설정 → 고급에 보존 기간이 있고(기본 90일), 워커가 매시간 그보다 오래된 기록을 정리하면서 프로젝트마다 최근 100건은 항상 남깁니다. 발견 항목, 음소거, 알림 기록은 절대 지워지지 않으며 대상은 스캔 로그뿐입니다. 기본값 90일이면 업그레이드한 인스턴스가 첫 실행에서 아무것도 지우지 않습니다. 기록이 실제로 그 기간을 넘어서거나 직접 값을 낮췄을 때 비로소 정리가 시작됩니다',
                '그 증가분의 대부분은 `npm audit`의 원본 출력이었습니다. 성공한 스캔마다 통째로 저장되면서도 어디에서도 읽히지 않았고, 해당 인스턴스 데이터베이스의 98.7%를 차지했습니다. 이제 스캔은 짧은 요약만 기록하므로 한 행이 약 79 KB에서 100바이트 남짓으로 줄어듭니다. 상한선도 두어 어떤 스캐너도 같은 일을 반복할 수 없습니다',
                'MCP에서는 `get_dashboard_summary`가 음소거한 프로젝트를 합계에서 제외하는 반면 `list_projects`는 여전히 반환한다는 점을 명시합니다. 둘은 의도적으로 서로 다른 모집단을 세며, 이를 비교한 에이전트가 결함으로 오해하고 있었습니다. `list_scans` 역시 각 스캔의 스캐너 원본 출력을 더 이상 반환하지 않습니다. 한 번의 응답이 16 MB에 이르기도 했기 때문입니다'
            ]
        },
        '3.0.1': {
            title: 'gemnasium 다운로드가 다시 동작하고, CLI가 터미널을 반환합니다',
            items: [
                '3.0.0에서는 모든 사용자의 GitLab gemnasium 다운로드가 `HTTP 406`으로 실패했습니다. Node 내장 fetch는 프로그램이 제거할 수 없는 `Sec-Fetch-Mode: cors` 헤더를 붙이고, GitLab은 그 헤더가 있는 저장소 아카이브 요청을 모두 거부합니다 — 따라서 네트워크나 IP, 재시도 횟수와는 무관했습니다. 이제 다운로드는 일반 HTTPS 요청을 사용하며 성공합니다',
                '아카이브를 브랜치 이름이 아니라 커밋 ID로 가져옵니다. 같은 업스트림 커밋에서 갱신하는 모든 사용자가 캐시된 사본 하나를 공유하므로, 각자 GitLab에 60MB 아카이브 생성을 요청할 필요가 없습니다. 7분 가까이 걸리던 첫 다운로드가 이제 몇 초 만에 끝납니다',
                'CLI는 모든 작업을 마치고도 — 보고서를 쓰고 요약을 출력한 뒤에도 — 터미널을 돌려주지 않았습니다. 다운로드 연결이 뒤에서 열린 채 프로세스를 살려 두었기 때문입니다. 이제 아카이브를 다 읽는 즉시 닫습니다',
                '다운로드를 거부당한 소스가 이를 알리기까지 3분을 멈춰 있지 않습니다. 몇 초 안에 알리고, 터미널에서는 재시도를 제안합니다 — 실제로 실패한 소스만 다시 시도합니다',
                '`--fail-on`이 양방향으로 정직해졌습니다. 권고 소스를 조회할 수 없었던 실행은, 수행한 적 없는 깨끗한 스캔으로 보고하는 대신 거부합니다. 또한 `SENTINELLO_OSV_FEED_URL=off`나 `SENTINELLO_GEMNASIUM_FEED_URL=off`로 직접 끄고 한 번도 내려받지 않은 소스 때문에 실행이 실패하지 않습니다'
            ]
        },
        '3.0.0': {
            title: '이제 포털 없이도 Sentinello를 쓸 수 있습니다',
            items: [
                '스캐너가 npm의 CLI로 제공됩니다. `npx sentinello`는 폴더를 흔어 그 아래 모든 프로젝트를 찾고 npm audit, OSV, GitLab gemnasium과 대조한 뒤 조치 프롬프트가 막부된 markdown 권고문을 작성합니다. 설치도 계정도 데이터베이스도 필요 없고, 코드가 머신 밖으로 나가지도 않습니다',
                '파이프로 넘기면 stdout에는 권고문만 흐르므로 `npx sentinello | claude -p "$(cat -)"`이 문서를 훼손하지 않고 완전한 작업 목록을 에이전트에 전달합니다',
                '첫 실행에서 다운로드가 거부되어 gemnasium 소스를 잃는 일이 없어졌습니다. GitLab은 아카이브를 한두 분씩 거부하는데 기존 재시도는 13초 만에 포기했습니다. 이제 CLI는 끝까지 기다리고, 기다리는 이유를 알려주며, 기본값 3분이 맞지 않으면 `--feed-wait`을 받습니다',
                '두 다운로드 예상치 모두 추측이 아니라 실측했습니다. OSV의 npm 익스포트는 196MB가 아닌 204MB로, gemnasium 아카이브는 80MB가 아닌 52MB로 표시됩니다. 동의 프롬프트는 추정치에 물결표를 붙여 서버가 알려준 크기와 혼동되지 않게 합니다',
                '옵션처럼 생긴 값은 이제 그대로 받아들이지 않고 거부합니다. `--out --`은 예전에 프로젝트 안에 `--`라는 이름의 파일로 권고문을 쓰고 성공했다고 알렸습니다',
                '릴리스에 담긴 내용이 많아도 새 소식 패널이 창 아래로 넘치지 않습니다'
            ]
        },
        '2.6.0': {
            title: '권고 문서가 실제로 도착합니다 — 집계도 정확하게',
            items: [
                'get_project_advisory가 이제 문서 자체를 반환합니다. 지금까지 연결된 클라이언트는 파일 이름과 건수 같은 메타데이터만 받았고, 전체 작업 목록이라고 설명된 문서 본문은 전달되지 않았습니다',
                '권고 내보내기가 스캐너 행 단위가 아니라 개별 권고 단위로 한 항목씩 묶입니다. npm audit과 OSV가 함께 보고하는 취약점은 두 개의 비슷한 항목이 아니라 두 권고 ID를 모두 담은 하나의 작업 항목이 됩니다. 포털의 .md 다운로드에도 동일하게 적용되며, 건수가 대시보드와 일치합니다',
                'MCP 응답 하나에 담기지 않는 큰 프로젝트는 이제 페이지로 나뉩니다. 문서가 불완전함을 밝히고 나머지를 가져올 정확한 호출을 알려주므로, 에이전트가 잘린 뒷부분을 깨끗한 것으로 잘못 읽지 않습니다',
                '모든 MCP 도구의 모든 입력에 설명이 붙었고, unmute에 필요한 뮤트 ID를 확인할 수 있는 list_mutes 도구가 추가되었습니다 — 이전에는 같은 세션에서 뮤트를 만든 경우에만 알 수 있었습니다',
                '심각도 집계의 허점을 고쳤습니다. 알려진 다섯 값에 없는 심각도를 가진 발견은 건수에는 포함되지만 어느 등급에도 들어가지 않아, 그 하나만 있는 프로젝트가 완전히 깨끗해 보였습니다'
            ]
        },
        '2.5.0': {
            title: 'MCP에서 바로 받는 권고 내보내기',
            items: [
                '연결된 MCP 클라이언트는 새 get_project_advisory 도구로 프로젝트의 전체 Markdown 권고 문서를 가져올 수 있습니다 — 포털의 「.md 다운로드」 버튼과 같은 문서를 브라우저에서 복사하지 않고 사용할 수 있습니다',
                '음소거한 발견 항목은 이제 프로젝트 권고 내보내기에서 제외되므로, 이미 위험을 수용한 작업이 에이전트에게 전달되지 않습니다',
                '참고: 권고 문서에는 내보내기 프롬프트가 포함되므로, 이제 MCP 클라이언트가 설정 → 내보내기에 작성한 내용을 읽을 수 있습니다'
            ]
        },
        '2.4.3': {
            title: '잘리지 않는 팝업과 더 엄격한 내보내기 프롬프트',
            items: [
                '드롭다운, 의존성 경로 팝오버, 권고 내보내기 메뉴가 자신이 놓인 표나 대화상자에 잘리지 않습니다. 페이지 위에 그려지고, 아래 공간이 부족하면 위쪽으로 펼쳐집니다',
                '기본 권고 내보내기 프롬프트가 이제 파일을 고치기 전에 먼저 계획하고, 같은 수정으로 함께 해결되는 발견 항목을 묶고, 버전 변경마다 코드에 미치는 영향을 구체적으로 밝히도록 요구합니다. 목표는 0건이지만 음소거, 버전 범위 완화, 스캔 범위 축소처럼 가짜 0건으로 가는 지름길은 금지하며, 정말로 해결할 수 없는 항목은 날짜가 적힌 잔여 항목 표에 남깁니다'
            ]
        },
        '2.4.2': {
            title: '브랜치를 별도 열로',
            items: [
                '프로젝트를 스캔한 git 브랜치가 프로젝트 이름 아래가 아니라 프로젝트 목록의 별도 열에 표시됩니다 — 아이콘 없는 일반 텍스트입니다'
            ]
        },
        '2.4.1': {
            title: '깔끔한 종료',
            items: [
                '컨테이너를 재시작해도 기록 중이던 스캔이 중단되지 않으며, 워커가 약 30초간 재시도하지 않고 곧바로 시작합니다',
                'compose 파일에 stop_grace_period: 60s(또는 --stop-timeout 60)를 설정해 여유를 주세요. README와 Docker 문서에 설명을 추가했습니다'
            ]
        },
        '2.4.0': {
            title: '다국어 스캔 — npm에 Python, Go, Rust가 합류했습니다',
            items: [
                'Sentinello가 npm과 함께 Python, Go, Rust 프로젝트도 스캔합니다. 잠금 파일은 완전히 오프라인으로 해석되며, 각 프로젝트가 스캔 커버리지(완전, 부분, 감사 불가)를 보고하므로 빈틈이 조용히 묻히지 않습니다',
                'GitLab의 gemnasium 데이터베이스가 npm audit, OSV와 함께 오프라인 권고 소스로 추가되어 CVE/GHSA 별칭으로 다른 소스와 중복이 제거됩니다. 설정 → 소스는 이제 언어 × 소스 행렬이며 셀별로 알림 범위를 지정할 수 있고, 소스가 하나라도 켜져 있으면 npm audit 자체도 끌 수 있습니다',
                '발견 항목에 어느 git 브랜치에서 나왔는지 기록되어 프로젝트 목록, 프로젝트 헤더, 모든 알림에 표시됩니다',
                '프로젝트 행에 자체 작업이 생겼습니다. 지금 스캔, 권고 복사 또는 다운로드, 음소거와 해제, 태그 편집을 바로 할 수 있어 분류 작업 때마다 프로젝트로 들어갈 필요가 없습니다',
                '프로젝트 대시보드가 약 3.3초에서 약 0.03초로 빨라졌고, 화면 전환 시 멈춘 것처럼 보이는 대신 로딩 상태가 표시됩니다',
                '보안: 의존성 권고 25건을 해결했습니다. 포털 이미지 최적화 경로에서 실제로 노출돼 있던 libvips CVE와 배포되는 포털에 영향을 주던 Next.js 권고 9건이 포함됩니다',
                '기본 권고 내보내기 프롬프트가 최소 배포 경과 기간, 잠금 파일 검증, 오래된 override를 다루도록 보강됐습니다'
            ]
        },
        '2.3.0': {
            title: '더 간단해진 MCP 설정 — 환경 변수 불필요',
            items: [
                '이제 MCP를 설정 → MCP에서 전부 구성합니다: 토큰을 생성하면 /api/mcp 엔드포인트가 켜지고, 지우면 꺼집니다 — SENTINELLO_MCP_ENABLED와 SENTINELLO_MCP_API_TOKEN 환경 변수는 제거되었습니다(기존 환경 변수 토큰은 업그레이드 시 한 번만 가져옵니다)',
                'Claude Code, Codex, Cursor, Claude Desktop용 붙여넣기만 하면 되는 연결 스니펫, 토큰이 미리 채워져 있습니다',
                '환경 변수로 SENTINELLO_PORTAL_BASE_URL을 설정하면 우선 적용되며 부팅할 때마다 다시 적용되므로 설정 → 고급에서 읽기 전용으로 표시됩니다'
            ]
        },
        '2.2.0': {
            title: '더 적은 오탐과 스스로 정리되는 발견 항목',
            items: [
                '악성코드 권고가 이제 정확히 영향받는 버전과 대조됩니다 — 한때 침해되었던 패키지라도 깨끗하거나 이미 수정된 버전은 더 이상 표시되지 않습니다',
                '중복된 발견 항목이 이제 다음 스캔에서 스스로 해결되어, 오래되었거나 남겨진 항목이 자동으로 정리됩니다',
                '프로덕션과 개발 라벨이 이제 모든 소스(npm 및 OSV)에서 일관된 단일 방식으로 계산됩니다'
            ]
        },
        '2.1.0': {
            title: '더 깔끔한 프로젝트 헤더와 일관된 필터',
            items: [
                '프로젝트 헤더 간소화 — 제목 옆에서 바로 이름 변경, 음소거와 태그는 아이콘으로',
                '의존성 유형 필터 옆의 새 드롭다운에서 소스(npm / OSV)별로 발견 항목 필터링',
                '앱 전반의 통일되고 일관된 드롭다운, 시간대 같은 긴 목록은 입력하여 검색 지원'
            ]
        },
        '2.0.1': {
            title: '더 명확한 업그레이드 안내',
            items: ['2.0 호환성 깨짐 변경에 대한 업그레이드 단계 보강', 'README에 localhost 전용 포트 바인딩 명시']
        },
        '2.0.0': {
            title: '다중 소스 스캔과 기본값으로 안전한 강화된 설치',
            items: [
                '선택적 두 번째 소스로서의 OSV(설정 → 소스, 기본값 꺼짐). 악성 패키지 탐지를 갖추고 로컬 캐시의 공개 OSV 데이터베이스와 대조합니다',
                '이제 검출 결과가 소스 간에 병합됩니다 — 취약점당 한 행으로, 각 소스를 태그하고 사용 가능한 최선의 수정과 의존성 경로의 합집합을 보여주며, 소스 필터와 의존성 경로 팝오버를 제공합니다',
                '보안 강화: MCP 엔드포인트는 기본적으로 꺼져 있고 토큰이 필요하며, 웹훅 전송은 SSRF로부터 보호되고, 선택적 포털 로그인 게이트가 있으며, 컨테이너는 비권한 사용자로 실행됩니다',
                '설정이 이제 사이드바와 프로필 페이지를 갖춘 최상위 섹션이 되었습니다'
            ]
        },
        '1.4.0': {
            title: 'MCP 연동 및 새로운 기능',
            items: [
                'Claude Desktop, Cursor 등 클라이언트를 위한 /api/mcp MCP 서버',
                '서버 URL과 토큰 관리를 갖춘 새로운 설정 → MCP 섹션',
                '새로운 기능 배지와 릴리스 노트 기록'
            ]
        },
        '1.3.1': { title: '푸터 버전 표시 수정', items: ['실행 중인 버전이 푸터에 깔끔하게 표시됩니다'] },
        '1.3.0': {
            title: '알림 개선',
            items: ['환경별로 알림 필터링', '더 간단해진 알림 대상 편집 양식', '기존 알림 대상 복제']
        },
        '1.2.0': {
            title: '프로젝트 및 라이브러리 페이지',
            items: ['홈 화면이 전용 프로젝트 페이지와 라이브러리 페이지로 분리되었습니다']
        },
        '1.1.2': {
            title: '일정 실시간 다시 로드',
            items: ['포털에서 변경 사항을 저장하면 워커가 즉시 스캔 일정을 다시 로드합니다']
        },
        '1.1.0': {
            title: '더 안전한 삭제와 더 명확한 업데이트 배너',
            items: [
                '루트와 알림 대상을 삭제하기 전에 확인',
                '업데이트 알림이 닫을 수 있는 상단 배너로 이동',
                '호스트 마운트가 사라지면 워커가 오래된 루트를 정리합니다'
            ]
        },
        '1.0.1': {
            title: '스캐너 정확도 수정',
            items: [
                '설치된 버전이 실제로 취약 범위에 없는 점검 결과 제외',
                '발송 기록이 있는 알림 대상을 삭제할 수 있도록 허용'
            ]
        },
        '1.0.0': { title: '첫 오픈 소스 릴리스', items: ['Sentinello의 첫 공개 릴리스'] }
    },
    ru: {
        '3.3.1': {
            title: 'Тот же выпуск, что и 3.3.0, но с собирающимся Docker-образом',
            items: [
                '3.3.0 опубликована в npm и на GitHub, но её контейнерный образ не собрался — на момент выпуска 3.3.0 не было ни в GHCR, ни в Docker Hub. Dockerfile перечисляет каждый пакет рабочего пространства, который устанавливает, и один из них — пакет сравнения версий — там никогда не значился. До этого выпуска ничто в образе его не импортировало, поэтому пропуск ни разу не проявился. С тех пор опубликован исправленный образ 3.3.0, собранный из кода приложения самой 3.3.0, так что <code>docker pull sentinello:3.3.0</code> снова работает. 3.3.1 несёт то же исправление в дереве исходников. Для CLI версия 3.3.0 уже была верной.'
            ]
        },
        '3.3.0': {
            title: 'Только те экосистемы, которые действительно работают — и уведомления, которым можно верить',
            items: [
                'Уведомление могло прийти пустым. Оператор получил сообщение в Telegram, объявлявшее об уязвимостях в проекте и не перечислявшее ни одной. Рассылка ограничена проектом, но выполнялась по одному разу на сканер: проход npm audit получил два ожидающих события OSV, не сопоставил ни одного и всё равно отрисовал заголовок над пустым списком. Затем он пометил оба события как доставленные — и две находки, которые он ни разу не назвал, оказались записаны как отправленные, а к доставленному событию больше никто не возвращается. Теперь событие рассылается, только если его можно описать; если нет, оно остаётся в ожидании и рассматривается снова при следующем сканировании',
                'Находка сообщается с худшей оценкой, которую ей дал хоть один источник, и это повышение доходило до панели, итогов по проекту и шлюза <code>--fail-on</code> в CLI — но не до порогов уведомлений. Уведомление выполнялось до подтверждения, поэтому событие получало оценку уцелевшего источника и больше не переписывалось. На реальной инстанции 135 открытых находок несли серьёзность события ниже настоящей, <strong>41 из них записывала critical как low, high или moderate</strong>. Цель, отфильтрованная по critical и high, не была бы вызвана ни по одной из них — навсегда',
                'Запланированные сканирования останавливались в полночь, вместо того чтобы продолжаться. «Каждые 3 часа с 07:00» запускалось в 07, 10, 13, 16, 19 и 22, а затем только в 07:00 — шесть сканирований в сутки вместо восьми, с девятичасовым слепым окном каждую ночь — при этом Настройки продолжали показывать выбранный интервал. «Каждые 6 часов с 20:00» давало одно сканирование в сутки. Теперь слоты переходят через смену суток',
                '<strong>Python, Go и Rust отозваны.</strong> Это не осторожность из-за шероховатостей: их сбои сообщались как «чисто». Вывод исправленной версии и упорядочивание версий работают только по semver, поэтому рекомендация OSV по Django советовала «обновиться до 3.2.23» для установленной 4.2; имена пакетов PyPI в OSV не канонизированы по PEP 503 и потому никогда не совпадали с именами резолвера; а парсер диапазонов gemnasium не умеет читать пересечения через запятую из PEP 440. Источник, который по неверным причинам отвечает «уязвимостей нет», хуже того, который не предлагается вовсе, — поэтому они полностью убраны с поверхности продукта: ни переключателя, ни обнаружения, ни загрузки. <strong>Находки, уже собранные с ними, остаются видимыми, их можно заглушить; ничего не удаляется.</strong> Экосистема npm теперь называется <strong>Node.js</strong> — это имя реально сканируемой экосистемы пакетов, а не языка',
                '<strong>Настройки → Источники</strong> перестроены вокруг этого. Раньше каждый источник повторял собственное объяснение рядом с собственным переключателем, а каждый источник с кэшем нёс пятистрочную панель состояния с собственной полноразмерной кнопкой «Обновить сейчас» — хотя эта кнопка ставит в очередь один общий сигнал на источник, сколько бы раз она ни появлялась. Теперь переключатели говорят только о том, включён ли источник; что каждый из них добавляет, что и откуда загружает и когда работает, переехало в одну справочную таблицу под ними, а состояние синхронизации уместилось в одну строку',
                'Пакеты, которые собственный lock-файл npm объявляет достижимыми из продакшена, понижались до «только разработка». Отсутствие <code>dev: true</code> в lock-файле — это утверждение npm, что пакет ДОСТИЖИМ из продакшена, и оно сильнее того, что может сказать корневой манифест. Но резолвер перекрывал его всякий раз, когда имя встречалось и в <code>devDependencies</code>, то есть ровно тогда, когда npm был прав. Измерено на 130 реальных проектах: 142 пакета понижены в 97 из них — lodash, semver, postcss, tailwindcss, @babel/runtime — из-за чего на одной инстанции семь открытых находок скрылись из фильтра «только продакшен»',
                'Любой пакет, закреплённый на версии вида <code>0.0.0-20180523222229-09b5706aa936</code>, не совпадал <strong>ни с одной рекомендацией</strong> — даже с открытой — и сканирование сообщало ok при нулевом числе находок. Нижняя граница <code>introduced: 0</code> сравнивалась как релиз 0.0.0, а в semver предрелиз сортируется ниже своего релиза. 330 из 19 085 сравнимых диапазонов реального кэша хранились как интервалы, которые ничем нельзя удовлетворить',
                'Прерванная синхронизация OSV могла удалить рекомендацию навсегда. Инкрементальный путь удалял строки рекомендации, а замену получал уже внутри try/catch, поэтому любой таймаут, 5xx или остановка стирали её целиком — а курсор всё равно продвигался, оставляя идентификатор позади навсегда. Потеря была молчаливой, доживала до следующего полного пересева и происходила в синхронизации, которая отчитывалась об успехе. Кэш <code>npx sentinello</code> точно так же истончался при каждом нестабильном запуске. Теперь оба сначала получают и только потом заменяют',
                '<code>--dep-type dev</code> в CLI означал «достижим из dev хоть как-нибудь», тогда как портал имеет в виду «достижим <em>только</em> из dev», поэтому пакет, достижимый из обоих, появлялся в одном представлении и отсутствовал в другом — на одной инстанции два прочтения расходятся на 177 открытых находок. Теперь CLI использует правило портала и учитывает поле <code>withdrawn</code> из OSV, прочитать которое раньше был структурно неспособен: 585 строк реального npm-кэша несут его, и все они сообщались как действующие находки',
                'Рекомендация gemnasium, которая сообщает, что уязвимость начинается <em>после</em> версии — <code>&gt;1.2.8</code>, а не <code>&gt;=1.2.8</code>, — читалась так, будто затронута и сама граничная версия. Захват пакета <code>rc</code> в 2021 году описан именно так, а 1.2.8 — его последний чистый выпуск: ровно та версия, на которой рекомендация своим же указанием по устранению советует остаться. В результате каждому проекту с установленным <code>rc</code> показывалась критическая находка о вредоносном коде без доступного исправления — против версии, которая никогда не была скомпрометирована. Теперь границы сохраняются ровно так, как их формулирует рекомендация, и ложные критические находки такого рода исчезают',
                'То же округление работало и в обратную сторону, скрывая настоящие находки. Рекомендация с границей <code>&lt;=2.0.0</code> сохранялась как «ниже 2.0.0», поэтому сама 2.0.0 — версия, о которой сказано яснее всего, — не сообщалась, а рекомендация, называющая ровно одну затронутую версию, превращалась в пустой интервал и отбрасывалась целиком. Ожидайте небольшое число новых находок, которые всегда были, но оставались невидимыми',
                'Диапазоны, записанные синтаксисом, который Sentinello не реализует, — <code>^1.0.0</code>, <code>~1.0.0</code> — сохранялись как точная версия, привязанная к буквальному тексту, и потому не могли совпасть ни с чем, пока оставались в кэше: рекомендация выглядела действующей, но сработать не могла. Такие записи теперь отклоняются, а не хранятся в неработоспособном виде; рекомендациям, у которых верхняя граница не несёт чистой исправленной версии, наконец выдаётся предложение по обновлению',
                'Помощник, который маскирует URL вебхука или токен бота, прежде чем тот попадёт в строку журнала, печатал короткие значения целиком. Он отклонял значения из шести символов и меньше, но затем оставлял восьмисимвольную голову и четырёхсимвольный хвост, и никто не проверял, не смыкаются ли эти две половины — так что любой секрет длиной от 7 до 12 символов возвращался полностью. Теперь он скрывает не менее восьми символов либо затирает значение целиком'
            ]
        },
        '3.2.0': {
            title: 'Находки показывают, какие источники согласны, а отозванные рекомендации больше не сообщаются',
            items: [
                'Когда одну и ту же уязвимость сообщают несколько баз рекомендаций, Sentinello всегда оставлял ОДНУ находку: сообщать об одном изъяне трижды лишь потому, что о нём знают три базы, — это шум. Но всё, что касалось объединённых источников, до сих пор отбрасывалось, и уязвимость, независимо подтверждённая npm audit, OSV и GitLab gemnasium, выглядела ровно так же, как та, о которой слышала лишь одна база. На реальном экземпляре это две трети всех находок. Теперь каждая находка несёт с собой остальные источники, сообщившие о ней, и их метки отображаются рядом с сохранившейся',
                'Находка сообщается с САМОЙ ВЫСОКОЙ серьёзностью, которую ей присвоил любой источник. Базы действительно расходятся в оценках: gemnasium вычисляет серьёзность по вектору CVSS, а npm audit берёт категорию GitHub — и для сканера действовать стоит по осторожному прочтению. Это не косметика: повышенная находка меняет категорию на панели, в итогах проекта, в барьере <code>--fail-on</code> у CLI и в порогах уведомлений. При первом сканировании после обновления некоторые счётчики сдвинутся; ничего нового не обнаружено — те же находки оцениваются осторожнее',
                'Там, где источники расходятся, рядом с серьёзностью находки появляется элемент управления, открывающий то, что сказал каждый источник: его собственный идентификатор рекомендации и его оценку. Он появляется только при наличии расхождения, поэтому находка, оценённая всеми одинаково, остаётся лаконичной',
                'OSV фиксирует отзыв в отдельном поле, а GitHub удаляет отозванные рекомендации ещё до того, как их увидит <code>npm audit</code>, но у GitLab gemnasium такого поля в схеме нет. Он отзывает рекомендацию, переписывая запись на месте: заголовок становится «False Positive», «Withdrawn Advisory: …» или «Duplicate Advisory: …», а версии, которые она называла прежде, остаются на месте. Sentinello читал эти версии и сообщал о находках, которые GitLab явно отозвал: 383 записи по JavaScript, Python, Go и Rust, включая одну, сообщавшую об <code>express</code> под заголовком «False Positive». Теперь все они отбрасываются, что заодно устраняет целый класс дублирующихся находок — 278 из 383 отозваны именно как дубликаты другой рекомендации',
                'Проверка сопоставляет маркеры отзыва точно, а не ищет слова где угодно в тексте, поэтому настоящая рекомендация, посвящённая ложному срабатыванию, по-прежнему сообщается: CVE-2026-39395 для Cosign с заголовком «Cosign’s verify-blob-attestation reports false positive when payload parsing fails» не затронут',
                'Кэш gemnasium перестраивается сам при первой синхронизации после этого обновления, и тогда отозванные рекомендации исчезают. Ничего делать не нужно: это произойдёт при ежедневной синхронизации или сразу через «Настройки → Источники → Обновить»'
            ]
        },
        '3.1.1': {
            title: 'Диапазоны версий в рекомендациях верны в обе стороны',
            items: [
                'Некоторые рекомендации GitLab gemnasium вообще не содержат машиночитаемого диапазона версий — 698 из 10 777 для JavaScript. Sentinello закрывал этот пробел предположением, что затронуты все версии ниже первого перечисленного исправления, но этот список не упорядочен и содержит по одному исправлению на ветку выпуска, поэтому догадка регулярно попадала не в ту ветку. protobufjs 7.6.5 сообщался как критическое удалённое выполнение кода, хотя эта ветка была исправлена в 7.5.5, а три отдельные рекомендации утверждали, что уязвимы все версии vite ниже 8.0.5. Sentinello больше не выдумывает диапазоны: он восстанавливает настоящий из той же рекомендации, опубликованной под другим идентификатором, из её собственного описания или — только если у вас включён OSV — из копии OSV, уже имеющейся на вашей машине, а если ничто из этого не отвечает, отбрасывает запись, а не строит догадки. Часть критических находок исчезнет',
                'OSV описывает рекомендацию, исправленную в нескольких ветках выпуска, отдельной записью на каждую ветку, а Sentinello оставлял первую и отбрасывал остальные — 1 927 уязвимых диапазонов версий только для JavaScript, и каждый из них — реальная уязвимость, ставшая невидимой. Рекомендация minimatch охватывает восемь веток, а выживала лишь одна, поэтому установленный minimatch 3.0.4 или 9.0.0 не сообщался; next и ua-parser-js теряли ветки так же. Теперь сохраняются все ветки. Появятся новые находки — эти уязвимости существовали всегда, просто были невидимы',
                'Оба кэша рекомендаций перестраиваются сами при первой синхронизации после этого обновления, потому что хранящиеся в них диапазоны созданы прежним кодом. Ничего делать не нужно: это произойдёт при ежедневной синхронизации или сразу через «Настройки → Источники → Обновить», если не хотите ждать'
            ]
        },
        '3.1.0': {
            title: 'Заглушённые находки уходят с глаз долой, а база данных перестаёт расти без конца',
            items: [
                'Заглушённая находка — это решение, которое вы уже приняли, поэтому теперь она полностью уходит со страницы проекта, а не остаётся на ней блёклой строкой. Дело не только в аккуратности: каждое число на странице — счётчик в заголовке, значки обеих вкладок, постраничная навигация, итоги по библиотекам, кнопка экспорта — считается по одним и тем же строкам, так что страница наконец согласуется с панелью, инструментами MCP и экспортом рекомендаций, которые и раньше исключали заглушённые находки. Переключатель «Показать заглушённые» возвращает их в любой момент, в том числе в проекте, где заглушены *все* находки',
                'Ввод в диалоговом окне больше не теряет фокус после первого же символа. Из-за этой ошибки поле «Причина» в диалоге заглушения было практически невозможно заполнить — хотя оно обязательное и остаётся единственным, что позволяет разобраться в заглушении спустя месяцы. Тот же диалог перестал наследовать выравнивание строки таблицы, из которой он открыт: именно поэтому при заглушении находки диалог получался выровненным по правому краю, а при заглушении проекта — нет',
                'История сканирований больше не растёт бесконечно. Ничто и никогда не удаляло записи сканирований по возрасту, поэтому проект, остававшийся на диске, бесконечно накапливал по строке на источник за каждый проход — реальный экземпляр дошёл до 2,2 ГБ меньше чем за три месяца. В «Настройках → Дополнительно» появился срок хранения, по умолчанию 90 дней, и воркер ежечасно удаляет всё, что старше, всегда сохраняя 100 последних сканирований каждого проекта. Находки, заглушения и история уведомлений не затрагиваются — только журнал сканирований. При 90 днях обновившийся экземпляр ничего не удалит на первом же проходе: очистка начнётся, только когда история действительно окажется старше этого срока или когда вы сами уменьшите его',
                'Основная часть этого роста — необработанный вывод `npm audit`, который целиком сохранялся при каждом успешном сканировании и не читался ничем: 98,7 % базы данных того экземпляра. Теперь сканирования записывают краткую сводку, и строка уменьшается примерно с 79 КБ до сотни байт, а жёсткое ограничение не позволит ни одному сканеру повторить это',
                'В MCP инструмент `get_dashboard_summary` теперь прямо сообщает, что заглушённый вами проект выпадает из его итогов, тогда как `list_projects` по-прежнему его возвращает. Они намеренно считают разные совокупности, и агент, сравнивавший их, принимал это за ошибку. `list_scans` также перестал возвращать необработанный вывод сканера по каждому сканированию, который в одном ответе мог достигать примерно 16 МБ'
            ]
        },
        '3.0.1': {
            title: 'Загрузка gemnasium снова работает, а CLI возвращает терминал',
            items: [
                'В 3.0.0 загрузка GitLab gemnasium падала с `HTTP 406` у всех. Встроенный fetch в Node добавляет заголовок `Sec-Fetch-Mode: cors`, который программа не вправе убрать, а GitLab отклоняет любой запрос архива репозитория с этим заголовком — так что дело никогда не было ни в вашей сети, ни в IP, ни в числе повторов. Теперь загрузка выполняется обычным HTTPS-запросом и проходит успешно',
                'Архив запрашивается по идентификатору коммита, а не по имени ветки: все, кто обновляется с одного и того же коммита, используют общую кэшированную копию вместо того, чтобы каждый просил GitLab собрать архив на 60 МБ. Первая загрузка, занимавшая почти семь минут, теперь завершается за секунды',
                'CLI заканчивал всю работу — записывал отчёт, печатал сводку — и после этого не возвращал терминал. Соединение загрузки оставалось открытым и удерживало процесс; теперь оно закрывается сразу после чтения архива',
                'Источник, отказавший в загрузке, больше не молчит три минуты перед сообщением. Он сообщает за секунды и в терминале предлагает повторить — повторяя только тот источник, который действительно не удался',
                '`--fail-on` честен в обе стороны. Он отклоняет запуск, в котором источник рекомендаций не удалось опросить, вместо того чтобы отчитаться о чистом сканировании, которого не было; и больше не заваливает запуск из-за источника, который вы сами отключили через `SENTINELLO_OSV_FEED_URL=off` или `SENTINELLO_GEMNASIUM_FEED_URL=off` и ни разу не загружали'
            ]
        },
        '3.0.0': {
            title: 'Sentinello теперь работает вообще без портала',
            items: [
                'Сканеры выходят как CLI в npm. `npx sentinello` обходит папку, находит все проекты внутри, сверяет их с npm audit, OSV и GitLab gemnasium и пишет markdown-сводку с приложенным промптом по устранению — без установки, без аккаунта, без базы данных, и ничего из вашего кода не покидает машину',
                'В конвейере на stdout попадает только сводка, поэтому `npx sentinello | claude -p "$(cat -)"` передаёт агенту полный список работ, ничем не повредив документ',
                'Первый запуск больше не теряет источник gemnasium из-за отклонённой загрузки. GitLab отклоняет свой архив на минуту-две подряд, а прежние повторы сдавались через тринадцать секунд; теперь CLI дожидается окончания, объясняет, почему ждёт, и принимает `--feed-wait`, если три минуты по умолчанию вам не подходят',
                'Обе оценки размера загрузки измерены, а не угаданы: npm-экспорт OSV указан как 204 МБ вместо 196, а архив gemnasium — как 52 МБ вместо 80. В запросе подтверждения оценка помечается тильдой, чтобы её нельзя было принять за размер, сообщённый сервером',
                'Значение, похожее на флаг, теперь отклоняется, а не понимается буквально: `--out --` раньше писал сводку в файл с именем `--` внутри вашего проекта и рапортовал об успехе',
                'Панель «Что нового» больше не уходит за нижний край окна, когда в релизе много изменений'
            ]
        },
        '2.6.0': {
            title: 'Документ с рекомендациями действительно доходит — и считает верно',
            items: [
                'get_project_advisory теперь возвращает сам документ. Раньше подключённые клиенты получали только метаданные — имя файла и количество — но не документ, хотя инструмент описывал его как полный рабочий список',
                'Экспорт рекомендаций теперь содержит одну запись на каждую отдельную рекомендацию с объединёнными источниками, а не одну на строку сканера: уязвимость, о которой сообщают и npm audit, и OSV, становится единой рабочей задачей с обоими идентификаторами, а не двумя почти одинаковыми. Это касается и кнопки «Скачать .md» в портале, а количество теперь совпадает с панелью',
                'Проект, который не помещается в один ответ MCP, теперь разбивается на страницы: документ сообщает, что он неполный, и указывает точный следующий вызов для получения остального, вместо того чтобы молча обрываться там, где агент счёл бы остаток чистым',
                'У каждого параметра каждого инструмента MCP появилось описание, а новый инструмент list_mutes выдаёт идентификаторы отключений, нужные для unmute — раньше их можно было узнать, только создав отключение в той же сессии',
                'Исправлен пробел в подсчёте уровней риска: находка с уровнем вне пяти известных значений учитывалась как находка, но не попадала ни в одну категорию, поэтому проект с единственной такой находкой выглядел полностью чистым'
            ]
        },
        '2.5.0': {
            title: 'Экспорт рекомендаций прямо через MCP',
            items: [
                'Подключённые MCP-клиенты могут получить полный Markdown-отчёт проекта новым инструментом get_project_advisory — тот же документ, что и кнопка «Скачать .md» в портале, без копирования из браузера',
                'Заглушённые находки больше не попадают в экспорт рекомендаций проекта, поэтому агент никогда не получит работу, риск которой вы уже приняли',
                'Примечание: поскольку отчёт содержит ваш промпт экспорта, MCP-клиент теперь может прочитать то, что вы написали в Настройки → Экспорт'
            ]
        },
        '2.4.3': {
            title: 'Всплывающие панели без обрезки и более строгий промпт экспорта',
            items: [
                'Выпадающие списки, всплывающая панель пути зависимости и меню экспорта рекомендаций больше не обрезаются таблицей или диалогом, в котором они находятся, — они отрисовываются поверх страницы и раскрываются вверх, когда снизу не хватает места',
                'Стандартный промпт экспорта рекомендаций теперь требует от агента сначала составить план и только потом что-то править, группировать находки, закрывающиеся одним исправлением, и описывать влияние каждого изменения версии на код; цель — ноль находок, но обходные пути к фальшивому нулю запрещены: заглушение, расширение диапазонов или сужение области сканирования, а действительно нерешаемое попадает в датированную таблицу остатков'
            ]
        },
        '2.4.2': {
            title: 'Ветка в отдельной колонке',
            items: [
                'Ветка git, на которой сканировался проект, теперь занимает отдельную колонку в списке проектов — обычный текст, без иконки — вместо строки под названием проекта'
            ]
        },
        '2.4.1': {
            title: 'Корректное завершение работы',
            items: [
                'Перезапуск контейнера больше не обрывает сканирование на середине записи, а воркер запускается сразу, а не после ~30 секунд повторных попыток',
                'Задайте stop_grace_period: 60s (или --stop-timeout 60) в compose-файле, чтобы дать ему запас, — README и документация по Docker теперь это описывают'
            ]
        },
        '2.4.0': {
            title: 'Полиглотное сканирование — к npm добавились Python, Go и Rust',
            items: [
                'Sentinello теперь сканирует проекты на Python, Go и Rust наряду с npm — файлы блокировок разбираются полностью офлайн, а каждый проект сообщает своё покрытие сканирования (полное, частичное или непроверяемое), поэтому пробелы видны, а не остаются незамеченными',
                'База gemnasium от GitLab присоединяется к npm audit и OSV как офлайн-источник рекомендаций с дедупликацией по псевдонимам CVE/GHSA; раздел Настройки → Источники стал матрицей «Языки × Источники» с областью уведомлений для каждой ячейки, а сам npm audit теперь можно отключить, пока активен хотя бы один источник',
                'Находки теперь фиксируют ветку git, из которой они получены, — она видна в списке проектов, в заголовке проекта и в каждом уведомлении',
                'В строках проектов появились собственные действия — сканировать сейчас, скопировать или скачать рекомендацию, заглушить или снять заглушение и изменить теги, — поэтому для разбора больше не нужно заходить в каждый проект',
                'Панель проектов ускорилась с ~3,3 с до ~0,03 с, а при переходах теперь показываются состояния загрузки вместо подвисшей страницы',
                'Безопасность: устранено 25 рекомендаций по зависимостям, включая CVE в libvips, которые реально действовали в оптимизаторе изображений портала, и девять рекомендаций Next.js, затрагивавших поставляемый портал',
                'Стандартный промпт экспорта рекомендаций теперь учитывает минимальный возраст релиза, проверку файла блокировки и устаревшие override'
            ]
        },
        '2.3.0': {
            title: 'Более простая настройка MCP — без переменных окружения',
            items: [
                'Теперь MCP настраивается полностью в «Настройки → MCP»: сгенерируйте токен, чтобы включить эндпойнт /api/mcp, очистите его, чтобы выключить — переменные окружения SENTINELLO_MCP_ENABLED и SENTINELLO_MCP_API_TOKEN удалены (существующий токен из окружения импортируется один раз при обновлении)',
                'Готовые к вставке фрагменты подключения для Claude Code, Codex, Cursor и Claude Desktop, уже заполненные вашим токеном',
                'Когда SENTINELLO_PORTAL_BASE_URL задана в окружении, она отображается только для чтения в «Настройки → Дополнительно», поскольку остаётся приоритетной и повторно применяется при каждом запуске'
            ]
        },
        '2.2.0': {
            title: 'Меньше ложных срабатываний и самоочищающиеся находки',
            items: [
                'Оповещения о вредоносном ПО теперь сопоставляются с точной затронутой версией — чистая или уже исправленная версия некогда скомпрометированного пакета больше не помечается',
                'Дублирующиеся находки теперь устраняются сами при следующем сканировании, поэтому старые или осиротевшие записи удаляются автоматически',
                'Метки production и development теперь вычисляются единым согласованным способом по всем источникам (npm и OSV)'
            ]
        },
        '2.1.0': {
            title: 'Более чистый заголовок проекта и единообразные фильтры',
            items: [
                'Упрощённый заголовок проекта — переименование рядом с названием, отключение и теги в виде иконок',
                'Фильтрация находок по источнику (npm / OSV) через новый выпадающий список рядом с фильтром типа зависимости',
                'Единообразные выпадающие списки по всему приложению, с поиском по вводу для длинных списков, например часовых поясов'
            ]
        },
        '2.0.1': {
            title: 'Более понятные инструкции по обновлению',
            items: [
                'Расширенные шаги обновления для несовместимых изменений 2.0',
                'В README указана привязка порта только к localhost'
            ]
        },
        '2.0.0': {
            title: 'Сканирование из нескольких источников и усиленная, безопасная по умолчанию установка',
            items: [
                'OSV как необязательный второй источник (Настройки → Источники, по умолчанию выключено) с обнаружением вредоносных пакетов, сверяемый с публичной базой данных OSV в локальном кэше',
                'Результаты теперь объединяются между источниками — одна строка на уязвимость, каждый источник помечен, лучшее доступное исправление и объединение путей зависимостей, с фильтром по источнику и всплывающим окном пути зависимости',
                'Усиление безопасности: эндпойнт MCP по умолчанию выключен и требует токен, доставка вебхуков защищена от SSRF, необязательный вход в портал, и контейнер запускается от непривилегированного пользователя',
                'Настройки теперь — раздел верхнего уровня с боковой панелью и страницей профиля'
            ]
        },
        '1.4.0': {
            title: 'Интеграция MCP и новинки',
            items: [
                'MCP-сервер по адресу /api/mcp для Claude Desktop, Cursor и других клиентов',
                'Новый раздел «Настройки → MCP» с URL сервера и управлением токенами',
                'Значок новинок и история примечаний к выпускам'
            ]
        },
        '1.3.1': { title: 'Исправление версии в подвале', items: ['Текущая версия корректно отображается в подвале'] },
        '1.3.0': {
            title: 'Улучшения уведомлений',
            items: [
                'Фильтрация уведомлений по среде',
                'Более простая форма редактирования получателей',
                'Дублирование существующего получателя уведомлений'
            ]
        },
        '1.2.0': {
            title: 'Страницы проектов и библиотек',
            items: ['Главный экран разделён на отдельные страницы проектов и библиотек']
        },
        '1.1.2': {
            title: 'Живая перезагрузка расписания',
            items: ['Воркер перезагружает расписание сканирования сразу после сохранения изменений в портале']
        },
        '1.1.0': {
            title: 'Более безопасное удаление и понятный баннер обновления',
            items: [
                'Подтверждение перед удалением корней и получателей уведомлений',
                'Уведомление об обновлении перенесено в закрываемый баннер сверху',
                'Воркер удаляет устаревшие корни, когда их монтирование исчезает'
            ]
        },
        '1.0.1': {
            title: 'Исправления точности сканера',
            items: [
                'Отбрасывает результаты, чья установленная версия фактически не входит в уязвимый диапазон',
                'Позволяет удалить получателя уведомлений с историей отправок'
            ]
        },
        '1.0.0': { title: 'Первый релиз с открытым исходным кодом', items: ['Первый публичный выпуск Sentinello'] }
    }
}

export function getReleases(): ReleaseEntry[] {
    return RELEASES
}

export function getLatestRelease(): ReleaseEntry | null {
    return RELEASES[0] || null
}

export function getReleaseFor(version: string): ReleaseEntry | null {
    const bare = stripVPrefix(version)
    return (
        RELEASES.find(function match(entry) {
            return entry.version === bare
        }) || null
    )
}

// Falls back to English when a locale is missing an entry (unlike next-intl’s hard error).
export function getReleaseCopy(locale: Locale, version: string): ReleaseCopy | null {
    const byLocale = RELEASE_COPY[locale] || RELEASE_COPY.en
    return byLocale[version] || RELEASE_COPY.en[version] || null
}
