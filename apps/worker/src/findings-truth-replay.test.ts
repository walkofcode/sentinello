import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sourceEnabledKey, type EcosystemId, type NotificationTarget, type OsvAdvisoryRow, type Severity, type SourceId } from '@sentinello/core'
import {
    getDashboardSummary,
    getProjectById,
    getProjectScanState,
    insertNotificationTarget,
    listCurrentFindingsForProject,
    listEventsForProject,
    listLibraries,
    listProjectCatalog,
    listProjects,
    projectId,
    setConfigValue,
    upsertRoot,
    type Root
} from '@sentinello/db'
import { normalizeOsvRecord } from '@sentinello/feeds'
import { createGemnasiumScanner, createOsvScanner, stampWithdrawnByPackage, type GemnasiumAdvisory, type OsvAdvisory, type ScannerPlugin } from '@sentinello/scanners'
import type { RegistryClients } from '@sentinello/fixes'
import { closeWorkerTestDb, makeTree, openWorkerTestDb, T0, type WorkerTestDb } from './worker-test-db.fixture'

// Milestone 1's smoke: frozen advisories through the real normalizer, discovery, resolvers, scanners, runner and
// notifier, on trees built at runtime. Every corrected fact is read back from what the portal reads, and no alert
// is recorded for the correction. Only the transports are fakes: no registry and no sender leaves this process.

const { discoverProjects } = await import('./discovery')
const { runProjectScanners } = await import('./runner')

const LATER = T0 + 1000

let handle: WorkerTestDb
let osvRows: OsvAdvisoryRow[]
let gemnasiumRows: GemnasiumAdvisory[]
let osvBroken: boolean
let gemnasiumBroken: boolean
const send = vi.fn(async function delivered() { return { ok: true as const } })

function enable(source: SourceId, ecosystem: EcosystemId, on = true): void {
    setConfigValue(handle.db, sourceEnabledKey(source, ecosystem), on)
}

function osvScanner(): ScannerPlugin {
    const scanner = createOsvScanner({
        lookup: function lookup(ecosystem, names) {
            const out = new Map<string, OsvAdvisory[]>()
            for (const row of osvRows) {
                if (row.ecosystem !== ecosystem || !names.includes(row.packageName)) continue
                out.set(row.packageName, [...(out.get(row.packageName) ?? []), row])
            }
            return out
        },
        isSeeded: function seeded() { return true },
        isEnabled: function enabled() { return true }
    })
    return {
        ...scanner,
        scan: async function scan(path, ctx) {
            if (osvBroken) return { status: 'error', reasonCode: 'osv_db_unavailable', findings: [], rawJson: '', errorText: 'cache gone', durationMs: 1 }
            return await scanner.scan(path, ctx)
        }
    }
}

function gemnasiumScanner(): ScannerPlugin {
    const scanner = createGemnasiumScanner({
        lookup: function lookup(ecosystem, names) {
            const byPackage = new Map<string, GemnasiumAdvisory[]>()
            for (const row of gemnasiumRows) {
                const key = (row as GemnasiumAdvisory & { packageName: string }).packageName
                if (names.includes(key)) byPackage.set(key, [...(byPackage.get(key) ?? []), row])
            }
            const links = new Map<string, OsvAdvisoryRow[]>()
            for (const row of osvRows) {
                if (row.ecosystem === ecosystem && names.includes(row.packageName)) links.set(row.packageName, [...(links.get(row.packageName) ?? []), row])
            }
            return stampWithdrawnByPackage(byPackage, links)
        },
        isSeeded: function seeded() { return true },
        isEnabled: function enabled() { return true },
        withdrawalEvidenceReady: function ready() { return true }
    })
    return {
        ...scanner,
        scan: async function scan(path, ctx) {
            if (gemnasiumBroken) return { status: 'error', reasonCode: 'gemnasium_db_unavailable', findings: [], rawJson: '', errorText: 'cache gone', durationMs: 1 }
            return await scanner.scan(path, ctx)
        }
    }
}

// An npm-audit cell that keeps failing: enabled, attempted, and answering nothing.
const FAILING_NPM_AUDIT: ScannerPlugin = {
    name: 'npm-audit',
    scan: async function fail() {
        return { status: 'error', reasonCode: 'audit_spawn_error', findings: [], rawJson: '', errorText: 'npm is gone', durationMs: 1 }
    }
}

function gemnasiumRow(packageName: string, advisoryId: string, severity: Severity | null, aliases: string[], ranges: GemnasiumAdvisory['ranges'] = [{ introduced: '0', fixed: '9.9.9', lastAffected: null }]): GemnasiumAdvisory {
    return { packageName, advisoryId, aliases, ranges, versions: [], severity, summary: advisoryId, url: 'https://gemnasium.example/' + advisoryId, withdrawn: null } as GemnasiumAdvisory
}

async function tree(spec: Record<string, string>, excludes: string[] = []): Promise<Root> {
    const path = await makeTree(handle.dir, 'code', spec)
    const root = { id: 'code', path, label: null, createdAt: T0 }
    upsertRoot(handle.db, root)
    discoverProjects({ db: handle.db, roots: [root], globalIgnore: excludes, at: T0 })
    return root
}

async function scanAll(scanners: ScannerPlugin[], registry: RegistryClients = {}): Promise<void> {
    for (const project of listProjects(handle.db)) {
        await runProjectScanners({ db: handle.db, scanners, project, registry, send })
    }
}

function target(id: string, severityFilter: NotificationTarget['severityFilter']): void {
    insertNotificationTarget(handle.db, {
        id,
        kind: 'slack',
        config: { webhookUrl: 'https://hooks.example/' + id },
        severityFilter,
        envFilter: 'all',
        enabled: true,
        createdAt: T0 - 1,
        rootIds: [],
        projectIds: [],
        sourceScope: { mode: 'all', cells: [] }
    })
}

// Messages about findings. A failing source's scan failure is told too, whatever a target's severity filter:
// that is an operational signal, and not what these replays are about.
function sentTo(id: string): number {
    return send.mock.calls.filter(function aboutFindings(call) {
        const [to, message] = call as unknown as [NotificationTarget, { title: string }]
        return to.id === id && message.title.includes('found vulnerabilities')
    }).length
}

function rows(project = '.') {
    return listCurrentFindingsForProject(handle.db, projectId('code', project), T0 + 10_000)
}

const PACKAGE_JSON = JSON.stringify({ name: 'app', dependencies: { lodash: '4.17.11' } })
const NPM_LOCK = JSON.stringify({ name: 'app', lockfileVersion: 3, packages: { '': { name: 'app', dependencies: { lodash: '4.17.11' } }, 'node_modules/lodash': { version: '4.17.11' } } })

function osvRecord(id: string, packageName: string, ecosystem: string, fields: Record<string, unknown> = {}, affected: Record<string, unknown> = {}): OsvAdvisoryRow[] {
    return normalizeOsvRecord({
        id,
        summary: id + ' summary',
        references: [{ type: 'ADVISORY', url: 'https://osv.example/' + id }],
        affected: [{ package: { name: packageName, ecosystem }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '9.9.9' }] }], ...affected }],
        ...fields
    }, ecosystem)
}

beforeEach(async function setup() {
    handle = await openWorkerTestDb('worker-findings-truth')
    vi.spyOn(console, 'log').mockImplementation(function silence() {})
    vi.spyOn(console, 'error').mockImplementation(function silence() {})
    send.mockClear()
    osvRows = []
    gemnasiumRows = []
    osvBroken = false
    gemnasiumBroken = false
    enable('npm-audit', 'npm', false)
})

afterEach(async function teardown() {
    vi.restoreAllMocks()
    await closeWorkerTestDb(handle)
})

describe('the corrected facts, through the real runner', function () {
    it('reads a bun.lock: findings appear, npm audit is not expected, and the project is fully scanned', async function () {
        enable('npm-audit', 'npm')
        enable('osv', 'npm')
        osvRows = osvRecord('GHSA-bunn-bunn-bunn', 'lodash', 'npm', { database_specific: { severity: 'HIGH' } })
        const attempted = vi.fn(async function neverRuns() { return { status: 'ok' as const, reasonCode: 'ok' as const, findings: [], rawJson: '', errorText: null, durationMs: 1 } })
        await tree({
            'package.json': PACKAGE_JSON,
            'bun.lock': '{\n  "lockfileVersion": 1,\n  "workspaces": { "": { "name": "app", "dependencies": { "lodash": "4.17.11" }, }, },\n  "packages": {\n    "lodash": ["lodash@4.17.11", "", {}, "sha512-x"],\n  },\n}\n'
        })
        await scanAll([{ name: 'npm-audit', scan: attempted }, osvScanner()])
        expect(attempted).not.toHaveBeenCalled()
        expect(getProjectById(handle.db, projectId('code', '.'))?.packageManager).toBe('bun')
        expect(rows().map(function id(r) { return r.advisoryId })).toEqual(['GHSA-bunn-bunn-bunn'])
        expect(rows()[0]?.isProd).toBe(true)
        expect(getProjectScanState(handle.db, projectId('code', '.'))).toEqual({ state: 'scanned', reasons: [] })
    })

    it('says bun.lockb is unsupported, and a lockfile v1 is unsupported rather than missing', async function () {
        enable('osv', 'npm')
        await tree({
            'binary/package.json': PACKAGE_JSON,
            'binary/bun.lockb': 'not text',
            'old/package.json': PACKAGE_JSON,
            'old/package-lock.json': JSON.stringify({ lockfileVersion: 1, dependencies: { lodash: { version: '4.17.11' } } })
        })
        await scanAll([osvScanner()])
        for (const project of ['binary', 'old']) {
            expect(getProjectScanState(handle.db, projectId('code', project)).reasons).toContainEqual(expect.objectContaining({ reasonCode: 'unsupported_lockfile', side: 'project' }))
        }
    })

    it('counts a crate a sibling Cargo.lock lists as covered, and keeps one no lock lists as no_lockfile', async function () {
        enable('osv', 'crates.io')
        await tree({
            'package.json': PACKAGE_JSON,
            'package-lock.json': NPM_LOCK,
            'apps/desktop/Cargo.toml': '[package]\nname = "desktop"\nversion = "0.1.0"\n',
            'apps/desktop/Cargo.lock': 'version = 3\n\n[[package]]\nname = "desktop"\nversion = "0.1.0"\n\n[[package]]\nname = "gx-core"\nversion = "0.1.0"\n',
            'packages/gx-core/Cargo.toml': '[package]\nname = "gx-core"\nversion = "0.1.0"\n',
            'packages/orphan/Cargo.toml': '[package]\nname = "orphan"\nversion = "0.1.0"\n'
        })
        const manifests = getProjectById(handle.db, projectId('code', '.'))?.manifests.map(function path(m) { return m.path })
        expect(manifests).toContain('apps/desktop/Cargo.lock')
        expect(manifests).not.toContain('packages/gx-core/Cargo.toml')
        expect(manifests).toContain('packages/orphan/Cargo.toml')
    })

    it('scores a CVSS vector, reads the rest as unrated, and counts a notice nowhere', async function () {
        enable('osv', 'crates.io')
        target('all', ['critical', 'high', 'moderate', 'low', 'info'])
        osvRows = [
            ...osvRecord('RUSTSEC-2026-0001', 'scored', 'crates.io', { severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H' }] }),
            ...osvRecord('RUSTSEC-2026-0002', 'ungraded', 'crates.io'),
            ...osvRecord('RUSTSEC-2026-0003', 'v4only', 'crates.io', { severity: [{ type: 'CVSS_V4', score: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N' }] }),
            ...osvRecord('RUSTSEC-2026-0004', 'abandoned', 'crates.io', {}, { database_specific: { informational: 'unmaintained' } })
        ]
        await tree({
            'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\n',
            'Cargo.lock': ['scored', 'ungraded', 'v4only', 'abandoned'].map(function lock(name) { return '[[package]]\nname = "' + name + '"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n' }).join('\n') + '\n[[package]]\nname = "app"\nversion = "0.1.0"\n'
        })
        await scanAll([osvScanner()])
        const byPackage = new Map(rows().map(function pair(r) { return [r.packageName, r] }))
        expect(byPackage.get('scored')?.severity).toBe('high')
        expect(byPackage.get('ungraded')?.severity).toBe('unrated')
        expect(byPackage.get('v4only')?.severity).toBe('unrated')
        expect(byPackage.get('abandoned')?.noticeKind).toBe('unmaintained')
        const summary = getDashboardSummary(handle.db, T0 + 10_000)
        expect(summary.severityCounts).toEqual({ critical: 0, high: 1, moderate: 0, unrated: 2, low: 0, info: 0 })
        expect(listProjectCatalog(handle.db, T0 + 10_000)[0]?.severityCounts.unrated).toBe(2)
        const abandoned = listLibraries(handle.db, T0 + 10_000).find(function named(l) { return l.packageName === 'abandoned' })
        expect(abandoned).toMatchObject({ distinctAdvisories: 0, distinctProjects: 0, distinctNotices: 1, severities: [] })
        // A new project's findings are news, a notice is not: its package has no event, and no message names it.
        expect(listEventsForProject(handle.db, projectId('code', '.')).map(function pkg(e) { return e.packageName }).sort()).toEqual(['scored', 'ungraded', 'v4only'])
        expect(JSON.stringify(send.mock.calls)).not.toContain('abandoned')
    })

    it('clears a gemnasium match OSV does not contain, keeps the one it does, and leaves one OSV never heard of', async function () {
        enable('gemnasium', 'Go')
        const module = 'github.com/example/renumbered'
        osvRows = [
            ...osvRecord('GHSA-clrd-clrd-clrd', module, 'Go', { aliases: ['CVE-2020-0001'] }, { ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '0.9.0' }] }] }),
            ...osvRecord('GHSA-stil-stil-stil', module, 'Go', { aliases: ['CVE-2020-0002'] })
        ]
        gemnasiumRows = [
            gemnasiumRow(module, 'CVE-2020-0001', 'high', ['GHSA-clrd-clrd-clrd'], [{ introduced: '0', fixed: null, lastAffected: '7.0.0' }]),
            gemnasiumRow(module, 'CVE-2020-0002', 'high', ['GHSA-stil-stil-stil']),
            gemnasiumRow(module, 'CVE-2020-0003', 'high', [])
        ]
        await tree({ 'go.mod': 'module example.com/app\n\ngo 1.22\n\nrequire ' + module + ' v0.14.0\n' })
        await scanAll([gemnasiumScanner()])
        expect(rows().map(function id(r) { return r.advisoryId }).sort()).toEqual(['CVE-2020-0002', 'CVE-2020-0003'])
    })

    it('keeps two advisories sharing a generic title apart', async function () {
        enable('osv', 'npm')
        osvRows = [
            ...osvRecord('GHSA-aaaa-aaaa-aaaa', 'lodash', 'npm', { aliases: ['CVE-2026-0001'], summary: 'Improper Limitation of a Pathname', database_specific: { severity: 'HIGH' } }),
            ...osvRecord('GHSA-bbbb-bbbb-bbbb', 'lodash', 'npm', { aliases: ['CVE-2026-0002'], summary: 'Improper Limitation of a Pathname', database_specific: { severity: 'HIGH' } })
        ]
        await tree({ 'package.json': PACKAGE_JSON, 'package-lock.json': NPM_LOCK })
        await scanAll([osvScanner()])
        expect(new Set(rows().map(function key(r) { return r.advisoryKey }))).toEqual(new Set(['ghsa-aaaa-aaaa-aaaa', 'ghsa-bbbb-bbbb-bbbb']))
        expect(getDashboardSummary(handle.db, T0 + 10_000).severityCounts.high).toBe(2)
    })

    it('names an untagged commit as such, and prefers a tag when one qualifies', async function () {
        enable('osv', 'Go')
        const module = 'golang.org/x/example'
        osvRows = [...osvRecord('GO-2026-0001', module, 'Go', {}, { ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '0.58.1-0.20261009181718-2f1f834330b2' }] }] })]
        await tree({ 'go.mod': 'module example.com/app\n\ngo 1.22\n\nrequire ' + module + ' v0.50.0\n' })
        function goRegistry(versions: string[]): RegistryClients {
            return {
                Go: {
                    published: async function published(stated) {
                        const list = versions.map(function release(version) { return { version, deprecated: false } })
                        return new Map([...stated.keys()].map(function view(name) { return [name, { status: 'ok' as const, published: list, dataAsOf: T0 }] as const }))
                    }
                }
            }
        }
        await scanAll([osvScanner()], goRegistry(['v0.58.1-0.20261009181718-2f1f834330b2']))
        expect(rows()[0]).toMatchObject({ fixStatus: 'released', fixVersion: 'v0.58.1-0.20261009181718-2f1f834330b2' })
        await scanAll([osvScanner()], goRegistry(['v0.58.1-0.20261009181718-2f1f834330b2', 'v0.59.0']))
        expect(rows()[0]).toMatchObject({ fixStatus: 'released', fixVersion: 'v0.59.0' })
    })

    it('removes what lived only under an excluded path, narrows a row in both, and sends nothing', async function () {
        enable('osv', 'crates.io')
        target('all', ['critical', 'high', 'moderate', 'low', 'info'])
        const lock = function lockOf(...names: string[]): string {
            return names.map(function entry(name) { return '[[package]]\nname = "' + name + '"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n' }).join('\n')
        }
        osvRows = [...osvRecord('RUSTSEC-2026-0010', 'both', 'crates.io', { database_specific: { severity: 'HIGH' } }), ...osvRecord('RUSTSEC-2026-0011', 'vendored', 'crates.io', { database_specific: { severity: 'HIGH' } })]
        const root = await tree({
            'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\n',
            'Cargo.lock': lock('both'),
            '.dependencies/zed/Cargo.toml': '[package]\nname = "zed"\nversion = "0.1.0"\n',
            '.dependencies/zed/Cargo.lock': lock('both', 'vendored'),
            '.mongodb/mongosh/snippets/package.json': PACKAGE_JSON,
            '.mongodb/mongosh/snippets/package-lock.json': NPM_LOCK
        })
        enable('osv', 'npm')
        osvRows = [...osvRows, ...osvRecord('GHSA-mong-mong-mong', 'lodash', 'npm', { database_specific: { severity: 'LOW' } })]
        await scanAll([osvScanner()])
        expect(rows().map(function pkg(r) { return r.packageName }).sort()).toEqual(['both', 'vendored'])
        expect(rows().find(function named(r) { return r.packageName === 'both' })?.installations).toHaveLength(2)
        expect(listProjects(handle.db)).toHaveLength(2)
        send.mockClear()
        // The same setting Settings → Advanced writes, which discovery and the runner's re-read both honour.
        const excludes = ['.dependencies', '.mongodb/mongosh/snippets']
        setConfigValue(handle.db, 'globalIgnore', excludes)
        discoverProjects({ db: handle.db, roots: [root], globalIgnore: excludes, at: LATER })
        await scanAll([osvScanner()])
        expect(rows().map(function pkg(r) { return r.packageName })).toEqual(['both'])
        expect(rows()[0]?.installations).toEqual([{ manifestPath: 'Cargo.lock', version: '1.0.0' }])
        expect(listProjects(handle.db).map(function rel(p) { return p.relPath })).toEqual(['.'])
        expect(send).not.toHaveBeenCalled()
    })
})

describe('no burst from corrected grades', function () {
    // A project scanned before this release: its event sits behind the version, at the grade it had then.
    async function eventBeforeTheRelease(severity: Severity): Promise<void> {
        await tree({ 'package.json': PACKAGE_JSON, 'package-lock.json': NPM_LOCK })
        enable('osv', 'npm')
        setOsv(severity)
        await scanAll([osvScanner()])
        handle.sqlite.prepare('UPDATE notification_events SET grade_version = 0, grade_answers_json = NULL, policy_severity = NULL').run()
        send.mockClear()
    }

    function setOsv(severity: Severity | null): void {
        osvRows = severity === null
            ? osvRecord('GHSA-grad-grad-grad', 'lodash', 'npm', { aliases: ['CVE-2026-1000'] })
            : osvRecord('GHSA-grad-grad-grad', 'lodash', 'npm', { aliases: ['CVE-2026-1000'], database_specific: { severity: severity.toUpperCase() } })
    }

    function setGemnasium(severity: Severity | null): void {
        gemnasiumRows = severity === null ? [] : [gemnasiumRow('lodash', 'CVE-2026-1000', severity, ['GHSA-grad-grad-grad'])]
    }

    function event() {
        return listEventsForProject(handle.db, projectId('code', '.')).find(function finding(e) { return e.eventType === 'finding' })
    }

    it('keeps a correction from a filtered target, and a later real re-grade reaches it', async function () {
        await eventBeforeTheRelease('moderate')
        target('high-only', ['high'])
        target('critical-only', ['critical'])
        setOsv('high')
        await scanAll([osvScanner()])
        expect(event()).toMatchObject({ severity: 'high', policySeverity: 'moderate', gradeVersion: 1 })
        expect(send).not.toHaveBeenCalled()
        setOsv('critical')
        await scanAll([osvScanner()])
        expect(event()).toMatchObject({ severity: 'critical', policySeverity: null })
        expect(sentTo('critical-only')).toBe(1)
        expect(sentTo('high-only')).toBe(0)
    })

    it('still owes a target the event at the grade it was owed', async function () {
        await eventBeforeTheRelease('moderate')
        target('moderate-only', ['moderate'])
        setOsv('high')
        await scanAll([osvScanner()])
        expect(sentTo('moderate-only')).toBe(1)
    })

    it('reads a moderate corrected to unrated as still moderate to a stored filter', async function () {
        await eventBeforeTheRelease('moderate')
        target('moderate-only', ['moderate'])
        target('high-only', ['high'])
        setOsv(null)
        await scanAll([osvScanner()])
        expect(event()?.severity).toBe('unrated')
        expect(sentTo('moderate-only')).toBe(1)
        expect(sentTo('high-only')).toBe(0)
    })

    it('holds a correction however late the first successful rescan comes', async function () {
        await eventBeforeTheRelease('moderate')
        target('high-only', ['high'])
        osvBroken = true
        await scanAll([osvScanner()])
        expect(event()).toMatchObject({ gradeVersion: 0, severity: 'moderate' })
        osvBroken = false
        setOsv('high')
        await scanAll([osvScanner()])
        expect(event()).toMatchObject({ severity: 'high', policySeverity: 'moderate' })
        expect(sentTo('high-only')).toBe(0)
    })

    it('lets a real critical through while an unrelated npm-audit cell fails throughout', async function () {
        enable('npm-audit', 'npm')
        await eventBeforeTheRelease('moderate')
        target('critical-only', ['critical'])
        setOsv('high')
        await scanAll([FAILING_NPM_AUDIT, osvScanner()])
        expect(event()).toMatchObject({ severity: 'high', policySeverity: 'moderate', gradeAnswers: { osv: 'high' } })
        setOsv('critical')
        await scanAll([FAILING_NPM_AUDIT, osvScanner()])
        expect(event()).toMatchObject({ severity: 'critical', policySeverity: null })
        expect(sentTo('critical-only')).toBe(1)
    })

    it('keeps a delayed corroborator\'s first higher answer silent, and its next change is real', async function () {
        await eventBeforeTheRelease('moderate')
        enable('gemnasium', 'npm')
        target('critical-only', ['critical'])
        gemnasiumBroken = true
        setGemnasium('critical')
        await scanAll([osvScanner(), gemnasiumScanner()])
        expect(event()).toMatchObject({ severity: 'moderate', gradeAnswers: { osv: 'moderate' } })
        gemnasiumBroken = false
        await scanAll([osvScanner(), gemnasiumScanner()])
        expect(event()).toMatchObject({ severity: 'critical', policySeverity: 'moderate' })
        expect(sentTo('critical-only')).toBe(0)
        setGemnasium('low')
        await scanAll([osvScanner(), gemnasiumScanner()])
        setGemnasium('critical')
        await scanAll([osvScanner(), gemnasiumScanner()])
        expect(event()).toMatchObject({ severity: 'critical', policySeverity: null })
        expect(sentTo('critical-only')).toBe(1)
    })

    it('keeps a disabled corroborator silent when it is enabled later', async function () {
        await eventBeforeTheRelease('moderate')
        target('critical-only', ['critical'])
        await scanAll([osvScanner()])
        expect(event()?.gradeAnswers).toEqual({ osv: 'moderate' })
        enable('gemnasium', 'npm')
        setGemnasium('critical')
        await scanAll([osvScanner(), gemnasiumScanner()])
        expect(event()).toMatchObject({ severity: 'critical', policySeverity: 'moderate' })
        expect(sentTo('critical-only')).toBe(0)
    })

    it('tells nothing when a corroborator fails one scan and returns with the same grade', async function () {
        await eventBeforeTheRelease('moderate')
        enable('gemnasium', 'npm')
        target('critical-only', ['critical'])
        setGemnasium('critical')
        await scanAll([osvScanner(), gemnasiumScanner()])
        gemnasiumBroken = true
        await scanAll([osvScanner(), gemnasiumScanner()])
        expect(event()).toMatchObject({ severity: 'moderate', policySeverity: null })
        gemnasiumBroken = false
        await scanAll([osvScanner(), gemnasiumScanner()])
        expect(event()?.severity).toBe('critical')
        expect(sentTo('critical-only')).toBe(0)
    })

    it('reads a source that answered without the advisory and reports it later as real news', async function () {
        await eventBeforeTheRelease('moderate')
        enable('gemnasium', 'npm')
        target('critical-only', ['critical'])
        setGemnasium(null)
        await scanAll([osvScanner(), gemnasiumScanner()])
        expect(event()?.gradeAnswers).toEqual({ osv: 'moderate', gemnasium: null })
        setGemnasium('critical')
        await scanAll([osvScanner(), gemnasiumScanner()])
        expect(event()).toMatchObject({ severity: 'critical', policySeverity: null })
        expect(sentTo('critical-only')).toBe(1)
    })

    it('treats a brand-new finding as news at once', async function () {
        await tree({ 'package.json': PACKAGE_JSON, 'package-lock.json': NPM_LOCK })
        enable('osv', 'npm')
        target('critical-only', ['critical'])
        setOsv('critical')
        await scanAll([osvScanner()])
        expect(sentTo('critical-only')).toBe(1)
        expect(event()).toMatchObject({ gradeVersion: 1, gradeAnswers: null, policySeverity: null })
    })

    it('refuses an older pending event whose row is now a notice', async function () {
        await eventBeforeTheRelease('moderate')
        target('moderate-only', ['moderate'])
        osvRows = osvRecord('GHSA-grad-grad-grad', 'lodash', 'npm', { aliases: ['CVE-2026-1000'], database_specific: { severity: 'MODERATE', informational: 'unsound' } })
        await scanAll([osvScanner()])
        expect(rows()[0]?.noticeKind).toBe('unsound')
        expect(send).not.toHaveBeenCalled()
    })
})

describe('advisory keys during a scan', function () {
    it('costs the counts a stale key when a cache throws, never the scan', async function () {
        enable('osv', 'npm')
        osvRows = osvRecord('GHSA-keyy-keyy-keyy', 'lodash', 'npm', { database_specific: { severity: 'HIGH' } })
        await tree({ 'package.json': PACKAGE_JSON, 'package-lock.json': NPM_LOCK })
        const broken = { ...osvScanner(), aliasEvidence: function broken() { throw new Error('cache gone') } }
        await scanAll([broken])
        expect(rows()[0]?.advisoryKey).toBeNull()
        expect(console.error).toHaveBeenCalledWith(expect.stringContaining('advisory keys not refreshed'))
        await scanAll([osvScanner()])
        expect(rows()[0]?.advisoryKey).toBe('ghsa-keyy-keyy-keyy')
    })
})

describe('a notice another source reports as a vulnerability', function () {
    it('is a vulnerability, at the worst grade any record gave', async function () {
        enable('osv', 'crates.io')
        enable('gemnasium', 'crates.io')
        target('all', ['critical', 'high', 'moderate', 'low', 'info'])
        osvRows = [
            ...osvRecord('RUSTSEC-2026-0020', 'mixed', 'crates.io', { aliases: ['CVE-2026-2000'] }, { database_specific: { informational: 'unsound' } }),
            ...osvRecord('RUSTSEC-2026-0021', 'folded', 'crates.io', { aliases: ['GHSA-fold-fold-fold'] }, { database_specific: { informational: 'unsound' } }),
            ...osvRecord('GHSA-fold-fold-fold', 'folded', 'crates.io', { database_specific: { severity: 'HIGH' } })
        ]
        gemnasiumRows = [gemnasiumRow('mixed', 'CVE-2026-2000', 'critical', [])]
        await tree({
            'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\n',
            'Cargo.lock': ['mixed', 'folded'].map(function lock(name) { return '[[package]]\nname = "' + name + '"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n' }).join('\n') + '\n[[package]]\nname = "app"\nversion = "0.1.0"\n'
        })
        await scanAll([osvScanner(), gemnasiumScanner()])
        const byPackage = new Map(rows().map(function pair(r) { return [r.packageName, r] }))
        expect(byPackage.get('mixed')).toMatchObject({ noticeKind: null, severity: 'critical' })
        expect(byPackage.get('folded')).toMatchObject({ noticeKind: null, severity: 'high' })
        expect(getDashboardSummary(handle.db, T0 + 10_000).severityCounts).toMatchObject({ critical: 1, high: 1 })
        expect(send).toHaveBeenCalled()
    })
})

describe('a project whose root is gone', function () {
    it('records the failure for every cell that can answer for it, and none for npm audit on Bun', async function () {
        enable('npm-audit', 'npm')
        enable('osv', 'npm')
        await tree({ 'package.json': PACKAGE_JSON, 'bun.lock': '{ "packages": {} }' })
        const project = { ...listProjects(handle.db)[0]!, rootId: 'gone' }
        const outcomes = await runProjectScanners({ db: handle.db, scanners: [FAILING_NPM_AUDIT, osvScanner()], project, registry: {}, send })
        expect(outcomes.map(function source(o) { return o.scan.source })).toEqual(['osv'])
    })
})

describe('a package manager moving under a project', function () {
    it('resolves what npm audit found once the project has moved to Bun, with one last answer of nothing', async function () {
        enable('npm-audit', 'npm')
        const finding = { advisoryId: '1123528', advisoryTitle: 't', advisoryUrl: 'https://github.com/advisories/GHSA-xxxx-yyyy-zzzz', packageName: 'lodash', ecosystem: 'npm', installedVersion: '4.17.11', vulnerableRange: '<4.17.21', severity: 'high' as const, fixAvailable: false, fixVersion: null, fixInputs: { source: 'npm-audit', installed: ['4.17.11'], affected: { comparator: 'semver' as const, ranges: [], exact: [], complete: false }, patched: null, patchedSet: null, statedFix: null, fixViaParent: false }, depPath: [], isProd: true, isDev: false, aliases: ['GHSA-xxxx-yyyy-zzzz'] }
        const audit = vi.fn(async function audited() { return { status: 'ok' as const, reasonCode: 'ok' as const, findings: [finding], rawJson: '{}', errorText: null, durationMs: 1 } })
        const npmAudit = { name: 'npm-audit', scan: audit }
        const path = await makeTree(handle.dir, 'code', { 'package.json': PACKAGE_JSON, 'package-lock.json': NPM_LOCK })
        const root = { id: 'code', path, label: null, createdAt: T0 }
        upsertRoot(handle.db, root)
        discoverProjects({ db: handle.db, roots: [root], globalIgnore: [], at: T0 })
        await scanAll([npmAudit])
        expect(rows()).toHaveLength(1)
        const { rm } = await import('node:fs/promises')
        await rm(join(path, 'package-lock.json'))
        await writeFile(join(path, 'bun.lock'), '{ "lockfileVersion": 1, "workspaces": { "": { "dependencies": { "lodash": "1" } } }, "packages": { "lodash": ["lodash@4.17.11", "", {}, "x"] } }')
        audit.mockClear()
        await scanAll([npmAudit])
        expect(audit).not.toHaveBeenCalled()
        expect(rows()).toEqual([])
        await scanAll([npmAudit])
        expect(audit).not.toHaveBeenCalled()
    })
})
