import { compareSeverity, type Severity } from './types'

// The built-in remediation prompt prepended to every advisory export. Operators can override this
// in Settings → Export; the override is stored in app_config under the key 'markdownExportPrompt'.
// Keep this paragraph opinionated — its job is to steer a dev (or an LLM acting on a dev's behalf)
// toward safe, organic upgrades and away from the easy-but-risky `overrides` shortcut. The rules are
// written as enforced gates, not soft principles: a consolidated up-front triage is mandatory, and no
// override may be proposed without a four-part written justification block. This is deliberate — soft
// principles get internalized and silently skipped, forcing the human to drag the reasoning out.
//
// Four sections exist because each one covers a failure that actually happened during a real
// remediation pass, and each fails SILENTLY — nothing errors, the work just ends up wrong:
//   - step 6 (release age): the agent either ignores the supply-chain gate or abandons a critical fix
//     because of it. Both are wrong; the human decides, and the relaxation must never be committed.
//   - "Audit existing overrides first": an override added for last quarter's advisory pins a version
//     that no longer moves and becomes the cause of today's finding, removal-trigger notes included.
//   - "Ranges are a claim": a parent range permitting a patched child does NOT mean the lockfile
//     resolved to it, so an "applied" fix can leave the vulnerable copy installed.
//   - "The goal is zero": the zero target is what makes the agent finish the list instead of stopping
//     at the easy half, but stated alone it rewards the cheapest path to a clean dashboard rather than
//     a fixed tree. The disqualification list is the load-bearing half — an agent with the Sentinello
//     MCP connected holds mute_finding, so "reach zero" plus that tool is a straight line to a muted
//     clean board. Muting is a human's accepted-risk call; the same goes for widening a range or
//     narrowing the scan's scope until the advisory stops matching. The residual table is the honest
//     alternative: it makes "not fixed" visible and dated instead of absent.
export const DEFAULT_EXPORT_PROMPT = `You are helping a development team triage and fix the vulnerabilities listed at the bottom of this document. Treat this as a remediation work list, not a checklist to rubber-stamp. Work in a planning posture from the start: if your tooling has a read-only planning mode (Claude Code's plan mode, for example), enter it now and stay in it until the human has approved the triage below. Nothing in this document authorises you to edit a file before then.

## Audit existing overrides first — they may be the cause

Before triaging anything, read the existing \`overrides\` / \`resolutions\` / \`pnpm.overrides\` and any notes recorded beside them. An override written to fix an older advisory pins a version that no longer moves, so over time it silently becomes the reason a package is stale — including, quite possibly, the reason a finding in this list exists at all. For each existing override, report: what it forces and to which version, the original reason if one was recorded, whether its removal trigger has now been met, and whether it is currently *causing* any finding below. Say so explicitly when an override has become the problem rather than the fix, and treat correcting it as part of this work. Verify recorded removal triggers instead of trusting them — check the upstream version the note refers to and confirm it actually resolves the patched dependency, because a trigger written months ago is frequently no longer true.

## Triage every finding before you touch anything

Do NOT propose or apply a single version change until you have worked through all findings and presented a consolidated triage. Front-load the analysis so the human never has to ask "did you check X?". For each finding, determine and write down:

1. **What the advisory actually does.** Open the linked URL. Severity alone does not tell you whether your code path is exposed — a "critical" in a dev-only tool is very different from a "critical" in a request-handling library. Note the realistic exposure for *this* project.

2. **Direct or transitive?** Run \`pnpm why <pkg>\` / \`npm ls <pkg>\` / \`yarn why <pkg>\` at the repo root. Record the dependency path and the immediate parent.

3. **The parent-upgrade path — always check this; it is the preferred fix.** If the package is transitive, the safest fix is almost always to upgrade the *parent* so it pulls the patched child via a combination its author actually tested. For each transitive finding, report: the immediate parent, whether a newer parent version exists that resolves to the patched child, that parent's release maturity (stable / rc / beta / canary), and whether it is installable under the project's policy. Only if no viable parent upgrade exists do you move on to an override.

4. **Breaking changes between installed and target.** Read the CHANGELOG between the installed version and the fix version. Majors regularly break APIs; minors occasionally; patches rarely but can. Note what affects *this* codebase specifically — and go further than "this is a major, it may break": grep for the affected APIs, list the call sites by file, and sketch the code change each one needs. A version bump whose code impact you cannot describe is not a plan, it is a guess. If the upgrade needs no code change, say that explicitly too — it is the single most useful line the human can read.

5. **Install-policy / supply-chain check.** Before recommending a target version, confirm it satisfies the project's install policy. If the project pins a minimum release age (\`.npmrc\` \`minimum-release-age\`, or pnpm \`minimumReleaseAge\`), check the target version's publish date — if it is too new to install, say so up front and present options (wait N days vs. temporarily lower the threshold). Do not discover this only when the install fails.

6. **When the fix is too new for the install policy.** A minimum release age is a deliberate supply-chain control: it stops a freshly compromised release from being installed automatically. Do not quietly work around it — and do not silently drop the fix either. When the target version is younger than the threshold, report the advisory severity, the version's exact publish date and age, and the configured threshold, then let the human decide. For **critical or high** severity, actively recommend overriding and explain why the exposure outweighs the remaining wait; for moderate or low, default to waiting. If the human agrees, relax the gate for that **single command only** — e.g. \`pnpm --config.minimumReleaseAge=0 add <pkg>@<exact-version>\` — and **never** edit \`.npmrc\` or \`pnpm-workspace.yaml\` to achieve it, because a relaxed setting that gets committed disables the protection for everyone, permanently and invisibly. Whenever the gate is relaxed, pin every package you install in that command to an exact version: the relaxation applies to the whole resolution, not just the package you are fixing, so unrelated transitives can otherwise silently float to builds published hours ago. Afterwards, re-read the lockfile and confirm nothing moved except what you intended.

Present all of the above as one triage table covering every finding, with your recommended fix path per finding, and get the human's go-ahead before editing any manifest.

## Ranges are a claim; the lockfile is the fact

A caret or wildcard range tells you what *could* be installed, never what *is*. After every change, verify the fix in the lockfile itself — read the resolved version there, do not infer it from \`package.json\`. A parent's range routinely permits a patched child while the lockfile keeps the older resolved version, so the advisory survives an upgrade that looked correct. Re-running the scanner is the check that matters: if the finding is still present, the vulnerable copy is still installed.

Where you do control the specifier, prefer an exact version for direct dependencies — many projects enforce this already via \`save-exact\`. Treat \`*\`, \`latest\`, and bare \`>=\` as defects worth flagging on sight: they hand version selection to whatever was published most recently, which is precisely the window a compromised release needs. Never widen a range to obtain a fix, and never loosen a pin a human deliberately set — if a pinned direct dependency must move, move it to another exact version.

## Overrides are a last resort — and they require a written justification

\`overrides\` / \`resolutions\` / \`pnpm.overrides\` force a version the parent was never tested against. They are the last option, not the first. **You may not propose an override until you have output a justification block containing all four of:**

- **Parent-upgrade path investigated** — what you checked (step 3) and why it is not viable right now (e.g. fix only in a canary/rc, parent unmaintained, major bump would touch X / Y / Z).
- **Breaking-change + API-surface analysis** — the changes between the installed and forced version, AND what the immediate consumer actually calls from the package. A wide version jump can be perfectly safe when the consumer only touches a stable subset of the API — prove that, don't assume it.
- **Which last-resort condition is met** — one of: parent unmaintained with no alternative; bump is patch-level with a changelog showing only the security fix; package is dev-only and isolated from production code paths.
- **Removal trigger** — the concrete condition under which the override should be dropped (e.g. "remove when the parent ships a stable release that pulls the patched child"). Record this next to the override in the manifest.

No justification block, no override.

## Then fix incrementally and verify

- **Group findings by their fix before you sequence anything.** Several findings frequently collapse into one change — a single parent upgrade can clear four transitive advisories at once. Work out that mapping first and order the work by findings-cleared-per-change, so the cheapest high-yield fixes land first and whatever residue is left is genuinely irreducible rather than an artefact of fixing things one at a time.
- **Baseline first.** Run the test suite and a smoke build before any change; capture the output. After each fix, re-run both and diff — any new failure, warning, or behavioural change is yours to investigate, not to wave through because the audit went green.
- **One package (or one tight family) per commit.** After each fix, re-run Sentinello — the advisory should disappear from the current findings. If it does not, the upgrade did not actually replace the vulnerable version (usually a transitive resolution issue); dig deeper, do not move on.
- **Do not skip findings because they look hard.** Record the specific blocker (e.g. "needs major bump of X which touches Y, Z") so the team can plan it. Silent skips become next quarter's incident.

## The goal is zero — and what "zero" actually means

The target is zero remaining findings, and you should plan for zero rather than for "fewer". But zero only counts when you got there honestly: every finding either fixed by a real upgrade, or covered by an override carrying the full four-part justification above.

None of the following count as reaching zero, and you must not use them to close a finding:

- **Muting or dismissing a finding in Sentinello.** Muting is a human's decision about accepted risk, not a remediation step. Never mute on your own initiative, and never offer muting as a way to clear the list — if a finding genuinely warrants one, recommend it with reasoning and let the human do it.
- **Widening a range, unpinning a dependency, or loosening the lockfile** so the advisory stops matching.
- **Removing a package from the scan's scope**, excluding a workspace, or narrowing the dep-type filter.
- **Declaring a finding "not exploitable" without evidence.** Reachability is an argument you make from the code, not an assumption you start from.

Finish every pass with a residual table covering everything still open: the finding, why it is open (no upstream fix / needs a major bump touching X / parent unmaintained), what has to become true to close it, and the concrete trigger to revisit. A short residual table with real reasons is a good outcome. A silent zero is not.

The vulnerability list follows.`

export type ExportScope =
    | { kind: 'project'; projectName: string; projectPath: string; depType: 'all' | 'prod' | 'dev' }
    | { kind: 'library'; packageName: string; depType: 'all' | 'prod' | 'dev' }
    // Many projects under one directory, which is what a CLI run over a folder of repositories produces.
    // Findings stay in one severity-ordered list rather than being grouped per project, because the work
    // is prioritised by severity across the whole tree — each finding carries its own `projectName`, so
    // attribution is never lost.
    | { kind: 'workspace'; rootPath: string; projectCount: number; depType: 'all' | 'prod' | 'dev' }

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
    // The three fields below are set only on a MERGED entry: one distinct vulnerability that several
    // sources each reported as their own row. They carry every reporting source, every source-specific
    // advisory id, and the union of dependency paths. Callers that render one row per finding (the
    // library-scope export, the CLI, the worker webhook) leave them unset, and the entry then renders
    // exactly as it always has — that equivalence is asserted in advisory-export.test.ts.
    sources?: string[]
    advisoryIds?: string[]
    depPaths?: string[][]
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

function scopeTitle(scope: ExportScope): string {
    if (scope.kind === 'project') return scope.projectName
    if (scope.kind === 'library') return scope.packageName
    return scope.rootPath
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
    // Sources that reported this same vulnerability under a different id. Listed so a reader can tell
    // one merged entry from one npm-audit-only entry, and so searching for the CVE they saw elsewhere
    // still hits this entry.
    const otherIds = f.advisoryIds ? f.advisoryIds.filter(function notPrimary(id) { return id !== f.advisoryId }) : []
    if (otherIds.length > 0) {
        lines.push('- **Also reported as:** ' + otherIds.map(function code(id) { return '`' + escapeForMarkdown(id) + '`' }).join(', '))
    }
    if (f.sources && f.sources.length > 0) {
        lines.push('- **Sources:** ' + f.sources.map(escapeForMarkdown).join(', '))
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
    // A merged entry carries the union of every contributing row's paths. One path still renders in the
    // singular inline form, so a merged entry with a single route is indistinguishable from an unmerged
    // one — only genuinely multi-route entries pay for the list.
    let paths: string[][] = []
    if (f.depPaths && f.depPaths.length > 0) paths = f.depPaths
    else if (f.depPath.length > 0) paths = [f.depPath]
    const [onlyPath] = paths
    if (paths.length === 1 && onlyPath) {
        lines.push('- **Dependency path:** `' + onlyPath.map(escapeForMarkdown).join(' › ') + '`')
    } else if (paths.length > 1) {
        lines.push('- **Dependency paths:**')
        for (const p of paths) {
            lines.push('    - `' + p.map(escapeForMarkdown).join(' › ') + '`')
        }
    }
    if (f.projectName) {
        lines.push('- **Project:** ' + f.projectName)
    }
    return lines.join('\n')
}

// The document's finding order. Total and deterministic — severity, then package, then advisory id —
// which is what makes offset-based paging safe: page 2 of an unchanged data set always resumes exactly
// where page 1 stopped. Do not make this order depend on anything that varies between calls.
function sortForExport(findings: ExportFinding[]): ExportFinding[] {
    return [...findings].sort(function bySeverityThenName(a, b) {
        const sev = compareSeverity(a.severity, b.severity)
        if (sev !== 0) return sev
        const nameCmp = a.packageName.localeCompare(b.packageName)
        if (nameCmp !== 0) return nameCmp
        return a.advisoryId.localeCompare(b.advisoryId)
    })
}

// `range` is set only by the paginated build, where the count in the subtitle must describe the page
// rather than the whole set — a header claiming "36 findings" above 24 of them is exactly the silent
// undercount the remediation prompt warns against.
function buildHeader(scope: ExportScope, generatedAt: number, count: number, range: { offset: number; total: number } | null): string[] {
    const title = 'Sentinello advisory export — ' + scopeTitle(scope)
    const subtitleParts: string[] = []
    subtitleParts.push('Generated ' + new Date(generatedAt).toISOString())
    if (range) {
        subtitleParts.push('findings ' + (range.offset + 1) + '–' + (range.offset + count) + ' of ' + range.total)
    } else {
        subtitleParts.push(count + ' ' + (count === 1 ? 'finding' : 'findings'))
    }
    if (scope.kind === 'project') {
        subtitleParts.push('project: `' + escapeForMarkdown(scope.projectPath) + '`')
    } else if (scope.kind === 'library') {
        subtitleParts.push('library: `' + escapeForMarkdown(scope.packageName) + '`')
    } else {
        subtitleParts.push('root: `' + escapeForMarkdown(scope.rootPath) + '`')
        subtitleParts.push(scope.projectCount + ' ' + (scope.projectCount === 1 ? 'project' : 'projects'))
    }
    subtitleParts.push('dep type: ' + depTypeLabel(scope.depType))

    const out: string[] = []
    out.push('# ' + title)
    out.push('')
    out.push('> ' + subtitleParts.join(' · '))
    out.push('')
    return out
}

// An empty prompt means the caller deliberately asked for findings alone (the CLI's default, and any
// continuation page over MCP). Drop the whole section rather than leaving a heading over a blank.
function buildPromptSection(prompt: string): string[] {
    if (prompt.trim().length === 0) return []
    const out: string[] = []
    out.push('## How to approach these fixes')
    out.push('')
    out.push(prompt)
    out.push('')
    out.push('---')
    out.push('')
    return out
}

// `startIndex` keeps the printed numbering continuous across pages, so entry 25 is called 25 on page 2
// rather than restarting at 1.
function buildFindingsSection(findings: ExportFinding[], startIndex: number): string[] {
    const out: string[] = []
    out.push('## Findings')
    out.push('')
    if (findings.length === 0) {
        out.push('_No current findings._')
        out.push('')
        return out
    }
    findings.forEach(function appendFinding(f, i) {
        out.push(formatFinding(startIndex + i + 1, f))
        out.push('')
    })
    return out
}

export function buildAdvisoryMarkdown(args: {
    scope: ExportScope
    prompt: string
    findings: ExportFinding[]
    generatedAt: number
}): string {
    const { scope, prompt, findings, generatedAt } = args
    const sorted = sortForExport(findings)
    const out = buildHeader(scope, generatedAt, sorted.length, null)
        .concat(buildPromptSection(prompt))
        .concat(buildFindingsSection(sorted, 0))
    return out.join('\n')
}

export type PaginatedAdvisoryMarkdown = {
    markdown: string
    offset: number
    // How many findings this page actually rendered.
    rendered: number
    total: number
    // Index to pass as the next `offset`, or null when this page is the last one.
    nextOffset: number | null
}

// Size-bounded variant used by the MCP tool, where the whole document has to fit inside one tool
// result. The portal download has no such limit and keeps using buildAdvisoryMarkdown above.
//
// Entries are rendered until `byteBudget` is reached and the cut always lands on an entry boundary —
// a half-rendered finding would be worse than an omitted one. At least one finding is always rendered
// even if it alone exceeds the budget, because returning an empty page with a "call again with the
// same offset" notice would loop forever.
export function buildPaginatedAdvisoryMarkdown(args: {
    scope: ExportScope
    prompt: string
    findings: ExportFinding[]
    generatedAt: number
    offset: number
    byteBudget: number
}): PaginatedAdvisoryMarkdown {
    const { scope, prompt, findings, generatedAt, byteBudget } = args
    const sorted = sortForExport(findings)
    const offset = Math.max(0, Math.min(args.offset, sorted.length))
    const preamble = buildHeader(scope, generatedAt, 0, { offset, total: sorted.length }).concat(buildPromptSection(prompt))
    // The header is rebuilt once the page size is known (its subtitle names the range), so only its
    // size is borrowed here. Leave headroom for that rebuild plus the continuation notice.
    let used = preamble.join('\n').length + 512
    const page: ExportFinding[] = []
    // entries() over the slice rather than an index walk: it yields the element itself, so there is no
    // possibly-undefined index access and no guard against one.
    for (const [step, finding] of sorted.slice(offset).entries()) {
        const size = formatFinding(offset + step + 1, finding).length + 1
        if (page.length > 0 && used + size > byteBudget) break
        used = used + size
        page.push(finding)
    }
    const nextIndex = offset + page.length
    const nextOffset = nextIndex < sorted.length ? nextIndex : null
    const out = buildHeader(scope, generatedAt, page.length, { offset, total: sorted.length })
        .concat(buildPromptSection(prompt))
        .concat(buildFindingsSection(page, offset))
    return {
        markdown: out.join('\n'),
        offset,
        rendered: page.length,
        total: sorted.length,
        nextOffset
    }
}

// Produce a safe, predictable filename for the downloaded .md. Sanitizes path separators, spaces,
// and other characters that browsers / filesystems handle poorly. Always suffixed with a YYYY-MM-DD
// stamp so multiple exports of the same scope sort sensibly when the dev team archives them.
export function buildExportFilename(scope: ExportScope, generatedAt: number): string {
    const stamp = new Date(generatedAt).toISOString().slice(0, 10)
    // A workspace scope names the directory that was scanned; its full path would make an unwieldy
    // filename, so only the final segment is used.
    const raw = scope.kind === 'workspace' ? lastPathSegment(scope.rootPath) : scopeTitle(scope)
    const slug = raw
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-{2,}/g, '-')
    const safeSlug = slug.length > 0 ? slug : 'unnamed'
    return 'sentinello-' + safeSlug + '-advisories-' + stamp + '.md'
}

function lastPathSegment(path: string): string {
    const parts = path.split('/').filter(function nonEmpty(p): boolean {
        return p.length > 0
    })
    return parts[parts.length - 1] || path
}
