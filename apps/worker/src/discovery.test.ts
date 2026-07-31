import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    countScansForProject,
    insertMute,
    insertScan,
    listActiveMutes,
    listFindingsForProject,
    listProjects,
    mergeFindingsForScan,
    projectId as makeProjectId,
    setProjectAlias,
    setProjectTags,
    upsertRoot,
    type Root
} from '@sentinello/db'
import {
    PKG_JSON,
    T0,
    closeWorkerTestDb,
    makeTree,
    openWorkerTestDb,
    project,
    type WorkerTestDb
} from './worker-test-db.fixture'
import { discoverProjects } from './discovery'

// discoverProjects is the reconciliation half of a discovery pass: the walk itself lives in
// @sentinello/scanners (and is covered there), so what is worth pinning here is what the database does
// with the result. Three rules carry real consequences and none of them are visible from the walk:
//
//   - a project that vanished from disk is HARD-deleted, taking its scans, findings and mutes with it;
//   - an unmounted root is skipped entirely, and its projects must survive that skip untouched —
//     otherwise every container restart with a missing volume would silently destroy history;
//   - re-discovering a project must not overwrite what the operator set (alias, muted, tags) or when it
//     was first seen, because discovery runs on every sweep and would otherwise revert those edits hourly.
//
// The trees are real directories under the harness temp dir, so the walk is real too.

let handle: WorkerTestDb
let rootPath: string

const OTHER_ROOT_ID = 'root-2'

function root(id: string, path: string): Root {
    return { id, path, label: null, createdAt: T0 }
}

function ids(): string[] {
    return listProjects(handle.db).map(function id(p) { return p.id }).sort()
}

beforeEach(async function setup() {
    handle = await openWorkerTestDb('worker-discovery')
    rootPath = await makeTree(handle.dir, 'code', {
        'web/package.json': PKG_JSON,
        'api/package.json': PKG_JSON
    })
    upsertRoot(handle.db, root('root-1', rootPath))
    vi.spyOn(console, 'log').mockImplementation(function silence() {})
})

afterEach(async function teardown() {
    vi.restoreAllMocks()
    await closeWorkerTestDb(handle)
})

describe('discoverProjects — first pass', function () {
    it('inserts every project found under a mounted root and reports them as new', function () {
        const result = discoverProjects({ db: handle.db, roots: [root('root-1', rootPath)], globalIgnore: [], at: T0 })
        expect(result.discoveredProjects.map(function rel(p) { return p.relPath }).sort()).toEqual(['api', 'web'])
        expect(result.newProjectIds.sort()).toEqual([
            makeProjectId('root-1', 'api'),
            makeProjectId('root-1', 'web')
        ].sort())
        expect(result.deletedProjectIds).toEqual([])
        expect(ids()).toHaveLength(2)
    })

    it('stamps discovery time on both createdAt and updatedAt', function () {
        discoverProjects({ db: handle.db, roots: [root('root-1', rootPath)], globalIgnore: [], at: T0 })
        const rows = listProjects(handle.db)
        expect(rows.every(function stamped(p) { return p.createdAt === T0 && p.updatedAt === T0 })).toBe(true)
    })

    it('honours the global ignore list', function () {
        const result = discoverProjects({
            db: handle.db,
            roots: [root('root-1', rootPath)],
            globalIgnore: ['api'],
            at: T0
        })
        expect(result.discoveredProjects.map(function rel(p) { return p.relPath })).toEqual(['web'])
    })

    // A root whose volume is not mounted is not evidence that anything was removed.
    it('skips a root whose path does not exist rather than treating it as empty', function () {
        const result = discoverProjects({
            db: handle.db,
            roots: [root('missing', join(handle.dir, 'not-there'))],
            globalIgnore: [],
            at: T0
        })
        expect(result).toEqual({ discoveredProjects: [], newProjectIds: [], deletedProjectIds: [] })
    })

    it('walks several roots in one pass', async function () {
        const second = await makeTree(handle.dir, 'other', { 'tool/package.json': PKG_JSON })
        upsertRoot(handle.db, root(OTHER_ROOT_ID, second))
        const result = discoverProjects({
            db: handle.db,
            roots: [root('root-1', rootPath), root(OTHER_ROOT_ID, second)],
            globalIgnore: [],
            at: T0
        })
        expect(result.newProjectIds).toHaveLength(3)
    })
})

describe('discoverProjects — re-discovery', function () {
    beforeEach(function seedFirstPass() {
        discoverProjects({ db: handle.db, roots: [root('root-1', rootPath)], globalIgnore: [], at: T0 })
    })

    it('reports nothing new on an unchanged second pass', function () {
        const result = discoverProjects({
            db: handle.db,
            roots: [root('root-1', rootPath)],
            globalIgnore: [],
            at: T0 + 1000
        })
        expect(result.newProjectIds).toEqual([])
        expect(result.deletedProjectIds).toEqual([])
        expect(ids()).toHaveLength(2)
    })

    // Discovery runs on every sweep. If it overwrote these, an operator's alias would survive at most
    // one scheduling interval.
    //
    // Note the division of labour: upsertProject's conflict-update deliberately omits alias, muted and
    // createdAt, so those are safe from ANY discovery upsert. It DOES write tagsJson — which is what
    // makes discoverProjects' explicit `tags: prior.tags` merge the load-bearing one. Seeding the alias
    // through setProjectAlias rather than a bare upsert is not incidental: a bare upsert cannot set it.
    it('preserves alias, tags and createdAt across a re-discovery', function () {
        const id = makeProjectId('root-1', 'web')
        setProjectAlias(handle.db, id, 'Portal', T0 + 100)
        setProjectTags(handle.db, id, ['prod'], T0 + 100)

        discoverProjects({ db: handle.db, roots: [root('root-1', rootPath)], globalIgnore: [], at: T0 + 5000 })

        const after = listProjects(handle.db).find(function match(p) { return p.id === id })
        expect(after).toMatchObject({ alias: 'Portal', tags: ['prod'], createdAt: T0 })
    })

    it('refreshes updatedAt on a re-discovered project', function () {
        discoverProjects({ db: handle.db, roots: [root('root-1', rootPath)], globalIgnore: [], at: T0 + 5000 })
        const rows = listProjects(handle.db)
        expect(rows.every(function stamped(p) { return p.updatedAt === T0 + 5000 })).toBe(true)
    })

    it('deletes a project whose directory is gone and reports it', async function () {
        await rm(join(rootPath, 'api'), { recursive: true, force: true })
        const result = discoverProjects({
            db: handle.db,
            roots: [root('root-1', rootPath)],
            globalIgnore: [],
            at: T0 + 1000
        })
        expect(result.deletedProjectIds).toEqual([makeProjectId('root-1', 'api')])
        expect(ids()).toEqual([makeProjectId('root-1', 'web')])
    })

    // The reason discoverProjects filters `existing` by the roots it actually walked. Without that
    // filter a per-root sweep would delete every project under every other root.
    it('leaves projects under a root it did not walk alone', async function () {
        const second = await makeTree(handle.dir, 'other', { 'tool/package.json': PKG_JSON })
        upsertRoot(handle.db, root(OTHER_ROOT_ID, second))
        discoverProjects({ db: handle.db, roots: [root(OTHER_ROOT_ID, second)], globalIgnore: [], at: T0 })

        const result = discoverProjects({
            db: handle.db,
            roots: [root('root-1', rootPath)],
            globalIgnore: [],
            at: T0 + 1000
        })

        expect(result.deletedProjectIds).toEqual([])
        expect(ids()).toContain(makeProjectId(OTHER_ROOT_ID, 'tool'))
    })

    // The regression this file exists for. `walkedRootIds` used to be built from `input.roots` rather
    // than from the roots that passed the existsSync check, so a root that was PASSED IN but not mounted
    // got reconciled against an empty walk — and every project under it was hard-deleted. Three call
    // sites reach here with roots straight out of listRoots(db): scheduler.ts (the cron sweep),
    // scan-request-poller.ts runFullSweep, and runRootSweep, which is the "Scan this root" button and
    // the likeliest trigger of the three. A volume that failed to mount destroyed that root's history.
    //
    // Distinct from 'skips a root whose path does not exist' above: that root has no rows, so it passes
    // either way. This one has two projects on record, which is what makes it load-bearing.
    it('leaves projects untouched when their root is passed but unmounted', async function () {
        await rm(rootPath, { recursive: true, force: true })
        const result = discoverProjects({
            db: handle.db,
            roots: [root('root-1', rootPath)],
            globalIgnore: [],
            at: T0 + 1000
        })
        expect(result.deletedProjectIds).toEqual([])
        expect(ids()).toEqual([makeProjectId('root-1', 'api'), makeProjectId('root-1', 'web')].sort())
    })

    // Surviving as a projects row is not the property that matters — deleteProject cascades through
    // notification deliveries/events, findings, scans, scan_requests and mutes, so the damage was the
    // history rather than the row. Asserting the cascade stayed shut is what pins that.
    it('leaves the scans, findings and mutes of an unmounted root intact', async function () {
        const id = makeProjectId('root-1', 'web')
        insertScan(handle.db, {
            id: 'scan-1',
            projectId: id,
            startedAt: T0,
            finishedAt: T0 + 500,
            scanner: 'npm-audit',
            source: 'npm-audit',
            ecosystem: 'npm',
            status: 'ok',
            reasonCode: 'ok',
            durationMs: 500,
            errorText: null,
            rawJson: ''
        } as Parameters<typeof insertScan>[1])
        mergeFindingsForScan(handle.db, {
            projectId: id,
            scanner: 'npm-audit',
            scanId: 'scan-1',
            scanFinishedAt: T0 + 500,
            incoming: [{
                projectId: id,
                scanner: 'npm-audit',
                source: 'npm-audit',
                ecosystem: 'npm',
                advisoryId: 'CVE-2024-1',
                advisoryTitle: 'Prototype pollution',
                advisoryUrl: 'https://example.test/CVE-2024-1',
                packageName: 'lodash',
                installedVersion: '4.17.11',
                vulnerableRange: '<4.17.21',
                severity: 'high',
                fixAvailable: true,
                fixVersion: '4.17.21',
                depPath: ['lodash'],
                isProd: true,
                isDev: false
            }]
        })
        insertMute(handle.db, {
            id: 'mute-1',
            scope: 'finding',
            projectId: id,
            scanner: 'npm-audit',
            ecosystem: 'npm',
            advisoryId: 'CVE-2024-1',
            packageName: 'lodash',
            reason: 'accepted',
            author: 'tester',
            createdAt: T0,
            expiresAt: null
        })

        await rm(rootPath, { recursive: true, force: true })
        discoverProjects({
            db: handle.db,
            roots: [root('root-1', rootPath)],
            globalIgnore: [],
            at: T0 + 1000
        })

        expect(countScansForProject(handle.db, id)).toBe(1)
        expect(listFindingsForProject(handle.db, id)).toHaveLength(1)
        expect(listActiveMutes(handle.db, T0 + 1000).map(function muteId(m) { return m.id })).toEqual(['mute-1'])
    })

    // An ignore rule added later removes the project exactly as a deleted directory would — that is the
    // documented behaviour (Sentinello keeps only what it currently sees), and it is destructive, so it
    // deserves to be visible rather than incidental.
    it('deletes a project that a newly-added ignore rule now excludes', function () {
        const result = discoverProjects({
            db: handle.db,
            roots: [root('root-1', rootPath)],
            globalIgnore: ['api'],
            at: T0 + 1000
        })
        expect(result.deletedProjectIds).toEqual([makeProjectId('root-1', 'api')])
    })

    it('replaces a project when its root is re-registered under a different id', async function () {
        const moved = await makeTree(handle.dir, 'moved', { 'web/package.json': PKG_JSON })
        upsertRoot(handle.db, root(OTHER_ROOT_ID, moved))
        const result = discoverProjects({
            db: handle.db,
            roots: [root(OTHER_ROOT_ID, moved)],
            globalIgnore: [],
            at: T0 + 1000
        })
        expect(result.newProjectIds).toEqual([makeProjectId(OTHER_ROOT_ID, 'web')])
        expect(result.deletedProjectIds).toEqual([])
    })
})

describe('discoverProjects — skip logging', function () {
    // "My project vanished from the dashboard" is otherwise indistinguishable from "it was never there".
    it('logs each ignored directory with the rule source that excluded it', async function () {
        const tree = await makeTree(handle.dir, 'ignored', {
            'keep/package.json': PKG_JSON,
            'drop/package.json': PKG_JSON,
            '.gitignore': 'drop\n'
        })
        upsertRoot(handle.db, root('root-3', tree))
        discoverProjects({ db: handle.db, roots: [root('root-3', tree)], globalIgnore: [], at: T0 })
        const logged = vi.mocked(console.log).mock.calls.map(function first(c) { return String(c[0]) })
        expect(logged.some(function match(line) {
            return line.startsWith('[discovery] skipped ') && line.includes('drop') && line.includes('(gitignore)')
        })).toBe(true)
    })
})

describe('project identity', function () {
    // The project id is derived from (rootId, relPath), which is what makes discovery idempotent: the
    // same directory under the same root always reconciles onto the same row rather than duplicating.
    it('derives a stable id from root and relative path', function () {
        discoverProjects({ db: handle.db, roots: [root('root-1', rootPath)], globalIgnore: [], at: T0 })
        const first = ids()
        discoverProjects({ db: handle.db, roots: [root('root-1', rootPath)], globalIgnore: [], at: T0 + 1 })
        expect(ids()).toEqual(first)
    })

    it('gives the same relative path under two different roots two different ids', function () {
        expect(makeProjectId('root-1', 'web')).not.toEqual(makeProjectId(OTHER_ROOT_ID, 'web'))
    })

    it('carries the discovered package manager and ecosystems onto the row', function () {
        discoverProjects({ db: handle.db, roots: [root('root-1', rootPath)], globalIgnore: [], at: T0 })
        const row = listProjects(handle.db)[0]
        expect(row).toMatchObject({ ecosystems: ['npm'] })
        expect(project().packageManager).toBe('npm')
    })
})
