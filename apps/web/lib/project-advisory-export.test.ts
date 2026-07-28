import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
    insertMute,
    insertScan,
    mergeFindingsForScan,
    openDb,
    runMigrations,
    setConfigValue,
    setProjectAlias,
    upsertProject,
    upsertRoot,
    type DrizzleDb,
    type IncomingFinding,
    type SqliteDb
} from '@sentinello/db'
import type { Mute } from '@sentinello/core'
import { buildProjectAdvisoryExport } from './project-advisory-export'

// This module assembles the document that the portal's export action hands to a human and that the
// MCP get_project_advisory tool hands to an agent. Both callers share it, so anything wrong here is
// wrong in two places at once.
//
// The mute filtering is the part that matters most. A mute is a human's recorded accepted-risk
// decision; letting a muted finding into this document would put it in front of an agent whose
// instructions are to remediate what it reads, which is exactly the thing the human signed off on
// not doing. The markdown rendering itself lives in @sentinello/core and is already covered by
// advisory-export.test.ts, so this suite stays on the assembly: what gets included, what gets
// counted, and how the project is named.

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'db', 'drizzle')

const ROOT_ID = 'root-1'
const PROJECT_ID = 'project-1'
const T0 = Date.UTC(2026, 0, 1)
const HOUR = 3600_000

let db: DrizzleDb
let sqlite: SqliteDb
let dir: string

function seedProject(overrides: Record<string, unknown> = {}): void {
    upsertProject(db, {
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
    })
}

function incoming(advisoryId: string, overrides: Partial<IncomingFinding> = {}): IncomingFinding {
    return {
        projectId: PROJECT_ID,
        scanner: 'npm-audit',
        source: 'npm-audit',
        ecosystem: 'npm',
        advisoryId,
        advisoryTitle: 'Advisory ' + advisoryId,
        advisoryUrl: 'https://example.test/' + advisoryId,
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

function scanWith(findings: IncomingFinding[], finishedAt = T0 + HOUR): void {
    const scanId = 'scan-' + finishedAt
    insertScan(db, {
        id: scanId,
        projectId: PROJECT_ID,
        startedAt: finishedAt - 1000,
        finishedAt,
        scanner: 'npm-audit',
        source: 'npm-audit',
        ecosystem: 'npm',
        status: 'ok',
        reasonCode: 'ok',
        durationMs: 1000,
        errorText: null,
        rawJson: ''
    })
    mergeFindingsForScan(db, {
        projectId: PROJECT_ID,
        scanner: 'npm-audit',
        scanId,
        scanFinishedAt: finishedAt,
        incoming: findings
    })
}

function mute(overrides: Partial<Mute> = {}): Mute {
    return {
        id: 'mute-1',
        scope: 'finding',
        projectId: PROJECT_ID,
        scanner: 'npm-audit',
        ecosystem: 'npm',
        advisoryId: 'CVE-1',
        packageName: 'lodash',
        reason: 'accepted risk',
        author: 'betty',
        createdAt: T0,
        expiresAt: null,
        ...overrides
    }
}

beforeEach(async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-advisory-export-'))
    const opened = openDb({ dbPath: join(dir, 'test.sqlite') })
    db = opened.db
    sqlite = opened.sqlite
    runMigrations(db, { migrationsFolder: MIGRATIONS })
    upsertRoot(db, { id: ROOT_ID, path: '/repo', label: null, createdAt: T0 })
    seedProject()
})

afterEach(async function teardown() {
    sqlite.close()
    await rm(dir, { recursive: true, force: true })
})

describe('buildProjectAdvisoryExport — resolution', function () {
    // Each caller shapes its own failure from this null: the server action throws, the MCP tool
    // returns an isError result.
    it('returns null for a project id that does not resolve', function () {
        expect(buildProjectAdvisoryExport(db, 'nope', 'all', T0)).toBeNull()
    })

    it('builds a document for a project with no findings', function () {
        const result = buildProjectAdvisoryExport(db, PROJECT_ID, 'all', T0)
        expect(result).not.toBeNull()
        expect(result?.findingCount).toBe(0)
        expect(result?.mutedExcludedCount).toBe(0)
    })

    it('echoes back the identifying fields it was asked for', function () {
        const result = buildProjectAdvisoryExport(db, PROJECT_ID, 'prod', T0)
        expect(result?.projectId).toBe(PROJECT_ID)
        expect(result?.depType).toBe('prod')
        expect(result?.generatedAt).toBe(T0)
    })
})

describe('buildProjectAdvisoryExport — muted findings', function () {
    // The regression this module was extracted to fix. A muted finding must not reach the document.
    it('excludes a muted finding from the document', function () {
        scanWith([incoming('CVE-1'), incoming('CVE-2', { packageName: 'express' })])
        insertMute(db, mute({ advisoryId: 'CVE-1', packageName: 'lodash' }))

        const result = buildProjectAdvisoryExport(db, PROJECT_ID, 'all', T0 + 2 * HOUR)
        expect(result?.findingCount).toBe(1)
        expect(result?.mutedExcludedCount).toBe(1)
        expect(result?.markdown).not.toContain('CVE-1')
        expect(result?.markdown).toContain('CVE-2')
    })

    it('counts every excluded finding', function () {
        scanWith([
            incoming('CVE-1'),
            incoming('CVE-2', { packageName: 'express' }),
            incoming('CVE-3', { packageName: 'axios' })
        ])
        insertMute(db, mute({ id: 'm1', advisoryId: 'CVE-1', packageName: 'lodash' }))
        insertMute(db, mute({ id: 'm2', advisoryId: 'CVE-2', packageName: 'express' }))

        const result = buildProjectAdvisoryExport(db, PROJECT_ID, 'all', T0 + 2 * HOUR)
        expect(result?.findingCount).toBe(1)
        expect(result?.mutedExcludedCount).toBe(2)
    })

    // A project-scope mute is a blanket accepted-risk decision, so the document empties out rather
    // than silently reverting to per-finding filtering.
    it('excludes everything under a project-scope mute', function () {
        scanWith([incoming('CVE-1'), incoming('CVE-2', { packageName: 'express' })])
        insertMute(db, mute({
            scope: 'project',
            scanner: null,
            ecosystem: null,
            advisoryId: null,
            packageName: null
        }))

        const result = buildProjectAdvisoryExport(db, PROJECT_ID, 'all', T0 + 2 * HOUR)
        expect(result?.findingCount).toBe(0)
        expect(result?.mutedExcludedCount).toBe(2)
    })

    // An expired mute is a lapsed decision — the finding comes back rather than staying hidden.
    it('includes a finding whose mute has expired', function () {
        scanWith([incoming('CVE-1')])
        insertMute(db, mute({ expiresAt: T0 + HOUR }))

        const result = buildProjectAdvisoryExport(db, PROJECT_ID, 'all', T0 + 2 * HOUR)
        expect(result?.findingCount).toBe(1)
        expect(result?.mutedExcludedCount).toBe(0)
    })

    it('still excludes a finding whose mute has not expired yet', function () {
        scanWith([incoming('CVE-1')])
        insertMute(db, mute({ expiresAt: T0 + 10 * HOUR }))

        const result = buildProjectAdvisoryExport(db, PROJECT_ID, 'all', T0 + 2 * HOUR)
        expect(result?.findingCount).toBe(0)
        expect(result?.mutedExcludedCount).toBe(1)
    })

    // The identity tuple includes the package, so muting lodash's copy of an advisory must not
    // silence the same advisory reported against a different package.
    it('does not let a mute leak across packages', function () {
        scanWith([incoming('CVE-1'), incoming('CVE-1', { packageName: 'express' })])
        insertMute(db, mute({ advisoryId: 'CVE-1', packageName: 'lodash' }))

        const result = buildProjectAdvisoryExport(db, PROJECT_ID, 'all', T0 + 2 * HOUR)
        expect(result?.findingCount).toBe(1)
        expect(result?.mutedExcludedCount).toBe(1)
        expect(result?.markdown).toContain('express')
    })
})

describe('buildProjectAdvisoryExport — naming', function () {
    it('prefers the operator-set alias over the discovered name', function () {
        setProjectAlias(db, PROJECT_ID, 'Billing API', T0)
        const result = buildProjectAdvisoryExport(db, PROJECT_ID, 'all', T0)
        expect(result?.projectName).toBe('Billing API')
    })

    // upsertProject deliberately leaves alias out of its conflict set, so a rescan re-discovering the
    // project cannot rename the document out from under the operator who titled it.
    it('keeps the alias across a rediscovery of the project', function () {
        setProjectAlias(db, PROJECT_ID, 'Billing API', T0)
        seedProject({ name: 'app-renamed-on-disk' })
        const result = buildProjectAdvisoryExport(db, PROJECT_ID, 'all', T0)
        expect(result?.projectName).toBe('Billing API')
    })

    it('falls back to the discovered name when there is no alias', function () {
        const result = buildProjectAdvisoryExport(db, PROJECT_ID, 'all', T0)
        expect(result?.projectName).toBe('app')
    })

    it('labels a root-level project with the root alone', function () {
        seedProject({ relPath: '.' })
        upsertRoot(db, { id: ROOT_ID, path: '/repo', label: 'Monorepo', createdAt: T0 })
        const result = buildProjectAdvisoryExport(db, PROJECT_ID, 'all', T0)
        expect(result?.markdown).toContain('Monorepo')
    })

    it('falls back to the root path when the root has no label', function () {
        const result = buildProjectAdvisoryExport(db, PROJECT_ID, 'all', T0)
        expect(result?.markdown).toContain('/repo/app')
    })
})

describe('buildProjectAdvisoryExport — document wiring', function () {
    // generatedAt is injected rather than read from Date.now() inside, precisely so the filename
    // stamp and the document header can never disagree.
    it('stamps the filename and the payload from the same instant', function () {
        const a = buildProjectAdvisoryExport(db, PROJECT_ID, 'all', T0)
        const b = buildProjectAdvisoryExport(db, PROJECT_ID, 'all', T0 + 48 * HOUR)
        expect(a?.generatedAt).toBe(T0)
        expect(b?.generatedAt).toBe(T0 + 48 * HOUR)
        expect(a?.filename).not.toBe(b?.filename)
    })

    it('uses the operator-configured remediation prompt when one is set', function () {
        setConfigValue(db, 'markdownExportPrompt', 'Do only what the ticket says.')
        const result = buildProjectAdvisoryExport(db, PROJECT_ID, 'all', T0)
        expect(result?.markdown).toContain('Do only what the ticket says.')
    })

    it('falls back to the default prompt when none is configured', function () {
        const result = buildProjectAdvisoryExport(db, PROJECT_ID, 'all', T0)
        expect(result?.markdown).toContain('plan mode')
    })

    // findingCount counts rendered rows, not distinct advisories — one vulnerability reported by two
    // scanners renders twice, so this number legitimately exceeds the merged count the project page
    // header shows.
    it('counts rendered rows rather than distinct advisories', function () {
        scanWith([incoming('CVE-1'), incoming('CVE-1', { packageName: 'express' })])
        const result = buildProjectAdvisoryExport(db, PROJECT_ID, 'all', T0 + 2 * HOUR)
        expect(result?.findingCount).toBe(2)
    })

    it('carries the finding details into the rendered document', function () {
        scanWith([incoming('CVE-1')])
        const result = buildProjectAdvisoryExport(db, PROJECT_ID, 'all', T0 + 2 * HOUR)
        expect(result?.markdown).toContain('lodash')
        expect(result?.markdown).toContain('4.17.11')
        expect(result?.markdown).toContain('4.17.21')
    })
})
