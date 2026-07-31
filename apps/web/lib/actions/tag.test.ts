import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { revalidatePath } from 'next/cache'
import { getProjectById } from '@sentinello/db'
import { closePortalTestDb, openPortalTestDb, seedProject, seedRoot, type PortalTestDb } from '@/lib/portal-test-db.fixture'
import { setProjectTagsAction } from './tag'

vi.mock('next/cache', function stubNextCache() {
    return { revalidatePath: vi.fn() }
})

let handle: PortalTestDb

function bustedPaths(): string[] {
    return vi.mocked(revalidatePath).mock.calls.map(function first(call) { return call[0] })
}

function tagsOf(id: string): string[] | undefined {
    return getProjectById(handle.db, id)?.tags
}

beforeEach(async function setup() {
    vi.mocked(revalidatePath).mockClear()
    handle = await openPortalTestDb('tag-action')
    seedRoot(handle.db)
    seedProject(handle.db, 'project-1')
})

afterEach(async function teardown() {
    await closePortalTestDb(handle)
})

// The action takes raw CSV straight from a text input, so every parsing rule here is the difference
// between a tag set an operator can filter on and one full of empty or padded strings.
describe('setProjectTagsAction', function () {
    it('splits a comma-separated list into tags', async function () {
        await setProjectTagsAction('project-1', 'backend,payments,tier-1')

        expect(tagsOf('project-1')).toEqual(['backend', 'payments', 'tier-1'])
    })

    it('trims whitespace around each tag', async function () {
        await setProjectTagsAction('project-1', ' backend ,  payments  ')

        expect(tagsOf('project-1')).toEqual(['backend', 'payments'])
    })

    // Trailing commas and double commas are what a human actually types while editing a list.
    it('drops empty segments from stray commas', async function () {
        await setProjectTagsAction('project-1', 'backend,,payments,')

        expect(tagsOf('project-1')).toEqual(['backend', 'payments'])
    })

    // Replace, not merge — this is the only way to remove a tag through the UI.
    it('replaces the previous tag set rather than merging into it', async function () {
        await setProjectTagsAction('project-1', 'backend,payments')
        await setProjectTagsAction('project-1', 'frontend')

        expect(tagsOf('project-1')).toEqual(['frontend'])
    })

    it('clears every tag when given an empty string', async function () {
        await setProjectTagsAction('project-1', 'backend,payments')
        await setProjectTagsAction('project-1', '')

        expect(tagsOf('project-1')).toEqual([])
    })

    it('busts the project page and the projects list', async function () {
        await setProjectTagsAction('project-1', 'backend')

        expect(bustedPaths()).toEqual(['/projects/project-1', '/projects'])
    })

    it('throws on an unknown project', async function () {
        await expect(setProjectTagsAction('missing', 'backend')).rejects.toThrow('project not found: missing')
        expect(bustedPaths()).toEqual([])
    })
})
