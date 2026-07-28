import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
    openGemnasiumDb,
    resolveGemnasiumDbPath,
    runGemnasiumMigrations,
    type GemnasiumDrizzleDb
} from '../gemnasium-client'
import type { GemnasiumAdvisoryRow } from '@sentinello/core'
import {
    countGemnasiumAdvisories,
    deleteGemnasiumAdvisories,
    deleteGemnasiumAdvisoriesExcept,
    GEMNASIUM_META_KEYS,
    gemnasiumRowKeyFor,
    getGemnasiumMeta,
    lookupGemnasiumByPackages,
    setGemnasiumMeta,
    upsertGemnasiumAdvisories
} from './gemnasium'

// The gemnasium cache is its own SQLite file (gemnasium.db), so this harness opens that database
// rather than the primary one — the same shape as the OSV suite next door.
//
// What is distinctive here is deletion. gemnasium-db ships no per-advisory delta feed, so a sync
// re-seeds the whole archive and then purges whatever it did not just write. That makes the two
// delete paths the dangerous surface in this module: too eager and the cache empties, which reports
// every project as unauditable; too timid and an advisory deleted upstream keeps firing forever.

let db: GemnasiumDrizzleDb
let sqlite: { close(): void }
let dir: string

function advisory(overrides: Partial<GemnasiumAdvisoryRow> = {}): GemnasiumAdvisoryRow {
    return {
        advisoryId: 'CVE-2024-1',
        ecosystem: 'npm',
        packageName: 'lodash',
        aliases: ['GHSA-aaaa-bbbb-cccc'],
        ranges: [{ introduced: '0', fixed: '4.17.21' }],
        versions: [],
        severity: 'high',
        summary: 'Prototype pollution',
        url: 'https://example.test/advisory/1',
        malicious: false,
        withdrawn: null,
        ...overrides
    }
}

beforeEach(async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-gemnasium-'))
    const opened = openGemnasiumDb(join(dir, 'gemnasium.db'))
    db = opened.db
    sqlite = opened.sqlite
    runGemnasiumMigrations(db)
})

afterEach(async function teardown() {
    sqlite.close()
    await rm(dir, { recursive: true, force: true })
})

describe('gemnasiumRowKeyFor', function () {
    // One advisory maps to 0..N rows, one per affected package per ecosystem. The key has to separate
    // all three or a PyPI row would overwrite the npm row for the same CVE.
    it('separates rows by advisory, ecosystem and package', function () {
        const keys = new Set([
            gemnasiumRowKeyFor('CVE-1', 'npm', 'lodash'),
            gemnasiumRowKeyFor('CVE-1', 'PyPI', 'lodash'),
            gemnasiumRowKeyFor('CVE-1', 'npm', 'express'),
            gemnasiumRowKeyFor('CVE-2', 'npm', 'lodash')
        ])
        expect(keys.size).toBe(4)
    })

    it('is stable for the same triple', function () {
        expect(gemnasiumRowKeyFor('CVE-1', 'npm', 'lodash')).toBe(gemnasiumRowKeyFor('CVE-1', 'npm', 'lodash'))
    })
})

describe('upsertGemnasiumAdvisories', function () {
    it('stores a row that can be looked up', function () {
        upsertGemnasiumAdvisories(db, [advisory()])
        expect(lookupGemnasiumByPackages(db, 'npm', ['lodash']).get('lodash')).toHaveLength(1)
    })

    it('round-trips every field', function () {
        const row = advisory({
            versions: ['1.0.0', '1.0.1'],
            ranges: [{ introduced: '1.0.0', fixed: '2.0.0' }, { introduced: '3.0.0', fixed: null }],
            aliases: ['CVE-1', 'GMS-2'],
            malicious: true
        })
        upsertGemnasiumAdvisories(db, [row])
        expect(lookupGemnasiumByPackages(db, 'npm', ['lodash']).get('lodash')?.[0]).toEqual(row)
    })

    it('round-trips null metadata without turning it into empty strings', function () {
        upsertGemnasiumAdvisories(db, [advisory({ severity: null, summary: null, url: null })])
        const found = lookupGemnasiumByPackages(db, 'npm', ['lodash']).get('lodash')?.[0]
        expect(found?.severity).toBeNull()
        expect(found?.summary).toBeNull()
        expect(found?.url).toBeNull()
    })

    it('does nothing for an empty batch', function () {
        upsertGemnasiumAdvisories(db, [])
        expect(countGemnasiumAdvisories(db)).toBe(0)
    })

    // Every sync re-upserts the entire archive, so this runs on every row on every sync.
    it('overwrites an existing row rather than duplicating it', function () {
        upsertGemnasiumAdvisories(db, [advisory({ severity: 'low' })])
        upsertGemnasiumAdvisories(db, [advisory({ severity: 'critical' })])
        const rows = lookupGemnasiumByPackages(db, 'npm', ['lodash']).get('lodash')
        expect(rows).toHaveLength(1)
        expect(rows?.[0]?.severity).toBe('critical')
    })

    it('keeps the same advisory in two ecosystems as separate rows', function () {
        upsertGemnasiumAdvisories(db, [
            advisory({ ecosystem: 'npm', packageName: 'requests' }),
            advisory({ ecosystem: 'PyPI', packageName: 'requests' })
        ])
        expect(countGemnasiumAdvisories(db)).toBe(2)
    })

    it('keeps two packages of one advisory as separate rows', function () {
        upsertGemnasiumAdvisories(db, [advisory({ packageName: 'a' }), advisory({ packageName: 'b' })])
        expect(countGemnasiumAdvisories(db)).toBe(2)
    })
})

describe('lookupGemnasiumByPackages', function () {
    it('keys results by package name', function () {
        upsertGemnasiumAdvisories(db, [advisory({ packageName: 'a' }), advisory({ packageName: 'b' })])
        const found = lookupGemnasiumByPackages(db, 'npm', ['a', 'b'])
        expect([...found.keys()].sort()).toEqual(['a', 'b'])
    })

    it('collects several advisories for one package', function () {
        upsertGemnasiumAdvisories(db, [advisory({ advisoryId: 'CVE-1' }), advisory({ advisoryId: 'CVE-2' })])
        expect(lookupGemnasiumByPackages(db, 'npm', ['lodash']).get('lodash')).toHaveLength(2)
    })

    it('returns an empty map for no package names', function () {
        upsertGemnasiumAdvisories(db, [advisory()])
        expect(lookupGemnasiumByPackages(db, 'npm', []).size).toBe(0)
    })

    it('omits a package with no advisories', function () {
        expect(lookupGemnasiumByPackages(db, 'npm', ['lodash']).has('lodash')).toBe(false)
    })

    // A same-named package in another ecosystem is a different package. Crossing here would report a
    // Python advisory against a JavaScript dependency.
    it('does not cross ecosystems', function () {
        upsertGemnasiumAdvisories(db, [advisory({ ecosystem: 'npm', packageName: 'requests' })])
        expect(lookupGemnasiumByPackages(db, 'PyPI', ['requests']).size).toBe(0)
    })

    it('excludes a withdrawn advisory without deleting it', function () {
        upsertGemnasiumAdvisories(db, [advisory({ withdrawn: Date.UTC(2026, 0, 1) })])
        expect(lookupGemnasiumByPackages(db, 'npm', ['lodash']).size).toBe(0)
        expect(countGemnasiumAdvisories(db)).toBe(1)
    })

    // The lookup chunks package names at 500; this crosses the seam to prove nothing is dropped there.
    it('handles more package names than one query chunk', function () {
        const rows: GemnasiumAdvisoryRow[] = []
        const names: string[] = []
        for (let i = 0; i < 600; i++) {
            rows.push(advisory({ packageName: 'pkg' + i }))
            names.push('pkg' + i)
        }
        upsertGemnasiumAdvisories(db, rows)
        expect(lookupGemnasiumByPackages(db, 'npm', names).size).toBe(600)
    })
})

describe('countGemnasiumAdvisories', function () {
    it('counts nothing on an empty cache', function () {
        expect(countGemnasiumAdvisories(db)).toBe(0)
    })

    it('counts rows across every ecosystem', function () {
        upsertGemnasiumAdvisories(db, [
            advisory({ ecosystem: 'npm' }),
            advisory({ ecosystem: 'PyPI' }),
            advisory({ ecosystem: 'Go' })
        ])
        expect(countGemnasiumAdvisories(db)).toBe(3)
    })
})

describe('deleteGemnasiumAdvisories', function () {
    // The incremental sync clears an advisory's rows and rewrites them from the new file, so a package
    // dropped from the advisory's affected set does not linger. That means deleting by advisory id,
    // not by row key — one id can own rows in several ecosystems.
    it('removes every row of an advisory across ecosystems', function () {
        upsertGemnasiumAdvisories(db, [
            advisory({ advisoryId: 'CVE-1', ecosystem: 'npm', packageName: 'a' }),
            advisory({ advisoryId: 'CVE-1', ecosystem: 'PyPI', packageName: 'b' }),
            advisory({ advisoryId: 'CVE-2', ecosystem: 'npm', packageName: 'c' })
        ])
        expect(deleteGemnasiumAdvisories(db, ['CVE-1'])).toBe(2)
        expect(countGemnasiumAdvisories(db)).toBe(1)
        expect(lookupGemnasiumByPackages(db, 'npm', ['c']).get('c')).toHaveLength(1)
    })

    it('does nothing for an empty id list', function () {
        upsertGemnasiumAdvisories(db, [advisory()])
        expect(deleteGemnasiumAdvisories(db, [])).toBe(0)
        expect(countGemnasiumAdvisories(db)).toBe(1)
    })

    it('reports zero for an advisory that is not cached', function () {
        upsertGemnasiumAdvisories(db, [advisory({ advisoryId: 'CVE-1' })])
        expect(deleteGemnasiumAdvisories(db, ['CVE-nope'])).toBe(0)
        expect(countGemnasiumAdvisories(db)).toBe(1)
    })

    it('handles more ids than one delete chunk', function () {
        const rows: GemnasiumAdvisoryRow[] = []
        const ids: string[] = []
        for (let i = 0; i < 600; i++) {
            rows.push(advisory({ advisoryId: 'CVE-' + i, packageName: 'pkg' + i }))
            ids.push('CVE-' + i)
        }
        upsertGemnasiumAdvisories(db, rows)
        expect(deleteGemnasiumAdvisories(db, ids)).toBe(600)
        expect(countGemnasiumAdvisories(db)).toBe(0)
    })
})

describe('deleteGemnasiumAdvisoriesExcept', function () {
    // This is the purge that runs after a full re-seed: whatever the pass did not write is stale.
    it('removes rows whose key was not seeded in this pass', function () {
        upsertGemnasiumAdvisories(db, [
            advisory({ advisoryId: 'CVE-1', packageName: 'keep' }),
            advisory({ advisoryId: 'CVE-2', packageName: 'drop' })
        ])
        const keep = new Set([gemnasiumRowKeyFor('CVE-1', 'npm', 'keep')])
        expect(deleteGemnasiumAdvisoriesExcept(db, keep)).toBe(1)
        expect(countGemnasiumAdvisories(db)).toBe(1)
        expect(lookupGemnasiumByPackages(db, 'npm', ['keep']).get('keep')).toHaveLength(1)
    })

    it('removes nothing when the seed covered every row', function () {
        upsertGemnasiumAdvisories(db, [
            advisory({ advisoryId: 'CVE-1', packageName: 'a' }),
            advisory({ advisoryId: 'CVE-2', packageName: 'b' })
        ])
        const keep = new Set([
            gemnasiumRowKeyFor('CVE-1', 'npm', 'a'),
            gemnasiumRowKeyFor('CVE-2', 'npm', 'b')
        ])
        expect(deleteGemnasiumAdvisoriesExcept(db, keep)).toBe(0)
        expect(countGemnasiumAdvisories(db)).toBe(2)
    })

    // The caller is contracted to invoke this only after a *successful* full pass, precisely because an
    // empty keep-set is a legitimate instruction to empty the cache. Pinning the behaviour documents how
    // much the caller's guard is carrying.
    it('empties the cache when the keep-set is empty', function () {
        upsertGemnasiumAdvisories(db, [advisory({ packageName: 'a' }), advisory({ packageName: 'b' })])
        expect(deleteGemnasiumAdvisoriesExcept(db, new Set())).toBe(2)
        expect(countGemnasiumAdvisories(db)).toBe(0)
    })

    it('ignores keys in the keep-set that are not in the cache', function () {
        upsertGemnasiumAdvisories(db, [advisory({ packageName: 'a' })])
        const keep = new Set([
            gemnasiumRowKeyFor('CVE-2024-1', 'npm', 'a'),
            gemnasiumRowKeyFor('CVE-9999', 'npm', 'ghost')
        ])
        expect(deleteGemnasiumAdvisoriesExcept(db, keep)).toBe(0)
        expect(countGemnasiumAdvisories(db)).toBe(1)
    })

    // Deletion chunks at 500 to avoid a giant bind-param list; this crosses that seam.
    it('handles more stale rows than one delete chunk', function () {
        const rows: GemnasiumAdvisoryRow[] = []
        for (let i = 0; i < 600; i++) rows.push(advisory({ packageName: 'pkg' + i }))
        upsertGemnasiumAdvisories(db, rows)
        expect(deleteGemnasiumAdvisoriesExcept(db, new Set())).toBe(600)
        expect(countGemnasiumAdvisories(db)).toBe(0)
    })
})

describe('resolveGemnasiumDbPath', function () {
    // Saved/restored around each case so a stray env var cannot leak into the rest of the suite.
    const savedGemnasium = process.env.SENTINELLO_GEMNASIUM_DB_PATH
    const savedMain = process.env.SENTINELLO_DB_PATH

    afterEach(function restoreEnv() {
        if (savedGemnasium === undefined) delete process.env.SENTINELLO_GEMNASIUM_DB_PATH
        else process.env.SENTINELLO_GEMNASIUM_DB_PATH = savedGemnasium
        if (savedMain === undefined) delete process.env.SENTINELLO_DB_PATH
        else process.env.SENTINELLO_DB_PATH = savedMain
    })

    it('honours an explicit override', function () {
        process.env.SENTINELLO_GEMNASIUM_DB_PATH = join(dir, 'custom.db')
        expect(resolveGemnasiumDbPath()).toBe(join(dir, 'custom.db'))
    })

    it('ignores a blank override', function () {
        process.env.SENTINELLO_GEMNASIUM_DB_PATH = '   '
        process.env.SENTINELLO_DB_PATH = join(dir, 'data', 'sentinello.sqlite')
        expect(resolveGemnasiumDbPath()).toBe(join(dir, 'data', 'gemnasium.db'))
    })

    // Default placement is a sibling of the primary database, so an operator who relocates the data
    // directory moves both caches together rather than stranding one at the old path.
    it('defaults to a sibling of the primary database', function () {
        delete process.env.SENTINELLO_GEMNASIUM_DB_PATH
        process.env.SENTINELLO_DB_PATH = join(dir, 'data', 'sentinello.sqlite')
        expect(resolveGemnasiumDbPath()).toBe(join(dir, 'data', 'gemnasium.db'))
    })
})

describe('gemnasium meta', function () {
    it('returns null for a key that was never set', function () {
        expect(getGemnasiumMeta(db, GEMNASIUM_META_KEYS.headSha)).toBeNull()
    })

    it('round-trips a string', function () {
        setGemnasiumMeta(db, GEMNASIUM_META_KEYS.headSha, 'abc123')
        expect(getGemnasiumMeta(db, GEMNASIUM_META_KEYS.headSha)).toBe('abc123')
    })

    it('round-trips non-string values', function () {
        setGemnasiumMeta(db, GEMNASIUM_META_KEYS.seedComplete, true)
        setGemnasiumMeta(db, GEMNASIUM_META_KEYS.recordCount, 4321)
        setGemnasiumMeta(db, GEMNASIUM_META_KEYS.lastError, null)
        expect(getGemnasiumMeta(db, GEMNASIUM_META_KEYS.seedComplete)).toBe(true)
        expect(getGemnasiumMeta(db, GEMNASIUM_META_KEYS.recordCount)).toBe(4321)
        expect(getGemnasiumMeta(db, GEMNASIUM_META_KEYS.lastError)).toBeNull()
    })

    it('overwrites an existing key', function () {
        setGemnasiumMeta(db, GEMNASIUM_META_KEYS.headSha, 'old')
        setGemnasiumMeta(db, GEMNASIUM_META_KEYS.headSha, 'new')
        expect(getGemnasiumMeta(db, GEMNASIUM_META_KEYS.headSha)).toBe('new')
    })

    it('keeps keys independent of one another', function () {
        setGemnasiumMeta(db, GEMNASIUM_META_KEYS.headSha, 'sha')
        setGemnasiumMeta(db, GEMNASIUM_META_KEYS.refreshedAt, 1700000000000)
        expect(getGemnasiumMeta(db, GEMNASIUM_META_KEYS.headSha)).toBe('sha')
        expect(getGemnasiumMeta(db, GEMNASIUM_META_KEYS.refreshedAt)).toBe(1700000000000)
    })
})
