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

Include the version (footer or `GET /api/health`), reproduction steps, and the
impact you observed. We aim to acknowledge within 5 business days and to ship a
fix or mitigation as quickly as the severity warrants. We'll credit you in the
release notes unless you'd rather stay anonymous.

## Threat model

Sentinello is **self-hosted and single-user by design — it ships with no
authentication.** The portal and its server actions assume the operator already
controls access at the network layer. Run it on a trusted host or behind your
own reverse proxy / VPN / auth gateway; do **not** expose it directly to the
public internet.

A few specifics worth knowing:

- **Filesystem access.** The worker scans whatever you mount under `/roots`, and
  the portal can browse directories the server process can read. Mount roots
  read-only and don't run the container as a more privileged user than you need.
- **Outbound webhooks.** Notification targets POST to whatever URL you configure.
  On a shared network, don't point a target at an internal-only service you
  don't trust to receive scan payloads.
- **Secrets.** Store notification tokens as `env:NAME` references rather than raw
  values where you can. Sentinello redacts known secret shapes from logs and
  persisted error text, but treat the SQLite database as sensitive.
