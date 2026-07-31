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
import { sourceEnabledKey, type Mute } from '@sentinello/core'
import { buildProjectAdvisoryExport } from './project-advisory-export'

// This module assembles the document that the portal's export action hands to a human and that the
// MCP get_project_advisory tool hands to an agent. Both callers share it, so anything wrong here is
// wrong in two places at once.
//
// Two things carry the weight. First, the counts: the document is a work list, so too many entries
// and the agent does the same upgrade three times, too few and a vulnerability goes unfixed.
// Sentinello stores one findings row per reporting source, so the same CVE arrives from npm-audit and
// OSV under different advisory ids — the document collapses those to one entry, matching what the
// dashboard and project page report. Second, the mute filtering: a mute is a human's recorded
// accepted-risk decision, and letting a muted finding into this document would put it in front of an
// agent whose instructions are to remediate what it reads, which is exactly the thing the human
// signed off on not doing.
//
// The markdown rendering itself lives in @sentinello/core and is already covered by
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

// The advisory title defaults to one derived from the id, because the normalized title IS the
// cross-source identity (advisory-identity.ts / merge-findings.ts:advisoryKey). Distinct ids
// therefore describe distinct vulnerabilities by default; the dedup suite below opts into a SHARED
// title explicitly, since sharing it is the whole mechanism under test.
function incoming(overrides: Partial<IncomingFinding> = {}): IncomingFinding {
    const advisoryId = overrides.advisoryId ?? 'GHSA-abc'
    return {
        projectId: PROJECT_ID,
        scanner: 'npm-audit',
        source: 'npm-audit',
        ecosystem: 'npm',
        advisoryId,
        advisoryTitle: 'Advisory ' + advisoryId,
        advisoryUrl: 'https://example.invalid/' + advisoryId,
        packageName: 'lodash',
        installedVersion: '4.17.11',
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
// so each source's rows land independently and both stay open. The rows are stamped with the scanning
// source rather than carrying their own — a row attributed to a source that did not run the scan is
// not a state the worker can produce, and letting a caller build one silently collapses the two scans
// into a single merge scope.
function scanWith(rows: IncomingFinding[], scanner = 'npm-audit', finishedAt = T0 + HOUR): void {
    const scanId = 'scan-' + scanner + '-' + finishedAt
    insertScan(db, {
        id: scanId,
        projectId: PROJECT_ID,
        startedAt: finishedAt - 1000,
        finishedAt,
        scanner,
        source: scanner,
        ecosystem: 'npm',
        status: 'ok',
        reasonCode: 'ok',
        durationMs: 1000,
        errorText: null,
        rawJson: '{}'
    })
    mergeFindingsForScan(db, {
        projectId: PROJECT_ID,
        scanner,
        scanId,
        scanFinishedAt: finishedAt,
        incoming: rows.map(function stampSource(row) {
            return { ...row, scanner, source: scanner }
        })
    })
}

function mute(overrides: Partial<Mute> = {}): Mute {
    return {
        id: 'mute-1',
        scope: 'finding',
        projectId: PROJECT_ID,
        scanner: 'npm-audit',
        ecosystem: 'npm',
        advisoryId: 'GHSA-abc',
        packageName: 'lodash',
        reason: 'accepted risk',
        author: 'betty',
        createdAt: T0,
        expiresAt: null,
        ...overrides
    }
}

function exportAt(at = T0 + 2 * HOUR): ReturnType<typeof buildProjectAdvisoryExport> {
    return buildProjectAdvisoryExport(db, PROJECT_ID, 'all', at)
}

beforeEach(async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-advisory-export-'))
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
        const result = exportAt()
        expect(result).not.toBeNull()
        expect(result?.findingCount).toBe(0)
        expect(result?.mutedExcludedCount).toBe(0)
    })

    it('says so explicitly rather than rendering an empty list when there is nothing to fix', function () {
        expect(exportAt()?.markdown).toContain('_No current findings._')
    })

    it('echoes back the identifying fields it was asked for', function () {
        const result = buildProjectAdvisoryExport(db, PROJECT_ID, 'prod', T0)
        expect(result?.projectId).toBe(PROJECT_ID)
        expect(result?.depType).toBe('prod')
        expect(result?.generatedAt).toBe(T0)
    })
})

describe('buildProjectAdvisoryExport — deduplication', function () {
    // The 60-vs-36 report that prompted this: npm-audit and OSV both report the CVE under their own
    // advisory ids, and the shared title is what identifies them as the same vulnerability.
    const SHARED = 'Prototype pollution in lodash'

    function bothSourcesReportOneVulnerability(): void {
        scanWith([incoming({ advisoryTitle: SHARED })])
        scanWith([incoming({ advisoryId: 'CVE-2026-1', advisoryTitle: SHARED })], 'osv')
    }

    it('renders one entry when two sources report the same vulnerability', function () {
        bothSourcesReportOneVulnerability()

        const result = exportAt()
        expect(result?.findingCount).toBe(1)
        expect(result?.markdown.match(/^### \d+\./gm)).toHaveLength(1)
    })

    it('credits both sources on the merged entry', function () {
        bothSourcesReportOneVulnerability()

        expect(exportAt()?.markdown).toContain('- **Sources:** npm-audit, osv')
    })

    it('keeps both advisory ids discoverable on the merged entry', function () {
        bothSourcesReportOneVulnerability()

        expect(exportAt()?.markdown).toContain('`CVE-2026-1`')
    })

    // Same package name, genuinely different vulnerabilities — merging these would hide one.
    it('keeps distinct advisories on one package separate', function () {
        scanWith([incoming(), incoming({ advisoryId: 'GHSA-def' })])

        expect(exportAt()?.findingCount).toBe(2)
    })

    // A CVE shared by an npm package and a PyPI package of the same name is two problems, not one.
    it('keeps the same advisory in different ecosystems separate', function () {
        scanWith([incoming({ advisoryTitle: SHARED })])
        scanWith([
            incoming({ ecosystem: 'PyPI', advisoryId: 'CVE-2026-1', advisoryTitle: SHARED })
        ], 'osv')

        expect(exportAt()?.findingCount).toBe(2)
    })

    // The merge keys on (ecosystem, package, advisory), so one advisory affecting two packages is two
    // pieces of work — the agent has to upgrade each of them.
    it('keeps one advisory reported against two packages separate', function () {
        scanWith([incoming(), incoming({ packageName: 'express' })])

        expect(exportAt()?.findingCount).toBe(2)
    })
})

describe('buildProjectAdvisoryExport — muted findings', function () {
    // The regression this module was extracted to fix. A muted finding must not reach the document.
    it('excludes a muted finding from the document', function () {
        scanWith([incoming(), incoming({ advisoryId: 'GHSA-def', packageName: 'express' })])
        insertMute(db, mute())

        const result = exportAt()
        expect(result?.findingCount).toBe(1)
        expect(result?.mutedExcludedCount).toBe(1)
        expect(result?.markdown).not.toContain('GHSA-abc')
        expect(result?.markdown).toContain('GHSA-def')
    })

    it('counts every excluded advisory', function () {
        scanWith([
            incoming(),
            incoming({ advisoryId: 'GHSA-def', packageName: 'express' }),
            incoming({ advisoryId: 'GHSA-ghi', packageName: 'axios' })
        ])
        insertMute(db, mute({ id: 'm1' }))
        insertMute(db, mute({ id: 'm2', advisoryId: 'GHSA-def', packageName: 'express' }))

        const result = exportAt()
        expect(result?.findingCount).toBe(1)
        expect(result?.mutedExcludedCount).toBe(2)
    })

    // A project-scope mute is a blanket accepted-risk decision, so the document empties out rather
    // than silently reverting to per-finding filtering.
    it('excludes everything under a project-scope mute', function () {
        scanWith([incoming(), incoming({ advisoryId: 'GHSA-def', packageName: 'express' })])
        insertMute(db, mute({
            scope: 'project',
            scanner: null,
            ecosystem: null,
            advisoryId: null,
            packageName: null
        }))

        const result = exportAt()
        expect(result?.findingCount).toBe(0)
        expect(result?.mutedExcludedCount).toBe(2)
    })

    // An expired mute is a lapsed decision — the finding comes back rather than staying hidden.
    it('includes a finding whose mute has expired', function () {
        scanWith([incoming()])
        insertMute(db, mute({ expiresAt: T0 + HOUR }))

        const result = exportAt()
        expect(result?.findingCount).toBe(1)
        expect(result?.mutedExcludedCount).toBe(0)
    })

    it('still excludes a finding whose mute has not expired yet', function () {
        scanWith([incoming()])
        insertMute(db, mute({ expiresAt: T0 + 10 * HOUR }))

        const result = exportAt()
        expect(result?.findingCount).toBe(0)
        expect(result?.mutedExcludedCount).toBe(1)
    })

    // The identity tuple includes the package, so muting lodash's copy of an advisory must not
    // silence the same advisory reported against a different package.
    it('does not let a mute leak across packages', function () {
        scanWith([incoming(), incoming({ packageName: 'express' })])
        insertMute(db, mute())

        const result = exportAt()
        expect(result?.findingCount).toBe(1)
        expect(result?.mutedExcludedCount).toBe(1)
        expect(result?.markdown).toContain('express')
    })
})

describe('buildProjectAdvisoryExport — mute accounting across sources', function () {
    const SHARED = 'Prototype pollution in lodash'

    function bothSourcesReportOneVulnerability(): void {
        scanWith([incoming({ advisoryTitle: SHARED })])
        scanWith([incoming({ advisoryId: 'CVE-2026-1', advisoryTitle: SHARED })], 'osv')
    }

    function muteLodash(source: string): void {
        insertMute(db, mute({
            id: 'mute-' + source,
            scanner: source,
            advisoryId: source === 'osv' ? 'CVE-2026-1' : 'GHSA-abc'
        }))
    }

    it('excludes an advisory only when every source reporting it is muted', function () {
        bothSourcesReportOneVulnerability()
        muteLodash('npm-audit')
        muteLodash('osv')

        const result = exportAt()
        expect(result?.findingCount).toBe(0)
        expect(result?.mutedExcludedCount).toBe(1)
    })

    // Muting one source is not a decision to accept the risk everywhere — the other source still
    // reports it, so the work item must survive.
    it('keeps an advisory that is muted on one source but still reported by another', function () {
        bothSourcesReportOneVulnerability()
        muteLodash('npm-audit')

        const result = exportAt()
        expect(result?.findingCount).toBe(1)
        expect(result?.mutedExcludedCount).toBe(0)
    })

    it('counts muted exclusions as advisories rather than rows', function () {
        bothSourcesReportOneVulnerability()
        muteLodash('npm-audit')
        muteLodash('osv')

        // Two rows were withheld, but they were one vulnerability.
        expect(exportAt()?.mutedExcludedCount).toBe(1)
    })
})

describe('buildProjectAdvisoryExport — naming', function () {
    it('prefers the operator-set alias over the discovered name', function () {
        setProjectAlias(db, PROJECT_ID, 'Billing API', T0)
        expect(exportAt()?.projectName).toBe('Billing API')
    })

    // upsertProject deliberately leaves alias out of its conflict set, so a rescan re-discovering the
    // project cannot rename the document out from under the operator who titled it.
    it('keeps the alias across a rediscovery of the project', function () {
        setProjectAlias(db, PROJECT_ID, 'Billing API', T0)
        seedProject({ name: 'app-renamed-on-disk' })
        expect(exportAt()?.projectName).toBe('Billing API')
    })

    it('falls back to the discovered name when there is no alias', function () {
        expect(exportAt()?.projectName).toBe('app')
    })

    it('labels a root-level project with the root alone', function () {
        seedProject({ relPath: '.' })
        upsertRoot(db, { id: ROOT_ID, path: '/repo', label: 'Monorepo', createdAt: T0 })
        expect(exportAt()?.markdown).toContain('Monorepo')
    })

    it('falls back to the root path when the root has no label', function () {
        expect(exportAt()?.markdown).toContain('/repo/app')
    })

    // The 'unknown root' fallback in buildProjectAdvisoryParts is unreachable from here and is left
    // untested deliberately: projects.root_id is a foreign key, so a project pointing at a missing
    // root cannot be inserted at all. It stays in the source as a type-level guard on the optional
    // lookup, not as a case the database can produce.
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
        expect(exportAt()?.markdown).toContain('Do only what the ticket says.')
    })

    it('falls back to the default prompt when none is configured', function () {
        expect(exportAt()?.markdown).toContain('plan mode')
    })

    it('carries the finding details into the rendered document', function () {
        scanWith([incoming()])
        const result = exportAt()
        expect(result?.markdown).toContain('lodash')
        expect(result?.markdown).toContain('4.17.11')
        expect(result?.markdown).toContain('4.17.21')
    })

    // depPaths supersedes the single-path field in the renderer, and a scanner that reports no path at
    // all must not take the document down with it — the vulnerability still has to be listed.
    it('renders a finding that arrived with no dependency path', function () {
        scanWith([incoming({ depPath: [] })])

        const result = exportAt()
        expect(result?.findingCount).toBe(1)
        expect(result?.markdown).toContain('lodash')
    })
})
