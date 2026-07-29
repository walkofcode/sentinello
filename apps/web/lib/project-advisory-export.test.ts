import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ulid } from 'ulid'
import {
    insertMute,
    insertScan,
    mergeFindingsForScan,
    openDb,
    runMigrations,
    setConfigValue,
    upsertProject,
    upsertRoot,
    type DrizzleDb,
    type IncomingFinding,
    type SqliteDb
} from '@sentinello/db'
import { sourceEnabledKey } from '@sentinello/core'
import { buildProjectAdvisoryExport } from './project-advisory-export'

// The advisory document is the work list an agent acts on, so its entry count is load-bearing: too
// many and the agent does the same upgrade three times, too few and a vulnerability goes unfixed.
// Sentinello stores one findings row per reporting source, so the same CVE arrives from npm-audit and
// OSV under different advisory ids — these tests pin that the document collapses those to one entry,
// matching what the dashboard and project page report.

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'db', 'drizzle')

const ROOT_ID = 'root-1'
const PROJECT_ID = 'project-1'
const T0 = Date.UTC(2026, 0, 1)

let db: DrizzleDb
let sqlite: SqliteDb
let dir: string

function incoming(overrides: Partial<IncomingFinding> = {}): IncomingFinding {
    return {
        projectId: PROJECT_ID,
        scanner: 'npm-audit',
        source: 'npm-audit',
        ecosystem: 'npm',
        advisoryId: 'GHSA-abc',
        advisoryTitle: 'Prototype pollution in lodash',
        advisoryUrl: 'https://example.invalid/GHSA-abc',
        packageName: 'lodash',
        installedVersion: '4.17.20',
        vulnerableRange: '<4.17.21',
        severity: 'high',
        fixAvailable: true,
        fixVersion: '4.17.21',
        depPath: ['node_modules/lodash'],
        isProd: true,
        isDev: false,
        ...overrides
    }
}

// One scan per source, mirroring how the worker runs them: the merge is scoped to (project, scanner),
// so each source's rows land independently and both stay open.
function scanWith(scanner: string, source: string, rows: IncomingFinding[]): void {
    const scanId = ulid()
    insertScan(db, {
        id: scanId,
        projectId: PROJECT_ID,
        startedAt: T0,
        finishedAt: T0,
        scanner,
        source,
        ecosystem: 'npm',
        status: 'ok',
        reasonCode: null,
        durationMs: 1,
        errorText: null,
        rawJson: '{}'
    })
    mergeFindingsForScan(db, {
        projectId: PROJECT_ID,
        scanner,
        scanId,
        scanFinishedAt: T0,
        incoming: rows
    })
}

function exportAt(): ReturnType<typeof buildProjectAdvisoryExport> {
    return buildProjectAdvisoryExport(db, PROJECT_ID, 'all', T0)
}

beforeEach(async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-advisory-'))
    const opened = openDb({ dbPath: join(dir, 'test.sqlite') })
    db = opened.db
    sqlite = opened.sqlite
    runMigrations(db, { migrationsFolder: MIGRATIONS })
    // OSV is opt-in and off by default; without this its rows are filtered out as an inactive source
    // cell and the cross-source dedup below would never be exercised. Enabled per ecosystem, because
    // that is how the source-cell filter is keyed.
    setConfigValue(db, sourceEnabledKey('osv', 'npm'), true)
    setConfigValue(db, sourceEnabledKey('osv', 'PyPI'), true)

    upsertRoot(db, { id: ROOT_ID, path: '/repo', label: null, createdAt: T0 })
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
        updatedAt: T0
    })
})

afterEach(async function teardown() {
    sqlite.close()
    await rm(dir, { recursive: true, force: true })
})

describe('buildProjectAdvisoryExport deduplication', function () {
    // The 60-vs-36 report that prompted this: npm-audit and OSV both report the CVE under their own
    // advisory ids, and the shared title is what identifies them as the same vulnerability.
    it('renders one entry when two sources report the same vulnerability', function () {
        scanWith('npm-audit', 'npm-audit', [incoming()])
        scanWith('osv', 'osv', [incoming({ scanner: 'osv', source: 'osv', advisoryId: 'CVE-2026-1' })])

        const result = exportAt()
        expect(result?.findingCount).toBe(1)
        expect(result?.markdown.match(/^### \d+\./gm)).toHaveLength(1)
    })

    it('credits both sources on the merged entry', function () {
        scanWith('npm-audit', 'npm-audit', [incoming()])
        scanWith('osv', 'osv', [incoming({ scanner: 'osv', source: 'osv', advisoryId: 'CVE-2026-1' })])

        expect(exportAt()?.markdown).toContain('- **Sources:** npm-audit, osv')
    })

    it('keeps both advisory ids discoverable on the merged entry', function () {
        scanWith('npm-audit', 'npm-audit', [incoming()])
        scanWith('osv', 'osv', [incoming({ scanner: 'osv', source: 'osv', advisoryId: 'CVE-2026-1' })])

        expect(exportAt()?.markdown).toContain('`CVE-2026-1`')
    })

    // Same package name, genuinely different vulnerabilities — merging these would hide one.
    it('keeps distinct advisories on one package separate', function () {
        scanWith('npm-audit', 'npm-audit', [
            incoming(),
            incoming({ advisoryId: 'GHSA-def', advisoryTitle: 'ReDoS in lodash' })
        ])

        expect(exportAt()?.findingCount).toBe(2)
    })

    // A CVE shared by an npm package and a PyPI package of the same name is two problems, not one.
    it('keeps the same advisory in different ecosystems separate', function () {
        scanWith('npm-audit', 'npm-audit', [incoming()])
        scanWith('osv', 'osv', [
            incoming({ scanner: 'osv', source: 'osv', ecosystem: 'PyPI', advisoryId: 'CVE-2026-1' })
        ])

        expect(exportAt()?.findingCount).toBe(2)
    })
})

describe('buildProjectAdvisoryExport mute accounting', function () {
    function muteLodash(source: string): void {
        insertMute(db, {
            id: ulid(),
            scope: 'finding',
            projectId: PROJECT_ID,
            scanner: source,
            ecosystem: 'npm',
            advisoryId: source === 'osv' ? 'CVE-2026-1' : 'GHSA-abc',
            packageName: 'lodash',
            reason: 'accepted',
            author: 'test',
            createdAt: T0,
            expiresAt: null
        })
    }

    it('excludes an advisory only when every source reporting it is muted', function () {
        scanWith('npm-audit', 'npm-audit', [incoming()])
        scanWith('osv', 'osv', [incoming({ scanner: 'osv', source: 'osv', advisoryId: 'CVE-2026-1' })])
        muteLodash('npm-audit')
        muteLodash('osv')

        const result = exportAt()
        expect(result?.findingCount).toBe(0)
        expect(result?.mutedExcludedCount).toBe(1)
    })

    // Muting one source is not a decision to accept the risk everywhere — the other source still
    // reports it, so the work item must survive.
    it('keeps an advisory that is muted on one source but still reported by another', function () {
        scanWith('npm-audit', 'npm-audit', [incoming()])
        scanWith('osv', 'osv', [incoming({ scanner: 'osv', source: 'osv', advisoryId: 'CVE-2026-1' })])
        muteLodash('npm-audit')

        const result = exportAt()
        expect(result?.findingCount).toBe(1)
        expect(result?.mutedExcludedCount).toBe(0)
    })

    it('counts muted exclusions as advisories rather than rows', function () {
        scanWith('npm-audit', 'npm-audit', [incoming()])
        scanWith('osv', 'osv', [incoming({ scanner: 'osv', source: 'osv', advisoryId: 'CVE-2026-1' })])
        muteLodash('npm-audit')
        muteLodash('osv')

        // Two rows were withheld, but they were one vulnerability.
        expect(exportAt()?.mutedExcludedCount).toBe(1)
    })
})

describe('buildProjectAdvisoryExport', function () {
    it('returns null for an unknown project', function () {
        expect(buildProjectAdvisoryExport(db, 'nope', 'all', T0)).toBeNull()
    })

    it('says so explicitly rather than rendering an empty list when there is nothing to fix', function () {
        const result = exportAt()
        expect(result?.findingCount).toBe(0)
        expect(result?.markdown).toContain('_No current findings._')
    })
})
