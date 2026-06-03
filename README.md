<p align="center">
  <img src="apps/web/public/sentinello-logo.png" alt="Sentinello" width="120" height="120" />
</p>

# Sentinello

**An early-warning system for the dependencies you stopped watching.**

In the AI age you ship more Node.js projects than you can maintain — the marketing
site, the client dashboard, the side project that quietly went to production. They
keep running long after anyone last looked at them, and a single forgotten
dependency with a critical CVE is all it takes to turn the simplest site into the
way in.

Sentinello is a self-hosted portal that continuously scans the repositories you
point it at, surfaces known CVEs in their dependencies, and gives you **one triage
queue across every project** — instead of `npm audit` output scattered across a
dozen checkouts, or finding out about a CVE from a headline days too late.

"Why not just use Snyk or Dependabot?" Those live inside the CI pipeline you wired
up — and the long tail never got one. Sentinello is for everything else: point it at
a folder and it watches every project you forgot. It's not trying to replace
enterprise SCA on a mature pipeline; it's here for the rest of your portfolio that
nobody is watching.

Single image, single SQLite file, no external services. The web portal and the
background scan worker run together under `pm2-runtime`. No account, no SaaS, no
telemetry — your code and your findings never leave your machine.

- **Website:** https://sentinello.org
- **Issues:** https://github.com/walkofcode/sentinello/issues
- **License:** MIT · Walk of Code LLC

---

## Quick start

> **Local/trusted-network only:** Sentinello has no built-in authentication by default. The command
> below binds to `127.0.0.1` so it's reachable only from the host. To allow access for a real login,
> set `SENTINELLO_PORTAL_TOKEN` and/or put it behind your VPN / reverse-proxy auth — see
> [Running it safely](#running-it-safely).

```bash
docker run -d \
  --name sentinello \
  -p 127.0.0.1:3870:3000 \
  -v sentinello-data:/app/data \
  -v sentinello-nvm:/home/sentinello/.nvm \
  -v /path/to/your/code:/roots/personal:ro \
  ghcr.io/walkofcode/sentinello:latest
```

Open http://localhost:3870 — that's the whole install. Sentinello runs on
`linux/amd64` and `linux/arm64`; the correct architecture is pulled automatically.
The image is mirrored on Docker Hub, so swap `ghcr.io/walkofcode/sentinello` for
`walkofcode/sentinello` if you prefer pulling from there.

Only mount code roots you trust. Sentinello runs package-manager audit commands
inside mounted projects, so treat roots like code you would run locally.

## How it works

Three steps — no agents to install in your projects, no accounts to create:

1. **Point it at your code.** Anything mounted under `/roots/<name>` is
   **auto-registered as a root on startup** (the directory name becomes its label),
   so discovery and scanning begin on their own — no manual setup. Mounting under
   `/roots` is optional: you can also add roots from **Settings → Roots**.
2. **It scans continuously.** A background worker checks your dependencies against
   known CVEs on a schedule, installing the Node version each project pins via
   `.nvmrc` when it needs to (the `sentinello-nvm` volume persists those so each
   version downloads only once).
3. **Triage in one queue.** Every finding across every project lands in a single
   queue you can filter by severity — browse by project or by library, export a
   remediation-ready advisory, and get optional alerts in Slack, Telegram, or a
   webhook.

## docker compose

```yaml
services:
    sentinello:
        image: ghcr.io/walkofcode/sentinello:latest
        container_name: sentinello
        restart: unless-stopped
        security_opt:
            - no-new-privileges:true
        cap_drop:
            - ALL
        ports:
            # Localhost-only by default; drop the 127.0.0.1 prefix to expose it (and add auth first).
            - '127.0.0.1:3870:3000'
        environment:
            SENTINELLO_DB_PATH: /app/data/sentinello.sqlite
            SENTINELLO_PORTAL_BASE_URL: http://localhost:3870
            # Optional login gate — set a long random string, then the portal prompts at /login:
            # SENTINELLO_PORTAL_TOKEN: change-me-to-a-long-random-string
        volumes:
            - sentinello-data:/app/data
            - sentinello-nvm:/home/sentinello/.nvm
            # One read-only mount per portfolio root you want scanned — each is
            # auto-registered on boot (the directory name becomes the label):
            - /Users/you/code:/roots/personal:ro

volumes:
    sentinello-data:
    sentinello-nvm:
```

A ready-to-use `docker-compose.yml` ships in the repo root.

## Configuration

| Variable                     | Default                       | Purpose                                       |
| ---------------------------- | ----------------------------- | --------------------------------------------- |
| `PORT`                       | `3000`                        | Web portal port inside the container          |
| `SENTINELLO_DB_PATH`         | `/app/data/sentinello.sqlite` | SQLite location (keep on the mounted volume)  |
| `SENTINELLO_PORTAL_BASE_URL` | `http://localhost:3870`       | External URL used in notification links       |
| `ME_NAME`                    | `anonymous`                   | Display name / owner label                    |
| `SENTINELLO_PORTAL_TOKEN`    | _(unset)_                     | When set, requires login at `/login` with this token before any route (except the health check) is reachable. Unset = no auth. See [Running it safely](#running-it-safely) |
| `SENTINELLO_VERSION`         | `dev`                         | Version label in the footer / `/api/version`; baked into the image at build time |
| `SENTINELLO_UPDATE_FEED_URL` | GitHub Releases API           | Update-check feed; set to `off` to disable update checks |
| `SENTINELLO_MCP_ENABLED`     | `false`                       | Set to `true` to enable the `/api/mcp` endpoint (a token is then **mandatory** — see below). Unset/`false` = 404 |
| `SENTINELLO_MCP_API_TOKEN`   | _(unset)_                     | Bearer token for the MCP endpoint; overrides the one set in **Settings → MCP**. The endpoint refuses all requests until one is set |
| `SENTINELLO_WEBHOOK_STRICT`  | _(unset)_                     | Set to `true` to reject webhook targets aimed at private (RFC-1918) / loopback addresses and require `https`. Link-local / cloud-metadata targets are always rejected regardless |
| `SENTINELLO_OSV_FEED_URL`    | OSV GCS bucket                | OSV advisory export base URL (only used when the **OSV source** is enabled); set to `off` to disable all OSV network access |
| `SENTINELLO_OSV_DB_PATH`     | `<data dir>/osv.db`           | Location of the rebuildable OSV advisory cache (defaults next to the main DB) |

### Language

The portal UI — including scan **reason codes** and **scan status** — is localized to the language
picked in the top-menu language switcher (10 languages). The language of **failure notifications**
(Slack / Telegram / webhook messages) is configured separately in **Settings → Advanced →
Notification language** (default English), since a notification has no per-viewer locale.

## Running it safely

Sentinello is built for a **single trusted operator** on a private host or LAN. A few defaults and
knobs make that posture safe — here's the whole picture in one place.

- **No exposure by default.** The quick-start and compose examples bind the port to `127.0.0.1`, so a
  fresh install is reachable only from the host. Drop the `127.0.0.1:` prefix only when you mean to
  serve other machines — and pair that with auth.
- **Optional login gate.** Set `SENTINELLO_PORTAL_TOKEN` to a long random string and the portal
  redirects every route (except the container health check) to `/login` until that token is entered.
  The token is held as an HMAC session cookie, never stored raw. It's a single shared secret, not
  multi-user auth — for anything past a trusted LAN, also sit Sentinello behind a reverse proxy / VPN
  with its own auth (Nginx Proxy Manager, Caddy basic-auth, Authelia, Tailscale, …).
- **Runs as non-root.** The image runs as `uid 10001`; the web server, worker, and every audit
  subprocess run unprivileged. The compose file sets `no-new-privileges` and drops all Linux
  capabilities.
- **Only mount roots you trust.** Sentinello runs `npm/pnpm/yarn audit` inside mounted roots. Audit is
  read-only and does **not** run package lifecycle scripts, but a hostile `.npmrc` could still redirect
  registry lookups — treat roots like code you'd run locally, and mount them read-only.
- **Webhook egress is fenced.** Webhook targets can't reach link-local / cloud-metadata addresses,
  can't use non-`http(s)` schemes, and don't follow redirects; `SENTINELLO_WEBHOOK_STRICT=true` also
  blocks private (RFC-1918) targets and requires `https`. Webhook URLs/headers never resolve `env:`.
- **MCP is off by default.** Enable it only when you need it, and only with a token — see
  [MCP integration](#mcp-integration).
- **The database is sensitive.** `sentinello.sqlite` holds notification configs and all findings.
  Restrict access to the `sentinello-data` volume.
- **Pin a digest in production.** Prefer `image: ghcr.io/walkofcode/sentinello:vX.Y.Z@sha256:…` over
  `:latest` so a re-pull can't silently swap the image — see [Image tags](#image-tags).

## Vulnerability sources

Out of the box Sentinello scans with **npm audit** (npm / pnpm / yarn audit against each project's
lockfile) — the GitHub Advisory feed those tools carry. That source is always on and needs no setup.

**OSV** is an optional second source you enable in **Settings → Sources** (off by default). When on,
the worker downloads the [OSV](https://osv.dev) npm export and matches your resolved lockfile versions
against it directly. It adds two things npm audit alone doesn't give you:

- **CVEs npm audit misses** — OSV aggregates more feeds than the npm/GitHub advisory set.
- **Known-malicious packages** — OSV's `MAL-` records flag packages published with malware
  (typosquats, install-script payloads, registry-pollution campaigns). These surface as **critical**
  findings with a distinct "malicious" badge.

OSV findings that duplicate an npm-audit advisory (same GHSA/CVE on the same package) are suppressed,
so enabling OSV only **adds** net-new findings to the same triage queue.

**Provisioning.** Enabling OSV downloads the npm export (**~196 MB**) into the data volume on first
sync, then pulls ~daily incremental updates. The normalized cache (`osv.db`) is smaller (~40–80 MB)
and fully **rebuildable** — it's stored separately from `sentinello.sqlite`, so deleting it never
touches your findings, and it's excluded from a lean DB backup. The Settings panel shows the last
refresh, the cached-advisory count, and a free-space hint, and runs a free-space pre-flight before the
first download. For a fully air-gapped install, leave the source off (or set `SENTINELLO_OSV_FEED_URL=off`)
and Sentinello makes no OSV network calls at all.

## Notifications & webhooks

Configure delivery targets in **Settings → Notifications**. Three channel kinds are supported —
**Slack** (incoming webhook), **Telegram** (bot token + chat id), and a generic **webhook**.
Each target carries a severity filter and a **scope**: leave it at "everything", or narrow it to
specific **roots** and/or individual **projects** (e.g. wire one noisy project to its own channel).
One message is sent per project per scan.

The generic webhook has two **payload flavors**:

- **Structured JSON** — for an auto-fix agent to act on. Shape:

  ```json
  {
    "event": "findings",
    "isBaseline": false,
    "root":    { "id": "...", "label": "...", "path": "/roots/..." },
    "project": { "id": "...", "name": "my-app", "relPath": "apps/web", "packageManager": "pnpm" },
    "portalUrl": "https://host/projects/<id>",
    "vulnerabilities": [
      {
        "library": "uuid",
        "version": "8.0.0",
        "recommendedVersion": "9.0.0",
        "fixAvailable": true,
        "severity": "moderate",
        "advisory": { "id": "1119441", "title": "...", "url": "https://..." },
        "vulnerableRange": "<9.0.0",
        "isProd": true,
        "isDev": false,
        "depPath": ["express", "uuid"]
      }
    ]
  }
  ```

  Scan-failure events arrive as `{ "event": "scan_failure", "failureSignature": "...", "vulnerabilities": [] }`.

- **Plain-text advisory** — POSTs `{ "text": "<markdown>" }` containing the same advisory export the
  portal produces (**Settings → Export**), ready to pipe straight into an LLM to triage and fix.

Slack URLs and Telegram credentials may be literals or `env:NAME` references resolved from the
container environment (handy for keeping secrets out of the database; the destination there is fixed
to `slack.com` / `api.telegram.org`). **Generic webhook URLs and headers are sent literally — they do
not resolve `env:`**, so a webhook target can never be turned into a way to read the container's
environment.

> A webhook POSTs to whatever host you point it at. Sentinello rejects non-`http(s)` schemes and
> link-local / cloud-metadata addresses (e.g. `169.254.169.254`) at dispatch, and never follows
> redirects. Set `SENTINELLO_WEBHOOK_STRICT=true` to also reject private (RFC-1918) targets and
> require `https`. On a shared network, don't aim a target at an internal-only service you don't
> trust to receive scan payloads.

## MCP integration

Sentinello exposes a [Model Context Protocol](https://modelcontextprotocol.io) server at
`POST /api/mcp` so Claude Desktop, Cursor, and other MCP-aware clients can query roots, projects,
findings, scans, and libraries — and trigger scans, mute findings, or rename projects — without
leaving the chat.

1. Generate a bearer token from **Settings → MCP** (the page also shows the server URL to paste
   into your client) — or set `SENTINELLO_MCP_API_TOKEN` in the container environment; env wins
   over the UI value.
2. Add Sentinello to your MCP client config. Example for Claude Desktop
   (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

   ```json
   {
       "mcpServers": {
           "sentinello": {
               "url": "http://localhost:3870/api/mcp",
               "headers": { "Authorization": "Bearer <your-token>" }
           }
       }
   }
   ```

The endpoint is **disabled by default**. Set `SENTINELLO_MCP_ENABLED=true` to turn it on — a bearer
token is then **mandatory**: set `SENTINELLO_MCP_API_TOKEN` (or generate one in **Settings → MCP**),
and until one is configured the endpoint refuses every request. Requests without a valid token return
401; when disabled the route returns 404. The token grants read **and** write tools (trigger scans,
mute findings, rename projects), so treat it like an admin credential.

## Scan schedule

**Settings → Schedule** sets the sweep cadence (1h / 3h / 6h / 12h / 24h). For any interval other
than 1h you can also pick a **start hour** (0–23) plus a **timezone** the start hour is interpreted
in (defaults to the server's timezone), so the cadence is anchored to a chosen time of day — e.g. 6h
starting at 02:00 in `Europe/Madrid` runs at 02:00, 08:00, 14:00, 20:00 Madrid time. Changes take
effect within ~5s — no container restart required.

## Volumes

- `/app/data` — the SQLite DB plus its WAL/SHM siblings and the worker lock.
  Mount this to persist state across restarts. When the **OSV source** is enabled
  this also holds the rebuildable `osv.db` advisory cache (~40–80 MB); size the
  volume with that in mind (the initial OSV download is ~196 MB).
- `/home/sentinello/.nvm` — Node versions installed on demand by `nvm` for
  projects that pin one via `.nvmrc`. Persist it so each version downloads only
  once (the image's baked-in Node 24.14.0 is seeded into the volume on first
  create). Mount path moved from `/root/.nvm` in the non-root release — see
  [Upgrading](#upgrading) if you ran an earlier image.
- `/roots/<name>` (read-only) — mount each code portfolio root you want
  scanned. Every subdirectory of `/roots` is auto-registered as a root on boot
  (the directory name becomes its label); no **Settings → Roots** step needed.
  `/roots` is optional — add roots from the portal instead if you prefer.
  Reconciliation is two-way: a `/roots/<name>` whose host mount disappeared
  between boots is removed at the next worker start, together with every
  project, scan, finding, and notification record under it.

> **Projects are kept only while they exist on disk.** When a sweep finds a previously-known project
> gone from a root it walked, Sentinello **deletes** that project and all of its history (scans,
> findings, notification state) — there is no "missing" tombstone. For Docker mounts under
> `/roots/<name>`, the same applies to the **root itself** at worker boot — an unmounted
> `/roots/<name>` is purged with all its history. Roots **outside** `/roots/` (manually added in
> the portal, or seeded from `sentinello.config.yaml`) are never auto-pruned — a temporarily
> unmounted manual root is skipped, not reconciled, so its projects survive the outage and
> reappear on the next sweep once the mount is back.

## Operating

### Health

The container exposes `GET /api/health` (runs a `SELECT 1` against SQLite) and
ships a `HEALTHCHECK`, so compose / k8s / Portainer can detect a wedged process.
It returns only liveness + DB status — the running version is served separately
at `GET /api/version`, so the unauthenticated health probe doesn't expose it.

### Platforms

`linux/amd64` and `linux/arm64` (multi-arch manifest — the correct architecture
is pulled automatically).

### Image tags

| Tag                | Points at                       | Use it when                              |
| ------------------ | ------------------------------- | ---------------------------------------- |
| `latest`           | newest stable release           | trying it out / you want auto-updates    |
| `vX.Y.Z`           | exact immutable release         | production — pin this                    |
| `vX.Y`             | latest patch within a minor     | track patches, hold the minor            |
| `sha-<short>`      | a specific commit build         | debugging / reproducing a single build   |

Pin a digest in production: `image: ghcr.io/walkofcode/sentinello:vX.Y.Z@sha256:<digest>` (copy the
digest from the release page) so a `docker compose pull` can't transparently swap the image.

## Upgrading

### Upgrading to the non-root image

This release runs Sentinello as an unprivileged user (`uid 10001`) and moves the nvm cache from
`/root/.nvm` to `/home/sentinello/.nvm`. Coming from an earlier (root) image:

1. **Update the nvm volume mount path** to `sentinello-nvm:/home/sentinello/.nvm` (the compose and
   `docker run` examples above already use it).
2. **Recreate the nvm cache volume** so it's owned by the new user — it's a pure cache, nothing is
   lost:

   ```bash
   docker compose down
   docker volume rm sentinello-nvm
   docker compose up -d
   ```

   The container refuses to start (with a clear message) if it still sees the old `/root/.nvm` mount
   or a root-owned nvm volume, so you can't accidentally run misconfigured.
3. **Fix ownership of the data volume** (your findings DB), which the old image created as root:

   ```bash
   docker run --rm -v sentinello-data:/d alpine chown -R 10001:10001 /d
   ```

   The worker fails fast with an explicit message if the data directory isn't writable by the new
   user — and `/api/health` now reports `"dataDir":"ro"` and returns HTTP 503 in that state (a
   read-only DB still answers `SELECT 1`, so the probe writes a temp file to catch it), so an
   orchestrator notices the half-up container too.

## Running with pm2 (without Docker)

Prefer to run Sentinello directly on a host instead of in a container? Both
processes are defined in `ecosystem.config.js`, so plain pm2 supervises them the
same way `pm2-runtime` does inside the image.

```bash
pnpm install
pnpm build
pm2 start ecosystem.config.js
```

This starts two processes — `sentinello-web` and `sentinello-worker` — both
pointing at the same SQLite file. The portal comes up on
**http://localhost:3870** by default (set `PORT` to change it).

Configure it with the same environment variables as the container
(`SENTINELLO_DB_PATH`, `ME_NAME`, `PORT`); export them before `pm2 start`.
There's no `/roots` auto-mount when running this way — add your code roots from
**Settings → Roots**.

Handy pm2 commands:

```bash
pm2 status                # process health
pm2 logs sentinello-web   # tail logs
pm2 restart ecosystem.config.js
pm2 stop ecosystem.config.js
pm2 startup && pm2 save    # survive reboots
```

Requires Node >= 24.14.0, pnpm >= 10.33.0, and pm2 (`npm install -g pm2`).

## Development

```bash
pnpm install
pnpm dev
```

Requires Node >= 24.14.0 and pnpm >= 10.33.0. See [`CONTRIBUTING.md`](CONTRIBUTING.md)
for development setup, contribution conventions, and the release process.

## Legal

By using Sentinello you accept the **Terms and Conditions**, **Privacy Policy**, and **Disclaimer**.
The software is released under the **MIT License** (see [`LICENSE`](LICENSE)).

The full legal documents are served by the portal at `/legal/terms`, `/legal/privacy`, and
`/legal/disclaimer`, and are linked from the in-app **About** page.
