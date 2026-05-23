# Contributing

Thanks for your interest in Sentinello! Contributions of all sizes are welcome —
bug reports, fixes, features, and documentation improvements.

By participating you agree to abide by the [Code of Conduct](CODE_OF_CONDUCT.md).
For security issues, please follow the [Security Policy](SECURITY.md) instead of
opening a public issue.

## Getting started

1. Fork the repo and create a topic branch.
2. Install dependencies with `pnpm install` (Node >= 24.14.0, pnpm >= 10.33.0).
3. Run the app locally with `pnpm dev`.
4. Make your change, then run `pnpm typecheck` and `pnpm lint` before pushing.
5. Open a pull request and fill out the template.

## Reporting bugs and requesting features

Use the issue templates under **Issues → New issue**. Please include the version
(shown in the portal footer, or `GET /api/health`), reproduction steps, and what
you expected to happen.

## Commit messages

This project uses [Conventional Commits](https://www.conventionalcommits.org/)
(`feat:`, `fix:`, `docs:`, etc.) so releases and the changelog can be generated
automatically. Non-conforming commits are silently dropped from the changelog —
the PR template has a checklist reminder.

## Pull requests

- Keep changes focused; one logical change per PR.
- Update `README.md` and `docs/docker/*` in the same PR for any operator-facing
  change (env vars, volumes, scanner behavior).
- Be patient with review — this is a small project.
