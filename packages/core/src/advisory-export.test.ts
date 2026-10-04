import { describe, expect, it } from 'vitest'
import {
    buildAdvisoryMarkdown,
    buildExportFilename,
    buildPaginatedAdvisoryMarkdown,
    DEFAULT_EXPORT_PROMPT,
    resolveExportPrompt,
    type ExportFinding,
    type ExportScope
} from './advisory-export'
import type { FixCheck } from './fix-status'
import type { Remediation } from './remediation'

// The advisory export is handed straight to an LLM as a remediation work list, so two properties
// matter: the prompt that frames the work must survive intact, and no finding may be silently dropped
// or mis-attributed. The markdown shape itself is asserted only where it carries meaning.

const CHECKED_AT = Date.UTC(2026, 9, 3)

function check(overrides: Partial<FixCheck> = {}): FixCheck {
    return { v: 1, checkedAt: CHECKED_AT, registry: 'ok', packageDataAsOf: CHECKED_AT, unevaluable: null, sources: [], ...overrides }
}

function exportFinding(overrides: Partial<ExportFinding> = {}): ExportFinding {
    return {
        packageName: 'lodash',
        installedVersion: '4.17.20',
        fixAvailable: false,
        fixVersion: null,
        fixStatus: 'unverified',
        fixCheck: check({ registry: 'skipped', packageDataAsOf: null }),
        remediation: null,
        severity: 'high',
        advisoryId: 'GHSA-1',
        advisoryTitle: null,
        advisoryUrl: null,
        vulnerableRange: '<4.17.21',
        isProd: true,
        isDev: false,
        depPath: [],
        ...overrides
    }
}

const PROJECT_SCOPE: ExportScope = {
    kind: 'project',
    projectName: 'api',
    projectPath: '/roots/work/api',
    depType: 'all'
}

const LIBRARY_SCOPE: ExportScope = { kind: 'library', packageName: 'lodash', depType: 'prod' }

const WORKSPACE_SCOPE: ExportScope = {
    kind: 'workspace',
    rootPath: '/roots/work',
    projectCount: 4,
    depType: 'dev'
}

const AT = Date.UTC(2026, 6, 27, 10, 30, 0)

function build(scope: ExportScope, findings: ExportFinding[]): string {
    return buildAdvisoryMarkdown({ scope, prompt: 'PROMPT-BODY', findings, generatedAt: AT })
}

describe('resolveExportPrompt', function () {
    it('returns a stored override as-is', function () {
        expect(resolveExportPrompt('use my prompt')).toBe('use my prompt')
    })

    // "No key", an explicit null, and a blank string all mean "use the default", so resetting the
    // prompt can just write null rather than needing a delete path.
    it.each([null, undefined, '', '   ', '\n\t'])('falls back to the default for %j', function (stored) {
        expect(resolveExportPrompt(stored)).toBe(DEFAULT_EXPORT_PROMPT)
    })

    it('preserves surrounding whitespace on a non-blank override', function () {
        expect(resolveExportPrompt('  keep me  ')).toBe('  keep me  ')
    })

    // The default prompt exists to put the agent in a planning posture before it edits anything;
    // if that instruction ever disappears the export silently becomes an invitation to auto-patch.
    it('ships a default prompt that demands a planning pass first', function () {
        expect(DEFAULT_EXPORT_PROMPT).toContain('plan mode')
        expect(DEFAULT_EXPORT_PROMPT.length).toBeGreaterThan(200)
    })
})

describe('buildAdvisoryMarkdown structure', function () {
    it('titles the document with the scope name', function () {
        expect(build(PROJECT_SCOPE, [])).toContain('# Sentinello advisory export — api')
    })

    it('embeds the prompt verbatim', function () {
        expect(build(PROJECT_SCOPE, [])).toContain('PROMPT-BODY')
    })

    it('stamps the generation time as ISO 8601', function () {
        expect(build(PROJECT_SCOPE, [])).toContain('Generated 2026-07-27T10:30:00.000Z')
    })

    it('says so explicitly when there are no findings', function () {
        expect(build(PROJECT_SCOPE, [])).toContain('_No current findings._')
    })

    it.each([
        [0, '0 findings'],
        [1, '1 finding'],
        [2, '2 findings']
    ] as Array<[number, string]>)('pluralizes a count of %d as %s', function (n, expected) {
        const findings: ExportFinding[] = []
        for (let i = 0; i < n; i++) findings.push(exportFinding({ advisoryId: 'GHSA-' + i }))
        expect(build(PROJECT_SCOPE, findings)).toContain(expected)
    })

    it('numbers each finding', function () {
        const md = build(PROJECT_SCOPE, [
            exportFinding({ packageName: 'a', advisoryId: 'GHSA-1' }),
            exportFinding({ packageName: 'b', advisoryId: 'GHSA-2' })
        ])
        expect(md).toContain('### 1. ')
        expect(md).toContain('### 2. ')
    })
})

describe('buildAdvisoryMarkdown scope subtitles', function () {
    it('names the project path for a project scope', function () {
        expect(build(PROJECT_SCOPE, [])).toContain('project: `/roots/work/api`')
    })

    it('names the library for a library scope', function () {
        expect(build(LIBRARY_SCOPE, [])).toContain('library: `lodash`')
    })

    it('names the root and project count for a workspace scope', function () {
        const md = build(WORKSPACE_SCOPE, [])
        expect(md).toContain('root: `/roots/work`')
        expect(md).toContain('4 projects')
    })

    it('singularizes a one-project workspace', function () {
        expect(build({ ...WORKSPACE_SCOPE, projectCount: 1 }, [])).toContain('1 project')
    })

    it.each([
        ['all', 'dep type: all (prod + dev)'],
        ['prod', 'dep type: production only'],
        ['dev', 'dep type: dev only']
    ] as Array<['all' | 'prod' | 'dev', string]>)('labels the %s dep filter', function (depType, expected) {
        expect(build({ ...PROJECT_SCOPE, depType }, [])).toContain(expected)
    })
})

describe('buildAdvisoryMarkdown finding rendering', function () {
    it('sorts by severity, then package name, then advisory id', function () {
        const md = build(PROJECT_SCOPE, [
            exportFinding({ packageName: 'zeta', severity: 'low', advisoryId: 'GHSA-9' }),
            exportFinding({ packageName: 'alpha', severity: 'critical', advisoryId: 'GHSA-2' }),
            exportFinding({ packageName: 'alpha', severity: 'critical', advisoryId: 'GHSA-1' })
        ])
        expect(md.indexOf('GHSA-1')).toBeLessThan(md.indexOf('GHSA-2'))
        expect(md.indexOf('GHSA-2')).toBeLessThan(md.indexOf('GHSA-9'))
    })

    it('does not mutate the caller findings array', function () {
        const findings = [
            exportFinding({ packageName: 'zeta', severity: 'low' }),
            exportFinding({ packageName: 'alpha', severity: 'critical' })
        ]
        build(PROJECT_SCOPE, findings)
        expect(findings[0]?.packageName).toBe('zeta')
    })

    it('links the advisory when a url is present', function () {
        const md = build(PROJECT_SCOPE, [
            exportFinding({ advisoryTitle: 'Prototype pollution', advisoryUrl: 'https://ghsa.example/1' })
        ])
        expect(md).toContain('- **Advisory:** [Prototype pollution](https://ghsa.example/1) (`GHSA-1`)')
    })

    it('renders the advisory without a link when there is no url', function () {
        const md = build(PROJECT_SCOPE, [exportFinding({ advisoryTitle: 'Prototype pollution' })])
        expect(md).toContain('- **Advisory:** Prototype pollution (`GHSA-1`)')
    })

    it('falls back to the advisory id when there is no title', function () {
        expect(build(PROJECT_SCOPE, [exportFinding()])).toContain('- **Advisory:** GHSA-1 (`GHSA-1`)')
    })

    it.each([
        [{ fixStatus: 'released', fixAvailable: true, fixVersion: '4.17.21', fixCheck: check() }, '- **Fix:** upgrade to `4.17.21`'],
        [{ fixStatus: 'none_released', fixCheck: check() }, '- **Fix:** **No fixed version released** — no published version of `lodash` is outside the vulnerable range (registry checked 2026-10-03)'],
        [{ fixAvailable: true, fixVersion: '4.17.21' }, '- **Fix:** advisory names `4.17.21` as the fix · not checked against the registry'],
        [{ fixAvailable: true, fixVersion: null }, '- **Fix:** npm reports `npm audit fix` resolves it (no version of this package stated) · not checked against the registry'],
        [{ fixAvailable: false, fixVersion: null }, '- **Fix:** no fix stated by the advisory · not checked against the registry'],
        [{ fixCheck: null }, '- **Fix:** fix not re-checked yet — rescan pending']
    ] as Array<[Partial<ExportFinding>, string]>)('renders the fix line for %j', function (overrides, expected) {
        expect(build(PROJECT_SCOPE, [exportFinding(overrides)])).toContain(expected)
    })

    // An unverified fix is the source's statement, not a registry fact, so it must never read as an
    // instruction to upgrade.
    it('never says "upgrade to" for an unverified fix', function () {
        const md = build(PROJECT_SCOPE, [exportFinding({ fixStatus: 'unverified', fixAvailable: true, fixVersion: '4.17.21' })])
        expect(md).not.toContain('upgrade to `4.17.21`')
    })

    it('names the sources when they disagree on the affected range', function () {
        const md = build(PROJECT_SCOPE, [exportFinding({
            fixStatus: 'released',
            fixAvailable: true,
            fixVersion: '1.2.0',
            fixCheck: check({
                sources: [
                    { source: 'npm-audit', installed: ['1.0.0'], affected: '<1.1.0', patched: null, statedFix: '1.1.0', noPatchedSentinel: false },
                    { source: 'osv', installed: ['1.0.0'], affected: '<1.2.0', patched: null, statedFix: '1.2.0', noPatchedSentinel: false }
                ]
            })
        })])
        expect(md).toContain('- **Fix evidence:** sources disagree: npm-audit `<1.1.0`, osv `<1.2.0` — `1.2.0` is outside both')
    })

    it('adds no evidence line when the sources agree', function () {
        const agreeing = check({ sources: [{ source: 'osv', installed: ['1.0.0'], affected: '<1.1.0', patched: null, statedFix: null, noPatchedSentinel: false }] })
        expect(build(PROJECT_SCOPE, [exportFinding({ fixCheck: agreeing })])).not.toContain('Fix evidence')
    })

    it.each([
        [{ isProd: true, isDev: false }, '- **Dep type:** prod'],
        [{ isProd: false, isDev: true }, '- **Dep type:** dev'],
        [{ isProd: true, isDev: true }, '- **Dep type:** prod + dev'],
        [{ isProd: false, isDev: false }, '- **Dep type:** unknown']
    ] as Array<[Partial<ExportFinding>, string]>)('renders the dep type for %j', function (overrides, expected) {
        expect(build(PROJECT_SCOPE, [exportFinding(overrides)])).toContain(expected)
    })

    it('renders the dependency path when there is one', function () {
        const md = build(PROJECT_SCOPE, [exportFinding({ depPath: ['app', 'express', 'lodash'] })])
        expect(md).toContain('- **Dependency path:** `app › express › lodash`')
    })

    it('omits the dependency path line when empty', function () {
        expect(build(PROJECT_SCOPE, [exportFinding()])).not.toContain('**Dependency path:**')
    })

    // Only library and workspace exports span projects, so attribution must survive there.
    it('names the project when the finding carries one', function () {
        expect(build(LIBRARY_SCOPE, [exportFinding({ projectName: 'api' })])).toContain('- **Project:** api')
    })

    it('omits the vulnerable range line when there is none', function () {
        expect(build(PROJECT_SCOPE, [exportFinding({ vulnerableRange: null })])).not.toContain('**Vulnerable range:**')
    })

    // Backticks in scanner output would otherwise break out of the inline code span and corrupt the
    // rest of the document for the reading model.
    it('escapes backticks in package names and versions', function () {
        const md = build(PROJECT_SCOPE, [exportFinding({ packageName: 'ev`il' })])
        expect(md).toContain('ev\\`il')
    })
})

// A project-scope export now renders one entry per distinct advisory, merging the rows that several
// sources each reported. The three optional fields carrying that merge must stay optional: the CLI,
// the worker webhook and the library-scope export all still pass single rows, and their output must
// not shift underneath them.
describe('buildAdvisoryMarkdown merged entries', function () {
    it('renders an entry with no merged fields exactly as it does without the feature', function () {
        const plain = exportFinding({ depPath: ['app', 'lodash'] })
        const md = build(PROJECT_SCOPE, [plain])
        expect(md).toContain('- **Dependency path:** `app › lodash`')
        expect(md).not.toContain('**Sources:**')
        expect(md).not.toContain('**Also reported as:**')
        expect(md).not.toContain('**Dependency paths:**')
    })

    it('lists every source that reported the vulnerability', function () {
        const md = build(PROJECT_SCOPE, [exportFinding({ sources: ['npm-audit', 'osv'] })])
        expect(md).toContain('- **Sources:** npm-audit, osv')
    })

    it('lists the other sources advisory ids without repeating the primary one', function () {
        const md = build(PROJECT_SCOPE, [
            exportFinding({ advisoryId: 'GHSA-1', advisoryIds: ['GHSA-1', 'CVE-2026-1'] })
        ])
        expect(md).toContain('- **Also reported as:** `CVE-2026-1`')
        expect(md).not.toContain('**Also reported as:** `GHSA-1`')
    })

    it('omits the also-reported-as line when every source used the same id', function () {
        const md = build(PROJECT_SCOPE, [exportFinding({ advisoryId: 'GHSA-1', advisoryIds: ['GHSA-1'] })])
        expect(md).not.toContain('**Also reported as:**')
    })

    // One route through the tree should read the same whether or not the entry happens to be merged;
    // only a genuinely multi-route entry earns the bullet list.
    it('keeps the singular inline form when a merged entry has one path', function () {
        const md = build(PROJECT_SCOPE, [exportFinding({ depPaths: [['app', 'lodash']] })])
        expect(md).toContain('- **Dependency path:** `app › lodash`')
        expect(md).not.toContain('**Dependency paths:**')
    })

    it('lists every route when a merged entry has several', function () {
        const md = build(PROJECT_SCOPE, [exportFinding({ depPaths: [['app', 'lodash'], ['app', 'express', 'lodash']] })])
        expect(md).toContain('- **Dependency paths:**')
        expect(md).toContain('    - `app › lodash`')
        expect(md).toContain('    - `app › express › lodash`')
    })

    it('prefers depPaths over the single depPath when both are set', function () {
        const md = build(PROJECT_SCOPE, [exportFinding({ depPath: ['stale'], depPaths: [['fresh', 'lodash']] })])
        expect(md).toContain('`fresh › lodash`')
        expect(md).not.toContain('`stale`')
    })
})

// The MCP tool has to fit a document into one tool result. Truncation is acceptable; a truncation the
// reader cannot detect is not — an agent that sees a document simply stop reads the rest as clean.
describe('buildPaginatedAdvisoryMarkdown', function () {
    function findings(n: number): ExportFinding[] {
        const out: ExportFinding[] = []
        for (let i = 0; i < n; i++) {
            out.push(exportFinding({ packageName: 'pkg-' + String(i).padStart(3, '0'), advisoryId: 'GHSA-' + i }))
        }
        return out
    }

    function page(all: ExportFinding[], offset: number, byteBudget: number) {
        return buildPaginatedAdvisoryMarkdown({
            scope: PROJECT_SCOPE,
            prompt: '',
            findings: all,
            generatedAt: AT,
            offset,
            byteBudget
        })
    }

    it('renders everything and reports no next page when it all fits', function () {
        const result = page(findings(5), 0, 1_000_000)
        expect(result.rendered).toBe(5)
        expect(result.total).toBe(5)
        expect(result.nextOffset).toBeNull()
    })

    it('stops at the budget and points at the next offset', function () {
        const result = page(findings(40), 0, 2000)
        expect(result.rendered).toBeGreaterThan(0)
        expect(result.rendered).toBeLessThan(40)
        expect(result.nextOffset).toBe(result.rendered)
        expect(result.total).toBe(40)
    })

    // The seam is the part that silently loses data if the arithmetic is off by one.
    it('walks every page without dropping or repeating an entry', function () {
        const all = findings(40)
        const seen: string[] = []
        let offset: number | null = 0
        let guard = 0
        while (offset !== null && guard < 50) {
            const result = page(all, offset, 2000)
            for (const f of all) {
                if (result.markdown.includes('`' + f.packageName + '@')) seen.push(f.packageName)
            }
            offset = result.nextOffset
            guard++
        }
        expect(offset).toBeNull()
        const unique = [...new Set(seen)]
        expect(unique).toHaveLength(40)
        expect(seen).toHaveLength(40)
    })

    it('numbers entries continuously across pages rather than restarting', function () {
        const all = findings(40)
        const first = page(all, 0, 2000)
        const second = page(all, first.rendered, 2000)
        expect(second.markdown).toContain('### ' + (first.rendered + 1) + '.')
        expect(second.markdown).not.toContain('### 1.')
    })

    it('states the page range rather than the whole total in the header', function () {
        const result = page(findings(40), 0, 2000)
        expect(result.markdown).toContain('findings 1–' + result.rendered + ' of 40')
    })

    // Otherwise a single oversized finding would return an empty page pointing at its own offset,
    // and a client following the continuation notice would loop forever.
    it('always renders at least one entry even when it alone exceeds the budget', function () {
        const result = page(findings(5), 0, 1)
        expect(result.rendered).toBe(1)
        expect(result.nextOffset).toBe(1)
    })

    it('clamps an offset past the end instead of throwing', function () {
        const result = page(findings(3), 99, 1_000_000)
        expect(result.rendered).toBe(0)
        expect(result.nextOffset).toBeNull()
        expect(result.markdown).toContain('_No current findings._')
    })

    it('drops the prompt section entirely when the prompt is empty', function () {
        const result = page(findings(1), 0, 1_000_000)
        expect(result.markdown).not.toContain('## How to approach these fixes')
    })

    it('keeps the prompt section when one is supplied', function () {
        const result = buildPaginatedAdvisoryMarkdown({
            scope: PROJECT_SCOPE,
            prompt: 'PROMPT-BODY',
            findings: findings(1),
            generatedAt: AT,
            offset: 0,
            byteBudget: 1_000_000
        })
        expect(result.markdown).toContain('## How to approach these fixes')
        expect(result.markdown).toContain('PROMPT-BODY')
    })
})

describe('buildExportFilename', function () {
    it('slugs a project name and stamps the date', function () {
        expect(buildExportFilename(PROJECT_SCOPE, AT)).toBe('sentinello-api-advisories-2026-07-27.md')
    })

    it('uses only the final path segment for a workspace scope', function () {
        expect(buildExportFilename(WORKSPACE_SCOPE, AT)).toBe('sentinello-work-advisories-2026-07-27.md')
    })

    // A slash-only root has no final segment, so lastPathSegment falls back to the path itself — which
    // then slugs away to nothing and lands on the placeholder rather than producing a bare filename.
    it('slugs a slash-only workspace root to the placeholder', function () {
        expect(buildExportFilename({ ...WORKSPACE_SCOPE, rootPath: '/' }, AT)).toBe(
            'sentinello-unnamed-advisories-2026-07-27.md'
        )
    })

    it.each([
        ['My Project', 'sentinello-my-project-advisories-2026-07-27.md'],
        ['@scope/pkg', 'sentinello-scope-pkg-advisories-2026-07-27.md'],
        ['a///b', 'sentinello-a-b-advisories-2026-07-27.md'],
        ['---weird---', 'sentinello-weird-advisories-2026-07-27.md'],
        ['keep.dots_and-dashes', 'sentinello-keep.dots_and-dashes-advisories-2026-07-27.md']
    ] as Array<[string, string]>)('sanitizes %j', function (projectName, expected) {
        expect(buildExportFilename({ ...PROJECT_SCOPE, projectName }, AT)).toBe(expected)
    })

    it('falls back to a placeholder when the name slugs to nothing', function () {
        expect(buildExportFilename({ ...PROJECT_SCOPE, projectName: '🙂' }, AT)).toBe(
            'sentinello-unnamed-advisories-2026-07-27.md'
        )
    })
})

describe('the way out of a none_released finding', function () {
    const remediation: Remediation = {
        v: 1,
        checkedAt: CHECKED_AT,
        package: 'braces',
        health: { name: 'braces', latest: '3.0.3', lastPublishAt: Date.UTC(2024, 4, 21), maintainers: 2, weeklyDownloads: 204706783, deprecated: null, daysSinceLastPublish: 865, unmaintained: true },
        chains: [
            { importer: '.', rootKind: 'dev', path: ['nodemon@3.1.14', 'chokidar@3.6.0', 'braces@3.0.3'], verdict: { kind: 'blocked', escapePackage: 'chokidar', escapeVersion: '4.0.0', blockedBy: 'nodemon', blockedByLatest: '3.1.14', blockedRange: '^3.5.2', proof: { release: 'chokidar@4.0.0', closureSize: 2 } } }
        ],
        moreChains: 0,
        alternatives: [{ replaces: 'nodemon', reason: 'blocked', signals: null, options: [], url: null }],
        devOnly: true,
        partial: false
    }

    it('renders the block under the Fix line for none_released, and never for another status', function () {
        const none = buildAdvisoryMarkdown({ scope: PROJECT_SCOPE, prompt: '', generatedAt: CHECKED_AT, findings: [exportFinding({ packageName: 'braces', installedVersion: '3.0.3', fixStatus: 'none_released', fixCheck: check(), remediation })] })
        expect(none).toContain('- **Fix:** **No fixed version released**')
        expect(none).toContain('- **Way out:**\n    - **Health:** `braces`: last publish 2024-05-21 (28 months ago) · 2 maintainers · 204,706,783 weekly downloads — **unmaintained** (no publish for 6+ months) → replace it')
        expect(none).toContain('        - `nodemon@3.1.14 › chokidar@3.6.0 › braces@3.0.3` [dev tooling only]: `chokidar` ≥ `4.0.0` drops `braces`, but no released `nodemon` admits it (latest 3.1.14 requires `^3.5.2`)')
        expect(none).toContain('    - **Dev tooling:** Every path to `braces` reaches only dev tooling')
        expect(none).toContain('    - **Alternatives:** no curated alternative known for `nodemon`')
        const released = buildAdvisoryMarkdown({ scope: PROJECT_SCOPE, prompt: '', generatedAt: CHECKED_AT, findings: [exportFinding({ fixStatus: 'released', fixVersion: '3.0.4', fixCheck: check(), remediation })] })
        expect(released).not.toContain('Way out')
    })

    it('omits the paths list when there are none, and says when the guidance is partial', function () {
        const md = buildAdvisoryMarkdown({ scope: PROJECT_SCOPE, prompt: '', generatedAt: CHECKED_AT, findings: [exportFinding({ packageName: 'braces', installedVersion: '3.0.3', fixStatus: 'none_released', fixCheck: check(), remediation: { ...remediation, chains: [], partial: true } })] })
        expect(md).not.toContain('**Paths:**')
        expect(md).toContain('    - Partial: the registry lookup budget ran out')
    })

    it('tells the reader, in the default prompt, not to chase a version that is not released', function () {
        expect(DEFAULT_EXPORT_PROMPT).toContain('## When no fixed version is released')
        expect(DEFAULT_EXPORT_PROMPT).toContain('Do not search for one, do not pin, install or override to a version the Fix line does not name')
        expect(DEFAULT_EXPORT_PROMPT).toContain('dev tooling only')
        expect(DEFAULT_EXPORT_PROMPT).toContain('"no upstream fix released"')
    })
})
