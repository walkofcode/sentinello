import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { sourceEnabledKey } from '@sentinello/core'
import { openDb, type DrizzleDb, type SqliteDb } from '../client'
import { runMigrations } from '../migrate'
import { refreshAdvisoryKeys, type AliasEvidence } from './advisory-keys'
import { advisoryIdentitySql } from './advisory-identity'
import { setConfigValue, upsertRoot } from './config'
import { getDashboardSummary } from './dashboard'
import { mergeFindingsForScan, type IncomingFinding } from './findings'
import { listLibraries } from './libraries'
import { upsertProject } from './projects'
import { insertScan } from './scans'

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle')
const T0 = Date.UTC(2026, 0, 1)

let db: DrizzleDb
let sqlite: SqliteDb
let dir: string
let seq = 0

function incoming(source: string, advisoryId: string, overrides: Partial<IncomingFinding> = {}, projectId = 'p1'): IncomingFinding {
    return {
        projectId, scanner: source, source, ecosystem: 'Go', advisoryId, advisoryTitle: 'Improper Limitation of a Pathname', advisoryUrl: null,
        packageName: 'u-root', installedVersion: '0.14.0', installations: [], vulnerableRange: '<=7.0.0', severity: 'high', fixAvailable: false, fixVersion: null,
        depPath: [], isProd: true, isDev: false, ...overrides
    }
}

function scan(source: string, rows: IncomingFinding[], projectId = 'p1'): void {
    seq += 1
    const scanId = 'scan-' + seq
    insertScan(db, { id: scanId, projectId, startedAt: T0, finishedAt: T0 + seq, scanner: source, source, ecosystem: 'Go', status: 'ok', reasonCode: 'ok', durationMs: 1, errorText: null, rawJson: '{}' })
    mergeFindingsForScan(db, { projectId, scanner: source, ecosystem: 'Go', scanId, scanFinishedAt: T0 + seq, incoming: rows })
}

function keys(): Record<string, string | null> {
    const rows = db.all<{ advisory_id: string; advisory_key: string | null }>(sql`SELECT advisory_id, advisory_key FROM findings ORDER BY advisory_id`)
    return Object.fromEntries(rows.map(function pair(r) { return [r.advisory_id, r.advisory_key] }))
}

beforeEach(async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-keys-'))
    const opened = openDb({ dbPath: join(dir, 't.sqlite') })
    db = opened.db
    sqlite = opened.sqlite
    runMigrations(db, { migrationsFolder: MIGRATIONS })
    upsertRoot(db, { id: 'r', path: '/r', label: null, createdAt: T0 })
    setConfigValue(db, sourceEnabledKey('osv', 'Go'), true)
    setConfigValue(db, sourceEnabledKey('gemnasium', 'Go'), true)
    for (const id of ['p1', 'p2']) {
        upsertProject(db, { id, rootId: 'r', relPath: id, name: id, alias: null, packageManager: 'go', nvmrcVersion: null, gitBranch: null, ecosystems: ['Go'], manifests: [], muted: false, tags: [], createdAt: T0, updatedAt: T0 })
    }
})

afterEach(async function teardown() {
    sqlite.close()
    await rm(dir, { recursive: true, force: true })
})

// The shared fixture SENTINEL-179 asks for: the same rows read by SQL's expression and by the key the JS merge
// reads, which are the one column.
describe('refreshAdvisoryKeys', function () {
    it('splits two ids that share a generic title, and counts them as two', function () {
        scan('gemnasium', [incoming('gemnasium', 'CVE-2020-7665'), incoming('gemnasium', 'CVE-2020-7669')])
        refreshAdvisoryKeys(db, [])
        expect(keys()).toEqual({ 'CVE-2020-7665': 'cve-2020-7665', 'CVE-2020-7669': 'cve-2020-7669' })
        expect(listLibraries(db, T0 + 100)[0]?.distinctAdvisories).toBe(2)
    })

    it('joins asymmetric aliases: one row lists the other\'s id, and not the reverse', function () {
        scan('osv', [incoming('osv', 'GHSA-58pf-pcwv-qg85', { aliases: ['CVE-2020-7665'] })])
        scan('gemnasium', [incoming('gemnasium', 'CVE-2020-7665')])
        refreshAdvisoryKeys(db, [])
        expect(keys()).toEqual({ 'CVE-2020-7665': 'ghsa-58pf-pcwv-qg85', 'GHSA-58pf-pcwv-qg85': 'ghsa-58pf-pcwv-qg85' })
        expect(getDashboardSummary(db, T0 + 100).severityCounts.high).toBe(1)
        expect(listLibraries(db, T0 + 100)[0]?.distinctAdvisories).toBe(1)
    })

    it('joins a retained row of a source that failed since, in another project too', function () {
        scan('gemnasium', [incoming('gemnasium', 'CVE-1', {}, 'p2')], 'p2')
        scan('osv', [incoming('osv', 'GHSA-aaaa-bbbb-cccc', { aliases: ['CVE-1'] })])
        refreshAdvisoryKeys(db, [], [{ ecosystem: 'Go', packageName: 'u-root' }])
        expect(keys()).toEqual({ 'CVE-1': 'ghsa-aaaa-bbbb-cccc', 'GHSA-aaaa-bbbb-cccc': 'ghsa-aaaa-bbbb-cccc' })
    })

    it('reads a GHSA or CVE out of the row\'s URL, and a corroborating source\'s id', function () {
        scan('npm-audit', [incoming('npm-audit', '1123528', { advisoryUrl: 'https://github.com/advisories/GHSA-58pf-pcwv-qg85' })])
        scan('osv', [incoming('osv', 'GHSA-58pf-pcwv-qg85')])
        scan('gemnasium', [incoming('gemnasium', 'GMS-2020-1', { advisoryUrl: 'https://nvd.nist.gov/vuln/detail/CVE-2020-1234' })])
        sqlite.prepare("UPDATE findings SET corroborations_json = ? WHERE advisory_id = 'GMS-2020-1'").run(JSON.stringify([{ source: 'trivy', advisoryId: 'TRV-1', severity: 'high' }]))
        refreshAdvisoryKeys(db, [])
        expect(keys()).toEqual({ '1123528': 'ghsa-58pf-pcwv-qg85', 'GHSA-58pf-pcwv-qg85': 'ghsa-58pf-pcwv-qg85', 'GMS-2020-1': 'cve-2020-1234' })
    })

    it('never joins two advisories through a bare number: npm audit\'s ids are namespaced', function () {
        scan('npm-audit', [incoming('npm-audit', '1234')])
        scan('other', [incoming('other', '1234')])
        refreshAdvisoryKeys(db, [])
        const rows = db.all<{ advisory_key: string }>(sql`SELECT advisory_key FROM findings ORDER BY scanner`)
        expect(rows.map(function key(r) { return r.advisory_key })).toEqual(['npm-audit:1234', 'other:1234'])
    })

    it('joins through what a cache knows, ignoring a private unnamed id, and reads a cache that cannot answer as stored evidence', function () {
        scan('osv', [incoming('osv', 'GHSA-aaaa-bbbb-cccc')])
        scan('gemnasium', [incoming('gemnasium', 'CVE-1')])
        const notReady: AliasEvidence = function none() { return null }
        refreshAdvisoryKeys(db, [notReady])
        expect(keys()).toEqual({ 'CVE-1': 'cve-1', 'GHSA-aaaa-bbbb-cccc': 'ghsa-aaaa-bbbb-cccc' })
        const cache: AliasEvidence = function known() { return new Map([['u-root', [{ advisoryId: 'GHSA-aaaa-bbbb-cccc', aliases: ['CVE-1', '12345'] }]]]) }
        expect(refreshAdvisoryKeys(db, [notReady, cache]).written).toBe(1)
        expect(keys()).toEqual({ 'CVE-1': 'ghsa-aaaa-bbbb-cccc', 'GHSA-aaaa-bbbb-cccc': 'ghsa-aaaa-bbbb-cccc' })
    })

    it('picks a GHSA, then a CVE, then the lowest id, whatever order the rows came in', function () {
        scan('a', [incoming('a', 'ZZZ-1', { aliases: ['AAA-1', 'CVE-2', 'CVE-1'] })])
        refreshAdvisoryKeys(db, [])
        expect(keys()).toEqual({ 'ZZZ-1': 'cve-1' })
        scan('b', [incoming('b', 'YYY-1', { aliases: ['AAA-1', 'GHSA-1'] })])
        refreshAdvisoryKeys(db, [])
        expect(keys()).toEqual({ 'YYY-1': 'ghsa-1', 'ZZZ-1': 'ghsa-1' })
        scan('c', [incoming('c', 'LOW-2', { aliases: ['LOW-1'] })])
        refreshAdvisoryKeys(db, [])
        expect(keys()['LOW-2']).toBe('low-1')
    })

    it('picks the lowest id of one rank from either side of the comparison', function () {
        scan('a', [incoming('a', 'LOW-2', { aliases: ['LOW-1', 'LOW-3'] }), incoming('a', 'HIGH-1', { aliases: ['HIGH-3', 'HIGH-2'] })])
        refreshAdvisoryKeys(db, [])
        expect(keys()).toEqual({ 'LOW-2': 'low-1', 'HIGH-1': 'high-1' })
    })

    it('writes only what changed, and survives a corrupted column as no evidence', function () {
        scan('osv', [incoming('osv', 'GHSA-1', { aliases: ['CVE-1'] })])
        expect(refreshAdvisoryKeys(db, []).written).toBe(1)
        const unchanged = refreshAdvisoryKeys(db, [])
        expect(unchanged.written).toBe(0)
        expect([...unchanged.keys.values()]).toEqual(['ghsa-1'])
        sqlite.prepare('UPDATE findings SET aliases_json = ?').run('{ not json')
        expect(refreshAdvisoryKeys(db, []).keys.size).toBe(1)
        sqlite.prepare('UPDATE findings SET aliases_json = ?').run('{"a":1}')
        expect(refreshAdvisoryKeys(db, []).keys.size).toBe(1)
    })

    it('reads only the named packages, in the named ecosystem', function () {
        scan('osv', [incoming('osv', 'GHSA-1'), incoming('osv', 'GHSA-2', { packageName: 'other' })])
        const result = refreshAdvisoryKeys(db, [], [{ ecosystem: 'Go', packageName: 'other' }, { ecosystem: 'npm', packageName: 'u-root' }])
        expect([...result.keys.values()]).toEqual(['ghsa-2'])
        const lookedUp = vi.fn(function none() { return null })
        refreshAdvisoryKeys(db, [lookedUp], [{ ecosystem: 'Go', packageName: 'other' }])
        expect(lookedUp).toHaveBeenCalledWith('Go', ['other'])
    })

    it('falls back on the row\'s own source and id until a key is written, never its title', function () {
        scan('gemnasium', [incoming('gemnasium', 'CVE-2020-7665'), incoming('gemnasium', 'CVE-2020-7669')])
        const rows = db.all<{ identity: string }>(sql`SELECT ${advisoryIdentitySql('f')} AS identity FROM findings f ORDER BY identity`)
        expect(rows.map(function id(r) { return r.identity })).toEqual(['gemnasium:CVE-2020-7665', 'gemnasium:CVE-2020-7669'])
    })
})
