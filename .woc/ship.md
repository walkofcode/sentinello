# Ship recipe

## Landing branch

`main` (origin's default; the tracker project names no landing branch). Merged by a PR on green checks, as a merge
commit, never a squash:

```bash
gh pr list --repo walkofcode/sentinello --state open   # no release PR may be open; land it first
git push -u origin HEAD
gh pr create --repo walkofcode/sentinello --base main --title "<plain prose, not conventional>" --body "<summary>"
gh pr checks <pr> --repo walkofcode/sentinello --watch --fail-fast
gh pr merge <pr> --repo walkofcode/sentinello --merge
```

The branch already carries, before the PR opens: conventional commit subjects, a `Release-As: X.Y.Z` trailer on one
commit, and the `packages/core/src/releases.ts` entry for that version in all 10 locales, dated for merge day.

## Release

A push to `main` runs `.github/workflows/release-please.yml`, which opens the release PR `chore(main): release X.Y.Z`.
Merging it creates the `vX.Y.Z` tag and GitHub Release, and dispatches `publish-image.yml` and `publish-npm.yml` against
the tag. Run each wait in the background:

```bash
gh pr list --repo walkofcode/sentinello --state open --search "release in:title"
gh pr checks <release-pr> --repo walkofcode/sentinello --watch --fail-fast
gh pr merge <release-pr> --repo walkofcode/sentinello --merge
gh release view vX.Y.Z --repo walkofcode/sentinello
gh run list --repo walkofcode/sentinello --workflow publish-image.yml --limit 1
gh run watch <run> --repo walkofcode/sentinello --exit-status
gh run list --repo walkofcode/sentinello --workflow publish-npm.yml --limit 1
gh run watch <run> --repo walkofcode/sentinello --exit-status
```

## Deploy

On mini, the only machine that carries the app:

```bash
appctl update sentinello
```

## Check after the deploy

`appctl update` has exited 0 on a failed checkout, and `/api/health` reports no version, so read the version:

```bash
appctl status sentinello                                 # deployed: vX.Y.Z, worktree: vX.Y.Z, health 200
git -C ~/Apps/sentinello/repo log --oneline -1           # the release's merge commit
jq -r .version ~/Apps/sentinello/repo/package.json       # X.Y.Z
curl -sS -m 5 http://127.0.0.1:3886/api/health           # "ok":true
npm view sentinello@X.Y.Z version                        # X.Y.Z
```

## Project specifics

- Never hand-bump `package.json#version`, hand-edit `CHANGELOG.md` below its seed header, or push a tag: release-please
  owns all three.
- A later release-notes commit on the branch is `docs(releases):`, never `chore`, which release-please hides.
- The gate CI enforces is `pnpm lint`, `pnpm typecheck`, `pnpm test:coverage` (100% thresholds; `pnpm test` skips them),
  `pnpm build`, and `pnpm test:e2e`. CI also builds the container image; never build it locally.
- `~/Apps/sentinello/data` holds the live DB and is never touched by a deploy. Port 3886 stays: the public tunnel depends
  on it.
- Roll back with `appctl rollback sentinello`. Never re-cut a published tag; ship a new patch version.
