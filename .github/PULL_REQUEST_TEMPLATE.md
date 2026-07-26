<!-- Thanks for contributing! A short summary helps reviewers. -->

## Summary

<!-- What does this PR do, and why? -->

## Checklist

- [ ] Commit subjects follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, …) — non-conforming commits are silently dropped from the changelog.
- [ ] `pnpm test`, `pnpm typecheck` and `pnpm lint` pass. (CI runs these too — this is just the fast local loop.)
- [ ] Behaviour changes come with tests, and any test added stays offline: no network, no `npm`/`pnpm` spawn, no dependency on `pnpm demo:gen` output.
- [ ] Operator-facing changes (env vars, volumes, scanner behavior) are reflected in `README.md` **and** `docs/docker/*`.
- [ ] DB schema changes generated via `pnpm --filter @sentinello/db db:generate` (no hand-written SQL or snapshots).
- [ ] No secrets, tokens, or personal hostnames added.
