import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getRegistryPackages, openDb, runMigrations, upsertRegistryPackage, type DrizzleDb, type SqliteDb } from '@sentinello/db'
import type { NpmPackageResult, NpmPackageSummary } from '@sentinello/feeds'
import { createNpmRegistryClient, parseSummary, REGISTRY_FETCH_CONCURRENCY, REGISTRY_FRESH_MS } from './registry-client'

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'db', 'drizzle')
const NOW = Date.UTC(2026, 9, 3, 12)

let db: DrizzleDb
let sqlite: SqliteDb
let dir: string

function summary(name: string): NpmPackageSummary {
    return { v: 1, name, latest: '1.0.0', modified: NOW, maintainers: 1, repository: null, versions: { '1.0.0': { publishedAt: NOW, deprecated: null, edges: null } }, edges: [] }
}

function cache(name: string, status: 'ok' | 'not_found', checkedAt: number, summaryJson: string | null = status === 'ok' ? JSON.stringify(summary(name)) : null): void {
    upsertRegistryPackage(db, { ecosystem: 'npm', name, status, summaryJson, checkedAt })
}

// A fetcher answering from a table and counting calls.
function fetcher(answers: Record<string, NpmPackageResult>) {
    const calls: string[] = []
    return {
        calls,
        fetchPackage: async function fetchPackage(name: string): Promise<NpmPackageResult> {
            calls.push(name)
            return answers[name] ?? { status: 'error', reason: 'no answer' }
        }
    }
}

beforeEach(async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-registry-'))
    const opened = openDb({ dbPath: join(dir, 'test.sqlite') })
    db = opened.db
    sqlite = opened.sqlite
    runMigrations(db, { migrationsFolder: MIGRATIONS })
})

afterEach(async function teardown() {
    sqlite.close()
    await rm(dir, { recursive: true, force: true })
})

describe('createNpmRegistryClient — cache first', function () {
    it('serves fresh rows from the cache without fetching', async function () {
        cache('a', 'ok', NOW - REGISTRY_FRESH_MS)
        cache('b', 'not_found', NOW - 1000)
        const f = fetcher({})
        const out = await createNpmRegistryClient(db, { fetchPackage: f.fetchPackage, now: () => NOW }).lookup(['a', 'b', 'a'])
        expect(f.calls).toEqual([])
        expect(out.get('a')).toEqual({ status: 'ok', summary: summary('a'), checkedAt: NOW - REGISTRY_FRESH_MS, origin: 'cache' })
        expect(out.get('b')).toEqual({ status: 'not_found', checkedAt: NOW - 1000, origin: 'cache' })
    })

    it('refetches an expired row and caches the answer', async function () {
        cache('a', 'ok', NOW - REGISTRY_FRESH_MS - 1)
        const f = fetcher({ a: { status: 'ok', summary: summary('a') }, gone: { status: 'not_found' } })
        const out = await createNpmRegistryClient(db, { fetchPackage: f.fetchPackage, now: () => NOW }).lookup(['a', 'gone'])
        expect(f.calls.sort()).toEqual(['a', 'gone'])
        expect(out.get('a')).toMatchObject({ status: 'ok', checkedAt: NOW, origin: 'fetched' })
        expect(out.get('gone')).toEqual({ status: 'not_found', checkedAt: NOW, origin: 'fetched' })
        const rows = getRegistryPackages(db, 'npm', ['a', 'gone'])
        expect(rows.get('a')).toMatchObject({ status: 'ok', checkedAt: NOW })
        expect(rows.get('gone')).toMatchObject({ status: 'not_found', summaryJson: null, checkedAt: NOW })
    })

    it('refetches a fresh row whose summary cannot be read', async function () {
        cache('a', 'ok', NOW, '{broken')
        const f = fetcher({ a: { status: 'ok', summary: summary('a') } })
        const out = await createNpmRegistryClient(db, { fetchPackage: f.fetchPackage, now: () => NOW }).lookup(['a'])
        expect(f.calls).toEqual(['a'])
        expect(out.get('a')).toMatchObject({ origin: 'fetched' })
    })
})

describe('createNpmRegistryClient — a failed refetch', function () {
    it('serves the last good row as stale and keeps it', async function () {
        const old = NOW - REGISTRY_FRESH_MS * 3
        cache('a', 'ok', old)
        const f = fetcher({ a: { status: 'error', reason: 'HTTP 503' } })
        const out = await createNpmRegistryClient(db, { fetchPackage: f.fetchPackage, now: () => NOW }).lookup(['a'])
        expect(out.get('a')).toEqual({ status: 'stale', summary: summary('a'), checkedAt: old, reason: 'HTTP 503' })
        expect(getRegistryPackages(db, 'npm', ['a']).get('a')).toMatchObject({ status: 'ok', checkedAt: old })
    })

    it('is an error, never cached, when there is no good row to fall back on', async function () {
        cache('gone', 'not_found', NOW - REGISTRY_FRESH_MS * 2)
        cache('junk', 'ok', NOW - REGISTRY_FRESH_MS * 2, 'null')
        const f = fetcher({})
        const out = await createNpmRegistryClient(db, { fetchPackage: f.fetchPackage, now: () => NOW }).lookup(['gone', 'junk', 'new'])
        expect(out.get('gone')).toEqual({ status: 'error', reason: 'no answer' })
        expect(out.get('junk')).toEqual({ status: 'error', reason: 'no answer' })
        expect(out.get('new')).toEqual({ status: 'error', reason: 'no answer' })
        expect(getRegistryPackages(db, 'npm', ['new']).size).toBe(0)
    })

    it('reaches the live fetcher by default, which degrades to an error when the registry is unreachable', async function () {
        // vitest.config.ts points SENTINELLO_NPM_REGISTRY_URL at a refusing port.
        const out = await createNpmRegistryClient(db).lookup(['braces'])
        expect(out.get('braces')?.status).toBe('error')
    })
})

describe('createNpmRegistryClient — concurrency', function () {
    it(`keeps at most ${REGISTRY_FETCH_CONCURRENCY} fetches in flight`, async function () {
        let inFlight = 0
        let peak = 0
        const names = Array.from({ length: 10 }, function n(_v, i) { return 'p' + i })
        const client = createNpmRegistryClient(db, {
            now: () => NOW,
            fetchPackage: async function slow(name): Promise<NpmPackageResult> {
                inFlight++
                peak = Math.max(peak, inFlight)
                await new Promise(function wait(r) { setTimeout(r, 5) })
                inFlight--
                return { status: 'ok', summary: summary(name) }
            }
        })
        const out = await client.lookup(names)
        expect(out.size).toBe(10)
        expect(peak).toBe(REGISTRY_FETCH_CONCURRENCY)
    })

    it('fetches nothing for an empty lookup', async function () {
        const f = fetcher({})
        expect((await createNpmRegistryClient(db, { fetchPackage: f.fetchPackage }).lookup([])).size).toBe(0)
        expect(f.calls).toEqual([])
    })
})

describe('parseSummary', function () {
    it('accepts a v1 summary and rejects anything else', function () {
        expect(parseSummary(JSON.stringify(summary('a')))).toEqual(summary('a'))
        expect(parseSummary(null)).toBeNull()
        expect(parseSummary('{')).toBeNull()
        expect(parseSummary('null')).toBeNull()
        expect(parseSummary(JSON.stringify({ ...summary('a'), v: 2 }))).toBeNull()
        expect(parseSummary(JSON.stringify({ ...summary('a'), versions: null }))).toBeNull()
        expect(parseSummary(JSON.stringify({ ...summary('a'), versions: 'x' }))).toBeNull()
    })
})
