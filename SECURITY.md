# Security Policy

## Supported versions

Security fixes land on the latest released version. Run the most recent
`vX.Y.Z` (or `latest`) image to stay covered — older tags are not patched.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through either channel:

- **GitHub Security Advisories** — open a draft advisory at
  <https://github.com/walkofcode/sentinello/security/advisories/new>.
- **Email** — <info@sentinello.org>.

Include the version (footer or `GET /api/version`), reproduction steps, and the
impact you observed. We aim to acknowledge within 5 business days and to ship a
fix or mitigation as quickly as the severity warrants. We'll credit you in the
release notes unless you'd rather stay anonymous.

## Threat model

Sentinello is **self-hosted and single-user by design.** The portal and its
server actions assume the operator controls access at the network layer. Run it
on a trusted host or behind your own reverse proxy / VPN / auth gateway; do
**not** expose it directly to the public internet.

By default the portal ships with **no built-in authentication**. You can turn on
a lightweight login gate by setting `SENTINELLO_PORTAL_TOKEN` — when set, every
route except the container health check redirects to `/login` until the token is
entered (it is stored as an HMAC session cookie, never raw). This is a single
shared secret, not multi-user auth; a reverse proxy / VPN in front is still
recommended for anything beyond a trusted LAN.

A few specifics worth knowing:

- **Non-root container.** The image runs as an unprivileged user (`uid 10001`);
  the web server, worker, and every package-manager audit subprocess run as that
  user, never root. The compose file additionally sets `no-new-privileges` and
  drops all Linux capabilities. Keep mounted roots read-only.
- **Filesystem access.** The worker scans whatever you mount under `/roots`, and
  the portal can browse directories the server process can read. Sentinello only
  ever runs `npm/pnpm/yarn audit` (read-only metadata queries — audit does **not**
  execute package lifecycle scripts), but a malicious `.npmrc` in a mounted root
  could still redirect registry lookups, so treat roots like code you would run
  locally.
- **Outbound webhooks.** Notification targets POST to whatever URL you configure.
  Sentinello rejects non-`http(s)` schemes and link-local / cloud-metadata
  addresses (e.g. `169.254.169.254`) at dispatch, and does not follow redirects.
  Set `SENTINELLO_WEBHOOK_STRICT=true` to additionally reject all private
  (RFC-1918) targets and require `https`. On a shared network, don't point a
  target at an internal-only service you don't trust to receive scan payloads.
- **Secrets.** Webhook URLs and headers are sent **literally** — they do not
  resolve `env:` references, so a notification target can never be used to read
  the container's environment. Slack and Telegram targets still accept `env:NAME`
  for their own credential fields (the destination there is fixed to
  `slack.com` / `api.telegram.org`). Sentinello redacts known secret shapes from
  logs and persisted error text, but treat the SQLite database as sensitive and
  restrict access to its volume.
- **MCP endpoint.** `/api/mcp` is **off until you generate a bearer token** in
  Settings → MCP — the token is the on/off switch and the credential (no env vars
  involved). With no token the endpoint returns 404; with a wrong/missing token it
  returns 401. The token grants both read and write tools, so treat it like an
  admin credential, and clear it from Settings → MCP to turn the endpoint off.
