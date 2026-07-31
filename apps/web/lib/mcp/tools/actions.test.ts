import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
    enqueueScanRequest,
    getProjectById,
    insertMute,
    listActiveMutes,
    listRecentScanRequests
} from '@sentinello/db'
import type { Mute, ScanRequest } from '@sentinello/core'
import {
    closePortalTestDb,
    openPortalTestDb,
    ROOT_ID,
    seedProject,
    seedRoot,
    T0,
    type PortalTestDb
} from '@/lib/portal-test-db.fixture'
import { connectMcp, textOf, type McpHarness } from '@/lib/mcp/mcp-client.fixture'

// The write half of the MCP surface: an agent reaching these can mute findings and queue scans. The
// tools deliberately mirror apps/web/lib/actions/* rather than calling them, because those invoke
// revalidatePath, which only works inside a Next render request. So the DB effect must match the
// portal's — and that equivalence is what these tests hold in place.

let handle: PortalTestDb
let mcp: McpHarness

function queued(): ScanRequest[] {
    return listRecentScanRequests(handle.db)
}

function activeMutes(): Mute[] {
    return listActiveMutes(handle.db, T0)
}

// Asserting on the mute the tool just created, without every caller narrowing the index. When no mute
// exists the failure is that the tool created none — say so, rather than reporting a TypeError on
// undefined from whichever property the test happened to read.
function firstMute(): Mute {
    const [mute] = activeMutes()
    if (!mute) throw new Error('expected the tool to have created a mute, but none is active')
    return mute
}

beforeEach(async function setup() {
    handle = await openPortalTestDb('mcp-actions')
    seedRoot(handle.db)
    seedProject(handle.db, 'project-1')
    mcp = await connectMcp()
})

afterEach(async function teardown() {
    delete process.env.ME_NAME
    await mcp.close()
    await closePortalTestDb(handle)
})

describe('tool registration', function () {
    it('exposes every action tool', async function () {
        const names = await mcp.listToolNames()

        expect(names).toContain('request_scan')
        expect(names).toContain('mute_finding')
        expect(names).toContain('unmute')
        expect(names).toContain('set_project_alias')
        expect(names).toContain('set_project_tags')
    })
})

describe('request_scan', function () {
    it('enqueues a project scan', async function () {
        const result = await mcp.call('request_scan', { projectId: 'project-1' })

        expect(result.structuredContent).toMatchObject({ skipped: false })
        expect(queued()).toHaveLength(1)
        expect(queued()[0]).toMatchObject({ projectId: 'project-1', rootId: null })
    })

    it('enqueues a root scan', async function () {
        const result = await mcp.call('request_scan', { rootId: ROOT_ID })

        expect(result.structuredContent).toMatchObject({ skipped: false })
        expect(queued()[0]).toMatchObject({ projectId: null, rootId: ROOT_ID })
    })

    it('enqueues a full sweep when given neither target', async function () {
        const result = await mcp.call('request_scan')

        expect(result.structuredContent).toMatchObject({ skipped: false })
        expect(queued()[0]).toMatchObject({ projectId: null, rootId: null })
        expect(textOf(result)).toContain('full-sweep')
    })

    // The two targets mean different things to the worker, so a call setting both is ambiguous
    // rather than additive — rejected instead of silently picking one.
    it('rejects a call setting both a project and a root', async function () {
        const result = await mcp.call('request_scan', { projectId: 'project-1', rootId: ROOT_ID })

        expect(result.isError).toBe(true)
        expect(textOf(result)).toBe('projectId and rootId are mutually exclusive')
        expect(queued()).toEqual([])
    })

    it('reports an error for an unknown project', async function () {
        const result = await mcp.call('request_scan', { projectId: 'nope' })

        expect(result.isError).toBe(true)
        expect(textOf(result)).toBe('Project not found: nope')
    })

    // An agent has no button to disable, so it can retry freely. The dedupe is the only thing
    // stopping a loop from queueing an unbounded pile of identical sweeps.
    it('reports skipped rather than queueing a duplicate project scan', async function () {
        enqueueScanRequest(handle.db, { projectId: 'project-1' }, Date.now())

        const result = await mcp.call('request_scan', { projectId: 'project-1' })

        expect(result.structuredContent).toEqual({ skipped: true, reason: 'scan_in_flight' })
        expect(queued()).toHaveLength(1)
    })

    it('treats a root sweep as covering a project inside it', async function () {
        enqueueScanRequest(handle.db, { rootId: ROOT_ID }, Date.now())

        const result = await mcp.call('request_scan', { projectId: 'project-1' })

        expect(result.structuredContent).toEqual({ skipped: true, reason: 'scan_in_flight' })
    })

    it('reports skipped rather than queueing a duplicate root scan', async function () {
        enqueueScanRequest(handle.db, { rootId: ROOT_ID }, Date.now())

        const result = await mcp.call('request_scan', { rootId: ROOT_ID })

        expect(result.structuredContent).toEqual({ skipped: true, reason: 'scan_in_flight' })
        expect(queued()).toHaveLength(1)
    })

    it('reports skipped for a full sweep when anything is already in flight', async function () {
        enqueueScanRequest(handle.db, { projectId: 'project-1' }, Date.now())

        const result = await mcp.call('request_scan')

        expect(result.structuredContent).toEqual({ skipped: true, reason: 'scan_in_flight' })
        expect(queued()).toHaveLength(1)
    })

    it('returns the enqueued request so the caller can track it', async function () {
        const result = await mcp.call('request_scan', { projectId: 'project-1' })

        expect(result.structuredContent?.request).toMatchObject({ projectId: 'project-1', status: 'pending' })
    })
})

describe('mute_finding', function () {
    const findingArgs = {
        scope: 'finding',
        projectId: 'project-1',
        source: 'npm-audit',
        advisoryId: 'CVE-2024-1',
        packageName: 'lodash',
        reason: 'accepted risk'
    }

    it('creates a finding-scope mute', async function () {
        await mcp.call('mute_finding', findingArgs)

        expect(activeMutes()[0]).toMatchObject({
            scope: 'finding',
            projectId: 'project-1',
            scanner: 'npm-audit',
            ecosystem: 'npm',
            advisoryId: 'CVE-2024-1',
            packageName: 'lodash',
            reason: 'accepted risk'
        })
    })

    // Older MCP clients passed `scanner` for what is now `source`. The alias keeps them working
    // rather than having them create mutes with a null identity that silence nothing.
    it('accepts the legacy scanner alias for source', async function () {
        await mcp.call('mute_finding', { ...findingArgs, source: undefined, scanner: 'npm-audit' })

        expect(firstMute().scanner).toBe('npm-audit')
    })

    it('prefers source over the legacy scanner alias when both are given', async function () {
        await mcp.call('mute_finding', { ...findingArgs, source: 'osv', scanner: 'npm-audit' })

        expect(firstMute().scanner).toBe('osv')
    })

    it.each([['source'], ['advisoryId'], ['packageName']])(
        'reports an error when a finding-scope mute omits %s',
        async function (field) {
            const result = await mcp.call('mute_finding', { ...findingArgs, [field]: undefined })

            expect(result.isError).toBe(true)
            expect(textOf(result)).toBe('scope=finding requires source, advisoryId, and packageName')
            expect(activeMutes()).toEqual([])
        }
    )

    it('nulls every identity column on a project-scope mute', async function () {
        await mcp.call('mute_finding', { ...findingArgs, scope: 'project' })

        expect(activeMutes()[0]).toMatchObject({
            scope: 'project',
            projectId: 'project-1',
            scanner: null,
            ecosystem: null,
            advisoryId: null,
            packageName: null
        })
    })

    // projectId is the one identity field a finding-scope mute may omit, and omitting it is a feature
    // rather than an oversight: a null project_id makes the mute estate-wide, which is how an agent
    // silences one advisory everywhere at once instead of filing the same mute per project. The
    // matching SQL reads it as `(m.project_id IS NULL OR m.project_id = ...)`, so the column has to be
    // a real NULL — an empty string would match no project at all and silence nothing.
    it('creates an estate-wide mute when no project is named', async function () {
        await mcp.call('mute_finding', { ...findingArgs, projectId: undefined })

        expect(activeMutes()[0]).toMatchObject({
            scope: 'finding',
            projectId: null,
            scanner: 'npm-audit',
            advisoryId: 'CVE-2024-1',
            packageName: 'lodash'
        })
    })

    // A mute on npm lodash must never silence a same-named PyPI package, so the ecosystem is part of
    // the identity and defaults rather than being left open.
    it('defaults a missing ecosystem to npm', async function () {
        await mcp.call('mute_finding', findingArgs)

        expect(firstMute().ecosystem).toBe('npm')
    })

    it('honours an explicit ecosystem', async function () {
        await mcp.call('mute_finding', { ...findingArgs, ecosystem: 'PyPI' })

        expect(firstMute().ecosystem).toBe('PyPI')
    })

    // The portal records the operator's name; an MCP-created mute is attributed to 'mcp' so the audit
    // trail distinguishes a human's decision from an agent's.
    it('attributes the mute to mcp when ME_NAME is unset', async function () {
        await mcp.call('mute_finding', findingArgs)

        expect(firstMute().author).toBe('mcp')
    })

    it('records ME_NAME as the author when set', async function () {
        process.env.ME_NAME = 'betty'

        await mcp.call('mute_finding', findingArgs)

        expect(firstMute().author).toBe('betty')
    })

    it('trims the reason', async function () {
        await mcp.call('mute_finding', { ...findingArgs, reason: '  accepted risk  ' })

        expect(firstMute().reason).toBe('accepted risk')
    })

    it('stores an expiry when given', async function () {
        await mcp.call('mute_finding', { ...findingArgs, expiresAt: T0 + 86_400_000 })

        expect(firstMute().expiresAt).toBe(T0 + 86_400_000)
    })

    it('treats a null expiry as permanent', async function () {
        await mcp.call('mute_finding', { ...findingArgs, expiresAt: null })

        expect(firstMute().expiresAt).toBeNull()
    })

    // The reason is the audit trail for an accepted-risk decision, so the schema requires it rather
    // than letting an agent record a silent mute.
    it('rejects a missing reason at the schema', async function () {
        const result = await mcp.call('mute_finding', { ...findingArgs, reason: undefined })

        expect(result.isError).toBe(true)
    })

    it('rejects an empty reason at the schema', async function () {
        const result = await mcp.call('mute_finding', { ...findingArgs, reason: '' })

        expect(result.isError).toBe(true)
    })

    it('rejects a scope outside project and finding', async function () {
        const result = await mcp.call('mute_finding', { ...findingArgs, scope: 'global' })

        expect(result.isError).toBe(true)
    })
})

describe('unmute', function () {
    function seedMute(id: string): void {
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
            expiresAt: null
        } as Mute)
    }

    it('deletes the mute', async function () {
        seedMute('mute-1')

        const result = await mcp.call('unmute', { muteId: 'mute-1' })

        expect(activeMutes()).toEqual([])
        expect(result.structuredContent).toEqual({ deleted: 'mute-1' })
    })

    // Reports success for an id that was never there. Deleting an already-deleted mute has reached
    // the desired state, so an agent retrying does not need to distinguish the two.
    it('reports success for an unknown id', async function () {
        const result = await mcp.call('unmute', { muteId: 'nope' })

        expect(result.isError).toBeFalsy()
        expect(result.structuredContent).toEqual({ deleted: 'nope' })
    })

    it('rejects an empty mute id at the schema', async function () {
        const result = await mcp.call('unmute', { muteId: '' })

        expect(result.isError).toBe(true)
    })
})

describe('set_project_alias', function () {
    it('sets the alias', async function () {
        await mcp.call('set_project_alias', { projectId: 'project-1', alias: 'Billing API' })

        expect(getProjectById(handle.db, 'project-1')?.alias).toBe('Billing API')
    })

    it('trims the alias', async function () {
        await mcp.call('set_project_alias', { projectId: 'project-1', alias: '  Billing API  ' })

        expect(getProjectById(handle.db, 'project-1')?.alias).toBe('Billing API')
    })

    // An empty string is the documented clear gesture, which is why the schema allows it here while
    // every other string field requires a minimum length.
    it('clears the alias when given an empty string', async function () {
        await mcp.call('set_project_alias', { projectId: 'project-1', alias: 'Billing API' })

        await mcp.call('set_project_alias', { projectId: 'project-1', alias: '' })

        expect(getProjectById(handle.db, 'project-1')?.alias).toBeNull()
    })

    it('reports an error for an unknown project', async function () {
        const result = await mcp.call('set_project_alias', { projectId: 'nope', alias: 'x' })

        expect(result.isError).toBe(true)
        expect(textOf(result)).toBe('Project not found: nope')
    })

    it('echoes the stored alias back to the caller', async function () {
        const result = await mcp.call('set_project_alias', { projectId: 'project-1', alias: '  Billing API ' })

        expect(result.structuredContent).toEqual({ projectId: 'project-1', alias: 'Billing API' })
    })
})

describe('set_project_tags', function () {
    it('replaces the tag set', async function () {
        await mcp.call('set_project_tags', { projectId: 'project-1', tags: ['backend', 'payments'] })

        expect(getProjectById(handle.db, 'project-1')?.tags).toEqual(['backend', 'payments'])
    })

    it('trims each tag and drops empty ones', async function () {
        await mcp.call('set_project_tags', { projectId: 'project-1', tags: ['  backend  ', '', '   ', 'payments'] })

        expect(getProjectById(handle.db, 'project-1')?.tags).toEqual(['backend', 'payments'])
    })

    it('clears every tag when given an empty list', async function () {
        await mcp.call('set_project_tags', { projectId: 'project-1', tags: ['backend'] })

        await mcp.call('set_project_tags', { projectId: 'project-1', tags: [] })

        expect(getProjectById(handle.db, 'project-1')?.tags).toEqual([])
    })

    it('reports an error for an unknown project', async function () {
        const result = await mcp.call('set_project_tags', { projectId: 'nope', tags: [] })

        expect(result.isError).toBe(true)
        expect(textOf(result)).toBe('Project not found: nope')
    })

    it('echoes the cleaned tags back to the caller', async function () {
        const result = await mcp.call('set_project_tags', { projectId: 'project-1', tags: [' backend ', ''] })

        expect(result.structuredContent).toEqual({ projectId: 'project-1', tags: ['backend'] })
    })
})
