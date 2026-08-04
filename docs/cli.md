# Sentinello CLI

`npx sentinello` runs the same scanners as the portal, in whatever folder you are standing in, and
writes a markdown advisory you can hand to an agent. No server, no database, no history.

```bash
npx sentinello
```

## What it does

1. **Walks the directory** for projects — any directory holding a `package.json`. Descent stops at the
   first manifest, so a monorepo root is one project, not one per workspace package.
2. **Refreshes the advisory cache**, incrementally and almost for free (see below).
3. **Scans each project** with npm audit, OSV, and GitLab gemnasium, deduplicating across them with npm
   audit treated as authoritative.
4. **Writes the advisory** — findings ordered by severity across every project, each tagged with the
   project it came from, preceded by a remediation prompt.

Scope is JavaScript and TypeScript (npm, pnpm, yarn berry). The portal's Python, Go, and Rust support has
not yet reached the CLI.

## Output

Output follows the pipe:

```bash
npx sentinello                          # TTY: summary + sentinello-<dir>-advisories-<date>.md
npx sentinello | claude -p "$(cat -)"   # piped: pure markdown on stdout
npx sentinello --out report.md          # explicit file
npx sentinello --out -                  # force stdout
npx sentinello --json                   # machine-readable
```

Every status line goes to stderr, so a piped document is never contaminated — there are no ANSI escapes
on stdout even when the terminal is colourful.

## The remediation prompt

The advisory leads with a prompt telling an agent how to approach the work: triage everything before
changing anything, prefer upgrading a parent over forcing an override, verify fixes in the lockfile
rather than the manifest, respect the project's minimum-release-age policy, and never close a finding by
muting it. It is the same prompt the portal's Export button uses.

```bash
npx sentinello --print-prompt > my-prompt.md   # start from the built-in and edit
npx sentinello --prompt ./my-prompt.md         # use yours
npx sentinello --no-prompt                     # findings only
```

## The advisory cache

The first run downloads the advisory databases and **asks first**, quoting the size:

```
  First run — the advisory databases need downloading.

    OSV  203.4 MB
    GitLab gemnasium  ~80.0 MB
```

A figure marked `~` is an estimate. OSV's is exact — it comes from a `HEAD` on the export. GitLab
generates repository archives on demand and advertises no length up front, so gemnasium's is the
measured size of a recent archive, the same constant the portal quotes for that download.

`--yes` accepts without asking, which is what you want in CI or after the first time. In a
non-interactive shell the CLI refuses to download unless `--yes` is given, so a build machine never pulls
hundreds of megabytes by surprise.

After that, every run refreshes incrementally, and this is cheap enough that there is no separate `sync`
command:

| source | check | cost when nothing changed |
|---|---|---|
| OSV | conditional GET on `modified_id.csv` | HTTP 304, no payload |
| gemnasium | the gemnasium-db HEAD commit sha | about a kilobyte |

A typical repeat scan completes in around a second. When something has changed, only the changed
advisories are fetched — not the whole corpus.

The cache lives in `$SENTINELLO_CACHE_DIR`, else `$XDG_CACHE_HOME/sentinello`, else
`~/.cache/sentinello`. Deleting it costs nothing but a re-download.

## Scope control

```bash
npx sentinello ~/Developer              # scan a whole folder of repositories
npx sentinello --depth 1                # only immediate subdirectories
npx sentinello --depth 0                # only this directory
npx sentinello --exclude 'archive/**'   # repeatable, or comma-separated
```

`.gitignore` and `.sentinelloignore` are always honoured — see
[What counts as a project](../README.md#what-counts-as-a-project). If a run finds nothing, `--doctor`
lists every directory that was skipped and the rule that caused it.

## CI

```bash
npx --yes sentinello --yes --fail-on high --json > findings.json
```

**Two different `--yes` flags, and a CI runner hits both.** The first belongs to npm: `npx` asks
"Ok to proceed?" before running a package it has not cached, and on a fresh runner that prompt has
nobody to answer it. The second belongs to Sentinello: the first run downloads the advisory databases
and refuses to do so on a non-interactive terminal without consent. Miss either and the job stops or
audits nothing.

A gated run that could not consult a source now exits `1` rather than reporting clean — see
[Exit codes](#ci) below. Before, a first CI run without `--yes` printed zero findings and exited `0`,
which is indistinguishable from a passing audit.

Exit codes: `0` completed, `1` a scan or configuration error **or a gated scan that lost a source**,
`2` the `--fail-on` threshold was met.
Findings alone exit `0` — a report is not a failure, and the default flow (pipe the advisory to an agent)
would otherwise trip `set -e`.

## Configuration file

Optional. A `sentinello.config.json` in the scanned directory supplies defaults so a team can commit its
settings and run `sentinello` bare. Flags always win.

```json
{
    "depth": "all",
    "exclude": ["fixtures/**"],
    "sources": ["npm-audit", "osv"],
    "depType": "prod",
    "prompt": "./security/remediation-prompt.md",
    "failOn": "high"
}
```

## What leaves your machine

Nothing about your code. No source, no file paths, no dependency list, no telemetry, and nothing is
retained between runs.

| destination | why | when | disable |
|---|---|---|---|
| `osv-vulnerabilities.storage.googleapis.com` | download the public OSV advisory export | on sync | `--source npm-audit` / `--offline` |
| `gitlab.com` | download the public gemnasium-db advisories | on sync | `--source npm-audit,osv` / `--offline` |
| your npm registry | `npm audit` submits the dependency tree, exactly as `npm audit` always does | on scan | `--source osv,gemnasium` |

`--offline` makes no network requests at all and uses whatever is cached.

## Troubleshooting

`--doctor` prints the resolved settings, the cache state, the projects it can see, and every directory it
skipped with the reason:

```bash
npx sentinello --doctor
```

The two things it most often explains: a project missing because a `.gitignore` rule excluded it, and a
source reporting `not downloaded` because the first-run consent prompt was declined.

## Full option list

```bash
npx sentinello --help
```
