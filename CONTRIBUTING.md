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
4. Make your change, then run `pnpm test`, `pnpm typecheck` and `pnpm lint` before pushing.
5. Open a pull request and fill out the template. CI runs the same checks on every PR.

## Tests

```bash
pnpm test              # unit + integration, offline, ~1s
pnpm test:watch        # the same suite in watch mode
pnpm test:coverage     # adds a merged coverage report in coverage/
pnpm test:e2e          # Playwright against a built portal (needs browsers, see below)
```

Tests live **beside the code they cover**, as `src/**/*.test.ts`. That placement is
deliberate: the existing per-package `tsconfig` already includes `src/**/*.ts`, so
`pnpm typecheck` checks your tests too, and `eslint .` already lints them.

The suite is **hermetic** — it never touches the network and never shells out to a
package manager. Two rules keep it that way, and both are worth knowing before you
add a test:

- **Fixtures are frozen on both sides.** Advisory records *and* lockfiles are pinned,
  so `known lockfile + known advisory = exactly these findings`, permanently. Do not
  point a test at `pnpm demo:gen` output: it resolves against the live npm registry,
  `demo-projects/` is gitignored so it does not exist in CI, and the findings drift as
  new advisories are published. The demo projects are for the manual Docker demo only.
- **Filesystem fixtures are built at runtime**, from specs held in the test file. A
  committed `.gitignore` inside a fixture would apply to this repository (git would
  refuse to track the files the test needs), and a committed `.git` directory is
  impossible — git treats a nested one as a submodule.

For end-to-end runs, install the browser once with
`pnpm exec playwright install --with-deps chromium`. pnpm blocks Playwright's
post-install script by default, which is why this step is explicit.

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
