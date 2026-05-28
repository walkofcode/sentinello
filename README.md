<p align="center">
  <img src="apps/web/public/sentinello-logo.png" alt="Sentinello" width="120" height="120" />
</p>

# Sentinello

**Centralized dependency-vulnerability monitoring for your entire code portfolio.**

Sentinello is a self-hosted portal that continuously scans the repositories you
point it at, surfaces known CVEs in their dependencies, and gives you one triage
queue across every project — instead of `npm audit` output scattered across a
dozen checkouts.

Single image, single SQLite file, no external services. The web portal and the
background scan worker run together under `pm2-runtime`.

- **Website:** https://sentinello.org
- **Issues:** https://github.com/walkofcode/sentinello/issues
- **License:** MIT · Walk of Code LLC

---

## Quick start

> **Local/trusted-network only:** Sentinello does not include built-in authentication. If you run it
> on a shared or public host, bind it to localhost or put it behind your VPN / reverse-proxy auth.

```bash
docker run -d \
  --name sentinello \
  -p 3870:3000 \
  -v sentinello-data:/app/data \
  -v sentinello-nvm:/root/.nvm \
  -v /path/to/your/code:/roots/personal:ro \
  ghcr.io/walkofcode/sentinello:latest
```

Open http://localhost:3870. Anything mounted under `/roots/<name>` is
**auto-registered as a root on startup** (the directory name becomes its label),
so discovery and scanning begin on their own — no manual setup. Mounting under
`/roots` is optional: you can also add roots from **Settings → Roots**.

The `sentinello-nvm` volume persists Node versions that `nvm` installs when a
project pins one via `.nvmrc`, so each version is downloaded only once.

Only mount code roots you trust. Sentinello runs package-manager audit commands
inside mounted projects, so treat roots like code you would run locally.

The image is mirrored on Docker Hub — swap `ghcr.io/walkofcode/sentinello` for
`walkofcode/sentinello` if you prefer pulling from there.

## docker compose

```yaml
services:
    sentinello:
        image: ghcr.io/walkofcode/sentinello:latest
        container_name: sentinello
        restart: unless-stopped
        ports:
            - '3870:3000'
        environment:
            SENTINELLO_DB_PATH: /app/data/sentinello.sqlite
            SENTINELLO_PORTAL_BASE_URL: http://localhost:3870
        volumes:
            - sentinello-data:/app/data
            - sentinello-nvm:/root/.nvm
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
| `SENTINELLO_VERSION`         | `dev`                         | Version label in the footer / `/api/health`; baked into the image at build time |
| `SENTINELLO_UPDATE_FEED_URL` | GitHub Releases API           | Update-check feed; set to `off` to disable update checks |
| `SENTINELLO_MCP_ENABLED`     | `true`                        | Set to `false` to hide the `/api/mcp` endpoint entirely (404) |
| `SENTINELLO_MCP_API_TOKEN`   | _(unset)_                     | Bearer token for the MCP endpoint; overrides the one set in **Settings → MCP** |

### Language

The portal UI — including scan **reason codes** and **scan status** — is localized to the language
picked in the top-menu language switcher (10 languages). The language of **failure notifications**
(Slack / Telegram / webhook messages) is configured separately in **Settings → Advanced →
Notification language** (default English), since a notification has no per-viewer locale.

### Notifications & webhooks

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

URLs and secrets may be literals or `env:NAME` references resolved from the container environment.

> A webhook POSTs to whatever host you point it at. On a shared network, don't aim a target at an
> internal-only service you don't trust to receive scan payloads.

### MCP integration

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

The route is enabled by default. Set `SENTINELLO_MCP_ENABLED=false` to disable it entirely (the
endpoint then returns 404). Requests without a valid bearer token return 401.

### Scan schedule

**Settings → Schedule** sets the sweep cadence (1h / 3h / 6h / 12h / 24h). For any interval other
than 1h you can also pick a **start hour** (0–23) plus a **timezone** the start hour is interpreted
in (defaults to the server's timezone), so the cadence is anchored to a chosen time of day — e.g. 6h
starting at 02:00 in `Europe/Madrid` runs at 02:00, 08:00, 14:00, 20:00 Madrid time. Changes take
effect within ~5s — no container restart required.

### Volumes

- `/app/data` — the SQLite DB plus its WAL/SHM siblings and the worker lock.
  Mount this to persist state across restarts.
- `/root/.nvm` — Node versions installed on demand by `nvm` for projects that
  pin one via `.nvmrc`. Persist it so each version downloads only once (the
  image's baked-in Node 24.14.0 is seeded into the volume on first create).
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

## Health

The container exposes `GET /api/health` (runs a `SELECT 1` against SQLite) and
ships a `HEALTHCHECK`, so compose / k8s / Portainer can detect a wedged process.

## Platforms

`linux/amd64` and `linux/arm64` (multi-arch manifest — the correct architecture
is pulled automatically).

## Image tags

| Tag                | Points at                       | Use it when                              |
| ------------------ | ------------------------------- | ---------------------------------------- |
| `latest`           | newest stable release           | trying it out / you want auto-updates    |
| `vX.Y.Z`           | exact immutable release         | production — pin this                    |
| `vX.Y`             | latest patch within a minor     | track patches, hold the minor            |
| `sha-<short>`      | a specific commit build         | debugging / reproducing a single build   |

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
