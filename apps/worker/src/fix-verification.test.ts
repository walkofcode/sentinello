import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
    listCurrentFindingsForProject,
    listFindingsForProject,
    openDb,
    runMigrations,
    schema,
    upsertProject,
    upsertRegistryPackage,
    upsertRoot,
    type DrizzleDb,
    type SqliteDb
} from '@sentinello/db'
import { buildAdvisoryMarkdown, type Finding, type Project } from '@sentinello/core'
import type { NpmPackageSummary } from '@sentinello/feeds'
import type { FixEvidence, RawFinding, ScannerPlugin, ScanResult } from '@sentinello/scanners'
import { toWebhookVulnerability } from '@sentinello/notifications'
import { toExportFinding } from './notifier'
import { runProjectScanners, type ProjectScanOutcome } from './runner'
import { publishedVersions, registryView, settleFixes } from './fix-verification'
import type { RegistryClient, RegistryEntry } from './registry-client'

// Settlement runs once per project after every source, over every source's evidence. These drive the real
// runner with fake scanners and a fake registry, and read the persisted row back — the row is what every
// surface reads.

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'db', 'drizzle')
const ROOT_ID = 'root-1'
const PROJECT_ID = 'project-1'
const T0 = Date.UTC(2026, 9, 3)

let db: DrizzleDb
let sqlite: SqliteDb
let dir: string

function project(): Project {
    return {
        id: PROJECT_ID, rootId: ROOT_ID, relPath: 'app', name: 'app', alias: null, packageManager: 'npm', nvmrcVersion: null,
        gitBranch: null, ecosystems: ['npm'], muted: false, tags: [], createdAt: T0, updatedAt: T0
    }
}

function summary(name: string, versions: string[], deprecated: string[] = []): NpmPackageSummary {
    const out: NpmPackageSummary['versions'] = {}
    for (const v of versions) out[v] = { publishedAt: T0, deprecated: deprecated.includes(v) ? 'old' : null, edges: null }
    return { v: 1, name, latest: versions[versions.length - 1] ?? null, modified: T0, maintainers: 1, repository: null, versions: out, edges: [] }
}

// A registry answering from a fixed table, counting what it was asked.
function fakeRegistry(entries: Record<string, RegistryEntry>): RegistryClient & { asked: string[][] } {
    const asked: string[][] = []
    return {
        asked,
        lookup: async function lookup(names) {
            asked.push([...names])
            const out = new Map<string, RegistryEntry>()
            for (const name of names) {
                const entry = entries[name]
                if (entry) out.set(name, entry)
            }
            return out
        },
        weeklyDownloads: async function weeklyDownloads(names) {
            return new Map(names.map(function none(n) { return [n, null] as const }))
        }
    }
}

function evidence(source: string, ranges: string, installed = '1.0.0', statedFix: string | null = null): FixEvidence {
    return { source, installed: [installed], affected: { ranges, exact: [], complete: true }, patched: null, statedFix, fixViaParent: false }
}

function raw(source: string, advisoryId: string, ranges: string, overrides: Partial<RawFinding> = {}): RawFinding {
    const stated = ranges.startsWith('<') ? ranges.slice(1) : null
    return {
        advisoryId,
        aliases: ['GHSA-pkg-1'],
        advisoryTitle: 'A flaw',
        advisoryUrl: null,
        packageName: 'pkg',
        ecosystem: 'npm',
        installedVersion: '1.0.0',
        vulnerableRange: ranges,
        severity: 'high',
        fixAvailable: stated !== null,
        fixVersion: stated,
        fixInputs: evidence(source, ranges, '1.0.0', stated),
        depPath: ['pkg'],
        isProd: true,
        isDev: false,
        ...overrides
    }
}

function scanner(name: string, findings: RawFinding[]): ScannerPlugin {
    return {
        name,
        scan: async function scan(): Promise<ScanResult> {
            return { status: 'ok', reasonCode: 'ok', findings, rawJson: '{}', errorText: null, durationMs: 1 }
        }
    }
}

const PKG_RELEASES: RegistryEntry = { status: 'ok', summary: summary('pkg', ['1.0.0', '1.1.0', '1.1.6', '1.2.0']), checkedAt: T0 - 1000, origin: 'fetched' }

async function scan(scanners: ScannerPlugin[], registry: RegistryClient, notified: ProjectScanOutcome[] = []): Promise<ProjectScanOutcome[]> {
    return await runProjectScanners({
        db,
        scanners,
        project: project(),
        registry,
        notify: async function record(outcome) { notified.push(structuredClone(outcome)) }
    })
}

function activeRows() {
    return db.select().from(schema.findings).all().filter(function open(r) { return r.resolvedAt === null })
}

beforeEach(async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-fixver-'))
    const opened = openDb({ dbPath: join(dir, 'test.sqlite') })
    db = opened.db
    sqlite = opened.sqlite
    runMigrations(db, { migrationsFolder: MIGRATIONS })
    upsertRoot(db, { id: ROOT_ID, path: join(dir, 'repo'), label: null, createdAt: T0 })
    upsertProject(db, project())
})

afterEach(async function teardown() {
    sqlite.close()
    await rm(dir, { recursive: true, force: true })
})

describe('settlement over every source', function () {
    // npm-audit says `<1.1.0`, OSV says `<1.2.0`: 1.1.0 clears only one of them.
    it('settles outside both sources’ affected sets', async function () {
        await scan([scanner('npm-audit', [raw('npm-audit', '1001', '<1.1.0')]), scanner('osv', [raw('osv', 'GHSA-pkg-1', '<1.2.0')])], fakeRegistry({ pkg: PKG_RELEASES }))
        const rows = activeRows()
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({ source: 'npm-audit', fixStatus: 'released', fixVersion: '1.2.0', fixAvailable: true })
        const check = JSON.parse(rows[0]?.fixCheckJson as string)
        expect(check.sources).toEqual([
            { source: 'npm-audit', installed: ['1.0.0'], affected: '<1.1.0', patched: null, statedFix: '1.1.0', noPatchedSentinel: false },
            { source: 'osv', installed: ['1.0.0'], affected: '<1.2.0', patched: null, statedFix: '1.2.0', noPatchedSentinel: false }
        ])
        expect(check).toMatchObject({ registry: 'ok', packageDataAsOf: T0 - 1000, unevaluable: null })
    })

    it('reaches the same fix with the scanners in the reverse order', async function () {
        await scan([scanner('osv', [raw('osv', 'GHSA-pkg-1', '<1.2.0')]), scanner('npm-audit', [raw('npm-audit', '1001', '<1.1.0')])], fakeRegistry({ pkg: PKG_RELEASES }))
        expect(activeRows()[0]).toMatchObject({ source: 'osv', fixStatus: 'released', fixVersion: '1.2.0' })
    })

    // A second installed copy from the same source is a corroboration, not a row — but its version is
    // still a floor: nobody is told to downgrade it.
    it('never settles below a second installed copy', async function () {
        const second = raw('osv', 'GHSA-pkg-1', '<1.1.0', { installedVersion: '1.1.5', fixInputs: evidence('osv', '<1.1.0', '1.1.5', '1.1.0') })
        await scan([scanner('osv', [raw('osv', 'GHSA-pkg-1', '<1.1.0'), second])], fakeRegistry({ pkg: PKG_RELEASES }))
        expect(activeRows()[0]).toMatchObject({ fixStatus: 'released', fixVersion: '1.1.6' })
    })

    it('hands the notifier exactly what was persisted', async function () {
        const notified: ProjectScanOutcome[] = []
        await scan([scanner('npm-audit', [raw('npm-audit', '1001', '<1.1.0')])], fakeRegistry({ pkg: PKG_RELEASES }), notified)
        const [persisted] = listFindingsForProject(db, PROJECT_ID)
        const handed = notified[0]?.findings[0] as Finding
        expect(handed.fixStatus).toBe('released')
        expect({ fixStatus: handed.fixStatus, fixVersion: handed.fixVersion, fixAvailable: handed.fixAvailable, fixCheck: handed.fixCheck })
            .toEqual({ fixStatus: persisted?.fixStatus, fixVersion: persisted?.fixVersion, fixAvailable: persisted?.fixAvailable, fixCheck: persisted?.fixCheck })
    })

    it('settles none_released when no published version clears the range, and keeps the finding', async function () {
        const braces = raw('osv', 'GHSA-vfj7', '<=3.0.3', { packageName: 'braces', installedVersion: '3.0.3', fixInputs: evidence('osv', '<=3.0.3', '3.0.3') })
        const registry = fakeRegistry({ braces: { status: 'ok', summary: summary('braces', ['3.0.2', '3.0.3']), checkedAt: T0, origin: 'cache' } })
        await scan([scanner('osv', [braces])], registry)
        expect(activeRows()[0]).toMatchObject({ packageName: 'braces', severity: 'high', fixStatus: 'none_released', fixVersion: null, fixAvailable: false })
    })
})

// The way out is written by the same project pass and handed to the notifier with the settled fix, so the
// row, the message and the advisory all say the same thing — and it goes away with the status.
describe('the way out travels with the finding', function () {
    const braces = raw('osv', 'GHSA-vfj7', '<=3.0.3', { packageName: 'braces', installedVersion: '3.0.3', fixInputs: evidence('osv', '<=3.0.3', '3.0.3') })

    it('is on the row, the notified finding, the webhook payload and the export while none_released, and gone once a fix is released', async function () {
        const first: ProjectScanOutcome[] = []
        await scan([scanner('osv', [braces])], fakeRegistry({ braces: { status: 'ok', summary: summary('braces', ['3.0.2', '3.0.3']), checkedAt: T0, origin: 'cache' } }), first)
        const [row] = listFindingsForProject(db, PROJECT_ID)
        expect(row?.fixStatus).toBe('none_released')
        expect(row?.remediation).toMatchObject({ v: 1, package: 'braces', devOnly: null, chains: [{ verdict: { kind: 'unknown', reason: 'no lockfile dependency graph' } }] })
        const handed = first[0]?.findings[0] as Finding
        expect(handed.remediation).toEqual(row?.remediation)
        expect(toWebhookVulnerability(handed).remediation).toEqual(row?.remediation)
        const exported = buildAdvisoryMarkdown({ scope: { kind: 'project', projectName: 'app', projectPath: 'app', depType: 'all' }, prompt: '', findings: [toExportFinding(handed)], generatedAt: T0 })
        expect(exported).toContain('- **Way out:**')

        const second: ProjectScanOutcome[] = []
        await scan([scanner('osv', [braces])], fakeRegistry({ braces: { status: 'ok', summary: summary('braces', ['3.0.3', '3.0.4']), checkedAt: T0, origin: 'fetched' } }), second)
        expect(activeRows()[0]).toMatchObject({ fixStatus: 'released', fixVersion: '3.0.4', remediationJson: null })
        const again = second[0]?.findings[0] as Finding
        expect(again.remediation).toBeNull()
        expect(toWebhookVulnerability(again).remediation).toBeNull()
        expect(buildAdvisoryMarkdown({ scope: { kind: 'project', projectName: 'app', projectPath: 'app', depType: 'all' }, prompt: '', findings: [toExportFinding(again)], generatedAt: T0 })).not.toContain('Way out')
    })

    it('computes one way out for rows with the same evidence, and none for other ecosystems', async function () {
        const pypi = raw('osv', 'PYSEC-1', '<=1.0.0', { packageName: 'pkg', ecosystem: 'PyPI', fixInputs: evidence('osv', '<=1.0.0') })
        const sameEvidence = raw('osv', 'GHSA-other', '<=3.0.3', { aliases: [], packageName: 'braces', installedVersion: '3.0.3', fixInputs: evidence('osv', '<=3.0.3', '3.0.3') })
        const registry = fakeRegistry({ braces: { status: 'ok', summary: summary('braces', ['3.0.3']), checkedAt: T0, origin: 'cache' } })
        await scan([scanner('osv', [{ ...braces, aliases: [] }, sameEvidence, pypi])], registry)
        const rows = activeRows()
        const bracesRows = rows.filter(function b(r) { return r.packageName === 'braces' })
        expect(bracesRows).toHaveLength(2)
        expect(bracesRows[0]?.remediationJson).not.toBeNull()
        expect(bracesRows[0]?.remediationJson).toBe(bracesRows[1]?.remediationJson)
        expect(rows.find(function p(r) { return r.ecosystem === 'PyPI' })?.remediationJson).toBeNull()
    })

    it('never fails the scan when the way out cannot be built', async function () {
        const notified: ProjectScanOutcome[] = []
        const registry = fakeRegistry({ braces: { status: 'ok', summary: summary('braces', ['3.0.3']), checkedAt: T0, origin: 'cache' } })
        registry.weeklyDownloads = async function broken() { throw new Error('database is locked') }
        await scan([scanner('osv', [braces])], registry, notified)
        expect(activeRows()[0]).toMatchObject({ fixStatus: 'none_released', remediationJson: null })
        expect(notified[0]?.findings[0]).toMatchObject({ fixStatus: 'none_released', remediation: null })
    })
})

describe('settlement without a registry answer', function () {
    it('is unverified with the stated fix when the registry is unreachable — never none_released', async function () {
        await scan([scanner('osv', [raw('osv', 'GHSA-pkg-1', '<1.1.0')])], fakeRegistry({ pkg: { status: 'error', reason: 'ECONNREFUSED' } }))
        const row = activeRows()[0]
        expect(row).toMatchObject({ fixStatus: 'unverified', fixVersion: '1.1.0', fixAvailable: true })
        expect(JSON.parse(row?.fixCheckJson as string)).toMatchObject({ registry: 'error', packageDataAsOf: null })
    })

    it('is unverified, not_found, when the registry has no such package', async function () {
        await scan([scanner('osv', [raw('osv', 'GHSA-pkg-1', '<1.1.0')])], fakeRegistry({ pkg: { status: 'not_found', checkedAt: T0, origin: 'fetched' } }))
        expect(JSON.parse(activeRows()[0]?.fixCheckJson as string)).toMatchObject({ registry: 'not_found', packageDataAsOf: T0 })
    })

    it('treats a package the lookup did not answer for as an error', async function () {
        await scan([scanner('osv', [raw('osv', 'GHSA-pkg-1', '<1.1.0')])], fakeRegistry({}))
        expect(JSON.parse(activeRows()[0]?.fixCheckJson as string)).toMatchObject({ registry: 'error' })
    })

    it('marks stale data as stale, keeping the data date', async function () {
        const stale: RegistryEntry = { status: 'stale', summary: summary('pkg', ['1.0.0', '1.1.0']), checkedAt: T0 - 86_400_000 * 3, reason: 'HTTP 503' }
        await scan([scanner('osv', [raw('osv', 'GHSA-pkg-1', '<1.1.0')])], fakeRegistry({ pkg: stale }))
        const row = activeRows()[0]
        expect(row).toMatchObject({ fixStatus: 'released', fixVersion: '1.1.0' })
        expect(JSON.parse(row?.fixCheckJson as string)).toMatchObject({ registry: 'stale', packageDataAsOf: T0 - 86_400_000 * 3 })
    })

    // D1: only npm is checked against a registry. Other ecosystems are never sent to it.
    it('skips the registry for an ecosystem it does not cover', async function () {
        const registry = fakeRegistry({})
        const pypi = raw('osv', 'PYSEC-1', '<2.0.0', { ecosystem: 'PyPI', packageName: 'requests', aliases: [] })
        await scan([scanner('osv', [pypi])], registry)
        expect(registry.asked).toEqual([])
        expect(activeRows()[0]).toMatchObject({ fixStatus: 'unverified', fixVersion: '2.0.0' })
        expect(JSON.parse(activeRows()[0]?.fixCheckJson as string)).toMatchObject({ registry: 'skipped' })
    })

    // A broken settlement leaves the rows unsettled ("rescan pending") and the scan still notifies.
    it('never fails the scan when settlement throws', async function () {
        const broken: RegistryClient = {
            lookup: async function lookup() { throw new Error('database is locked') },
            weeklyDownloads: async function weeklyDownloads() { throw new Error('database is locked') }
        }
        const notified: ProjectScanOutcome[] = []
        await scan([scanner('osv', [raw('osv', 'GHSA-pkg-1', '<1.1.0')])], broken, notified)
        expect(activeRows()[0]).toMatchObject({ fixStatus: null, fixCheckJson: null })
        expect(notified).toHaveLength(1)
        expect(notified[0]?.findings[0]).toMatchObject({ fixStatus: 'unverified', fixVersion: null, fixCheck: null })
    })
})

describe('reading a settled or unsettled row', function () {
    // A row written before 3.7.0 holds braces 3.0.4, a version nobody published. It must never be shown,
    // nor attributed to the advisory, until a rescan settles it.
    it('withholds a pre-settlement fix and renders "rescan pending"', async function () {
        await scan([scanner('npm-audit', [raw('npm-audit', '1001', '<1.1.0')])], fakeRegistry({ pkg: PKG_RELEASES }))
        db.update(schema.findings).set({ fixStatus: null, fixCheckJson: null, fixVersion: '3.0.4', fixAvailable: true }).run()
        const [row] = listCurrentFindingsForProject(db, PROJECT_ID, T0)
        expect(row).toMatchObject({ fixStatus: 'unverified', fixVersion: null, fixAvailable: false, fixCheck: null })
        const md = buildAdvisoryMarkdown({
            scope: { kind: 'project', projectName: 'app', projectPath: '/app', depType: 'all' },
            prompt: '',
            findings: [{ ...(row as NonNullable<typeof row>), depPath: [], severity: 'high' }],
            generatedAt: T0
        })
        expect(md).toContain('fix not re-checked yet — rescan pending')
        expect(md).not.toContain('3.0.4')
    })

    // (npm-audit rows: the read model shows only enabled source cells, and npm-audit is on by default.)
    // The finding's "checked" date comes from its own snapshot, never from today's cache row.
    it('keeps the rendered check date when the cache is refreshed after the scan', async function () {
        await scan([scanner('npm-audit', [raw('npm-audit', '1001', '<1.1.0')])], fakeRegistry({ pkg: PKG_RELEASES }))
        const before = listCurrentFindingsForProject(db, PROJECT_ID, T0)[0]?.fixCheck
        upsertRegistryPackage(db, { ecosystem: 'npm', name: 'pkg', status: 'ok', summaryJson: JSON.stringify(summary('pkg', ['9.9.9'])), checkedAt: T0 + 86_400_000 })
        const after = listCurrentFindingsForProject(db, PROJECT_ID, T0)[0]?.fixCheck
        expect(after).toEqual(before)
        expect(after?.packageDataAsOf).toBe(T0 - 1000)
    })

    it('rewrites the verdict on the next scan rather than keeping the last one', async function () {
        await scan([scanner('npm-audit', [raw('npm-audit', '1001', '<1.1.0')])], fakeRegistry({ pkg: PKG_RELEASES }))
        await scan([scanner('npm-audit', [raw('npm-audit', '1001', '<1.1.0')])], fakeRegistry({ pkg: { status: 'error', reason: 'down' } }))
        const rows = listFindingsForProject(db, PROJECT_ID)
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({ fixStatus: 'unverified', fixVersion: '1.1.0' })
    })
})

describe('settleFixes / registryView', function () {
    it('does nothing for a scan with no findings', async function () {
        const registry = fakeRegistry({})
        await settleFixes({ db, findings: [], evidence: new Map(), registry, checkedAt: T0 })
        expect(registry.asked).toEqual([])
    })

    it('settles a finding with no recorded evidence as unverified, never as a verdict', async function () {
        await scan([scanner('osv', [raw('osv', 'GHSA-pkg-1', '<1.1.0')])], fakeRegistry({ pkg: PKG_RELEASES }))
        const findings = listFindingsForProject(db, PROJECT_ID)
        await settleFixes({ db, findings, evidence: new Map(), registry: fakeRegistry({ pkg: PKG_RELEASES }), checkedAt: T0 })
        expect(findings[0]).toMatchObject({ fixStatus: 'unverified', fixVersion: null })
        expect(findings[0]?.fixCheck?.unevaluable).toBe('no_evidence')
    })

    it('maps every registry answer onto what settlement may conclude from it', function () {
        expect(registryView(undefined)).toEqual({ status: 'error' })
        expect(registryView({ status: 'error', reason: 'x' })).toEqual({ status: 'error' })
        expect(registryView({ status: 'not_found', checkedAt: 5, origin: 'cache' })).toEqual({ status: 'not_found', dataAsOf: 5 })
        expect(registryView({ status: 'ok', summary: summary('p', ['1.0.0'], ['1.0.0']), checkedAt: 7, origin: 'cache' }))
            .toEqual({ status: 'ok', published: [{ version: '1.0.0', deprecated: true }], dataAsOf: 7 })
        expect(publishedVersions(summary('p', ['1.0.0', '2.0.0']))).toEqual([
            { version: '1.0.0', deprecated: false },
            { version: '2.0.0', deprecated: false }
        ])
    })
})
