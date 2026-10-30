# Sentinello CLI

`npx sentinello` runs the same scanners as the portal, in whatever folder you are standing in, and
writes a markdown advisory you can hand to an agent. No server, no database, no history.

```bash
npx sentinello
```

## What it does

1. **Walks the directory** for projects, by the same rules as the portal (see
   [What counts as a project](../README.md#what-counts-as-a-project)): a directory with a `package.json` is
   a project and descent stops there, so a monorepo root is one project rather than one per workspace
   package; a manifest of another ecosystem below a project belongs to it (an Expo app's
   `ios/Gemfile.lock`); and one with no project above it starts a project of its own.
2. **Refreshes the advisory cache** for the ecosystems those projects hold, incrementally and almost for
   free (see below).
3. **Scans each project** with npm audit, OSV, and GitLab gemnasium, each source once per ecosystem the
   project holds, deduplicating across them with npm audit treated as authoritative.
4. **Writes the advisory** — findings ordered by severity across every project, each tagged with the
   project it came from and the ecosystem and manifests it was installed through, preceded by a
   remediation prompt.

## Ecosystems

The CLI scans the same ecosystems as the portal, reading each from its lockfile — the first one present
in a directory, in this order:

| ecosystem | lockfiles read | reported as "No lockfile" without one | sources | fix checked against |
|---|---|---|---|---|
| npm (Node.js) | `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock` (Yarn 2 and later) | `package.json` | npm audit, OSV, GitLab gemnasium | `registry.npmjs.org` |
| PyPI (Python) | `poetry.lock`, `Pipfile.lock`, `requirements.txt` (its `==` pins), `uv.lock` | `pyproject.toml`, `Pipfile` | OSV, GitLab gemnasium | `pypi.org` |
| Go | `go.mod` (`go.sum` only where there is no `go.mod`) | — | OSV, GitLab gemnasium | `proxy.golang.org` |
| crates.io (Rust) | `Cargo.lock` | `Cargo.toml` | OSV, GitLab gemnasium | `index.crates.io` |
| RubyGems (Ruby) | `Gemfile.lock` | `Gemfile` | OSV, GitLab gemnasium | `rubygems.org` |

npm audit is npm's own tool and answers for npm only, and only it runs the Node toolchain. Nothing else
runs a package manager: there is no pip, go, cargo or bundle involved, every lockfile is read as a file.

`requirements.txt` and `go.mod` record no dependency graph, so a finding read from one shows its
dependency path as **chain unknown**. The other lockfiles record one, and their findings show the real
chain.

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

A run that needs an advisory database not yet downloaded **asks first**, quoting the size — the first
run, and the first one after a new ecosystem appears in the folder:

```
  These advisory databases need downloading first.

    OSV (npm)  203.4 MB
    OSV (PyPI)  37.5 MB
    GitLab gemnasium (npm, PyPI)  ~80.0 MB
```

Only the ecosystems the scanned folder holds are downloaded. OSV publishes one export per ecosystem —
npm's is about 200 MB, PyPI's 37.5 MB, Go's 12.7 MB, RubyGems' 5.2 MB and crates.io's 3.7 MB — so a
folder of npm projects never downloads the others, and a Python project appearing later downloads PyPI's
then. GitLab gemnasium is one archive for every ecosystem, downloaded once for all of them; the cache
keeps one file per ecosystem from it.

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
advisories are fetched — not the whole corpus. The cache is rewritten only when every changed advisory
could be re-read; if one keeps failing, the previous OSV data is kept and the error names the advisory, and
once refreshes have failed for 48 hours the next run re-downloads the full OSV export without asking again.

The cache lives in `$SENTINELLO_CACHE_DIR`, else `$XDG_CACHE_HOME/sentinello`, else
`~/.cache/sentinello`. Deleting it costs nothing but a re-download.

The same directory holds one registry file per ecosystem (`registry-npm.ndjson.gz`,
`registry-PyPI.ndjson.gz`, …), the registry answers the fix check and the way out read (see below). An
answer is reused for 24 hours; after that the next scan that needs the package asks again, sending the
ETag the answer came with, so a package that has not changed costs a `304` with no body. If the registry
cannot be reached the earlier answer is used and marked with its date. Two runs at once never lose each
other's answers: each saves only what it fetched, merged into the files under the cache lock, and a run
that finds the lock held skips its save.

## Fixes are checked against each registry

An advisory's stated fix is not trusted on its word — braces `<=3.0.3` "fixed in 3.0.4" names a version
npm never published. For each finding the CLI asks the registry of its ecosystem (npm, PyPI, the Go
module proxy, the crates.io index or rubygems.org), through the same code the portal's worker uses,
whether a version outside every reporting source's affected range and not below any installed copy has
been published. A yanked release is never a fix.

| fix status | reads | meaning |
|---|---|---|
| `released` | upgrade to `X` | `X` is published and safe to target |
| `none_released` | No fixed version released, then the way out | no published version qualifies. For npm, the way out says which dependency chain carries the package, whether upgrading a parent frees it, and curated alternatives; for every other ecosystem it says the way out is computed for npm only |
| `unverified` | the advisory's stated fix · not checked against the registry (why) | the registry could not settle it: not reachable, the package not found there, `--offline`, or an affected range that cannot be evaluated |

The JSON carries the same as `fixStatus`, `fixVersion`, `fixCheck` and `remediation` per finding, beside
its `ecosystem` and `installations` (every manifest it was installed through, with the version there).

Each check can be pointed at a mirror, as for the portal's worker: `SENTINELLO_NPM_REGISTRY_URL` and
`SENTINELLO_NPM_DOWNLOADS_URL` for npm, `SENTINELLO_PYPI_URL`, `SENTINELLO_GOPROXY_URL`,
`SENTINELLO_CRATES_INDEX_URL` and `SENTINELLO_RUBYGEMS_URL` for the others.

There is no lookup cap: every package the fix check and the way out need is read, 16 at a time, so a way
out is never left partial. In a registry cache written by a pre-release build of 3.7.0, each package is
fetched in full once, the next time a run needs it — those entries lack the prereleases the check now
needs — and cached as usual after that. The rest of the cache is not refetched up front.

## Projects that cannot be scanned

Every project gets a scan state over the sources enabled for the run, the same states the portal shows:
fully scanned, **cannot be fully scanned** (some source answered, another did not, or the dependencies
were only partly read), or **cannot be scanned** (nothing could read it). Each comes with its reasons and
whose fix each one is — *the project* (a `package.json` with no lockfile, an unsupported lockfile, Yarn 1)
or *this Sentinello install* (an advisory database not downloaded, a missing package manager, an ecosystem
no selected source answers for, such as a Python project under `--source npm-audit`):

```
    ✗ ddns  cannot be scanned — No lockfile (the project)

  1 project cannot be scanned
    ✗ ddns  cannot be scanned — No lockfile (the project)
```

Such a project is never counted as clean: a run whose only projects could not be checked prints "No
findings — but not everything could be checked." The markdown advisory gets a **Projects that could not
be fully scanned** section, and the JSON carries `projects[].scanState` —
`{ state, reasons: [{ source, ecosystem, reasonCode, label, side }] }`, `state` one of `scanned`,
`partial`, `cannot_scan`, `not_scanned_yet`, labels in English, the same shape MCP returns. Exit codes
are unchanged: a reason on the project's side, such as a missing lockfile, never exits `1` by itself,
while a gated run that lost a source still does (see [CI](#ci)).

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
| `osv-vulnerabilities.storage.googleapis.com` | download the public OSV advisory export of each ecosystem the folder holds | on sync | `--source npm-audit` / `--offline` |
| `gitlab.com` | download the public gemnasium-db advisories | on sync | `--source npm-audit,osv` / `--offline` |
| your npm registry | `npm audit` submits the dependency tree, exactly as `npm audit` always does | on scan, for npm projects | `--source osv,gemnasium` / `--offline` |
| `registry.npmjs.org` | read the public metadata of the npm packages with findings, and of the dependency chains, candidate releases and alternatives the way out weighs — package names only, cached 24 hours | on scan, for packages not cached | `--offline` |
| `api.npmjs.org` | read last week's download count of the packages a way out shows | on scan, for packages not cached | `--offline` |
| `pypi.org` | read which releases of a Python package with a finding are published — package names only, cached 24 hours | on scan, for packages not cached | `--offline` |
| `proxy.golang.org` | read a Go module's published versions, and whether a stated fix version exists | on scan, for modules not cached | `--offline` |
| `index.crates.io` | read a crate's published and yanked versions from the sparse index | on scan, for crates not cached | `--offline` |
| `rubygems.org` | read a gem's published versions | on scan, for gems not cached | `--offline` |

`--offline` makes no network requests at all and uses whatever is cached: npm audit does not run, even
when `--source` or `sentinello.config.json` names it, and fixes read "not checked against the registry
(offline)" and carry no way out.

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
