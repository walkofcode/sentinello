# Sentinello

**Centralized dependency-vulnerability monitoring for your entire code portfolio.**

Sentinello is a self-hosted portal that continuously scans the repositories you
point it at, surfaces known CVEs in their dependencies, and gives you one triage
queue across every project — instead of `npm audit` output scattered across a
dozen checkouts.

Single image, single SQLite file, no external services. The web portal and the
background scan worker run together under `pm2-runtime`.

- **Source:** https://github.com/walkofcode/sentinello
- **Website:** https://sentinello.org
- **License:** MIT · Walk of Code LLC

---

## Quick start

> **Local/trusted-network only:** Sentinello has no built-in authentication by default. The command
> below binds to `127.0.0.1` so it's reachable only from the host. For a real login, set
> `SENTINELLO_PORTAL_TOKEN` and/or put it behind your VPN / reverse-proxy auth. The container runs as
> an unprivileged user (`uid 10001`).

```bash
docker run -d \
  --name sentinello \
  -p 127.0.0.1:3870:3000 \
  -v sentinello-data:/app/data \
  -v sentinello-nvm:/home/sentinello/.nvm \
  -v /path/to/your/code:/roots/personal:ro \
  walkofcode/sentinello:latest
```

Open http://localhost:3870. Anything mounted under `/roots/<name>` is
auto-registered as a root on startup (the directory name becomes its label), so
discovery and scanning begin on their own. Mounting under `/roots` is optional —
you can also add roots from **Settings → Roots**.

Only mount code roots you trust. Sentinello runs package-manager audit commands
inside mounted projects, so treat roots like code you would run locally.

## docker compose

```yaml
services:
    sentinello:
        image: walkofcode/sentinello:latest
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

## Configuration

| Variable                     | Default                       | Purpose                                       |
| ---------------------------- | ----------------------------- | --------------------------------------------- |
| `PORT`                       | `3000`                        | Web portal port inside the container          |
| `SENTINELLO_DB_PATH`         | `/app/data/sentinello.sqlite` | SQLite location (keep on the mounted volume)  |
| `SENTINELLO_PORTAL_BASE_URL` | `http://localhost:3870`       | External URL used in notification links. Authoritative when set (re-applied each boot, read-only in **Settings → Advanced**); leave unset to manage it from that page |
| `ME_NAME`                    | `anonymous`                   | Display name / owner label                    |
| `SENTINELLO_PORTAL_TOKEN`    | _(unset)_                     | When set, requires login at `/login` with this token before any route (except the health check). Unset = no auth |
| `SENTINELLO_VERSION`         | `dev`                         | Version label in the footer / `/api/version`; baked into the image at build time |
| `SENTINELLO_UPDATE_FEED_URL` | GitHub Releases API           | Update-check feed; set to `off` to disable update checks |
| `SENTINELLO_WEBHOOK_STRICT`  | _(unset)_                     | Set to `true` to reject private (RFC-1918) / loopback webhook targets and require `https`. Link-local / cloud-metadata is always rejected |
| `SENTINELLO_OSV_FEED_URL`    | OSV GCS bucket                | OSV advisory export base URL (only used when the **OSV source** is enabled); set to `off` to disable all OSV network access |
| `SENTINELLO_OSV_DB_PATH`     | `<data dir>/osv.db`           | Location of the rebuildable OSV advisory cache (defaults next to the main DB) |

### Vulnerability sources

**npm audit** is always on. **OSV** is an optional second source, enabled in **Settings → Sources**
(off by default): it matches your lockfiles against the [OSV](https://osv.dev) database, adding CVEs
npm audit misses and flagging **known-malicious** packages (`MAL-` records) as critical findings.
Enabling it downloads the OSV npm export (**~196 MB**) into the data volume, then ~daily incremental
updates; the normalized `osv.db` cache (~40–80 MB) is rebuildable and stored separately from your
findings. Leave it off (or set `SENTINELLO_OSV_FEED_URL=off`) for a fully air-gapped install.

### Language

The portal UI — including scan **reason codes** and **scan status** — is localized to the language
picked in the top-menu language switcher (10 languages). The language of **failure notifications**
(Slack / Telegram / webhook messages) is configured separately in **Settings → Advanced →
Notification language** (default English), since a notification has no per-viewer locale.

### Notifications & webhooks

Configure targets in **Settings → Notifications**: **Slack**, **Telegram**, or a generic
**webhook**. Each target has a severity filter and a **scope** — "everything", or specific **roots**
and/or individual **projects**. One message is sent per project per scan.

The generic webhook offers two **payload flavors**: **Structured JSON** (`{ root, project,
vulnerabilities[] }`, each vulnerability carrying library, version, recommended version, severity and
advisory — ready for an auto-fix agent), or **Plain-text advisory** (`{ "text": "<markdown>" }`, the
same advisory export the portal produces, ready to feed an LLM). Slack/Telegram credentials may be
literals or `env:NAME` references; **generic webhook URLs and headers are sent literally** (no `env:`
resolution), so a webhook can't be used to read the container environment.

> A webhook POSTs to whatever host you point it at. Sentinello rejects non-`http(s)` schemes and
> link-local / cloud-metadata addresses at dispatch and never follows redirects;
> `SENTINELLO_WEBHOOK_STRICT=true` also blocks private (RFC-1918) targets. On a shared network, don't
> aim a target at an internal-only service you don't trust to receive scan payloads.

### MCP integration

Sentinello hosts an MCP server at `POST /api/mcp` for Claude Code, Codex, Cursor, Claude Desktop,
and other MCP clients. **It needs no env vars** — generate a bearer token under **Settings → MCP**
and the endpoint goes live; the token is both the credential and the on/off switch (clear it and the
endpoint returns 404 again). The page shows the server URL and ready-to-paste config for each client.
Point your client at `http://localhost:3870/api/mcp` with `Authorization: Bearer <token>` (a
wrong/missing token returns 401, no token returns 404). The token grants read **and** write tools, so
treat it like an admin credential.

### Scan schedule

**Settings → Schedule** sets the cadence (1h/3h/6h/12h/24h). For intervals over 1h you can pick a
**start hour** (0–23) and a **timezone** it's interpreted in (defaults to the server's timezone) so
the cadence anchors to a chosen time of day. Changes take effect within ~5s — no container restart
required.

### Volumes

- `/app/data` — the SQLite DB plus its WAL/SHM siblings and the worker lock.
  Mount this to persist state across restarts. With the **OSV source** enabled
  it also holds the rebuildable `osv.db` cache (~40–80 MB; initial download ~196 MB).
- `/home/sentinello/.nvm` — Node versions installed on demand by `nvm` for
  projects that pin one via `.nvmrc`. Persist it so each version downloads only
  once (the image's baked-in Node 24.14.0 is seeded into the volume on first
  create). Moved from `/root/.nvm` in the non-root release: upgrading from an
  older image, delete the old cache volume so it is recreated owned by the runtime
  user (it's a pure cache — nothing is lost). With Docker Compose the volume is
  project-prefixed — `<project>_sentinello-nvm`, not a bare `sentinello-nvm` — so
  run `docker volume ls | grep sentinello` to find the exact name first. The
  container refuses to start if it detects the old root-owned volume.
- `/roots/<name>` (read-only) — mount each code portfolio root you want
  scanned. Every subdirectory of `/roots` is auto-registered as a root on boot
  (the directory name becomes its label), so no **Settings → Roots** step is
  needed. `/roots` is optional — add roots from the portal instead if you prefer.
  Reconciliation is two-way: a `/roots/<name>` whose host mount disappeared
  between boots is removed at the next worker start, together with every
  project, scan, finding, and notification record under it.

> **Projects are kept only while they exist on disk.** When a sweep finds a known project gone from a
> root it walked, Sentinello deletes it and all of its history (no "missing" tombstone). For Docker
> mounts under `/roots/<name>`, the same applies to the **root itself** at worker boot — an
> unmounted `/roots/<name>` is purged with all its history. Roots **outside** `/roots/` (manually
> added in the portal, or seeded from `sentinello.config.yaml`) are never auto-pruned — a
> temporarily unmounted manual root is skipped, not reconciled, so its projects survive the outage
> and reappear on the next sweep once the mount is back.

## Health

The container exposes `GET /api/health` (runs a `SELECT 1` against SQLite) and
ships a `HEALTHCHECK`, so compose / k8s / Portainer can detect a wedged process.
It returns only liveness + DB status — the running version is served separately at
`GET /api/version` so the unauthenticated probe doesn't expose it.

## Platforms

`linux/amd64` and `linux/arm64` (multi-arch manifest — the correct architecture
is pulled automatically).

## Tags

| Tag           | Points at                   | Use it when                            |
| ------------- | --------------------------- | -------------------------------------- |
| `latest`      | newest stable release       | trying it out / you want auto-updates  |
| `vX.Y.Z`      | exact immutable release     | production — pin this                  |
| `vX.Y`        | latest patch within a minor | track patches, hold the minor          |
| `sha-<short>` | a specific commit build     | debugging / reproducing a single build |
