import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { revalidatePath } from 'next/cache'
import { enqueueScanRequest, listRecentScanRequests } from '@sentinello/db'
import type { ScanRequest } from '@sentinello/core'
import { closePortalTestDb, openPortalTestDb, seedProject, seedRoot, ROOT_ID, type PortalTestDb } from '@/lib/portal-test-db.fixture'
import { requestFullSweep, requestScanForProject, requestScanForRoot } from './scan-request'

vi.mock('next/cache', function stubNextCache() {
    return { revalidatePath: vi.fn() }
})

let handle: PortalTestDb

function queued(): ScanRequest[] {
    return listRecentScanRequests(handle.db)
}

// The request the queue is holding, without every caller narrowing the index. An empty queue means
// nothing was enqueued at all, which is a more useful failure than a TypeError on undefined.
function firstQueued(): ScanRequest {
    const [request] = queued()
    if (!request) throw new Error('expected a scan request to be queued, but the queue is empty')
    return request
}

function bustedPaths(): string[] {
    return vi.mocked(revalidatePath).mock.calls.map(function first(call) { return call[0] })
}

beforeEach(async function setup() {
    vi.mocked(revalidatePath).mockClear()
    handle = await openPortalTestDb('scan-request-action')
    seedRoot(handle.db)
    seedProject(handle.db, 'project-1')
    seedProject(handle.db, 'project-2')
    seedRoot(handle.db, { id: 'root-2', path: '/srv/other', label: 'Other' })
})

afterEach(async function teardown() {
    await closePortalTestDb(handle)
})

// Every one of these actions is a dedupe guard in front of an enqueue. The UI already disables the
// button while a scan is in flight, so these paths only run on a race (double click, two tabs) —
// which is exactly why they are worth pinning: nothing else stops a duplicate sweep.
describe('requestScanForProject', function () {
    it('enqueues a request targeting just that project', async function () {
        await requestScanForProject('project-1')

        expect(queued()).toHaveLength(1)
        expect(queued()[0]).toMatchObject({ projectId: 'project-1', rootId: null, status: 'pending' })
    })

    it('busts the project page and the projects list', async function () {
        await requestScanForProject('project-1')

        expect(bustedPaths()).toEqual(['/projects/project-1', '/projects'])
    })

    // Unlike the alias/tag actions this one returns quietly. The caller is a fire-and-forget button
    // with no error surface, and a project can legitimately vanish between render and click when a
    // root is removed in another tab.
    it('returns without enqueueing or revalidating for an unknown project', async function () {
        await expect(requestScanForProject('missing')).resolves.toBeUndefined()

        expect(queued()).toEqual([])
        expect(bustedPaths()).toEqual([])
    })

    it('does not enqueue a second request while one is already pending for the project', async function () {
        await requestScanForProject('project-1')
        await requestScanForProject('project-1')

        expect(queued()).toHaveLength(1)
    })

    // A root sweep will visit this project anyway, so a per-project request on top of it is pure
    // duplicated work.
    it('is covered by a pending sweep of the project\'s own root', async function () {
        enqueueScanRequest(handle.db, { rootId: ROOT_ID }, Date.now())

        await requestScanForProject('project-1')

        expect(queued()).toHaveLength(1)
        expect(firstQueued().rootId).toBe(ROOT_ID)
    })

    it('is covered by a pending full sweep', async function () {
        enqueueScanRequest(handle.db, {}, Date.now())

        await requestScanForProject('project-1')

        expect(queued()).toHaveLength(1)
    })

    // The guard must be scoped, not global: an unrelated project's scan is not a reason to refuse.
    it('still enqueues when the in-flight request targets a different project', async function () {
        enqueueScanRequest(handle.db, { projectId: 'project-2' }, Date.now())

        await requestScanForProject('project-1')

        expect(queued()).toHaveLength(2)
    })

    it('still enqueues when the in-flight request targets a different root', async function () {
        enqueueScanRequest(handle.db, { rootId: 'root-2' }, Date.now())

        await requestScanForProject('project-1')

        expect(queued()).toHaveLength(2)
    })
})

describe('requestScanForRoot', function () {
    it('enqueues a request targeting the root', async function () {
        await requestScanForRoot(ROOT_ID)

        expect(queued()).toHaveLength(1)
        expect(queued()[0]).toMatchObject({ projectId: null, rootId: ROOT_ID, status: 'pending' })
    })

    it('busts the roots settings page and the projects list', async function () {
        await requestScanForRoot(ROOT_ID)

        expect(bustedPaths()).toEqual(['/settings/roots', '/projects'])
    })

    it('does not enqueue while a request for the same root is pending', async function () {
        await requestScanForRoot(ROOT_ID)
        await requestScanForRoot(ROOT_ID)

        expect(queued()).toHaveLength(1)
    })

    it('is covered by a pending full sweep', async function () {
        enqueueScanRequest(handle.db, {}, Date.now())

        await requestScanForRoot(ROOT_ID)

        expect(queued()).toHaveLength(1)
    })

    // The asymmetry with requestScanForProject is deliberate: a request for one project inside this
    // root does NOT cover a root sweep, because the operator asking to scan the whole root is asking
    // for strictly more work than the single-project request already queued.
    it('still enqueues when only a single project inside the root is in flight', async function () {
        enqueueScanRequest(handle.db, { projectId: 'project-1' }, Date.now())

        await requestScanForRoot(ROOT_ID)

        expect(queued()).toHaveLength(2)
    })

    // Note the asymmetry with requestScanForProject, which looks the project up first and returns
    // quietly when it is gone. This action has no such check, so a stale root id falls through to
    // the scan_requests.root_id foreign key and surfaces as a raw SqliteError. Pinned as-is rather
    // than treated as a bug: nothing is enqueued either way, and the UI has no error surface here.
    it('rejects an unknown root id at the foreign key rather than checking first', async function () {
        await expect(requestScanForRoot('root-unknown')).rejects.toThrow(/FOREIGN KEY/)

        expect(queued()).toEqual([])
    })
})

describe('requestFullSweep', function () {
    it('enqueues an untargeted request', async function () {
        await requestFullSweep()

        expect(queued()).toHaveLength(1)
        expect(queued()[0]).toMatchObject({ projectId: null, rootId: null, status: 'pending' })
    })

    it('busts the projects list and the dashboard', async function () {
        await requestFullSweep()

        expect(bustedPaths()).toEqual(['/projects', '/'])
    })

    // The broadest guard of the three: ANY in-flight request blocks a sweep, because a sweep is the
    // most expensive thing the worker can be asked to do and the queue is drained serially.
    it('is blocked by any in-flight request, including a single-project one', async function () {
        enqueueScanRequest(handle.db, { projectId: 'project-1' }, Date.now())

        await requestFullSweep()

        expect(queued()).toHaveLength(1)
        expect(firstQueued().projectId).toBe('project-1')
    })

    it('is blocked by a pending root sweep', async function () {
        enqueueScanRequest(handle.db, { rootId: ROOT_ID }, Date.now())

        await requestFullSweep()

        expect(queued()).toHaveLength(1)
    })
})
