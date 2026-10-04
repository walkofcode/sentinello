import { copyFileSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { senderFor, type NotificationSender } from '@sentinello/notifications'
import type { Project } from '@sentinello/core'
import {
    getConfigValue,
    insertNotificationTarget,
    listNotificationTargets,
    openDb,
    runMigrations,
    setConfigValue,
    upsertProject,
    upsertRoot
} from '@sentinello/db'
import type { RawFinding, ScannerPlugin } from '@sentinello/scanners'
import { assertScratchPath, liveDataDir, openScratchEnv } from '../scripts/scratch-env'
import { CONFIG_KEYS } from './config-loader'
import { runProjectScanners } from './runner'

// The scratch tools rescan real projects against a COPY of the live database. Two properties make that
// safe, and both are pinned here: the live data directory can never be opened, and no notification can
// leave a scratch run — whatever the copied database's targets and dryRunNotify say.

vi.mock('@sentinello/notifications', async function mockNotifications(importOriginal) {
    const actual = await importOriginal<typeof import('@sentinello/notifications')>()
    return { ...actual, senderFor: vi.fn() }
})

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'db', 'drizzle')
const T0 = Date.UTC(2026, 9, 3)

let dir: string
let send: ReturnType<typeof vi.fn> & NotificationSender
const savedEnv = { ...process.env }

function project(): Project {
    return {
        id: 'project-1', rootId: 'root-1', relPath: 'app', name: 'app', alias: null, packageManager: 'npm', nvmrcVersion: null,
        gitBranch: null, ecosystems: ['npm'], muted: false, tags: [], createdAt: T0, updatedAt: T0
    }
}

// A scanner that reports one high finding — dispatchable to a target filtering on high.
const scanner: ScannerPlugin = {
    name: 'npm-audit',
    scan: async function scan() {
        const finding: RawFinding = {
            advisoryId: '1001', aliases: [], advisoryTitle: 'A flaw', advisoryUrl: null, packageName: 'braces', ecosystem: 'npm',
            installedVersion: '3.0.3', vulnerableRange: '<=3.0.3', severity: 'high', fixAvailable: false, fixVersion: null,
            fixInputs: { source: 'npm-audit', installed: ['3.0.3'], affected: { ranges: '<=3.0.3', exact: [], complete: true }, patched: '<0.0.0', statedFix: null, fixViaParent: false },
            depPath: ['braces'], isProd: true, isDev: false
        }
        return { status: 'ok', reasonCode: 'ok', findings: [finding], rawJson: '{}', errorText: null, durationMs: 1 }
    }
}

// The "live" database a scratch copy is taken from: delivery switched ON, an enabled webhook target
// listening for high findings.
function seedLiveShapedDb(path: string): void {
    const { db, sqlite } = openDb({ dbPath: path })
    runMigrations(db, { migrationsFolder: MIGRATIONS })
    upsertRoot(db, { id: 'root-1', path: join(dir, 'repo'), label: null, createdAt: T0 })
    upsertProject(db, project())
    setConfigValue(db, CONFIG_KEYS.dryRunNotify, false)
    insertNotificationTarget(db, {
        id: 'hook-1', kind: 'webhook', config: { url: 'https://hooks.example.test/incoming' }, severityFilter: ['critical', 'high'],
        envFilter: 'all', enabled: true, createdAt: T0, rootIds: [], projectIds: [], sourceScope: { mode: 'all', cells: [] }
    })
    sqlite.pragma('wal_checkpoint(TRUNCATE)')
    sqlite.close()
}

beforeEach(async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-scratch-'))
    mkdirSync(join(dir, 'repo'))
    send = vi.fn(async function sent() { return { ok: true as const } }) as unknown as ReturnType<typeof vi.fn> & NotificationSender
    vi.mocked(senderFor).mockReturnValue(send)
    process.env.SENTINELLO_LIVE_DATA_DIR = join(dir, 'live')
    mkdirSync(join(dir, 'live'))
})

afterEach(async function teardown() {
    process.env = { ...savedEnv }
    await rm(dir, { recursive: true, force: true })
})

describe('assertScratchPath', function () {
    it('refuses the live database, anything under the live directory, and a symlink into it', function () {
        writeFileSync(join(dir, 'live', 'sentinello.sqlite'), '')
        symlinkSync(join(dir, 'live', 'sentinello.sqlite'), join(dir, 'innocent.sqlite'))
        expect(function live() { assertScratchPath(join(dir, 'live', 'sentinello.sqlite')) }).toThrow(/live data directory/)
        expect(function sibling() { assertScratchPath(join(dir, 'live', 'not-yet.db')) }).toThrow(/live data directory/)
        expect(function dotdot() { assertScratchPath(join(dir, 'other', '..', 'live', 'osv.db')) }).toThrow(/live data directory/)
        expect(function linked() { assertScratchPath(join(dir, 'innocent.sqlite')) }).toThrow(/live data directory/)
        expect(function dir_() { assertScratchPath(join(dir, 'live')) }).toThrow(/live data directory/)
    })

    it('accepts a copy elsewhere, existing or not', function () {
        expect(assertScratchPath(join(dir, 'scratch.sqlite'))).toMatch(/scratch\.sqlite$/)
        expect(assertScratchPath(join(dir, 'nowhere', 'scratch.sqlite'))).toMatch(/nowhere\/scratch\.sqlite$/)
    })

    it('defaults to the ~/Apps/sentinello/data convention', function () {
        delete process.env.SENTINELLO_LIVE_DATA_DIR
        expect(liveDataDir()).toMatch(/Apps\/sentinello\/data$/)
    })

    it('refuses to open a scratch environment whose feed databases point at the live directory', async function () {
        await expect(openScratchEnv({ db: join(dir, 'scratch.sqlite'), osvDb: join(dir, 'live', 'osv.db') })).rejects.toThrow(/live data directory/)
    })
})

describe('openScratchEnv — notification isolation', function () {
    // The control: the same database, scanned the normal way, does reach a sender. Without it the test
    // below could pass because nothing was ever dispatchable.
    it('control: the live-shaped database dispatches to its target', async function () {
        const livePath = join(dir, 'source.sqlite')
        seedLiveShapedDb(livePath)
        const { db, sqlite } = openDb({ dbPath: livePath })
        await runProjectScanners({ db, scanners: [scanner], project: project() })
        sqlite.close()
        expect(send).toHaveBeenCalled()
    })

    it('a scratch copy of that database sends nothing, through the recording notifier or the real one', async function () {
        const livePath = join(dir, 'source.sqlite')
        seedLiveShapedDb(livePath)
        const scratchPath = join(dir, 'scratch', 'sentinello.sqlite')
        mkdirSync(dirname(scratchPath))
        copyFileSync(livePath, scratchPath)
        const env = await openScratchEnv({ db: scratchPath })
        try {
            expect(process.env.SENTINELLO_DB_PATH).toBe(env.dbPath)
            expect(process.env.SENTINELLO_OSV_DB_PATH).toMatch(/scratch\/osv\.db$/)
            expect(process.env.SENTINELLO_GEMNASIUM_DB_PATH).toMatch(/scratch\/gemnasium\.db$/)
            expect(getConfigValue<boolean>(env.db, CONFIG_KEYS.dryRunNotify)).toBe(true)
            expect(listNotificationTargets(env.db).every(function off(t) { return !t.enabled })).toBe(true)

            await env.scan(project(), [scanner])
            expect(env.notifications).toHaveLength(1)
            expect(env.notifications[0]?.vulnerabilities[0]).toMatchObject({ library: 'braces', fixStatus: 'unverified', recommendedVersion: null })
            expect(env.notifications[0]?.advisoryText).toContain('`braces@3.0.3`')

            // Bypass the recording notifier entirely: the copied database itself still cannot send.
            await runProjectScanners({ db: env.db, scanners: [scanner], project: project() })
            expect(send).not.toHaveBeenCalled()

            env.clearRegistryCache()
            expect(env.sqlite.prepare('select count(*) as n from registry_packages').get()).toEqual({ n: 0 })
        } finally {
            env.close()
        }
    })
})
