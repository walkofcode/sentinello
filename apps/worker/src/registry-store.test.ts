import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getRegistryPackages, openDb, runMigrations, upsertRegistryPackage, type DrizzleDb, type SqliteDb } from '@sentinello/db'
import type { NpmDownloadsResult, NpmPackageResult, NpmPackageSummary } from '@sentinello/feeds'
import { createNpmRegistryClient, REGISTRY_FRESH_MS } from '@sentinello/fixes'
import { createDbRegistryStore } from './registry-store'

// The shared registry client over the worker's store, the registry_packages table: what a lookup leaves
// in the table is what the next scan reads.

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'db', 'drizzle')
const NOW = Date.UTC(2026, 9, 3, 12)

let db: DrizzleDb
let sqlite: SqliteDb
let dir: string

function summary(name: string): NpmPackageSummary {
    return { v: 2, name, latest: '1.0.0', modified: NOW, maintainers: 1, repository: null, versions: { '1.0.0': { publishedAt: NOW, deprecated: null, edges: null } }, prereleases: {}, edges: [] }
}

function answering(answers: Record<string, NpmPackageResult>) {
    return async function fetchPackage(name: string): Promise<NpmPackageResult> {
        return answers[name] ?? { status: 'error', reason: 'no answer' }
    }
}

beforeEach(async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-registry-store-'))
    const opened = openDb({ dbPath: join(dir, 'test.sqlite') })
    db = opened.db
    sqlite = opened.sqlite
    runMigrations(db, { migrationsFolder: MIGRATIONS })
})

afterEach(async function teardown() {
    sqlite.close()
    await rm(dir, { recursive: true, force: true })
})

describe('createDbRegistryStore', function () {
    it('caches each answer in the table, and serves it from there on the next lookup', async function () {
        const fetchPackage = answering({ a: { status: 'ok', summary: summary('a'), etag: null, bytes: 1 }, gone: { status: 'not_found' } })
        await createNpmRegistryClient(createDbRegistryStore(db), { fetchPackage, now: () => NOW }).lookup(['a', 'gone'])
        const rows = getRegistryPackages(db, 'npm', ['a', 'gone'])
        expect(rows.get('a')).toMatchObject({ ecosystem: 'npm', status: 'ok', summaryJson: JSON.stringify(summary('a')), checkedAt: NOW })
        expect(rows.get('gone')).toMatchObject({ ecosystem: 'npm', status: 'not_found', summaryJson: null, checkedAt: NOW })
        const again = await createNpmRegistryClient(createDbRegistryStore(db), { fetchPackage: answering({}), now: () => NOW }).lookup(['a', 'gone'])
        expect(again.get('a')).toMatchObject({ status: 'ok', origin: 'cache' })
        expect(again.get('gone')).toMatchObject({ status: 'not_found', origin: 'cache' })
    })

    it('keeps the last good row through a failed refetch, and caches no failure', async function () {
        const old = NOW - REGISTRY_FRESH_MS * 3
        upsertRegistryPackage(db, { ecosystem: 'npm', name: 'a', status: 'ok', summaryJson: JSON.stringify(summary('a')), checkedAt: old, etag: null })
        const out = await createNpmRegistryClient(createDbRegistryStore(db), { fetchPackage: answering({}), now: () => NOW }).lookup(['a', 'new'])
        expect(out.get('a')).toMatchObject({ status: 'stale', checkedAt: old })
        expect(getRegistryPackages(db, 'npm', ['a']).get('a')).toMatchObject({ status: 'ok', checkedAt: old })
        expect(getRegistryPackages(db, 'npm', ['new']).size).toBe(0)
    })

    // The expired-cache scan: the row's ETag goes back to the registry, and a 304 refreshes it in the table.
    it('revalidates an expired row with its stored ETag and records the 304 as a fresh answer', async function () {
        const old = NOW - REGISTRY_FRESH_MS - 1
        upsertRegistryPackage(db, { ecosystem: 'npm', name: 'a', status: 'ok', summaryJson: JSON.stringify(summary('a')), checkedAt: old, etag: 'W/"e1"' })
        const sent: (string | null)[] = []
        const out = await createNpmRegistryClient(createDbRegistryStore(db), {
            now: () => NOW,
            fetchPackage: async function revalidate(_name, request): Promise<NpmPackageResult> {
                sent.push(request.ifNoneMatch)
                return { status: 'not_modified', etag: '"e1"' }
            }
        }).lookup(['a'])
        expect(sent).toEqual(['W/"e1"'])
        expect(out.get('a')).toEqual({ status: 'ok', summary: summary('a'), checkedAt: NOW, origin: 'fetched' })
        expect(getRegistryPackages(db, 'npm', ['a']).get('a')).toMatchObject({ status: 'ok', summaryJson: JSON.stringify(summary('a')), checkedAt: NOW, etag: '"e1"' })
    })

    it('records a download count beside a cached answer, and nowhere else', async function () {
        upsertRegistryPackage(db, { ecosystem: 'npm', name: 'a', status: 'ok', summaryJson: JSON.stringify(summary('a')), checkedAt: NOW, etag: null })
        const fetchDownloads = async function count(): Promise<NpmDownloadsResult> { return { status: 'ok', weeklyDownloads: 42 } }
        const out = await createNpmRegistryClient(createDbRegistryStore(db), { fetchDownloads, now: () => NOW }).weeklyDownloads(['a', 'uncached'])
        expect(Object.fromEntries(out)).toEqual({ a: 42, uncached: 42 })
        expect(getRegistryPackages(db, 'npm', ['a']).get('a')).toMatchObject({ weeklyDownloads: 42, downloadsCheckedAt: NOW })
        expect(getRegistryPackages(db, 'npm', ['uncached']).size).toBe(0)
    })
})
