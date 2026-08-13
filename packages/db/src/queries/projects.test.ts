import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Project } from '@sentinello/core'
import { openDb } from '../client'
import type { DrizzleDb, SqliteDb } from '../client'
import { runMigrations } from '../migrate'
import { projects } from '../schema'
import { upsertRoot } from './config'
import { insertScan } from './scans'
import { mergeFindingsForScan, listFindingsForScan } from './findings'
import { insertMute, listActiveMutes } from './mutes'
import { insertNotificationTarget } from './notifications'
import { upsertFindingEvent, listEventsForProject } from './notification-events'
import { getDelivery, recordAttempt } from './notification-deliveries'
import { setTargetProjects, listTargetProjectIds } from './notification-target-projects'
import {
    cascadeDeleteProjects,
    deleteProject,
    getProjectById,
    listProjects,
    listProjectsByRoot,
    setProjectAlias,
    setProjectGitBranch,
    setProjectTags,
    upsertProject
} from './projects'

// Two things here carry real consequences.
//
// upsertProject runs on every discovery sweep, so which columns it refreshes and which it leaves
// alone is the difference between "rediscovery keeps the project current" and "rediscovery wipes what
// the operator configured". alias and muted are operator state and must survive.
//
// cascadeDeleteProjects is the other. Sentinello keeps only projects it currently sees on disk, so a
// project disappearing means a hard delete. SQLite's foreign keys here are advertised but not
// CASCADE-enforced, so every child table is deleted explicitly and in dependency order — a missed
// table leaves orphan rows that outlive their project.

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle')

const ROOT_ID = 'root-1'
const OTHER_ROOT_ID = 'root-2'
const PROJECT_ID = 'project-1'
const OTHER_PROJECT_ID = 'project-2'
const T0 = Date.UTC(2026, 0, 1)
const HOUR = 3600_000

let db: DrizzleDb
let sqlite: SqliteDb
let dir: string

function project(overrides: Partial<Project> = {}): Project {
    return {
        id: PROJECT_ID,
        rootId: ROOT_ID,
        relPath: 'app',
        name: 'app',
        alias: null,
        packageManager: 'npm',
        nvmrcVersion: null,
        gitBranch: null,
        ecosystems: ['npm'],
        muted: false,
        tags: [],
        createdAt: T0,
        updatedAt: T0,
        ...overrides
    }
}

beforeEach(async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-projects-'))
    const opened = openDb({ dbPath: join(dir, 'test.sqlite') })
    db = opened.db
    sqlite = opened.sqlite
    runMigrations(db, { migrationsFolder: MIGRATIONS })
    upsertRoot(db, { id: ROOT_ID, path: '/repo', label: null, createdAt: T0 })
    upsertRoot(db, { id: OTHER_ROOT_ID, path: '/other', label: null, createdAt: T0 })
})

afterEach(async function teardown() {
    sqlite.close()
    await rm(dir, { recursive: true, force: true })
})

describe('upsertProject and reads', function () {
    it('stores a project that can be read back', function () {
        upsertProject(db, project({ tags: ['backend'], ecosystems: ['npm', 'PyPI'] }))
        const found = getProjectById(db, PROJECT_ID)
        expect(found).toMatchObject({
            id: PROJECT_ID,
            rootId: ROOT_ID,
            relPath: 'app',
            tags: ['backend'],
            ecosystems: ['npm', 'PyPI']
        })
    })

    it('returns null for an unknown id', function () {
        expect(getProjectById(db, 'nope')).toBeNull()
    })

    // `muted` comes from the mutes table, not the legacy projects.muted column. Nothing writes that
    // column any more — muteAction and the MCP mute_finding tool both insert into `mutes` — so reading
    // it reported a wholesale-muted project as muted:false, which is what MCP get_project handed agents.
    it('reports muted from the mutes table, not the legacy column', function () {
        upsertProject(db, project({ muted: false }))
        expect(getProjectById(db, PROJECT_ID, T0)?.muted).toBe(false)
        insertMute(db, {
            id: 'mute-1',
            scope: 'project',
            projectId: PROJECT_ID,
            scanner: null,
            ecosystem: null,
            advisoryId: null,
            packageName: null,
            reason: 'retired service',
            author: 'betty',
            createdAt: T0,
            expiresAt: null
        })
        expect(getProjectById(db, PROJECT_ID, T0)?.muted).toBe(true)
    })

    it('reports muted:false once the project mute has expired', function () {
        upsertProject(db, project())
        insertMute(db, {
            id: 'mute-1',
            scope: 'project',
            projectId: PROJECT_ID,
            scanner: null,
            ecosystem: null,
            advisoryId: null,
            packageName: null,
            reason: 'temporary',
            author: 'betty',
            createdAt: T0,
            expiresAt: T0 + HOUR
        })
        expect(getProjectById(db, PROJECT_ID, T0)?.muted).toBe(true)
        expect(getProjectById(db, PROJECT_ID, T0 + HOUR + 1)?.muted).toBe(false)
    })

    // The `at` default exists so the many callers that do not care about mute state need not thread a
    // clock through. An unmuted project reads the same either way.
    it('defaults `at` to now when the caller omits it', function () {
        upsertProject(db, project())
        expect(getProjectById(db, PROJECT_ID)?.muted).toBe(false)
    })

    it('lists every project', function () {
        upsertProject(db, project())
        upsertProject(db, project({ id: OTHER_PROJECT_ID, rootId: OTHER_ROOT_ID, relPath: 'other' }))
        expect(listProjects(db)).toHaveLength(2)
    })

    it('lists only the projects under one root', function () {
        upsertProject(db, project())
        upsertProject(db, project({ id: OTHER_PROJECT_ID, rootId: OTHER_ROOT_ID, relPath: 'other' }))
        const found = listProjectsByRoot(db, ROOT_ID)
        expect(found).toHaveLength(1)
        expect(found[0]?.id).toBe(PROJECT_ID)
    })

    it('refreshes discovered fields on rediscovery', function () {
        upsertProject(db, project())
        upsertProject(db, project({
            name: 'renamed',
            relPath: 'moved',
            packageManager: 'pnpm',
            nvmrcVersion: '24.14.0',
            gitBranch: 'feature',
            ecosystems: ['npm', 'Go'],
            tags: ['api'],
            updatedAt: T0 + HOUR
        }))
        expect(getProjectById(db, PROJECT_ID)).toMatchObject({
            name: 'renamed',
            relPath: 'moved',
            packageManager: 'pnpm',
            nvmrcVersion: '24.14.0',
            gitBranch: 'feature',
            ecosystems: ['npm', 'Go'],
            tags: ['api'],
            updatedAt: T0 + HOUR
        })
    })

    // Operator state. A rediscovery must not rename a project the operator titled, nor unmute one
    // they deliberately silenced.
    it('preserves the operator alias and mute across rediscovery', function () {
        upsertProject(db, project())
        setProjectAlias(db, PROJECT_ID, 'Billing API', T0)
        upsertProject(db, project({ alias: null, muted: false, name: 'app-renamed' }))
        const found = getProjectById(db, PROJECT_ID)
        expect(found?.alias).toBe('Billing API')
        expect(found?.name).toBe('app-renamed')
    })

    it('keeps createdAt from the original discovery', function () {
        upsertProject(db, project({ createdAt: T0 }))
        upsertProject(db, project({ createdAt: T0 + 100 * HOUR, updatedAt: T0 + 100 * HOUR }))
        expect(getProjectById(db, PROJECT_ID)?.createdAt).toBe(T0)
    })

    // A removed or renamed ecosystem id must not reach the rest of the app as a phantom value.
    it('drops persisted ecosystems the registry no longer knows', function () {
        upsertProject(db, project({ ecosystems: ['npm', 'Fortran' as never] }))
        expect(getProjectById(db, PROJECT_ID)?.ecosystems).toEqual(['npm'])
    })
})

describe('operator setters', function () {
    beforeEach(function seed() {
        upsertProject(db, project())
    })

    it('sets and clears an alias', function () {
        setProjectAlias(db, PROJECT_ID, 'Billing API', T0 + HOUR)
        expect(getProjectById(db, PROJECT_ID)?.alias).toBe('Billing API')
        setProjectAlias(db, PROJECT_ID, null, T0 + 2 * HOUR)
        expect(getProjectById(db, PROJECT_ID)?.alias).toBeNull()
    })

    it('replaces tags wholesale rather than merging', function () {
        setProjectTags(db, PROJECT_ID, ['a', 'b'], T0 + HOUR)
        setProjectTags(db, PROJECT_ID, ['c'], T0 + 2 * HOUR)
        expect(getProjectById(db, PROJECT_ID)?.tags).toEqual(['c'])
    })

    it('clears tags with an empty list', function () {
        setProjectTags(db, PROJECT_ID, ['a'], T0 + HOUR)
        setProjectTags(db, PROJECT_ID, [], T0 + 2 * HOUR)
        expect(getProjectById(db, PROJECT_ID)?.tags).toEqual([])
    })

    // Written at scan start so the recorded branch matches the code the findings came from, not
    // whatever was checked out during the last discovery sweep.
    it('records the branch a scan ran against', function () {
        setProjectGitBranch(db, PROJECT_ID, 'release/2.5', T0 + HOUR)
        expect(getProjectById(db, PROJECT_ID)?.gitBranch).toBe('release/2.5')
    })

    it('records a detached head as no branch', function () {
        setProjectGitBranch(db, PROJECT_ID, 'main', T0)
        setProjectGitBranch(db, PROJECT_ID, null, T0 + HOUR)
        expect(getProjectById(db, PROJECT_ID)?.gitBranch).toBeNull()
    })

    it('stamps updatedAt on every setter', function () {
        setProjectTags(db, PROJECT_ID, ['a'], T0 + HOUR)
        expect(getProjectById(db, PROJECT_ID)?.updatedAt).toBe(T0 + HOUR)
        setProjectAlias(db, PROJECT_ID, 'x', T0 + 2 * HOUR)
        expect(getProjectById(db, PROJECT_ID)?.updatedAt).toBe(T0 + 2 * HOUR)
    })
})

describe('cascadeDeleteProjects', function () {
    // Builds a project with a row in every table that hangs off it, so a missed delete shows up as a
    // surviving orphan rather than as a silent pass.
    function seedFullProject(id: string): { eventId: string; scanId: string } {
        upsertProject(db, project({ id, relPath: id }))
        const scanId = 'scan-' + id
        insertScan(db, {
            id: scanId,
            projectId: id,
            startedAt: T0 - 1000,
            finishedAt: T0,
            scanner: 'osv',
            source: 'osv',
            ecosystem: 'npm',
            status: 'ok',
            reasonCode: 'ok',
            durationMs: 1000,
            errorText: null,
            rawJson: ''
        })
        mergeFindingsForScan(db, {
            projectId: id,
            scanner: 'osv',
            scanId,
            scanFinishedAt: T0,
            incoming: [{
                projectId: id,
                scanner: 'osv',
                source: 'osv',
                ecosystem: 'npm',
                advisoryId: 'CVE-2024-1',
                advisoryTitle: 'x',
                advisoryUrl: null,
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
        const eventId = upsertFindingEvent(db, {
            projectId: id,
            source: 'osv',
            ecosystem: 'npm',
            advisoryId: 'CVE-2024-1',
            packageName: 'lodash',
            severity: 'high',
            firstScanId: scanId,
            at: T0
        }).eventId
        insertMute(db, {
            id: 'mute-' + id,
            scope: 'finding',
            projectId: id,
            scanner: 'osv',
            ecosystem: 'npm',
            advisoryId: 'CVE-2024-1',
            packageName: 'lodash',
            reason: 'accepted',
            author: 'betty',
            createdAt: T0,
            expiresAt: null
        })
        return { eventId, scanId }
    }

    it('does nothing for an empty id list', function () {
        upsertProject(db, project())
        cascadeDeleteProjects(db, [])
        expect(listProjects(db)).toHaveLength(1)
    })

    it('removes the project and every row hanging off it', function () {
        const { eventId, scanId } = seedFullProject(PROJECT_ID)
        insertNotificationTarget(db, {
            id: 'target-1',
            kind: 'webhook',
            config: { url: 'https://hooks.example.test/incoming' },
            severityFilter: ['high'],
            envFilter: 'all',
            enabled: true,
            createdAt: T0 - HOUR,
            rootIds: [],
            projectIds: [],
            sourceScope: { mode: 'all', cells: [] }
        })
        setTargetProjects(db, 'target-1', [PROJECT_ID])
        recordAttempt(db, eventId, 'target-1', T0)

        deleteProject(db, PROJECT_ID)

        expect(getProjectById(db, PROJECT_ID)).toBeNull()
        expect(listFindingsForScan(db, scanId)).toEqual([])
        expect(listEventsForProject(db, PROJECT_ID)).toEqual([])
        expect(getDelivery(db, eventId, 'target-1')).toBeNull()
        expect(listTargetProjectIds(db, 'target-1')).toEqual([])
        expect(listActiveMutes(db, T0)).toEqual([])
    })

    it('leaves other projects untouched', function () {
        seedFullProject(PROJECT_ID)
        seedFullProject(OTHER_PROJECT_ID)
        deleteProject(db, PROJECT_ID)
        expect(getProjectById(db, OTHER_PROJECT_ID)).not.toBeNull()
        expect(listEventsForProject(db, OTHER_PROJECT_ID)).toHaveLength(1)
    })

    // A global finding mute (project_id IS NULL) is not this project's to delete — it applies across
    // every project and must outlive any one of them.
    it('keeps a global finding mute', function () {
        seedFullProject(PROJECT_ID)
        insertMute(db, {
            id: 'global-mute',
            scope: 'finding',
            projectId: null,
            scanner: 'osv',
            ecosystem: 'npm',
            advisoryId: 'CVE-9999',
            packageName: 'express',
            reason: 'accepted everywhere',
            author: 'betty',
            createdAt: T0,
            expiresAt: null
        })
        deleteProject(db, PROJECT_ID)
        const remaining = listActiveMutes(db, T0)
        expect(remaining).toHaveLength(1)
        expect(remaining[0]?.id).toBe('global-mute')
    })

    it('deletes several projects in one pass', function () {
        seedFullProject(PROJECT_ID)
        seedFullProject(OTHER_PROJECT_ID)
        db.transaction(function txn(tx) {
            cascadeDeleteProjects(tx, [PROJECT_ID, OTHER_PROJECT_ID])
        })
        expect(listProjects(db)).toEqual([])
    })

    it('tolerates a project with no child rows', function () {
        upsertProject(db, project())
        deleteProject(db, PROJECT_ID)
        expect(listProjects(db)).toEqual([])
    })
})

// tags_json and ecosystems_json are only ever written by upsertProject, which serialises a typed
// array. These parsers therefore guard the hand-edited or shape-drifted row, and writing the column
// directly is the only way to reach them. Both must degrade to an empty list rather than throwing:
// a project row that cannot be read is a project that vanishes from the portal entirely.
describe('defensive column parsing', function () {
    function corrupt(patch: { tagsJson?: string; ecosystemsJson?: string }): Project | null {
        upsertProject(db, project({ tags: ['prod', 'team-a'], ecosystems: ['npm', 'PyPI'] }))
        db.update(projects).set(patch).where(eq(projects.id, PROJECT_ID)).run()
        return getProjectById(db, PROJECT_ID)
    }

    // The seed row is non-empty in both columns, so every empty expectation below is a rejection.
    it('seeds both columns non-empty', function () {
        const seeded = corrupt({ tagsJson: JSON.stringify(['prod']) })
        expect(seeded?.tags).toEqual(['prod'])
        expect(seeded?.ecosystems).toEqual(['npm', 'PyPI'])
    })

    it.each(['{}', 'null', '42', '"prod"'])('reads the non-array tags_json %s as empty', function (json) {
        expect(corrupt({ tagsJson: json })?.tags).toEqual([])
    })

    it('drops a tag that is not a string', function () {
        expect(corrupt({ tagsJson: '["prod",7,null,{},"team-a"]' })?.tags).toEqual(['prod', 'team-a'])
    })

    it.each(['{}', 'null', '42'])('reads the non-array ecosystems_json %s as empty', function (json) {
        expect(corrupt({ ecosystemsJson: json })?.ecosystems).toEqual([])
    })

    it('drops an ecosystem entry that is not a string', function () {
        expect(corrupt({ ecosystemsJson: '["npm",7,null,"Go"]' })?.ecosystems).toEqual(['npm', 'Go'])
    })

    // An id the central registry no longer knows must not reach the rest of the app as a phantom
    // EcosystemId — it would render as a filter nothing can ever match.
    it('drops an ecosystem the registry no longer knows', function () {
        expect(corrupt({ ecosystemsJson: '["npm","cocoapods"]' })?.ecosystems).toEqual(['npm'])
    })
})
