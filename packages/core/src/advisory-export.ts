import { severityRank, type Severity } from './types'

// The built-in remediation prompt prepended to every advisory export. Operators can override this
// in Settings → Export; the override is stored in app_config under the key 'markdownExportPrompt'.
// Keep this paragraph opinionated — its job is to steer a dev (or an LLM acting on a dev's behalf)
// toward safe, organic upgrades and away from the easy-but-risky `overrides` shortcut. The rules are
// written as enforced gates, not soft principles: a consolidated up-front triage is mandatory, and no
// override may be proposed without a four-part written justification block. This is deliberate — soft
// principles get internalized and silently skipped, forcing the human to drag the reasoning out.
export const DEFAULT_EXPORT_PROMPT = `You are helping a development team triage and fix the vulnerabilities listed at the bottom of this document. Treat this as a remediation work list, not a checklist to rubber-stamp.

## Triage every finding before you touch anything

Do NOT propose or apply a single version change until you have worked through all findings and presented a consolidated triage. Front-load the analysis so the human never has to ask "did you check X?". For each finding, determine and write down:

1. **What the advisory actually does.** Open the linked URL. Severity alone does not tell you whether your code path is exposed — a "critical" in a dev-only tool is very different from a "critical" in a request-handling library. Note the realistic exposure for *this* project.

2. **Direct or transitive?** Run \`pnpm why <pkg>\` / \`npm ls <pkg>\` / \`yarn why <pkg>\` at the repo root. Record the dependency path and the immediate parent.

3. **The parent-upgrade path — always check this; it is the preferred fix.** If the package is transitive, the safest fix is almost always to upgrade the *parent* so it pulls the patched child via a combination its author actually tested. For each transitive finding, report: the immediate parent, whether a newer parent version exists that resolves to the patched child, that parent's release maturity (stable / rc / beta / canary), and whether it is installable under the project's policy. Only if no viable parent upgrade exists do you move on to an override.

4. **Breaking changes between installed and target.** Read the CHANGELOG between the installed version and the fix version. Majors regularly break APIs; minors occasionally; patches rarely but can. Note what affects *this* codebase specifically.

5. **Install-policy / supply-chain check.** Before recommending a target version, confirm it satisfies the project's install policy. If the project pins a minimum release age (\`.npmrc\` \`minimum-release-age\`, or pnpm \`minimumReleaseAge\`), check the target version's publish date — if it is too new to install, say so up front and present options (wait N days vs. temporarily lower the threshold). Do not discover this only when the install fails.

Present all of the above as one triage table covering every finding, with your recommended fix path per finding, and get the human's go-ahead before editing any manifest.

## Overrides are a last resort — and they require a written justification

\`overrides\` / \`resolutions\` / \`pnpm.overrides\` force a version the parent was never tested against. They are the last option, not the first. **You may not propose an override until you have output a justification block containing all four of:**

- **Parent-upgrade path investigated** — what you checked (step 3) and why it is not viable right now (e.g. fix only in a canary/rc, parent unmaintained, major bump would touch X / Y / Z).
- **Breaking-change + API-surface analysis** — the changes between the installed and forced version, AND what the immediate consumer actually calls from the package. A wide version jump can be perfectly safe when the consumer only touches a stable subset of the API — prove that, don't assume it.
- **Which last-resort condition is met** — one of: parent unmaintained with no alternative; bump is patch-level with a changelog showing only the security fix; package is dev-only and isolated from production code paths.
- **Removal trigger** — the concrete condition under which the override should be dropped (e.g. "remove when the parent ships a stable release that pulls the patched child"). Record this next to the override in the manifest.

No justification block, no override.

## Then fix incrementally and verify

- **Baseline first.** Run the test suite and a smoke build before any change; capture the output. After each fix, re-run both and diff — any new failure, warning, or behavioural change is yours to investigate, not to wave through because the audit went green.
- **One package (or one tight family) per commit.** After each fix, re-run Sentinello — the advisory should disappear from the current findings. If it does not, the upgrade did not actually replace the vulnerable version (usually a transitive resolution issue); dig deeper, do not move on.
- **Do not skip findings because they look hard.** Record the specific blocker (e.g. "needs major bump of X which touches Y, Z") so the team can plan it. Silent skips become next quarter's incident.

The vulnerability list follows.\``

export type ExportScope =
    | { kind: 'project'; projectName: string; projectPath: string; depType: 'all' | 'prod' | 'dev' }
    | { kind: 'library'; packageName: string; depType: 'all' | 'prod' | 'dev' }

export type ExportFinding = {
    packageName: string
    installedVersion: string
    fixAvailable: boolean
    fixVersion: string | null
    severity: Severity
    advisoryId: string
    advisoryTitle: string | null
    advisoryUrl: string | null
    vulnerableRange: string | null
    isProd: boolean
    isDev: boolean
    depPath: string[]
    // Only set on library-scope exports — the project this finding belongs to. For project-scope
    // exports every row is the same project, so this is omitted from the rendered output.
    projectName?: string
}

// Resolve the prompt the export should use. Treats both "no key" and a stored null/empty-string
// override as "use the default" — that way resetExportPromptAction can simply write null without
// needing a separate delete path on the appConfig table.
export function resolveExportPrompt(stored: string | null | undefined): string {
    if (!stored) return DEFAULT_EXPORT_PROMPT
    const trimmed = stored.trim()
    if (trimmed.length === 0) return DEFAULT_EXPORT_PROMPT
    return stored
}

function depTypeLabel(depType: 'all' | 'prod' | 'dev'): string {
    if (depType === 'prod') return 'production only'
    if (depType === 'dev') return 'dev only'
    return 'all (prod + dev)'
}

function depTypeForFinding(f: ExportFinding): string {
    if (f.isProd && f.isDev) return 'prod + dev'
    if (f.isProd) return 'prod'
    if (f.isDev) return 'dev'
    return 'unknown'
}

function escapeForMarkdown(value: string): string {
    // Findings come from npm/scanner output. Backticks and pipes can corrupt inline code spans /
    // table cells; escape the small set that actually matters in the contexts we render.
    return value.replace(/`/g, '\\`')
}

function formatFinding(index: number, f: ExportFinding): string {
    const lines: string[] = []
    const headline = '`' + escapeForMarkdown(f.packageName) + '@' + escapeForMarkdown(f.installedVersion) + '` — ' + f.severity
    lines.push('### ' + index + '. ' + headline)
    lines.push('')
    const title = f.advisoryTitle || f.advisoryId
    if (f.advisoryUrl) {
        lines.push('- **Advisory:** [' + title + '](' + f.advisoryUrl + ') (`' + escapeForMarkdown(f.advisoryId) + '`)')
    } else {
        lines.push('- **Advisory:** ' + title + ' (`' + escapeForMarkdown(f.advisoryId) + '`)')
    }
    if (f.fixAvailable && f.fixVersion) {
        lines.push('- **Fix:** upgrade to `' + escapeForMarkdown(f.fixVersion) + '`')
    } else if (f.fixAvailable) {
        lines.push('- **Fix:** available (target version not specified — check the advisory)')
    } else {
        lines.push('- **Fix:** no fix available yet — track upstream or mitigate at the call site')
    }
    if (f.vulnerableRange) {
        lines.push('- **Vulnerable range:** `' + escapeForMarkdown(f.vulnerableRange) + '`')
    }
    lines.push('- **Dep type:** ' + depTypeForFinding(f))
    if (f.depPath.length > 0) {
        const path = f.depPath.map(escapeForMarkdown).join(' › ')
        lines.push('- **Dependency path:** `' + path + '`')
    }
    if (f.projectName) {
        lines.push('- **Project:** ' + f.projectName)
    }
    return lines.join('\n')
}

export function buildAdvisoryMarkdown(args: {
    scope: ExportScope
    prompt: string
    findings: ExportFinding[]
    generatedAt: number
}): string {
    const { scope, prompt, findings, generatedAt } = args
    const sorted = [...findings].sort(function bySeverityThenName(a, b) {
        const ra = severityRank(a.severity)
        const rb = severityRank(b.severity)
        if (ra !== rb) return ra - rb
        const nameCmp = a.packageName.localeCompare(b.packageName)
        if (nameCmp !== 0) return nameCmp
        return a.advisoryId.localeCompare(b.advisoryId)
    })
    const title = scope.kind === 'project'
        ? 'Sentinello advisory export — ' + scope.projectName
        : 'Sentinello advisory export — ' + scope.packageName
    const subtitleParts: string[] = []
    subtitleParts.push('Generated ' + new Date(generatedAt).toISOString())
    subtitleParts.push(sorted.length + ' ' + (sorted.length === 1 ? 'finding' : 'findings'))
    if (scope.kind === 'project') {
        subtitleParts.push('project: `' + escapeForMarkdown(scope.projectPath) + '`')
    } else {
        subtitleParts.push('library: `' + escapeForMarkdown(scope.packageName) + '`')
    }
    subtitleParts.push('dep type: ' + depTypeLabel(scope.depType))

    const out: string[] = []
    out.push('# ' + title)
    out.push('')
    out.push('> ' + subtitleParts.join(' · '))
    out.push('')
    out.push('## How to approach these fixes')
    out.push('')
    out.push(prompt)
    out.push('')
    out.push('---')
    out.push('')
    out.push('## Findings')
    out.push('')
    if (sorted.length === 0) {
        out.push('_No current findings._')
        out.push('')
    } else {
        sorted.forEach(function appendFinding(f, i) {
            out.push(formatFinding(i + 1, f))
            out.push('')
        })
    }
    return out.join('\n')
}

// Produce a safe, predictable filename for the downloaded .md. Sanitizes path separators, spaces,
// and other characters that browsers / filesystems handle poorly. Always suffixed with a YYYY-MM-DD
// stamp so multiple exports of the same scope sort sensibly when the dev team archives them.
export function buildExportFilename(scope: ExportScope, generatedAt: number): string {
    const stamp = new Date(generatedAt).toISOString().slice(0, 10)
    const raw = scope.kind === 'project' ? scope.projectName : scope.packageName
    const slug = raw
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-{2,}/g, '-')
    const safeSlug = slug.length > 0 ? slug : 'unnamed'
    return 'sentinello-' + safeSlug + '-advisories-' + stamp + '.md'
}
