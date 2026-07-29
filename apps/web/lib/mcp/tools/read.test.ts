import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { insertMute, setConfigValue } from '@sentinello/db'
import { sourceEnabledKey, type EcosystemId, type Mute, type SourceId } from '@sentinello/core'
import {
    closePortalTestDb,
    finding,
    openPortalTestDb,
    ROOT_ID,
    ROOT_PATH,
    scanProject,
    seedProject,
    seedRoot,
    T0,
    type PortalTestDb
} from '@/lib/portal-test-db.fixture'
import { connectMcp, jsonOf, textOf, type McpHarness } from '@/lib/mcp/mcp-client.fixture'

// These tools are what an agent sees of the estate. The failure that matters is a filter that
// silently drops findings: an agent reading an empty list concludes the project is clean, which is
// the one wrong answer a vulnerability tool must never give.

let handle: PortalTestDb
let mcp: McpHarness

function seedMute(id: string, overrides: Partial<Mute> = {}): void {
    insertMute(handle.db, {
        id,
        scope: 'finding',
        projectId: 'project-1',
        scanner: 'npm-audit',
        ecosystem: 'npm',
        advisoryId: 'CVE-2024-1',
        packageName: 'lodash',
        reason: 'accepted risk',
        author: 'betty',
        createdAt: T0,
        expiresAt: null,
        ...overrides
    } as Mute)
}

// Findings are visible only through the currently-active (source, ecosystem) cells. npm-audit/npm is
// the only cell on by default, so any fixture reaching for another source or ecosystem has to switch
// that cell on first — otherwise the rows exist but every read path correctly hides them.
function enableSourceCell(source: SourceId, ecosystem: EcosystemId): void {
    setConfigValue(handle.db, sourceEnabledKey(source, ecosystem), true)
}

// The SDK reports a schema violation as a normal result carrying isError, not as a thrown error, so
// a bad call reaches the agent as a readable message rather than a transport failure.
async function expectSchemaRejection(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await mcp.call(name, args)
    expect(result.isError).toBe(true)
    return textOf(result)
}

beforeEach(async function setup() {
    handle = await openPortalTestDb('mcp-read')
    seedRoot(handle.db)
    seedProject(handle.db, 'project-1', { name: 'Billing API' })
    mcp = await connectMcp()
})

afterEach(async function teardown() {
    await mcp.close()
    await closePortalTestDb(handle)
})

describe('tool registration', function () {
    it('exposes every read tool', async function () {
        const names = await mcp.listToolNames()

        expect(names).toContain('list_roots')
        expect(names).toContain('get_root')
        expect(names).toContain('list_projects')
        expect(names).toContain('get_project')
        expect(names).toContain('list_findings')
        expect(names).toContain('list_scans')
        expect(names).toContain('list_libraries')
        expect(names).toContain('get_dashboard_summary')
        expect(names).toContain('get_project_advisory')
    })
})

describe('list_roots', function () {
    it('returns each configured root', async function () {
        const result = await mcp.call('list_roots')

        expect(result.structuredContent).toEqual({
            roots: [{ id: ROOT_ID, path: ROOT_PATH, label: 'Code', createdAt: T0 }]
        })
    })

    // Both shapes go on the wire: structuredContent for schema-aware clients, a text block for the
    // ones that only render plain content.
    it('mirrors the payload as JSON text for clients without structured rendering', async function () {
        const result = await mcp.call('list_roots')

        expect(jsonOf<unknown[]>(result)).toEqual([{ id: ROOT_ID, path: ROOT_PATH, label: 'Code', createdAt: T0 }])
    })
})

describe('get_root', function () {
    it('returns the root', async function () {
        const result = await mcp.call('get_root', { id: ROOT_ID })

        expect(result.structuredContent).toMatchObject({ id: ROOT_ID, path: ROOT_PATH })
    })

    it('reports an error for an unknown id', async function () {
        const result = await mcp.call('get_root', { id: 'nope' })

        expect(result.isError).toBe(true)
        expect(textOf(result)).toBe('Root not found: nope')
    })

    // The schema declares id as required and non-empty, so the call is rejected before the handler
    // runs. Without that an agent could probe with an empty id and get a confusing miss instead of a
    // message telling it what it got wrong.
    it('rejects a call with no id at the schema', async function () {
        expect(await expectSchemaRejection('get_root', {})).toContain('expected string, received undefined')
    })

    it('rejects an empty id at the schema', async function () {
        expect(await expectSchemaRejection('get_root', { id: '' })).toContain('>=1 characters')
    })
})

describe('list_projects', function () {
    beforeEach(function seedSecondRoot() {
        seedRoot(handle.db, { id: 'root-2', path: '/srv/other', label: 'Other' })
        seedProject(handle.db, 'project-2', { rootId: 'root-2', name: 'Web Store' })
    })

    it('lists every project across all roots', async function () {
        const result = await mcp.call('list_projects')

        expect(jsonOf<{ id: string }[]>(result).map(function id(p) { return p.id }).sort()).toEqual([
            'project-1',
            'project-2'
        ])
    })

    it('limits to one root when given a root id', async function () {
        const result = await mcp.call('list_projects', { rootId: ROOT_ID })

        expect(jsonOf<{ id: string }[]>(result).map(function id(p) { return p.id })).toEqual(['project-1'])
    })

    it('reports an error for an unknown root id', async function () {
        const result = await mcp.call('list_projects', { rootId: 'nope' })

        expect(result.isError).toBe(true)
        expect(textOf(result)).toBe('Root not found: nope')
    })

    // The rich catalog shape is returned whether or not rootId is passed, so an agent gets the same
    // fields either way rather than a narrower row when it filters.
    it('carries severity counts and last-scan status in both modes', async function () {
        scanProject(handle.db, 'project-1', [finding({ severity: 'critical' })])

        const all = jsonOf<Record<string, unknown>[]>(await mcp.call('list_projects'))
        const scoped = jsonOf<Record<string, unknown>[]>(await mcp.call('list_projects', { rootId: ROOT_ID }))

        expect(Object.keys(all[0]).sort()).toEqual(Object.keys(scoped[0]).sort())
        expect(scoped[0]).toHaveProperty('rootPath', ROOT_PATH)
    })

    it('rejects a depType outside the allowed set', async function () {
        expect(await expectSchemaRejection('list_projects', { depType: 'everything' })).toContain(
            'expected one of'
        )
    })
})

describe('get_project', function () {
    it('returns the project', async function () {
        const result = await mcp.call('get_project', { id: 'project-1' })

        expect(result.structuredContent).toMatchObject({ id: 'project-1', name: 'Billing API' })
    })

    // Coverage is what stops an agent reading "no findings" as a clean bill of health when a
    // resolver could not audit the ecosystem at all.
    it('includes per-ecosystem resolver coverage', async function () {
        const result = await mcp.call('get_project', { id: 'project-1' })

        expect(result.structuredContent).toHaveProperty('coverage')
    })

    it('reports an error for an unknown project', async function () {
        const result = await mcp.call('get_project', { id: 'nope' })

        expect(result.isError).toBe(true)
        expect(textOf(result)).toBe('Project not found: nope')
    })
})

describe('list_findings', function () {
    beforeEach(function seedFindings() {
        scanProject(handle.db, 'project-1', [
            finding({ advisoryId: 'CVE-CRIT', packageName: 'crit-pkg', severity: 'critical' }),
            finding({ advisoryId: 'CVE-HIGH', packageName: 'high-pkg', severity: 'high' }),
            finding({ advisoryId: 'CVE-LOW', packageName: 'low-pkg', severity: 'low' })
        ])
    })

    function advisoryIds(result: { content: { text?: string }[] }): string[] {
        return jsonOf<{ advisoryId: string }[]>(result as never)
            .map(function id(f) { return f.advisoryId })
            .sort()
    }

    it('returns every active finding by default', async function () {
        const result = await mcp.call('list_findings', { projectId: 'project-1' })

        expect(advisoryIds(result)).toEqual(['CVE-CRIT', 'CVE-HIGH', 'CVE-LOW'])
    })

    it('keeps findings at or above the requested severity floor', async function () {
        const result = await mcp.call('list_findings', { projectId: 'project-1', minSeverity: 'high' })

        expect(advisoryIds(result)).toEqual(['CVE-CRIT', 'CVE-HIGH'])
    })

    // The trap the implementation comment calls out: `critical` ranks 0, so a falsy-zero check would
    // silently drop the floor entirely and return everything — inverting the most important filter
    // an agent can ask for.
    it('does not treat a critical floor as no floor at all', async function () {
        const result = await mcp.call('list_findings', { projectId: 'project-1', minSeverity: 'critical' })

        expect(advisoryIds(result)).toEqual(['CVE-CRIT'])
    })

    it('excludes muted findings by default', async function () {
        seedMute('mute-1', { advisoryId: 'CVE-CRIT', packageName: 'crit-pkg' })

        const result = await mcp.call('list_findings', { projectId: 'project-1' })

        expect(advisoryIds(result)).toEqual(['CVE-HIGH', 'CVE-LOW'])
    })

    it('includes muted findings when asked', async function () {
        seedMute('mute-1', { advisoryId: 'CVE-CRIT', packageName: 'crit-pkg' })

        const result = await mcp.call('list_findings', { projectId: 'project-1', includeMuted: true })

        expect(advisoryIds(result)).toEqual(['CVE-CRIT', 'CVE-HIGH', 'CVE-LOW'])
    })

    it('filters to one ecosystem', async function () {
        enableSourceCell('osv', 'PyPI')
        scanProject(
            handle.db,
            'project-1',
            [finding({ advisoryId: 'PYSEC-1', packageName: 'requests', ecosystem: 'PyPI' })],
            { scanner: 'osv', ecosystem: 'PyPI' }
        )

        const result = await mcp.call('list_findings', { projectId: 'project-1', ecosystem: 'PyPI' })

        expect(advisoryIds(result)).toEqual(['PYSEC-1'])
    })

    it('filters to one source', async function () {
        enableSourceCell('osv', 'npm')
        scanProject(handle.db, 'project-1', [finding({ advisoryId: 'GHSA-OSV', packageName: 'osv-pkg' })], {
            scanner: 'osv'
        })

        const result = await mcp.call('list_findings', { projectId: 'project-1', source: 'osv' })

        expect(advisoryIds(result)).toEqual(['GHSA-OSV'])
    })

    // The source-cell matrix gates the tool, not just the portal. An operator who has not enabled
    // osv for PyPI gets no PyPI findings through MCP either — the agent sees the same estate the
    // operator does, rather than a superset the portal is hiding.
    it('hides findings from a source cell the operator has not enabled', async function () {
        scanProject(
            handle.db,
            'project-1',
            [finding({ advisoryId: 'PYSEC-1', packageName: 'requests', ecosystem: 'PyPI' })],
            { scanner: 'osv', ecosystem: 'PyPI' }
        )

        const result = await mcp.call('list_findings', { projectId: 'project-1', ecosystem: 'PyPI' })

        expect(advisoryIds(result)).toEqual([])
    })

    it('returns an empty list for a project with no findings', async function () {
        seedProject(handle.db, 'project-clean')

        const result = await mcp.call('list_findings', { projectId: 'project-clean' })

        expect(jsonOf<unknown[]>(result)).toEqual([])
    })

    it('rejects a severity outside the known set', async function () {
        expect(
            await expectSchemaRejection('list_findings', { projectId: 'project-1', minSeverity: 'urgent' })
        ).toContain('expected one of')
    })

    it('rejects a call with no project id', async function () {
        expect(await expectSchemaRejection('list_findings', {})).toContain('expected string, received undefined')
    })
})

describe('list_scans', function () {
    it('returns the recorded scans for a project', async function () {
        scanProject(handle.db, 'project-1', [finding()])
        scanProject(handle.db, 'project-1', [finding()])

        expect(jsonOf<unknown[]>(await mcp.call('list_scans', { projectId: 'project-1' }))).toHaveLength(2)
    })

    it('honours an explicit limit', async function () {
        scanProject(handle.db, 'project-1', [finding()])
        scanProject(handle.db, 'project-1', [finding()])

        expect(jsonOf<unknown[]>(await mcp.call('list_scans', { projectId: 'project-1', limit: 1 }))).toHaveLength(1)
    })

    it('returns an empty list for a project that was never scanned', async function () {
        expect(jsonOf<unknown[]>(await mcp.call('list_scans', { projectId: 'project-1' }))).toEqual([])
    })

    it.each([[0], [201], [1.5]])('rejects a limit of %s', async function (limit) {
        const result = await mcp.call('list_scans', { projectId: 'project-1', limit })

        expect(result.isError).toBe(true)
    })
})

describe('list_libraries', function () {
    beforeEach(function seedAcrossEcosystems() {
        enableSourceCell('osv', 'PyPI')
        scanProject(handle.db, 'project-1', [finding({ packageName: 'lodash' })])
        scanProject(
            handle.db,
            'project-1',
            [finding({ packageName: 'requests', advisoryId: 'PYSEC-1', ecosystem: 'PyPI' })],
            { scanner: 'osv', ecosystem: 'PyPI' }
        )
    })

    function packageNames(result: { content: { text?: string }[] }): string[] {
        return jsonOf<{ packageName: string }[]>(result as never)
            .map(function name(l) { return l.packageName })
            .sort()
    }

    it('returns every observed package', async function () {
        expect(packageNames(await mcp.call('list_libraries'))).toEqual(['lodash', 'requests'])
    })

    // Each row carries its ecosystem so same-named packages in different ecosystems stay distinct.
    it('filters to one ecosystem', async function () {
        expect(packageNames(await mcp.call('list_libraries', { ecosystem: 'PyPI' }))).toEqual(['requests'])
    })

    it('returns an empty list for an ecosystem with nothing in it', async function () {
        expect(jsonOf<unknown[]>(await mcp.call('list_libraries', { ecosystem: 'crates.io' }))).toEqual([])
    })
})

describe('get_dashboard_summary', function () {
    it('returns the headline counts', async function () {
        scanProject(handle.db, 'project-1', [finding({ severity: 'critical' })])

        const result = await mcp.call('get_dashboard_summary')

        expect(result.structuredContent).toMatchObject({
            totalActiveProjects: 1,
            projectsWithFindings: 1,
            severityCounts: { critical: 1, high: 0, moderate: 0, low: 0, info: 0 }
        })
    })

    it('honours the dependency-type filter', async function () {
        scanProject(handle.db, 'project-1', [finding({ severity: 'critical', isProd: false, isDev: true })])

        const prod = await mcp.call('get_dashboard_summary', { depType: 'prod' })

        expect(prod.structuredContent).toMatchObject({
            projectsWithFindings: 0,
            severityCounts: { critical: 0 }
        })
    })
})

describe('get_project_advisory', function () {
    beforeEach(function seedFindings() {
        scanProject(handle.db, 'project-1', [
            finding({ advisoryId: 'CVE-2024-1', packageName: 'lodash' }),
            finding({ advisoryId: 'CVE-2024-2', packageName: 'axios' })
        ])
    })

    // The documented exception to the JSON-in-a-text-block convention: this payload is prose, and
    // stringifying it would escape every newline and backtick in a document whose native form is
    // already text.
    it('returns raw markdown rather than JSON', async function () {
        const result = await mcp.call('get_project_advisory', { projectId: 'project-1' })

        expect(textOf(result)).toContain('## Findings')
        expect(function parse() { return JSON.parse(textOf(result)) }).toThrow()
    })

    // structuredContent carries metadata only — duplicating the document there would double the
    // frame for a field most clients ignore.
    it('carries only metadata in structuredContent, not the document', async function () {
        const result = await mcp.call('get_project_advisory', { projectId: 'project-1' })

        expect(result.structuredContent).toMatchObject({ projectId: 'project-1', findingCount: 2 })
        expect(result.structuredContent).not.toHaveProperty('markdown')
    })

    it('reports an error for an unknown project', async function () {
        const result = await mcp.call('get_project_advisory', { projectId: 'nope' })

        expect(result.isError).toBe(true)
        expect(textOf(result)).toBe('Project not found: nope')
    })

    // Without the note the document can render "no current findings" under a prompt whose whole point
    // is that a silent zero is not success. The note also tells the agent not to act on the mutes,
    // because a mute is a human's accepted-risk decision.
    it('appends a note when findings were excluded for being muted', async function () {
        seedMute('mute-1', { advisoryId: 'CVE-2024-1', packageName: 'lodash' })

        const result = await mcp.call('get_project_advisory', { projectId: 'project-1' })

        expect(textOf(result)).toContain('1 finding is excluded from this document because it is muted')
        expect(textOf(result)).toContain('do not unmute or act on it')
    })

    it('pluralizes the muted note for more than one finding', async function () {
        seedMute('mute-1', { advisoryId: 'CVE-2024-1', packageName: 'lodash' })
        seedMute('mute-2', { advisoryId: 'CVE-2024-2', packageName: 'axios' })

        const result = await mcp.call('get_project_advisory', { projectId: 'project-1' })

        expect(textOf(result)).toContain('2 findings are excluded from this document because they are muted')
        expect(textOf(result)).toContain('do not unmute or act on them')
    })

    it('adds no note when nothing is muted', async function () {
        const result = await mcp.call('get_project_advisory', { projectId: 'project-1' })

        expect(textOf(result)).not.toContain('excluded from this document')
    })

    // The tool's default is 'all' while the portal page defaults to 'prod', which is why the tool
    // description tells the caller to pass 'prod' to match a download taken from the default view.
    it('defaults to every dependency type', async function () {
        scanProject(handle.db, 'project-1', [
            finding({ advisoryId: 'CVE-2024-1', packageName: 'lodash' }),
            finding({ advisoryId: 'CVE-2024-2', packageName: 'axios' }),
            finding({ advisoryId: 'CVE-DEV', packageName: 'devtool', isProd: false, isDev: true })
        ])

        const all = await mcp.call('get_project_advisory', { projectId: 'project-1' })
        const prod = await mcp.call('get_project_advisory', { projectId: 'project-1', depType: 'prod' })

        expect(textOf(all)).toContain('devtool')
        expect(textOf(prod)).not.toContain('devtool')
    })
})
