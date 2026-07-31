import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { revalidatePath } from 'next/cache'
import { getProjectById } from '@sentinello/db'
import { closePortalTestDb, openPortalTestDb, seedProject, seedRoot, type PortalTestDb } from '@/lib/portal-test-db.fixture'
import { setProjectAliasAction } from './alias'

// revalidatePath only works inside a Next render request, so it is stubbed — but the stub is also
// the assertion surface. Which paths an action busts is real behaviour: miss one and the operator
// keeps seeing the pre-edit value until something else happens to invalidate that route.
vi.mock('next/cache', function stubNextCache() {
    return { revalidatePath: vi.fn() }
})

let handle: PortalTestDb

function bustedPaths(): string[] {
    return vi.mocked(revalidatePath).mock.calls.map(function first(call) { return call[0] })
}

beforeEach(async function setup() {
    vi.mocked(revalidatePath).mockClear()
    handle = await openPortalTestDb('alias-action')
    seedRoot(handle.db)
    seedProject(handle.db, 'project-1')
})

afterEach(async function teardown() {
    await closePortalTestDb(handle)
})

describe('setProjectAliasAction', function () {
    it('sets the alias on an existing project', async function () {
        await setProjectAliasAction('project-1', 'Billing API')

        expect(getProjectById(handle.db, 'project-1')?.alias).toBe('Billing API')
    })

    it('trims surrounding whitespace before storing', async function () {
        await setProjectAliasAction('project-1', '   Billing API   ')

        expect(getProjectById(handle.db, 'project-1')?.alias).toBe('Billing API')
    })

    // The alias overrides the auto-derived project name, so "clear it" has to be expressible. An
    // empty (or whitespace-only) submission is the UI's clear gesture and must land as NULL rather
    // than as an empty-string alias that would render as a blank project title.
    it('stores null when the alias is empty or whitespace only', async function () {
        await setProjectAliasAction('project-1', 'Billing API')
        await setProjectAliasAction('project-1', '   ')

        expect(getProjectById(handle.db, 'project-1')?.alias).toBeNull()
    })

    it('busts the project page and the dashboard', async function () {
        await setProjectAliasAction('project-1', 'Billing API')

        expect(bustedPaths()).toEqual(['/projects/project-1', '/'])
    })

    it('throws on an unknown project rather than silently doing nothing', async function () {
        await expect(setProjectAliasAction('missing', 'Whatever')).rejects.toThrow('project not found: missing')
    })

    it('does not revalidate when the project does not exist', async function () {
        await expect(setProjectAliasAction('missing', 'Whatever')).rejects.toThrow()

        expect(bustedPaths()).toEqual([])
    })
})
