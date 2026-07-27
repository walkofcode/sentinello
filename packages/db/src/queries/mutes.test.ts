import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Mute } from '@sentinello/core'
import { openDb } from '../client'
import type { DrizzleDb, SqliteDb } from '../client'
import { runMigrations } from '../migrate'
import { upsertRoot } from './config'
import { upsertProject } from './projects'
import { deleteMute, insertMute, isMuted, listActiveMutes, listExpiredMutes, type MuteMatchInput } from './mutes'
import {
    listMuteLiftsForLibrary,
    listMuteLiftsForProject,
    listRecentMuteLifts,
    recordMuteLift
} from './mute-lifts'

// A mute suppresses a real vulnerability from the operator's view, so the risk runs in one direction:
// a mute that matches MORE than it should silences something the operator never agreed to silence.
// The cross-ecosystem and cross-source cases below exist for exactly that reason.

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle')

const ROOT_ID = 'root-1'
const PROJECT_ID = 'project-1'
const OTHER_PROJECT_ID = 'project-2'
const T0 = Date.UTC(2026, 0, 1)
const HOUR = 3600_000

let db: DrizzleDb
let sqlite: SqliteDb
let dir: string

function mute(overrides: Partial<Mute> = {}): Mute {
    return {
        id: 'mute-1',
        scope: 'finding',
        projectId: PROJECT_ID,
        scanner: 'osv',
        ecosystem: 'npm',
        advisoryId: 'GHSA-1',
        packageName: 'lodash',
        reason: 'accepted risk',
        author: 'betty',
        createdAt: T0,
        expiresAt: null,
        ...overrides
    }
}

function match(overrides: Partial<MuteMatchInput> = {}): MuteMatchInput {
    return {
        projectId: PROJECT_ID,
        source: 'osv',
        ecosystem: 'npm',
        advisoryId: 'GHSA-1',
        packageName: 'lodash',
        at: T0,
        ...overrides
    }
}

function addProject(id: string, relPath: string): void {
    upsertProject(db, {
        id,
        rootId: ROOT_ID,
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
    dir = await mkdtemp(join(tmpdir(), 'sentinello-mutes-'))
    const opened = openDb({ dbPath: join(dir, 'test.sqlite') })
    db = opened.db
    sqlite = opened.sqlite
    runMigrations(db, { migrationsFolder: MIGRATIONS })

    upsertRoot(db, { id: ROOT_ID, path: '/repo', label: null, createdAt: T0 })
    addProject(PROJECT_ID, 'app')
    addProject(OTHER_PROJECT_ID, 'other-app')
})

afterEach(async function teardown() {
    sqlite.close()
    await rm(dir, { recursive: true, force: true })
})

describe('insertMute and deleteMute', function () {
    it('stores a mute so it can be listed', function () {
        insertMute(db, mute())
        expect(listActiveMutes(db, T0)).toHaveLength(1)
    })

    it('round-trips every field', function () {
        insertMute(db, mute({ reason: 'upstream fix pending', expiresAt: T0 + HOUR }))
        expect(listActiveMutes(db, T0)[0]).toEqual(mute({ reason: 'upstream fix pending', expiresAt: T0 + HOUR }))
    })

    it('removes a mute', function () {
        insertMute(db, mute())
        deleteMute(db, 'mute-1')
        expect(listActiveMutes(db, T0)).toEqual([])
    })

    it('is a no-op when deleting an unknown id', function () {
        insertMute(db, mute())
        deleteMute(db, 'nope')
        expect(listActiveMutes(db, T0)).toHaveLength(1)
    })
})

describe('listActiveMutes and listExpiredMutes', function () {
    it('treats a null expiry as permanently active', function () {
        insertMute(db, mute({ expiresAt: null }))
        expect(listActiveMutes(db, T0 + 1000 * HOUR)).toHaveLength(1)
        expect(listExpiredMutes(db, T0 + 1000 * HOUR)).toEqual([])
    })

    it('keeps a mute active before its expiry', function () {
        insertMute(db, mute({ expiresAt: T0 + HOUR }))
        expect(listActiveMutes(db, T0 + HOUR - 1)).toHaveLength(1)
    })

    // The boundary is exclusive on the active side: at exactly expiresAt the mute has expired.
    it('expires a mute exactly at its expiry instant', function () {
        insertMute(db, mute({ expiresAt: T0 + HOUR }))
        expect(listActiveMutes(db, T0 + HOUR)).toEqual([])
        expect(listExpiredMutes(db, T0 + HOUR)).toHaveLength(1)
    })

    it('never lists a null-expiry mute as expired', function () {
        insertMute(db, mute({ expiresAt: null }))
        expect(listExpiredMutes(db, T0 + 1000 * HOUR)).toEqual([])
    })

    it('returns nothing when there are no mutes', function () {
        expect(listActiveMutes(db, T0)).toEqual([])
        expect(listExpiredMutes(db, T0)).toEqual([])
    })
})

describe('isMuted with a project-scope mute', function () {
    it('mutes every finding in the project regardless of source', function () {
        insertMute(db, mute({ scope: 'project', scanner: 'osv' }))
        expect(isMuted(db, match({ source: 'npm-audit', advisoryId: 'anything', packageName: 'other' }))).toBe(true)
    })

    it('does not reach a different project', function () {
        insertMute(db, mute({ scope: 'project' }))
        expect(isMuted(db, match({ projectId: OTHER_PROJECT_ID }))).toBe(false)
    })

    it('stops applying once expired', function () {
        insertMute(db, mute({ scope: 'project', expiresAt: T0 + HOUR }))
        expect(isMuted(db, match({ at: T0 + HOUR + 1 }))).toBe(false)
    })
})

describe('isMuted with a finding-scope mute', function () {
    it('matches the full identity tuple', function () {
        insertMute(db, mute())
        expect(isMuted(db, match())).toBe(true)
    })

    it('is false when nothing is muted', function () {
        expect(isMuted(db, match())).toBe(false)
    })

    it.each([
        ['projectId', { projectId: OTHER_PROJECT_ID }],
        ['source', { source: 'npm-audit' }],
        ['ecosystem', { ecosystem: 'PyPI' }],
        ['advisoryId', { advisoryId: 'GHSA-2' }],
        ['packageName', { packageName: 'express' }]
    ] as Array<[string, Partial<MuteMatchInput>]>)('does not match when the %s differs', function (_field, override) {
        insertMute(db, mute())
        expect(isMuted(db, match(override))).toBe(false)
    })

    // The single most important row: an npm mute must never silence a same-named PyPI package.
    it('never silences the same package name in another ecosystem', function () {
        insertMute(db, mute({ packageName: 'requests', ecosystem: 'npm' }))
        expect(isMuted(db, match({ packageName: 'requests', ecosystem: 'PyPI' }))).toBe(false)
    })

    // mutes.scanner is a back-compat column holding the SOURCE identity, not the plugin name — so a
    // mute keyed to one source must not silence another source reporting the same advisory.
    it('is scoped to the source identity', function () {
        insertMute(db, mute({ scanner: 'osv' }))
        expect(isMuted(db, match({ source: 'osv' }))).toBe(true)
        expect(isMuted(db, match({ source: 'gemnasium' }))).toBe(false)
    })

    it('stops applying once expired', function () {
        insertMute(db, mute({ expiresAt: T0 + HOUR }))
        expect(isMuted(db, match({ at: T0 + HOUR - 1 }))).toBe(true)
        expect(isMuted(db, match({ at: T0 + HOUR }))).toBe(false)
    })
})

describe('isMuted with a global finding mute', function () {
    // projectId NULL on a finding-scope mute means "this advisory, everywhere".
    it('matches the same finding in any project', function () {
        insertMute(db, mute({ projectId: null }))
        expect(isMuted(db, match({ projectId: PROJECT_ID }))).toBe(true)
        expect(isMuted(db, match({ projectId: OTHER_PROJECT_ID }))).toBe(true)
    })

    it('still requires the rest of the identity to match', function () {
        insertMute(db, mute({ projectId: null }))
        expect(isMuted(db, match({ advisoryId: 'GHSA-2' }))).toBe(false)
    })
})

describe('isMuted with a legacy pre-polyglot mute', function () {
    // A NULL ecosystem is a row written before ecosystems existed; it matches any ecosystem so
    // pre-existing mutes keep working after the upgrade.
    it('matches any ecosystem when the mute has none recorded', function () {
        insertMute(db, mute({ ecosystem: null }))
        expect(isMuted(db, match({ ecosystem: 'npm' }))).toBe(true)
        expect(isMuted(db, match({ ecosystem: 'PyPI' }))).toBe(true)
    })
})

describe('recordMuteLift', function () {
    it('copies the mute identity onto the lift record', function () {
        const lift = recordMuteLift(db, mute(), T0 + HOUR)
        expect(lift).toMatchObject({
            muteId: 'mute-1',
            liftedAt: T0 + HOUR,
            scope: 'finding',
            projectId: PROJECT_ID,
            scanner: 'osv',
            ecosystem: 'npm',
            advisoryId: 'GHSA-1',
            packageName: 'lodash',
            reason: 'accepted risk',
            author: 'betty'
        })
    })

    it('gives each lift its own id', function () {
        const a = recordMuteLift(db, mute(), T0)
        const b = recordMuteLift(db, mute(), T0)
        expect(a.id).not.toBe(b.id)
    })

    it('persists the lift', function () {
        recordMuteLift(db, mute(), T0)
        expect(listRecentMuteLifts(db)).toHaveLength(1)
    })
})

describe('listMuteLiftsForProject', function () {
    it('returns only that project lifts, newest first', function () {
        recordMuteLift(db, mute({ id: 'm1' }), T0)
        recordMuteLift(db, mute({ id: 'm2' }), T0 + HOUR)
        recordMuteLift(db, mute({ id: 'm3', projectId: OTHER_PROJECT_ID }), T0 + 2 * HOUR)
        expect(listMuteLiftsForProject(db, PROJECT_ID).map(function id(l) { return l.muteId })).toEqual(['m2', 'm1'])
    })

    it('honours the limit', function () {
        recordMuteLift(db, mute({ id: 'm1' }), T0)
        recordMuteLift(db, mute({ id: 'm2' }), T0 + HOUR)
        expect(listMuteLiftsForProject(db, PROJECT_ID, 1)).toHaveLength(1)
    })

    it('returns nothing for a project with no lifts', function () {
        expect(listMuteLiftsForProject(db, OTHER_PROJECT_ID)).toEqual([])
    })
})

describe('listMuteLiftsForLibrary', function () {
    it('returns lifts for that package name', function () {
        recordMuteLift(db, mute({ id: 'm1', packageName: 'lodash' }), T0)
        recordMuteLift(db, mute({ id: 'm2', packageName: 'express' }), T0 + HOUR)
        expect(listMuteLiftsForLibrary(db, 'lodash').map(function id(l) { return l.muteId })).toEqual(['m1'])
    })

    // Same reasoning as the mute matcher: a PyPI library's history must not show npm lifts.
    it('filters by ecosystem when one is given', function () {
        recordMuteLift(db, mute({ id: 'm1', packageName: 'requests', ecosystem: 'npm' }), T0)
        recordMuteLift(db, mute({ id: 'm2', packageName: 'requests', ecosystem: 'PyPI' }), T0 + HOUR)
        expect(listMuteLiftsForLibrary(db, 'requests', 50, 'PyPI').map(function id(l) { return l.muteId })).toEqual([
            'm2'
        ])
    })

    it('includes a legacy lift with no ecosystem', function () {
        recordMuteLift(db, mute({ id: 'm1', packageName: 'requests', ecosystem: null }), T0)
        expect(listMuteLiftsForLibrary(db, 'requests', 50, 'PyPI')).toHaveLength(1)
    })

    it('ignores the ecosystem filter when none is given', function () {
        recordMuteLift(db, mute({ id: 'm1', packageName: 'requests', ecosystem: 'npm' }), T0)
        recordMuteLift(db, mute({ id: 'm2', packageName: 'requests', ecosystem: 'PyPI' }), T0 + HOUR)
        expect(listMuteLiftsForLibrary(db, 'requests')).toHaveLength(2)
    })

    it('returns newest first', function () {
        recordMuteLift(db, mute({ id: 'm1' }), T0)
        recordMuteLift(db, mute({ id: 'm2' }), T0 + HOUR)
        expect(listMuteLiftsForLibrary(db, 'lodash').map(function id(l) { return l.muteId })).toEqual(['m2', 'm1'])
    })
})

describe('listRecentMuteLifts', function () {
    it('returns every lift newest first', function () {
        recordMuteLift(db, mute({ id: 'm1' }), T0)
        recordMuteLift(db, mute({ id: 'm2', projectId: OTHER_PROJECT_ID }), T0 + HOUR)
        expect(listRecentMuteLifts(db).map(function id(l) { return l.muteId })).toEqual(['m2', 'm1'])
    })

    it('honours the limit', function () {
        recordMuteLift(db, mute({ id: 'm1' }), T0)
        recordMuteLift(db, mute({ id: 'm2' }), T0 + HOUR)
        expect(listRecentMuteLifts(db, 1).map(function id(l) { return l.muteId })).toEqual(['m2'])
    })

    it('returns nothing when there are no lifts', function () {
        expect(listRecentMuteLifts(db)).toEqual([])
    })
})
