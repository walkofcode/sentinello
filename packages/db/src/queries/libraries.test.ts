import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sourceEnabledKey } from '@sentinello/core'
import { openDb } from '../client'
import type { DrizzleDb, SqliteDb } from '../client'
import { runMigrations } from '../migrate'
import { setConfigValue, upsertRoot } from './config'
import { upsertProject } from './projects'
import { insertScan } from './scans'
import { mergeFindingsForScan, type IncomingFinding } from './findings'
import { insertMute } from './mutes'
import { listLibraries, listLibraryUsage } from './libraries'

// The library pivot is the cross-project triage view: "which dependency is hurting us in the most
// places". It aggregates over findings with the same blast-radius restrictions the rest of the portal
// honours, and each restriction exists because showing the row would be actively misleading —
// a resolved finding is already fixed, a muted one was signed off, and a disabled source cell is one
// the operator switched off.
//
// The identity rule is the subtle part. npm-audit and OSV assign different advisory ids to the same
// CVE but share the title, so distinctAdvisories counts by normalised title when present. Counting
// raw ids would double-count one vulnerability reported by two sources and overstate the damage.

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle')

const ROOT_ID = 'root-1'
const T0 = Date.UTC(2026, 0, 1)
const HOUR = 3600_000
const AT = T0 + HOUR

let db: DrizzleDb
let sqlite: SqliteDb
let dir: string
let scanCounter = 0

function addProject(id: string): void {
    upsertProject(db, {
        id,
        rootId: ROOT_ID,
        relPath: id,
        name: id,
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

function finding(overrides: Partial<IncomingFinding> = {}): IncomingFinding {
    return {
        projectId: 'project-1',
        scanner: 'npm-audit',
        source: 'npm-audit',
        ecosystem: 'npm',
        advisoryId: 'CVE-2024-1',
        advisoryTitle: 'Prototype pollution',
        advisoryUrl: 'https://example.test/1',
        packageName: 'lodash',
        installedVersion: '4.17.11',
        vulnerableRange: '<4.17.21',
        severity: 'high',
        fixAvailable: true,
        fixVersion: '4.17.21',
        depPath: ['lodash'],
        isProd: true,
        isDev: false,
        ...overrides
    }
}

// Writes findings for one project under one scanner, going through the real lifecycle merge so
// resolved_at behaves as it does in production.
function scanProject(projectId: string, incoming: IncomingFinding[], scanner = 'npm-audit'): void {
    scanCounter += 1
    const scanId = 'scan-' + scanCounter
    insertScan(db, {
        id: scanId,
        projectId,
        startedAt: T0 - 1000,
        finishedAt: T0 + scanCounter,
        scanner,
        source: scanner,
        ecosystem: 'npm',
        status: 'ok',
        reasonCode: 'ok',
        durationMs: 1000,
        errorText: null,
        rawJson: ''
    })
    mergeFindingsForScan(db, {
        projectId,
        scanner,
        scanId,
        scanFinishedAt: T0 + scanCounter,
        // The finding's own scanner/source must match the scan's, or the source-cell filter judges it
        // under the wrong cell — npm-audit, for instance, only ever answers for the npm ecosystem.
        incoming: incoming.map(function scoped(f) { return { ...f, projectId, scanner, source: scanner } })
    })
}

function mute(overrides: Record<string, unknown> = {}): void {
    insertMute(db, {
        id: 'mute-' + Math.round(Math.random() * 1e9),
        scope: 'finding',
        projectId: 'project-1',
        scanner: 'npm-audit',
        ecosystem: 'npm',
        advisoryId: 'CVE-2024-1',
        packageName: 'lodash',
        reason: 'accepted risk',
        author: 'betty',
        createdAt: T0,
        expiresAt: null,
        ...overrides
    } as Parameters<typeof insertMute>[1])
}

beforeEach(async function setup() {
    scanCounter = 0
    dir = await mkdtemp(join(tmpdir(), 'sentinello-libraries-'))
    const opened = openDb({ dbPath: join(dir, 'test.sqlite') })
    db = opened.db
    sqlite = opened.sqlite
    runMigrations(db, { migrationsFolder: MIGRATIONS })
    upsertRoot(db, { id: ROOT_ID, path: '/repo', label: null, createdAt: T0 })
    addProject('project-1')
    addProject('project-2')
    // OSV is opt-in per cell; several cases below report findings from it.
    setConfigValue(db, sourceEnabledKey('osv', 'npm'), true)
    setConfigValue(db, sourceEnabledKey('osv', 'PyPI'), true)
})

afterEach(async function teardown() {
    sqlite.close()
    await rm(dir, { recursive: true, force: true })
})

describe('listLibraries — aggregation', function () {
    it('reports nothing on an empty database', function () {
        expect(listLibraries(db, AT)).toEqual([])
    })

    it('summarises one library across one project', function () {
        scanProject('project-1', [finding()])
        expect(listLibraries(db, AT)).toEqual([
            {
                ecosystem: 'npm',
                packageName: 'lodash',
                distinctAdvisories: 1,
                distinctProjects: 1,
                severities: ['high']
            }
        ])
    })

    it('counts the projects a library appears in', function () {
        scanProject('project-1', [finding()])
        scanProject('project-2', [finding()])
        expect(listLibraries(db, AT)[0]?.distinctProjects).toBe(2)
    })

    it('collects the distinct severities seen', function () {
        scanProject('project-1', [
            finding({ advisoryId: 'CVE-1', advisoryTitle: 'A', severity: 'high' }),
            finding({ advisoryId: 'CVE-2', advisoryTitle: 'B', severity: 'critical' })
        ])
        expect(listLibraries(db, AT)[0]?.severities.sort()).toEqual(['critical', 'high'])
    })

    // The identity rule. Two sources naming the same vulnerability differently must count once, or
    // the triage view overstates how many distinct problems a library has.
    it('counts one vulnerability once even when two sources report it', function () {
        scanProject('project-1', [finding({ advisoryId: 'GHSA-x', advisoryTitle: 'Prototype pollution' })], 'npm-audit')
        scanProject('project-1', [finding({ advisoryId: 'CVE-2024-1', advisoryTitle: 'Prototype pollution' })], 'osv')
        expect(listLibraries(db, AT)[0]?.distinctAdvisories).toBe(1)
    })

    it('counts genuinely different advisories separately', function () {
        scanProject('project-1', [
            finding({ advisoryId: 'CVE-1', advisoryTitle: 'Prototype pollution' }),
            finding({ advisoryId: 'CVE-2', advisoryTitle: 'ReDoS' })
        ])
        expect(listLibraries(db, AT)[0]?.distinctAdvisories).toBe(2)
    })

    it('falls back to the advisory id when there is no title', function () {
        scanProject('project-1', [
            finding({ advisoryId: 'CVE-1', advisoryTitle: null }),
            finding({ advisoryId: 'CVE-2', advisoryTitle: null })
        ])
        expect(listLibraries(db, AT)[0]?.distinctAdvisories).toBe(2)
    })

    // A library is (ecosystem, packageName): npm `requests` and PyPI `requests` are unrelated
    // packages that happen to share a name.
    it('keeps the same package name in two ecosystems as two libraries', function () {
        scanProject('project-1', [
            finding({ packageName: 'requests', ecosystem: 'npm' }),
            finding({ packageName: 'requests', ecosystem: 'PyPI', advisoryId: 'CVE-2', advisoryTitle: 'Other' })
        ], 'osv')
        const found = listLibraries(db, AT)
        expect(found).toHaveLength(2)
        expect(found.map(function e(l) { return l.ecosystem }).sort()).toEqual(['PyPI', 'npm'])
    })

    // Most-affected first is what makes this a triage view rather than a list.
    it('orders by project count descending, then package name', function () {
        scanProject('project-1', [finding({ packageName: 'widespread' })])
        scanProject('project-2', [finding({ packageName: 'widespread' })])
        scanProject('project-1', [
            finding({ packageName: 'zeta', advisoryId: 'CVE-2', advisoryTitle: 'Z' }),
            finding({ packageName: 'alpha', advisoryId: 'CVE-3', advisoryTitle: 'A' })
        ], 'osv')
        expect(listLibraries(db, AT).map(function n(l) { return l.packageName })).toEqual([
            'widespread', 'alpha', 'zeta'
        ])
    })
})

describe('listLibraries — exclusions', function () {
    it('excludes a finding resolved by a later scan', function () {
        scanProject('project-1', [finding()])
        expect(listLibraries(db, AT)).toHaveLength(1)
        // A subsequent clean scan closes the episode.
        scanProject('project-1', [])
        expect(listLibraries(db, AT)).toEqual([])
    })

    it('excludes a muted finding', function () {
        scanProject('project-1', [finding()])
        mute()
        expect(listLibraries(db, AT)).toEqual([])
    })

    it('includes a finding whose mute has expired', function () {
        scanProject('project-1', [finding()])
        mute({ expiresAt: T0 })
        expect(listLibraries(db, AT)).toHaveLength(1)
    })

    it('excludes everything under a project-scope mute', function () {
        scanProject('project-1', [finding()])
        scanProject('project-2', [finding()])
        mute({ scope: 'project', scanner: null, ecosystem: null, advisoryId: null, packageName: null })
        expect(listLibraries(db, AT)[0]?.distinctProjects).toBe(1)
    })

    // A mute on the npm copy must not silence the PyPI package of the same name.
    it('does not let a mute cross ecosystems', function () {
        scanProject('project-1', [
            finding({ packageName: 'requests', ecosystem: 'npm' }),
            finding({ packageName: 'requests', ecosystem: 'PyPI', advisoryId: 'CVE-2', advisoryTitle: 'Other' })
        ], 'osv')
        mute({ scanner: 'osv', ecosystem: 'npm', advisoryId: 'CVE-2024-1', packageName: 'requests' })
        const found = listLibraries(db, AT)
        expect(found).toHaveLength(1)
        expect(found[0]?.ecosystem).toBe('PyPI')
    })

    // Disabling a source cell hides its findings on read without deleting them.
    it('excludes findings from a disabled source cell', function () {
        scanProject('project-1', [finding()], 'osv')
        expect(listLibraries(db, AT)).toHaveLength(1)
        setConfigValue(db, sourceEnabledKey('osv', 'npm'), false)
        expect(listLibraries(db, AT)).toEqual([])
    })
})

describe('listLibraries — dependency type filter', function () {
    it('keeps only production findings for the prod filter', function () {
        scanProject('project-1', [
            finding({ packageName: 'prod-lib', isProd: true, isDev: false }),
            finding({ packageName: 'dev-lib', isProd: false, isDev: true, advisoryId: 'CVE-2', advisoryTitle: 'B' })
        ])
        expect(listLibraries(db, AT, 'prod').map(function n(l) { return l.packageName })).toEqual(['prod-lib'])
    })

    // "dev" means reachable only from devDependencies, so a package that is also production is not
    // a dev finding.
    it('excludes a prod-and-dev package from the dev filter', function () {
        scanProject('project-1', [
            finding({ packageName: 'both', isProd: true, isDev: true }),
            finding({ packageName: 'dev-only', isProd: false, isDev: true, advisoryId: 'CVE-2', advisoryTitle: 'B' })
        ])
        expect(listLibraries(db, AT, 'dev').map(function n(l) { return l.packageName })).toEqual(['dev-only'])
    })

    it('keeps everything for the all filter', function () {
        scanProject('project-1', [
            finding({ packageName: 'prod-lib', isProd: true, isDev: false }),
            finding({ packageName: 'dev-lib', isProd: false, isDev: true, advisoryId: 'CVE-2', advisoryTitle: 'B' })
        ])
        expect(listLibraries(db, AT, 'all')).toHaveLength(2)
    })
})

describe('listLibraryUsage', function () {
    it('reports nothing for a library with no findings', function () {
        expect(listLibraryUsage(db, 'lodash', AT)).toEqual([])
    })

    it('lists each project using the library', function () {
        scanProject('project-1', [finding()])
        scanProject('project-2', [finding()])
        const usage = listLibraryUsage(db, 'lodash', AT)
        expect(usage).toHaveLength(2)
        expect(usage.map(function p(u) { return u.projectId }).sort()).toEqual(['project-1', 'project-2'])
    })

    it('carries the identity a mute would need', function () {
        scanProject('project-1', [finding()])
        expect(listLibraryUsage(db, 'lodash', AT)[0]).toMatchObject({
            source: 'npm-audit',
            ecosystem: 'npm',
            advisoryId: 'CVE-2024-1'
        })
    })

    it('reports the installed version and range', function () {
        scanProject('project-1', [finding()])
        expect(listLibraryUsage(db, 'lodash', AT)[0]).toMatchObject({
            installedVersion: '4.17.11',
            vulnerableRange: '<4.17.21',
            severity: 'high'
        })
    })

    // The detail page passes the ecosystem so a same-named package elsewhere never bleeds in.
    it('scopes to one ecosystem when asked', function () {
        scanProject('project-1', [
            finding({ packageName: 'requests', ecosystem: 'npm' }),
            finding({ packageName: 'requests', ecosystem: 'PyPI', advisoryId: 'CVE-2', advisoryTitle: 'Other' })
        ], 'osv')
        expect(listLibraryUsage(db, 'requests', AT, 'all', 'PyPI')).toHaveLength(1)
        expect(listLibraryUsage(db, 'requests', AT, 'all', 'PyPI')[0]?.ecosystem).toBe('PyPI')
    })

    it('spans both ecosystems when none is given', function () {
        scanProject('project-1', [
            finding({ packageName: 'requests', ecosystem: 'npm' }),
            finding({ packageName: 'requests', ecosystem: 'PyPI', advisoryId: 'CVE-2', advisoryTitle: 'Other' })
        ], 'osv')
        expect(listLibraryUsage(db, 'requests', AT)).toHaveLength(2)
    })

    it('excludes a muted usage', function () {
        scanProject('project-1', [finding()])
        scanProject('project-2', [finding()])
        mute({ projectId: 'project-1' })
        const usage = listLibraryUsage(db, 'lodash', AT)
        expect(usage).toHaveLength(1)
        expect(usage[0]?.projectId).toBe('project-2')
    })

    it('honours the dependency type filter', function () {
        scanProject('project-1', [finding({ isProd: false, isDev: true })])
        expect(listLibraryUsage(db, 'lodash', AT, 'prod')).toEqual([])
        expect(listLibraryUsage(db, 'lodash', AT, 'dev')).toHaveLength(1)
    })
})
