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

> **Local/trusted-network only:** Sentinello does not include built-in authentication. If you run it
> on a shared or public host, bind it to localhost or put it behind your VPN / reverse-proxy auth.

```bash
docker run -d \
  --name sentinello \
  -p 3870:3000 \
  -v sentinello-data:/app/data \
  -v sentinello-nvm:/root/.nvm \
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

## Configuration

| Variable                     | Default                       | Purpose                                       |
| ---------------------------- | ----------------------------- | --------------------------------------------- |
| `PORT`                       | `3000`                        | Web portal port inside the container          |
| `SENTINELLO_DB_PATH`         | `/app/data/sentinello.sqlite` | SQLite location (keep on the mounted volume)  |
| `SENTINELLO_PORTAL_BASE_URL` | `http://localhost:3870`       | External URL used in notification links       |
| `ME_NAME`                    | `anonymous`                   | Display name / owner label                    |
| `SENTINELLO_VERSION`         | `dev`                         | Version label in the footer / `/api/health`; baked into the image at build time |
| `SENTINELLO_UPDATE_FEED_URL` | GitHub Releases API           | Update-check feed; set to `off` to disable update checks |

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
same advisory export the portal produces, ready to feed an LLM). URLs/secrets may be literals or
`env:NAME` references.

> A webhook POSTs to whatever host you point it at. On a shared network, don't aim a target at an
> internal-only service you don't trust to receive scan payloads.

### Scan schedule

**Settings → Schedule** sets the cadence (1h/3h/6h/12h/24h). For intervals over 1h you can pick a
**start hour** (0–23) and a **timezone** it's interpreted in (defaults to the server's timezone) so
the cadence anchors to a chosen time of day. Changes take effect within ~5s — no container restart
required.

### Volumes

- `/app/data` — the SQLite DB plus its WAL/SHM siblings and the worker lock.
  Mount this to persist state across restarts.
- `/root/.nvm` — Node versions installed on demand by `nvm` for projects that
  pin one via `.nvmrc`. Persist it so each version downloads only once (the
  image's baked-in Node 24.14.0 is seeded into the volume on first create).
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
