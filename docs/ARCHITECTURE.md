# Architecture

A short tour of how Sentinello fits together, aimed at contributors. For
operator-facing setup see the [README](../README.md).

## Two processes, one database

```
┌────────────────────────┐        ┌────────────────────────┐
│  apps/web (Next.js)    │        │  apps/worker (tsx)     │
│  - portal UI           │ ─────► │  - scheduler           │
│  - server actions      │  scan  │  - discovery + scanner │
│  - API routes          │  reqs  │  - notifier            │
│  - reads scan results  │ ◄───── │  - lockfile watcher    │
└──────────┬─────────────┘        └──────────┬─────────────┘
           │                                 │
           │     same SENTINELLO_DB_PATH     │
           ▼                                 ▼
        ┌──────────────────────────────────────┐
        │   SQLite (WAL mode, better-sqlite3)  │
        └──────────────────────────────────────┘
```

The portal and worker are independent OS processes that **coordinate exclusively
through one SQLite file** — there is no in-process IPC, no message bus, no
HTTP between them. In Docker both processes run under `pm2-runtime`; locally
both are launched by `pnpm dev`; in production-on-host they're supervised by
plain `pm2` via `ecosystem.config.js`.

The single source of truth is `SENTINELLO_DB_PATH`. Both processes resolve to
the same default (`<repo>/data/sentinello.sqlite` in dev, `/app/data/…` in
Docker) when it's unset.

## Worker pipeline

The worker is a long-lived daemon. On boot it acquires a single-instance lock,
loads config from disk (`sentinello.config.{json,yaml}` if present) and the DB,
auto-registers any subdirectory of `/roots/` as a root, then starts four
concurrent loops:

1. **Scheduler** — sweeps every root on a cadence (1h/3h/6h/12h/24h, optionally
   anchored to a start hour + timezone), discovers projects via lockfiles,
   queues per-project scan requests.
2. **Scan-request poller** — drains the `scan_requests` queue, runs npm-audit
   for each project (under the right Node version via `nvm` if `.nvmrc` says
   so), writes findings, and emits notification events.
3. **Mute-expiry sweep** — every 15 minutes, lifts expired mutes and journals
   the lift so the UI can show "this mute was auto-lifted".
4. **Lockfile watcher** (opt-in per root) — debounces filesystem events on
   `package-lock.json` / `pnpm-lock.yaml` / `yarn.lock` and enqueues scan
   requests for the affected project.

The notifier UPSERTs into a per-(event, target) ledger so a crash between POST
and the success record produces at most one duplicate. Webhook URLs and tokens
can be `env:NAME` references that resolve from the worker's environment at
dispatch time.

## Package boundaries

| Package                  | Purpose                                                    |
| ------------------------ | ---------------------------------------------------------- |
| `@sentinello/core`       | Shared types and localized label maps (no runtime deps)    |
| `@sentinello/db`         | Drizzle schema, migrations, and query helpers              |
| `@sentinello/scanners`   | `npm audit` runner + version-fix logic                     |
| `@sentinello/notifications` | Slack / Telegram / generic-webhook senders + secret resolution |

`apps/web` and `apps/worker` consume these as raw TypeScript source through
pnpm workspace links — there is no `dist/` build step for the packages. Next's
`transpilePackages` and `tsx` handle compilation on demand.

## Why SQLite

A single-file embedded database is what makes Sentinello "single image, single
volume, no external services." `better-sqlite3` opens it synchronously inside
server components and worker callbacks alike; WAL mode allows the worker to
write while the portal reads without contention. The DB plus its `*-wal`,
`*-shm`, and lockfile siblings all live on the `/app/data` volume.

## Data lifecycle

- **Projects** exist on disk → exist in the DB. When a sweep finds a known
  project missing from a root it walked, that project (and all its scan
  history, findings, notification state) is deleted. There is no "missing"
  tombstone. A temporarily unmounted root is *skipped*, not reconciled — its
  projects survive the outage.
- **Findings** are deduplicated per (project, library, advisory) and carry
  lifecycle timestamps (first seen / last seen / resolved).
- **Notification deliveries** are recorded *before* the outbound POST so a
  crash mid-send can replay safely.

## Where to start reading

| Want to understand…          | Start here                                          |
| ---------------------------- | --------------------------------------------------- |
| How scans run                | `apps/worker/src/scheduler.ts`, `runner.ts`         |
| How projects are discovered  | `apps/worker/src/discovery.ts`                      |
| The DB schema                | `packages/db/src/schema.ts`                         |
| What npm audit returns       | `packages/scanners/src/npm-audit.ts`                |
| How notifications dispatch   | `apps/worker/src/notifier.ts`                       |
| Portal data fetching         | `apps/web/lib/db.ts`, `packages/db/src/queries/*`   |
| Server actions (UI writes)   | `apps/web/lib/actions/*`                            |
