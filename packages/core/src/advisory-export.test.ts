import { describe, expect, it } from 'vitest'
import {
    buildAdvisoryMarkdown,
    buildExportFilename,
    DEFAULT_EXPORT_PROMPT,
    resolveExportPrompt,
    type ExportFinding,
    type ExportScope
} from './advisory-export'

// The advisory export is handed straight to an LLM as a remediation work list, so two properties
// matter: the prompt that frames the work must survive intact, and no finding may be silently dropped
// or mis-attributed. The markdown shape itself is asserted only where it carries meaning.

function exportFinding(overrides: Partial<ExportFinding> = {}): ExportFinding {
    return {
        packageName: 'lodash',
        installedVersion: '4.17.20',
        fixAvailable: false,
        fixVersion: null,
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
        [{ fixAvailable: true, fixVersion: '4.17.21' }, '- **Fix:** upgrade to `4.17.21`'],
        [{ fixAvailable: true, fixVersion: null }, '- **Fix:** available (target version not specified — check the advisory)'],
        [{ fixAvailable: false, fixVersion: null }, '- **Fix:** no fix available yet — track upstream or mitigate at the call site']
    ] as Array<[Partial<ExportFinding>, string]>)('renders the fix line for %j', function (overrides, expected) {
        expect(build(PROJECT_SCOPE, [exportFinding(overrides)])).toContain(expected)
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
