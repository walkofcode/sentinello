// Injected at build time by tsup so the binary reports the released version. tsx (dev) has no define, so
// the fallback keeps `pnpm --filter sentinello dev` working.
declare const __SENTINELLO_VERSION__: string | undefined

export const CLI_VERSION: string = (function resolveVersion(): string {
    if (typeof __SENTINELLO_VERSION__ === 'string' && __SENTINELLO_VERSION__.length > 0) {
        return __SENTINELLO_VERSION__
    }
    const fromEnv = process.env.SENTINELLO_VERSION
    if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim()
    return 'dev'
})()

export const HELP_TEXT = `sentinello — dependency advisories for the projects in a folder

USAGE
  sentinello [path] [options]
  npx sentinello

  Walks [path] (default: the current directory) for projects, checks their
  dependencies against npm audit, OSV and GitLab gemnasium, and writes a markdown
  advisory with a remediation prompt an agent can act on.

  Piped, it writes the markdown to stdout:   npx sentinello | claude -p "$(cat -)"
  In a terminal, it writes a dated .md file and prints a summary.
  For the advisory and nothing else:         npx sentinello --out - > advisory.md

ECOSYSTEMS
  A project is read from its lockfile (the first one present, per ecosystem):
    npm        package-lock.json, pnpm-lock.yaml, yarn.lock (Yarn 2+)
    PyPI       poetry.lock, Pipfile.lock, requirements.txt (its == pins), uv.lock
    Go         go.mod (go.sum only where there is no go.mod)
    crates.io  Cargo.lock
    RubyGems   Gemfile.lock
  A package.json, pyproject.toml, Pipfile, Cargo.toml or Gemfile with no lockfile
  is reported as "cannot be scanned — No lockfile", never as clean.

SCOPE
  --depth <n|all>       How many directory levels to descend. Default: all.
                        Descent stops at the first package.json, so a monorepo root is
                        one project rather than many; other manifests below a project
                        belong to it (ios/Gemfile.lock).
  --exclude <glob>      Exclude paths. Repeatable, or comma-separated.
                        .gitignore and .sentinelloignore are always honoured.
  --dep-type <type>     all | prod | dev. Default: all.

SOURCES
  --source <list>       npm-audit, osv, gemnasium. Default: all three.
                        npm audit covers npm only; OSV and GitLab gemnasium cover every
                        ecosystem above. Only the ecosystems found are downloaded.
  --offline             Make no network request: use the cached advisories as-is, skip
                        npm audit, and do not check fixes against any registry.
  --cache-dir <path>    Where the advisory cache lives.
                        Default: $XDG_CACHE_HOME/sentinello or ~/.cache/sentinello.
  --feed-wait <secs>    How long to keep retrying a feed that declines a download.
                        Default: 15 — short, because a declined download is offered
                        as a retry rather than waited out. 0 gives up on the first
                        refusal, leaving that source unseeded.

OUTPUT
  --out <file|->        Write the advisory to a file, or "-" for stdout. With "-" the
                        document is the ONLY thing on stdout — every status line goes
                        to stderr — so it can be redirected or piped safely.
  --json                Emit machine-readable JSON instead of markdown.
  --severity <level>    Report findings at this severity or above.
                        critical | high | moderate | low | info. Default: info.
  --prompt <file>       Use a custom remediation prompt instead of the built-in one.
  --no-prompt           Findings only, with no remediation prompt.
  --print-prompt        Print the built-in prompt and exit, so a custom one can start
                        from a working base.

BEHAVIOUR
  --fail-on <level>     Exit 2 when a finding at this severity or above exists.
                        A severity, "any", or "none". Default: none.
  -y, --yes             Accept every prompt, including the first-run download. Required on a
                        non-TTY: without it the download is refused, and under --fail-on
                        that refusal exits 1 rather than reporting a clean scan. npx has a
                        separate prompt of its own: in CI use  npx --yes sentinello --yes
  --doctor              Print cache status, resolved settings, and detected projects.
  -q, --quiet           Suppress the human-readable output.
  --verbose             List every directory skipped by an ignore rule.
  --no-color            Disable colour. NO_COLOR is honoured too.
  -h, --help            Show this help.
  -V, --version         Print the version.

EXIT CODES
  0  completed (findings alone are not a failure)
  1  a scan or configuration error, or a --fail-on run that lost an advisory source
     (a gate cannot be honoured by a scan that could not consult its sources)
  2  the --fail-on threshold was met

CONFIG
  An optional sentinello.config.json in the scanned directory supplies defaults for
  depth, exclude, sources, depType, prompt, failOn, out, and feedWait. Flags always win.

FIXES
  Each finding's fix is checked against its ecosystem's registry, as the Sentinello
  portal checks it: registry.npmjs.org (and api.npmjs.org for download counts),
  pypi.org, proxy.golang.org, index.crates.io and rubygems.org. A published fix reads
  "upgrade to"; none reads "No fixed version released", with the way out for npm.
  Only package names are sent. Answers are cached for 24 hours. Point a check at a
  mirror with SENTINELLO_NPM_REGISTRY_URL, SENTINELLO_PYPI_URL, SENTINELLO_GOPROXY_URL,
  SENTINELLO_CRATES_INDEX_URL or SENTINELLO_RUBYGEMS_URL.

Sentinello stores nothing about your code. The only thing written to the cache
directory is public data: advisories from OSV and GitLab, and registry metadata.
`
