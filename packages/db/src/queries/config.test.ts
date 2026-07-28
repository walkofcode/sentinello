import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../client'
import type { DrizzleDb, SqliteDb } from '../client'
import { runMigrations } from '../migrate'
import {
    deleteRoot,
    getConfigValue,
    getRootById,
    getRootByPath,
    listConfig,
    listRoots,
    setConfigValue,
    updateRootLabel,
    upsertRoot
} from './config'
import { getProjectById, upsertProject } from './projects'
import { insertScan } from './scans'
import { enqueueScanRequest, listRecentScanRequests } from './scan-requests'
import { insertNotificationTarget } from './notifications'
import { listTargetRootIds, setTargetRoots } from './notification-target-roots'

// app_config is a JSON key/value store, so the round-trip has to survive types that are easy to lose
// through JSON — false and 0 in particular, which a truthiness check would silently turn into "unset".
//
// deleteRoot is the risky one. Three tables reference roots.id with no ON DELETE action and
// foreign_keys is ON, so a bare DELETE fails outright once children exist. It cascades explicitly,
// child-first, reusing cascadeDeleteProjects so it stays in lockstep with deleteProject.

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle')

const ROOT_ID = 'root-1'
const OTHER_ROOT_ID = 'root-2'
const T0 = Date.UTC(2026, 0, 1)

let db: DrizzleDb
let sqlite: SqliteDb
let dir: string

beforeEach(async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-config-'))
    const opened = openDb({ dbPath: join(dir, 'test.sqlite') })
    db = opened.db
    sqlite = opened.sqlite
    runMigrations(db, { migrationsFolder: MIGRATIONS })
})

afterEach(async function teardown() {
    sqlite.close()
    await rm(dir, { recursive: true, force: true })
})

describe('app config', function () {
    it('returns null for a key that was never set', function () {
        expect(getConfigValue(db, 'parallelism')).toBeNull()
    })

    it('round-trips a string and a number', function () {
        setConfigValue(db, 'portalBaseUrl', 'https://portal.example.test')
        setConfigValue(db, 'parallelism', 8)
        expect(getConfigValue(db, 'portalBaseUrl')).toBe('https://portal.example.test')
        expect(getConfigValue(db, 'parallelism')).toBe(8)
    })

    // These are the values a truthiness check would lose: stored false must read back as false, not
    // as "no value configured", or an operator's explicit opt-out silently reverts to the default.
    it('distinguishes a stored false from an unset key', function () {
        setConfigValue(db, 'watcherEnabled', false)
        expect(getConfigValue(db, 'watcherEnabled')).toBe(false)
        expect(getConfigValue(db, 'watcherEnabled')).not.toBeNull()
    })

    it('distinguishes a stored zero from an unset key', function () {
        setConfigValue(db, 'someCount', 0)
        expect(getConfigValue(db, 'someCount')).toBe(0)
    })

    it('round-trips objects and arrays', function () {
        setConfigValue(db, 'schedule', { intervalHours: 6, startHour: 2 })
        setConfigValue(db, 'globalIgnore', ['node_modules', 'dist'])
        expect(getConfigValue(db, 'schedule')).toEqual({ intervalHours: 6, startHour: 2 })
        expect(getConfigValue(db, 'globalIgnore')).toEqual(['node_modules', 'dist'])
    })

    it('round-trips an explicit null', function () {
        setConfigValue(db, 'lastError', null)
        expect(getConfigValue(db, 'lastError')).toBeNull()
    })

    it('overwrites an existing key', function () {
        setConfigValue(db, 'parallelism', 4)
        setConfigValue(db, 'parallelism', 16)
        expect(getConfigValue(db, 'parallelism')).toBe(16)
    })

    it('lists every stored key', function () {
        setConfigValue(db, 'parallelism', 8)
        setConfigValue(db, 'watcherEnabled', false)
        expect(listConfig(db)).toEqual({ parallelism: 8, watcherEnabled: false })
    })

    it('lists nothing on a fresh database', function () {
        expect(listConfig(db)).toEqual({})
    })
})

describe('roots', function () {
    it('stores and reads a root', function () {
        upsertRoot(db, { id: ROOT_ID, path: '/repo', label: 'Repos', createdAt: T0 })
        expect(getRootById(db, ROOT_ID)).toMatchObject({ path: '/repo', label: 'Repos' })
    })

    it('returns null for an unknown id or path', function () {
        expect(getRootById(db, 'nope')).toBeNull()
        expect(getRootByPath(db, '/nowhere')).toBeNull()
    })

    it('finds a root by its path', function () {
        upsertRoot(db, { id: ROOT_ID, path: '/repo', label: null, createdAt: T0 })
        expect(getRootByPath(db, '/repo')?.id).toBe(ROOT_ID)
    })

    it('updates path and label on conflict', function () {
        upsertRoot(db, { id: ROOT_ID, path: '/repo', label: null, createdAt: T0 })
        upsertRoot(db, { id: ROOT_ID, path: '/repo2', label: 'Renamed', createdAt: T0 + 1000 })
        expect(getRootById(db, ROOT_ID)).toMatchObject({ path: '/repo2', label: 'Renamed' })
    })

    it('keeps the original createdAt on conflict', function () {
        upsertRoot(db, { id: ROOT_ID, path: '/repo', label: null, createdAt: T0 })
        upsertRoot(db, { id: ROOT_ID, path: '/repo', label: 'x', createdAt: T0 + 5000 })
        expect(getRootById(db, ROOT_ID)?.createdAt).toBe(T0)
    })

    // Sorted by label when present, path otherwise. Note the consequence: an unlabelled root sorts on
    // its path, which starts with '/', and '/' sorts before every letter — so labelling a root moves
    // it below every unlabelled one rather than into alphabetical position among them.
    it('lists unlabelled roots by path, ahead of labelled ones', function () {
        upsertRoot(db, { id: 'a', path: '/zebra', label: null, createdAt: T0 })
        upsertRoot(db, { id: 'b', path: '/alpha', label: null, createdAt: T0 })
        upsertRoot(db, { id: 'c', path: '/middle', label: 'Beta', createdAt: T0 })
        expect(listRoots(db).map(function p(r) { return r.id })).toEqual(['b', 'a', 'c'])
    })

    it('sorts labels case-insensitively', function () {
        upsertRoot(db, { id: 'a', path: '/one', label: 'zebra', createdAt: T0 })
        upsertRoot(db, { id: 'b', path: '/two', label: 'Alpha', createdAt: T0 })
        expect(listRoots(db).map(function p(r) { return r.id })).toEqual(['b', 'a'])
    })

    it('lists nothing on a fresh database', function () {
        expect(listRoots(db)).toEqual([])
    })

    // Path is deliberately not writable through the rename UI: the root id is sha256(path), so
    // changing it would orphan every project, scan and finding underneath.
    it('renames a root without touching its path', function () {
        upsertRoot(db, { id: ROOT_ID, path: '/repo', label: null, createdAt: T0 })
        updateRootLabel(db, ROOT_ID, 'Production')
        expect(getRootById(db, ROOT_ID)).toMatchObject({ label: 'Production', path: '/repo' })
    })

    it('clears a label back to the path', function () {
        upsertRoot(db, { id: ROOT_ID, path: '/repo', label: 'Production', createdAt: T0 })
        updateRootLabel(db, ROOT_ID, null)
        expect(getRootById(db, ROOT_ID)?.label).toBeNull()
    })
})

describe('deleteRoot', function () {
    function seedRootWithChildren(rootId: string, projectId: string): void {
        upsertRoot(db, { id: rootId, path: '/' + rootId, label: null, createdAt: T0 })
        upsertProject(db, {
            id: projectId,
            rootId,
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
            updatedAt: T0
        })
        insertScan(db, {
            id: 'scan-' + projectId,
            projectId,
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
    }

    it('removes an empty root', function () {
        upsertRoot(db, { id: ROOT_ID, path: '/repo', label: null, createdAt: T0 })
        deleteRoot(db, ROOT_ID)
        expect(listRoots(db)).toEqual([])
    })

    // Without the explicit cascade this throws FOREIGN KEY constraint failed rather than deleting.
    it('removes a root that still has projects under it', function () {
        seedRootWithChildren(ROOT_ID, 'project-1')
        deleteRoot(db, ROOT_ID)
        expect(listRoots(db)).toEqual([])
        expect(getProjectById(db, 'project-1')).toBeNull()
    })

    // Root-level scan requests carry rootId with a null projectId, so the per-project cascade never
    // sees them.
    it('removes root-level scan requests', function () {
        seedRootWithChildren(ROOT_ID, 'project-1')
        enqueueScanRequest(db, { rootId: ROOT_ID }, T0)
        expect(listRecentScanRequests(db)).toHaveLength(1)
        deleteRoot(db, ROOT_ID)
        expect(listRecentScanRequests(db)).toEqual([])
    })

    // A notification target scoped to a deleted root would otherwise keep a dangling reference and
    // silently match zero projects.
    it('removes notification target scope rows pointing at the root', function () {
        seedRootWithChildren(ROOT_ID, 'project-1')
        insertNotificationTarget(db, {
            id: 'target-1',
            kind: 'webhook',
            config: { url: 'https://hooks.example.test/incoming' },
            severityFilter: ['high'],
            envFilter: 'all',
            enabled: true,
            createdAt: T0,
            rootIds: [],
            projectIds: [],
            sourceScope: { mode: 'all', cells: [] }
        })
        setTargetRoots(db, 'target-1', [ROOT_ID])
        deleteRoot(db, ROOT_ID)
        expect(listTargetRootIds(db, 'target-1')).toEqual([])
    })

    it('leaves another root and its projects intact', function () {
        seedRootWithChildren(ROOT_ID, 'project-1')
        seedRootWithChildren(OTHER_ROOT_ID, 'project-2')
        deleteRoot(db, ROOT_ID)
        expect(listRoots(db).map(function id(r) { return r.id })).toEqual([OTHER_ROOT_ID])
        expect(getProjectById(db, 'project-2')).not.toBeNull()
    })

    it('is a no-op for an unknown id', function () {
        upsertRoot(db, { id: ROOT_ID, path: '/repo', label: null, createdAt: T0 })
        deleteRoot(db, 'nope')
        expect(listRoots(db)).toHaveLength(1)
    })
})
