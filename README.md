<p align="center">
  <img src="apps/web/public/sentinello-logo.png" alt="Sentinello" width="120" height="120" />
</p>

# Sentinello

**An early-warning system for the dependencies you stopped watching.**

In the AI age you ship more projects than you can maintain — the marketing
site, the client dashboard, the side project that quietly went to production. They
keep running long after anyone last looked at them, and a single forgotten
dependency with a critical CVE is all it takes to turn the simplest site into the
way in.

Sentinello is a self-hosted portal that continuously scans the repositories you
point it at, surfaces known CVEs in their dependencies, and gives you **one triage
queue across every project** — instead of `npm audit` output scattered across a
dozen checkouts, or finding out about a CVE from a headline days too late.

It scans **JavaScript** out of the box and can also scan **Python, Go, and Rust**
once you enable their sources in **Settings → Sources** (off by default). One
project can span several ecosystems at once; findings land in the same queue
regardless of language.

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
   known CVEs on a schedule. For the **npm-audit** path it installs the Node
   version each project pins via `.nvmrc` when it needs to (the `sentinello-nvm`
   volume persists those so each version downloads only once); `nvm` is used only
   on that path — the Python/Go/Rust sources resolve dependencies offline from
   lockfiles and never invoke `nvm`.
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
| `SENTINELLO_PORTAL_BASE_URL` | `http://localhost:3870`       | External URL used in notification links. When set it is authoritative — re-applied on every boot and shown read-only in **Settings → Advanced**. Leave it unset to manage the value from that page instead |
| `ME_NAME`                    | `anonymous`                   | Display name / owner label                    |
| `SENTINELLO_PORTAL_TOKEN`    | _(unset)_                     | When set, requires login at `/login` with this token before any route (except the health check) is reachable. Unset = no auth. See [Running it safely](#running-it-safely) |
| `SENTINELLO_VERSION`         | `dev`                         | Version label in the footer / `/api/version`; baked into the image at build time |
| `SENTINELLO_UPDATE_FEED_URL` | GitHub Releases API           | Update-check feed; set to `off` to disable update checks |
| `SENTINELLO_WEBHOOK_STRICT`  | _(unset)_                     | Set to `true` to reject webhook targets aimed at private (RFC-1918) / loopback addresses and require `https`. Link-local / cloud-metadata targets are always rejected regardless |
| `SENTINELLO_OSV_FEED_URL`    | OSV GCS bucket                | OSV advisory export base URL (only used when an **OSV** cell is enabled); set to `off` to disable all OSV network access. Per-ecosystem exports are fetched from `<base>/<ecosystem>/all.zip` (`npm`, `PyPI`, `Go`, `crates.io`) |
| `SENTINELLO_OSV_DB_PATH`     | `<data dir>/osv.db`           | Location of the rebuildable OSV advisory cache (defaults next to the main DB) |
| `SENTINELLO_GEMNASIUM_FEED_URL` | GitLab gemnasium-db archive | gemnasium advisory archive URL (only used when a **GitLab gemnasium** cell is enabled); set to `off` to disable all gemnasium network access |
| `SENTINELLO_GEMNASIUM_DB_PATH`  | `<data dir>/gemnasium.db`   | Location of the rebuildable gemnasium advisory cache (defaults next to the main DB) |

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
- **Only mount roots you trust.** On the **npm-audit** path Sentinello runs `npm/pnpm/yarn audit`
  inside mounted roots. Audit is read-only and does **not** run package lifecycle scripts, but a
  hostile `.npmrc` could still redirect registry lookups — treat roots like code you'd run locally, and
  mount them read-only. The Python/Go/Rust sources only **read** lockfiles (matched offline against the
  local advisory cache) and run no package-manager command in the root.
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

**Settings → Sources** is a **Languages × Sources matrix**: rows are languages (JavaScript, Python,
Go, Rust) and each cell is an advisory source that answers for that language. You enable sources
per-language, and an **"always a source on" invariant** stops you disabling the last active cell, so
the system is never left source-blind.

- **JavaScript** ships **npm audit** on by default (now toggleable), plus optional **OSV** and
  **GitLab gemnasium** cells.
- **Python, Go, and Rust** default **off**. Each offers **OSV** (the default cell) plus optional
  **GitLab gemnasium**.

**npm audit** runs the package manager's own audit (npm / pnpm / yarn audit against each project's
lockfile) — the GitHub Advisory feed those tools carry. It needs no provisioning.

**OSV** and **GitLab gemnasium** are **cache-backed**: the worker downloads the advisory feed once,
keeps a local normalized cache, and then matches **offline** — it parses each project's lockfile,
resolves the installed versions, and matches them against the cached advisories. No per-project
network calls are made at scan time. OSV adds two things npm audit alone doesn't give you:

- **CVEs npm audit misses** — [OSV](https://osv.dev) aggregates more feeds than the npm/GitHub
  advisory set.
- **Known-malicious packages** — OSV's `MAL-` records flag packages published with malware
  (typosquats, install-script payloads, registry-pollution campaigns). These surface as **critical**
  findings with a distinct "malicious" badge. The installed version is matched against the advisory's
  specific compromised versions, so a clean or already-remediated version of a once-compromised package
  is **not** flagged.

Findings that duplicate a higher-priority source (same advisory on the same package — e.g. an OSV or
gemnasium hit that npm audit already reported) are suppressed, so enabling an extra source only
**adds** net-new findings to the same triage queue.

### Coverage — read this before you rely on the non-JS sources

Exact scanning needs a **true lockfile**. Where one exists (`package-lock.json` / `pnpm-lock.yaml` /
`yarn.lock`, `poetry.lock` / `Pipfile.lock` / `uv.lock`, `Cargo.lock`) Sentinello resolves exact
installed versions and audits them fully. Where it doesn't, coverage is **honestly partial** — and a
scan reports its coverage state per ecosystem (`ok` / `partial` / `unauditable`) rather than implying
full resolution:

- **`requirements.txt`** is audited for **pinned (`==`) entries only**. Unpinned, ranged, editable
  (`-e`), or `-r`/`-c`-included entries can't be resolved to an exact version offline and are reported
  as partial / unauditable, not silently passed.
- **Go** coverage is a documented **conservative offline subset** — the offline module graph isn't
  guaranteed complete, so Go scans can report a partial graph.

"Polyglot" here means Sentinello *discovers and scans* these ecosystems — it does **not** mean every
manifest yields a full, exact dependency graph.

### Scan reason codes for the non-JS sources

Alongside the existing npm/OSV reason codes, scans surface these operator-visible states (localized in
the UI and in failure notifications):

- **`partial_dependency_graph`** — some dependencies resolved to exact versions, others could not
  (e.g. a `requirements.txt` mixing `==` pins with ranges; Go's offline graph isn't guaranteed full).
- **`ambiguous_dependency_spec`** — a manifest exists but pins nothing auditable (all ranges / markers
  / editable / `-r`/`-c` includes), so no exact version could be extracted.
- **`unsupported_lockfile`** — a manifest/lockfile format Sentinello doesn't yet parse for that
  ecosystem.
- **`ecosystem_source_disabled`** — an ecosystem's manifests were found but no source is enabled for
  it, so it can't be audited.
- **`gemnasium_db_not_seeded` / `gemnasium_db_unavailable`** — the gemnasium cache hasn't been
  downloaded yet, or couldn't be opened (mirrors `osv_db_not_seeded` / `osv_db_unavailable`).

**Provisioning.** Enabling **OSV** downloads the per-ecosystem export(s) into the data volume on first
sync (the npm export is **~196 MB**; each additional enabled ecosystem adds its own export), then pulls
~daily incremental updates. Enabling **GitLab gemnasium** downloads its advisory archive from
`gitlab.com` (tens of MB; re-downloaded whole on each sync since it ships no delta feed). Both
normalized caches (`osv.db`, `gemnasium.db`) are fully **rebuildable** and stored separately from
`sentinello.sqlite`, so deleting either never touches your findings, and they're excluded from a lean
DB backup. The Settings panel shows the last refresh, the cached-advisory count, and a free-space hint,
and runs a free-space pre-flight before the first download. For a fully air-gapped install, leave these
sources off (or set `SENTINELLO_OSV_FEED_URL=off` / `SENTINELLO_GEMNASIUM_FEED_URL=off`) and Sentinello
makes no OSV/gemnasium network calls at all.

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
`POST /api/mcp` so Claude Code, Codex, Cursor, Claude Desktop, and other MCP-aware clients can query
roots, projects, findings, scans, and libraries — and trigger scans, mute findings, or rename
projects — without leaving the chat.

**The endpoint is off until you generate a token — the bearer token is the on/off switch.** No env
vars are involved. Go to **Settings → MCP**, click **Generate token**, and the endpoint goes live
immediately; **Clear token** turns it off again (it then returns 404). The page shows the server URL
and ready-to-paste config for Claude Code, Codex, Cursor, and Claude Desktop with your token filled
in. Authentication is `Authorization: Bearer <token>`; a wrong/missing token returns 401, no token at
all returns 404. The token grants read **and** write tools (trigger scans, mute findings, rename
projects), so treat it like an admin credential.

Examples (replace `<token>` with the value from **Settings → MCP**):

- **Claude Code** —
  ```bash
  claude mcp add --transport http sentinello http://localhost:3870/api/mcp \
    --header "Authorization: Bearer <token>"
  ```
- **Codex** (`~/.codex/config.toml`) — Codex reads the token from an env var you name:
  ```toml
  [mcp_servers.sentinello]
  url = "http://localhost:3870/api/mcp"
  bearer_token_env_var = "SENTINELLO_MCP_TOKEN"
  ```
  then export `SENTINELLO_MCP_TOKEN=<token>` in your shell.
- **Cursor / Claude Desktop** (`.cursor/mcp.json`, `claude_desktop_config.json`):
  ```json
  {
      "mcpServers": {
          "sentinello": {
              "url": "http://localhost:3870/api/mcp",
              "headers": { "Authorization": "Bearer <token>" }
          }
      }
  }
  ```

## Scan schedule

**Settings → Schedule** sets the sweep cadence (1h / 3h / 6h / 12h / 24h). For any interval other
than 1h you can also pick a **start hour** (0–23) plus a **timezone** the start hour is interpreted
in (defaults to the server's timezone), so the cadence is anchored to a chosen time of day — e.g. 6h
starting at 02:00 in `Europe/Madrid` runs at 02:00, 08:00, 14:00, 20:00 Madrid time. Changes take
effect within ~5s — no container restart required.

## Volumes

- `/app/data` — the SQLite DB plus its WAL/SHM siblings and the worker lock.
  Mount this to persist state across restarts. When **OSV** is enabled this also
  holds the rebuildable `osv.db` advisory cache; that cache **grows per enabled
  ecosystem** (the initial npm export is ~196 MB, each additional enabled language
  adds its own export). When **GitLab gemnasium** is enabled it also holds the
  separate rebuildable `gemnasium.db` cache. Both caches are stored apart from
  `sentinello.sqlite` and are safe to delete — size the volume with the enabled
  sources in mind.
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
   lost. **Mind the volume name:** Docker Compose prefixes named volumes with the project name (the
   compose directory's name), so yours is usually `<project>_sentinello-nvm`, *not* a bare
   `sentinello-nvm`. Deleting the wrong one silently leaves the offending volume in place and you'll
   hit the guard again — so look it up first:

   ```bash
   docker compose down
   docker volume ls | grep sentinello           # find your real volume name(s)
   docker volume rm <project>_sentinello-nvm     # e.g. docker_sentinello-nvm
   docker compose up -d
   ```

   The container refuses to start (with a clear message) if it still sees the old `/root/.nvm` mount
   or a root-owned nvm volume, so you can't accidentally run misconfigured.
3. **Fix ownership of the data volume** (your findings DB), which the old image created as root. Use
   the same project-prefixed name here too:

   ```bash
   docker run --rm -v <project>_sentinello-data:/d alpine chown -R 10001:10001 /d
   ```

   The worker fails fast with an explicit message if the data directory isn't writable by the new
   user — and `/api/health` now reports `"dataDir":"ro"` and returns HTTP 503 in that state (a
   read-only DB still answers `SELECT 1`, so the probe writes a temp file to catch it), so an
   orchestrator notices the half-up container too.
4. **Check your port binding.** The compose and `docker run` examples now bind
   `127.0.0.1:3870:3000` (localhost-only) instead of `3870:3000`. Pulling the image doesn't rewrite a
   mapping you already have, but if you adopt the new examples and reach the portal from another host,
   drop the `127.0.0.1:` prefix — and put auth (`SENTINELLO_PORTAL_TOKEN` or a reverse proxy) in
   front first.

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
