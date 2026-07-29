# sentinello

<!-- Absolute URLs throughout: npm does not resolve relative links, and this file ships in the package. -->
<p>
  <a href="https://github.com/walkofcode/sentinello/actions/workflows/ci.yml"><img src="https://github.com/walkofcode/sentinello/actions/workflows/ci.yml/badge.svg" alt="CI status" /></a>
  <a href="https://github.com/walkofcode/sentinello/blob/main/CONTRIBUTING.md#tests"><img src="https://img.shields.io/badge/coverage-99%25-brightgreen" alt="Statement coverage 99%, enforced by CI" /></a>
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT licensed" />
</p>

Scan the projects in a folder for vulnerable dependencies and get back an advisory an agent can act on.

```bash
npx sentinello
```

Walks the current directory for JavaScript projects, checks their dependencies against **npm audit**,
**OSV**, and **GitLab gemnasium**, and writes a markdown advisory with a remediation prompt attached.

It is `npm audit` with two differences that matter: it covers a folder of repositories rather than one
project, and it sees things npm audit cannot — including OSV's ~214,000 malicious-package records.

## Use it

```bash
npx sentinello                      # scan here, write a dated .md, print a summary
npx sentinello ~/Developer          # scan every project under a directory
npx sentinello | claude -p "$(cat -)"   # pipe the advisory straight to an agent
```

Or add it to a project and run it like any other check:

```bash
npm install -D sentinello
npx sentinello --fail-on high       # exit 2 when a high or critical finding exists
```

## Output

In a terminal you get a summary and a dated `.md` file. Piped, stdout is pure markdown — every status
line goes to stderr, so the document is never corrupted.

The markdown contains the findings **and** a remediation prompt that tells an agent to triage before
touching anything, prefer parent upgrades over overrides, verify fixes in the lockfile rather than the
manifest, and never close a finding by muting it. Print it with `--print-prompt`, replace it with
`--prompt ./yours.md`, or drop it with `--no-prompt`.

## The advisory cache

The first run downloads the advisory databases (~200 MB for OSV, ~80 MB for gemnasium) and asks before
it does. After that every run refreshes incrementally: OSV answers `304 Not Modified` when nothing was
published, and gemnasium is gated on its repository's HEAD commit, so a routine scan transfers almost
nothing and completes in about a second.

The cache lives in `$XDG_CACHE_HOME/sentinello` or `~/.cache/sentinello`. It is the only thing written
outside your project.

## Privacy

**Nothing about your code is uploaded.** No source, no paths, no dependency list, no telemetry, and no
history is kept between runs.

Outbound requests go to `osv-vulnerabilities.storage.googleapis.com` and `gitlab.com` to download public
advisory data, and `npm audit` talks to your configured npm registry exactly as it always does. Use
`--source osv,gemnasium` to skip npm audit, or `--offline` to make no network requests at all.

## Options

Run `sentinello --help` for the full list. The ones people reach for:

| | |
|---|---|
| `--depth <n\|all>` | how far to descend. Default `all`, stopping at each project |
| `--exclude <glob>` | skip paths. `.gitignore` and `.sentinelloignore` are always honoured |
| `--source <list>` | `npm-audit`, `osv`, `gemnasium`. Default: all three |
| `--severity <level>` | report at this severity or above |
| `--fail-on <level>` | exit 2 when matched, for CI |
| `--out <file\|->` | where the advisory goes |
| `--json` | machine-readable output |
| `-y, --yes` | accept the first-run download without asking |
| `--offline` | use the cache as-is, no network |
| `--doctor` | cache status, resolved settings, and what was skipped and why |

Exit codes: `0` completed, `1` a scan or configuration error, `2` the `--fail-on` threshold was met.
Findings alone are not a failure.

## Requires

Node 22 or newer. No dependencies, no install scripts, no native modules.

## The portal

This CLI is one half of [Sentinello](https://sentinello.org). The other is a self-hosted portal that
watches your projects continuously, tracks findings over time, and notifies you when something new
appears — the same scanners and the same advisory sources, with history.

MIT © [Walk of Code](https://walkofcode.io)
