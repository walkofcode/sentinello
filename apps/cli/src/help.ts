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

  Walks [path] (default: the current directory) for JavaScript projects, checks their
  dependencies against npm audit, OSV, and GitLab gemnasium, and writes a markdown
  advisory with a remediation prompt an agent can act on.

  Piped, it writes the markdown to stdout:   npx sentinello | claude -p "$(cat -)"
  In a terminal, it writes a dated .md file and prints a summary.

SCOPE
  --depth <n|all>       How many directory levels to descend. Default: all.
                        Descent always stops at the first directory holding a manifest,
                        so a monorepo root is one project rather than many.
  --exclude <glob>      Exclude paths. Repeatable, or comma-separated.
                        .gitignore and .sentinelloignore are always honoured.
  --dep-type <type>     all | prod | dev. Default: all.

SOURCES
  --source <list>       npm-audit, osv, gemnasium. Default: all three.
  --offline             Skip the freshness check and use the cached data as-is.
  --cache-dir <path>    Where the advisory cache lives.
                        Default: $XDG_CACHE_HOME/sentinello or ~/.cache/sentinello.

OUTPUT
  --out <file|->        Write the advisory to a file, or "-" for stdout.
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
  -y, --yes             Accept every prompt, including the first-run download.
  --doctor              Print cache status, resolved settings, and detected projects.
  -q, --quiet           Suppress the human-readable output.
  --verbose             List every directory skipped by an ignore rule.
  --no-color            Disable colour. NO_COLOR is honoured too.
  -h, --help            Show this help.
  -V, --version         Print the version.

EXIT CODES
  0  completed (findings alone are not a failure)
  1  a scan or configuration error
  2  the --fail-on threshold was met

CONFIG
  An optional sentinello.config.json in the scanned directory supplies defaults for
  depth, exclude, sources, depType, prompt, failOn, and out. Flags always win.

Sentinello stores nothing about your code. The only thing written to the cache
directory is public advisory data downloaded from OSV and GitLab.
`
