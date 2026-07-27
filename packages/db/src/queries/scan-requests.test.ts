import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SCAN_HEARTBEAT_STALE_MS } from '@sentinello/core'
import { openDb } from '../client'
import type { DrizzleDb, SqliteDb } from '../client'
import { runMigrations } from '../migrate'
import { upsertRoot } from './config'
import { upsertProject } from './projects'
import {
    claimNextPendingRequest,
    enqueueScanRequest,
    isAnyScanInFlight,
    isScanInFlightForProject,
    isScanInFlightForRoot,
    listInFlightScanProjectIds,
    listRecentScanRequests,
    markScanRequestDone,
    markScanRequestFailed,
    pingScanRequestHeartbeat,
    resetOrphanedRunningRequests,
    selectInFlightScanRequests
} from './scan-requests'

// The scan_requests table is the portal → worker mailbox. Two properties matter to a user watching a
// "Scan now" button: a crashed worker must not pin the UI to "Scanning…" forever (hence the heartbeat
// staleness rules, tested at their exact boundary), and the queue must be self-healing across a crash.
//
// Runs against a real SQLite file rather than ':memory:', matching the harness in findings.test.ts —
// the client applies WAL pragmas and the worker opens the database by path.

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle')

const ROOT_ID = 'root-1'
const OTHER_ROOT_ID = 'root-2'
const PROJECT_ID = 'project-1'
const OTHER_PROJECT_ID = 'project-2'
const T0 = Date.UTC(2026, 0, 1)

let db: DrizzleDb
let sqlite: SqliteDb
let dir: string

function addProject(id: string, rootId: string, relPath: string): void {
    upsertProject(db, {
        id,
        rootId,
        relPath,
        name: relPath,
        alias: null,
        packageManager: 'npm',
        nvmrcVersion: null,
        gitBranch: null,
        ecosystems: ['npm'],
        muted: false,
        tags: [],
        createdAt: T0,
        updatedAt: T0
    })
}

beforeEach(async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-scan-requests-'))
    const opened = openDb({ dbPath: join(dir, 'test.sqlite') })
    db = opened.db
    sqlite = opened.sqlite
    runMigrations(db, { migrationsFolder: MIGRATIONS })

    upsertRoot(db, { id: ROOT_ID, path: '/repo', label: null, createdAt: T0 })
    upsertRoot(db, { id: OTHER_ROOT_ID, path: '/other', label: null, createdAt: T0 })
    addProject(PROJECT_ID, ROOT_ID, 'app')
    addProject(OTHER_PROJECT_ID, OTHER_ROOT_ID, 'other-app')
})

afterEach(async function teardown() {
    sqlite.close()
    await rm(dir, { recursive: true, force: true })
})

describe('enqueueScanRequest', function () {
    it('enqueues a pending single-project request', function () {
        const request = enqueueScanRequest(db, { projectId: PROJECT_ID }, T0)
        expect(request).toMatchObject({
            projectId: PROJECT_ID,
            rootId: null,
            status: 'pending',
            requestedAt: T0,
            pickedUpAt: null,
            finishedAt: null
        })
    })

    it('enqueues a root-scoped request', function () {
        expect(enqueueScanRequest(db, { rootId: ROOT_ID }, T0)).toMatchObject({ projectId: null, rootId: ROOT_ID })
    })

    // Both null is the full-sweep signal the worker reads, so it must survive as null rather than ''.
    it('enqueues a full sweep when neither target is given', function () {
        expect(enqueueScanRequest(db, {}, T0)).toMatchObject({ projectId: null, rootId: null })
    })

    it('normalizes empty-string targets to null', function () {
        expect(enqueueScanRequest(db, { projectId: '', rootId: '' }, T0)).toMatchObject({
            projectId: null,
            rootId: null
        })
    })

    it('gives each request a distinct id', function () {
        const a = enqueueScanRequest(db, {}, T0)
        const b = enqueueScanRequest(db, {}, T0)
        expect(a.id).not.toBe(b.id)
    })

    it('persists the request so it can be listed', function () {
        enqueueScanRequest(db, { projectId: PROJECT_ID }, T0)
        expect(listRecentScanRequests(db)).toHaveLength(1)
    })
})

describe('claimNextPendingRequest', function () {
    it('returns null when the queue is empty', function () {
        expect(claimNextPendingRequest(db, T0)).toBeNull()
    })

    it('claims the oldest pending request first', function () {
        enqueueScanRequest(db, { projectId: OTHER_PROJECT_ID }, T0 + 1000)
        enqueueScanRequest(db, { projectId: PROJECT_ID }, T0)
        expect(claimNextPendingRequest(db, T0 + 5000)?.projectId).toBe(PROJECT_ID)
    })

    it('marks the claimed request running and stamps both timestamps', function () {
        enqueueScanRequest(db, { projectId: PROJECT_ID }, T0)
        const claimed = claimNextPendingRequest(db, T0 + 500)
        expect(claimed).toMatchObject({ status: 'running', pickedUpAt: T0 + 500, heartbeatAt: T0 + 500 })
    })

    // Claiming must be a state transition, not a peek: a second worker must not get the same row.
    it('does not hand the same request out twice', function () {
        enqueueScanRequest(db, { projectId: PROJECT_ID }, T0)
        expect(claimNextPendingRequest(db, T0 + 1)).not.toBeNull()
        expect(claimNextPendingRequest(db, T0 + 2)).toBeNull()
    })

    it('ignores requests that already finished', function () {
        const request = enqueueScanRequest(db, { projectId: PROJECT_ID }, T0)
        markScanRequestDone(db, request.id, T0 + 1)
        expect(claimNextPendingRequest(db, T0 + 2)).toBeNull()
    })
})

describe('pingScanRequestHeartbeat', function () {
    it('refreshes the heartbeat of a running request', function () {
        enqueueScanRequest(db, { projectId: PROJECT_ID }, T0)
        const claimed = claimNextPendingRequest(db, T0 + 100)
        if (!claimed) throw new Error('expected a claimed request')
        pingScanRequestHeartbeat(db, claimed.id, T0 + 900)
        expect(selectInFlightScanRequests(db, T0 + 900)[0]?.heartbeatAt).toBe(T0 + 900)
    })

    // Guarded by status='running' so a late ping from a finishing scan cannot resurrect a done row.
    it('is a no-op for a request that already finished', function () {
        const request = enqueueScanRequest(db, { projectId: PROJECT_ID }, T0)
        claimNextPendingRequest(db, T0 + 100)
        markScanRequestDone(db, request.id, T0 + 200)
        pingScanRequestHeartbeat(db, request.id, T0 + 300)
        expect(listRecentScanRequests(db)[0]).toMatchObject({ status: 'done', heartbeatAt: T0 + 100 })
    })

    it('is a no-op for an unknown id', function () {
        expect(function ping() {
            pingScanRequestHeartbeat(db, 'nope', T0)
        }).not.toThrow()
    })
})

describe('resetOrphanedRunningRequests', function () {
    // Called at worker boot: any 'running' row belongs to a process that did not exit cleanly, so the
    // queue heals itself rather than leaving the UI stuck.
    it('fails every running request and reports the count', function () {
        enqueueScanRequest(db, { projectId: PROJECT_ID }, T0)
        enqueueScanRequest(db, { projectId: OTHER_PROJECT_ID }, T0 + 1)
        claimNextPendingRequest(db, T0 + 10)
        claimNextPendingRequest(db, T0 + 11)
        expect(resetOrphanedRunningRequests(db, T0 + 100)).toBe(2)
        expect(listRecentScanRequests(db).every(function failed(r) { return r.status === 'failed' })).toBe(true)
    })

    it('leaves pending requests alone', function () {
        enqueueScanRequest(db, { projectId: PROJECT_ID }, T0)
        expect(resetOrphanedRunningRequests(db, T0 + 100)).toBe(0)
        expect(listRecentScanRequests(db)[0]?.status).toBe('pending')
    })

    it('returns zero on an empty queue', function () {
        expect(resetOrphanedRunningRequests(db, T0)).toBe(0)
    })

    it('stamps the finish time', function () {
        enqueueScanRequest(db, { projectId: PROJECT_ID }, T0)
        claimNextPendingRequest(db, T0 + 10)
        resetOrphanedRunningRequests(db, T0 + 100)
        expect(listRecentScanRequests(db)[0]?.finishedAt).toBe(T0 + 100)
    })
})

describe('markScanRequestDone and markScanRequestFailed', function () {
    it.each([
        ['done', markScanRequestDone],
        ['failed', markScanRequestFailed]
    ] as Array<[string, (db: DrizzleDb, id: string, at: number) => void]>)('marks a request %s', function (status, mark) {
        const request = enqueueScanRequest(db, { projectId: PROJECT_ID }, T0)
        mark(db, request.id, T0 + 100)
        expect(listRecentScanRequests(db)[0]).toMatchObject({ status, finishedAt: T0 + 100 })
    })
})

describe('listRecentScanRequests', function () {
    it('returns requests oldest first', function () {
        enqueueScanRequest(db, { projectId: OTHER_PROJECT_ID }, T0 + 1000)
        enqueueScanRequest(db, { projectId: PROJECT_ID }, T0)
        expect(listRecentScanRequests(db).map(function id(r) { return r.projectId })).toEqual([
            PROJECT_ID,
            OTHER_PROJECT_ID
        ])
    })

    it('honours the limit', function () {
        enqueueScanRequest(db, {}, T0)
        enqueueScanRequest(db, {}, T0 + 1)
        expect(listRecentScanRequests(db, 1)).toHaveLength(1)
    })

    it('returns nothing on an empty queue', function () {
        expect(listRecentScanRequests(db)).toEqual([])
    })
})

// The heartbeat staleness boundary is what stops a crashed worker pinning the UI to "Scanning…".
// Both sides of it are asserted explicitly rather than approximated.
describe('in-flight detection', function () {
    it('counts a pending request as in flight', function () {
        enqueueScanRequest(db, { projectId: PROJECT_ID }, T0)
        expect(isAnyScanInFlight(db, T0)).toBe(true)
    })

    it('counts a running request with a fresh heartbeat as in flight', function () {
        enqueueScanRequest(db, { projectId: PROJECT_ID }, T0)
        claimNextPendingRequest(db, T0)
        expect(isAnyScanInFlight(db, T0 + SCAN_HEARTBEAT_STALE_MS - 1)).toBe(true)
    })

    it('counts a heartbeat exactly at the staleness boundary as fresh', function () {
        enqueueScanRequest(db, { projectId: PROJECT_ID }, T0)
        claimNextPendingRequest(db, T0)
        expect(isAnyScanInFlight(db, T0 + SCAN_HEARTBEAT_STALE_MS)).toBe(true)
    })

    it('stops counting a running request once its heartbeat goes stale', function () {
        enqueueScanRequest(db, { projectId: PROJECT_ID }, T0)
        claimNextPendingRequest(db, T0)
        expect(isAnyScanInFlight(db, T0 + SCAN_HEARTBEAT_STALE_MS + 1)).toBe(false)
    })

    it('is false on an empty queue', function () {
        expect(isAnyScanInFlight(db, T0)).toBe(false)
    })

    it('excludes a stale running request from the in-flight list', function () {
        enqueueScanRequest(db, { projectId: PROJECT_ID }, T0)
        claimNextPendingRequest(db, T0)
        expect(selectInFlightScanRequests(db, T0 + SCAN_HEARTBEAT_STALE_MS + 1)).toEqual([])
    })

    it('excludes finished requests from the in-flight list', function () {
        const request = enqueueScanRequest(db, { projectId: PROJECT_ID }, T0)
        markScanRequestDone(db, request.id, T0 + 1)
        expect(selectInFlightScanRequests(db, T0 + 2)).toEqual([])
    })
})

describe('isScanInFlightForProject', function () {
    it('is true when a request targets the project directly', function () {
        enqueueScanRequest(db, { projectId: PROJECT_ID }, T0)
        expect(isScanInFlightForProject(db, PROJECT_ID, ROOT_ID, T0)).toBe(true)
    })

    // A root sweep will reach this project, so its button must show scanning too.
    it('is true when a request targets the project root', function () {
        enqueueScanRequest(db, { rootId: ROOT_ID }, T0)
        expect(isScanInFlightForProject(db, PROJECT_ID, ROOT_ID, T0)).toBe(true)
    })

    it('is true during a full sweep', function () {
        enqueueScanRequest(db, {}, T0)
        expect(isScanInFlightForProject(db, PROJECT_ID, ROOT_ID, T0)).toBe(true)
    })

    it('is false for a request targeting a different project', function () {
        enqueueScanRequest(db, { projectId: OTHER_PROJECT_ID }, T0)
        expect(isScanInFlightForProject(db, PROJECT_ID, ROOT_ID, T0)).toBe(false)
    })

    it('is false for a request targeting a different root', function () {
        enqueueScanRequest(db, { rootId: OTHER_ROOT_ID }, T0)
        expect(isScanInFlightForProject(db, PROJECT_ID, ROOT_ID, T0)).toBe(false)
    })

    it('is false once the covering request goes stale', function () {
        enqueueScanRequest(db, { projectId: PROJECT_ID }, T0)
        claimNextPendingRequest(db, T0)
        expect(isScanInFlightForProject(db, PROJECT_ID, ROOT_ID, T0 + SCAN_HEARTBEAT_STALE_MS + 1)).toBe(false)
    })
})

describe('listInFlightScanProjectIds', function () {
    // Deliberately identical scope semantics to isScanInFlightForProject, in one query rather than
    // one per row — so the two must agree.
    it('lists a directly targeted project', function () {
        enqueueScanRequest(db, { projectId: PROJECT_ID }, T0)
        expect(listInFlightScanProjectIds(db, T0)).toEqual([PROJECT_ID])
    })

    it('lists every project under a targeted root', function () {
        addProject('project-3', ROOT_ID, 'sibling')
        enqueueScanRequest(db, { rootId: ROOT_ID }, T0)
        expect(listInFlightScanProjectIds(db, T0).sort()).toEqual([PROJECT_ID, 'project-3'])
    })

    it('lists every project during a full sweep', function () {
        enqueueScanRequest(db, {}, T0)
        expect(listInFlightScanProjectIds(db, T0).sort()).toEqual([PROJECT_ID, OTHER_PROJECT_ID].sort())
    })

    it('agrees with isScanInFlightForProject for a root sweep', function () {
        enqueueScanRequest(db, { rootId: ROOT_ID }, T0)
        const listed = listInFlightScanProjectIds(db, T0)
        expect(listed.includes(PROJECT_ID)).toBe(isScanInFlightForProject(db, PROJECT_ID, ROOT_ID, T0))
        expect(listed.includes(OTHER_PROJECT_ID)).toBe(
            isScanInFlightForProject(db, OTHER_PROJECT_ID, OTHER_ROOT_ID, T0)
        )
    })

    it('excludes stale running requests', function () {
        enqueueScanRequest(db, {}, T0)
        claimNextPendingRequest(db, T0)
        expect(listInFlightScanProjectIds(db, T0 + SCAN_HEARTBEAT_STALE_MS + 1)).toEqual([])
    })

    it('returns nothing when nothing is queued', function () {
        expect(listInFlightScanProjectIds(db, T0)).toEqual([])
    })
})

describe('isScanInFlightForRoot', function () {
    it('is true when a request targets the root', function () {
        enqueueScanRequest(db, { rootId: ROOT_ID }, T0)
        expect(isScanInFlightForRoot(db, ROOT_ID, T0)).toBe(true)
    })

    it('is true during a full sweep', function () {
        enqueueScanRequest(db, {}, T0)
        expect(isScanInFlightForRoot(db, ROOT_ID, T0)).toBe(true)
    })

    // Deliberately coarser than the per-project check: a single project scan inside this root does
    // NOT light up the root button, because the user picked the strict cascade.
    it('is false for a per-project request inside the root', function () {
        enqueueScanRequest(db, { projectId: PROJECT_ID }, T0)
        expect(isScanInFlightForRoot(db, ROOT_ID, T0)).toBe(false)
    })

    it('is false for a different root', function () {
        enqueueScanRequest(db, { rootId: OTHER_ROOT_ID }, T0)
        expect(isScanInFlightForRoot(db, ROOT_ID, T0)).toBe(false)
    })

    it('is false once the request goes stale', function () {
        enqueueScanRequest(db, { rootId: ROOT_ID }, T0)
        claimNextPendingRequest(db, T0)
        expect(isScanInFlightForRoot(db, ROOT_ID, T0 + SCAN_HEARTBEAT_STALE_MS + 1)).toBe(false)
    })
})
