import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openOsvDb, runOsvMigrations, type OsvDrizzleDb } from '../osv-client'
import { osvAdvisories } from '../osv-schema'
import type { OsvAdvisoryRow } from '@sentinello/core'
import {
    countOsvAdvisories,
    deleteOsvAdvisories,
    deleteOsvAdvisoriesForEcosystem,
    getOsvMeta,
    lookupOsvByPackages,
    OSV_META_KEYS,
    osvMetaKeyFor,
    setOsvMeta,
    upsertOsvAdvisories
} from './osv'

// The OSV cache lives in its own SQLite file (osv.db), so this harness opens that database rather than
// the primary one. The behaviours worth pinning are all about scoping: each ecosystem syncs from its own
// export with its own cursor, so a PyPI sync must never disturb npm rows — and a withdrawn advisory
// must stop matching without being deleted.

let db: OsvDrizzleDb
let sqlite: { close(): void }
let dir: string

function advisory(overrides: Partial<OsvAdvisoryRow> = {}): OsvAdvisoryRow {
    return {
        advisoryId: 'GHSA-1',
        ecosystem: 'npm',
        packageName: 'lodash',
        aliases: ['CVE-2024-1'],
        ranges: [{ type: 'SEMVER', introduced: '0', fixed: '4.17.21', lastAffected: null }],
        versions: [],
        severity: 'high',
        summary: 'Prototype pollution',
        url: 'https://ghsa.example/1',
        malicious: false,
        withdrawn: null,
        ...overrides
    }
}

beforeEach(async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-osv-'))
    const opened = openOsvDb(join(dir, 'osv.db'))
    db = opened.db
    sqlite = opened.sqlite
    runOsvMigrations(db)
})

afterEach(async function teardown() {
    sqlite.close()
    await rm(dir, { recursive: true, force: true })
})

describe('upsertOsvAdvisories', function () {
    it('stores a row that can be looked up', function () {
        upsertOsvAdvisories(db, [advisory()])
        expect(lookupOsvByPackages(db, 'npm', ['lodash']).get('lodash')).toHaveLength(1)
    })

    it('round-trips every field', function () {
        const row = advisory({ versions: ['1.0.0'], malicious: true, aliases: ['CVE-1', 'CVE-2'] })
        upsertOsvAdvisories(db, [row])
        expect(lookupOsvByPackages(db, 'npm', ['lodash']).get('lodash')?.[0]).toEqual(row)
    })

    it('does nothing for an empty batch', function () {
        upsertOsvAdvisories(db, [])
        expect(countOsvAdvisories(db)).toBe(0)
    })

    // Idempotent on (advisory, ecosystem, package) so re-seeding overwrites rather than duplicating.
    it('overwrites an existing row rather than duplicating it', function () {
        upsertOsvAdvisories(db, [advisory({ severity: 'low' })])
        upsertOsvAdvisories(db, [advisory({ severity: 'critical' })])
        const rows = lookupOsvByPackages(db, 'npm', ['lodash']).get('lodash')
        expect(rows).toHaveLength(1)
        expect(rows?.[0]?.severity).toBe('critical')
    })

    // The same OSV record can affect several ecosystems; those are distinct rows.
    it('keeps the same advisory in two ecosystems as separate rows', function () {
        upsertOsvAdvisories(db, [
            advisory({ ecosystem: 'npm', packageName: 'requests' }),
            advisory({ ecosystem: 'PyPI', packageName: 'requests' })
        ])
        expect(countOsvAdvisories(db)).toBe(2)
    })

    it('keeps two packages of one advisory as separate rows', function () {
        upsertOsvAdvisories(db, [advisory({ packageName: 'a' }), advisory({ packageName: 'b' })])
        expect(countOsvAdvisories(db)).toBe(2)
    })
})

describe('lookupOsvByPackages', function () {
    it('keys results by package name', function () {
        upsertOsvAdvisories(db, [advisory({ packageName: 'a' }), advisory({ packageName: 'b' })])
        const found = lookupOsvByPackages(db, 'npm', ['a', 'b'])
        expect([...found.keys()].sort()).toEqual(['a', 'b'])
    })

    it('collects several advisories for one package', function () {
        upsertOsvAdvisories(db, [advisory({ advisoryId: 'GHSA-1' }), advisory({ advisoryId: 'GHSA-2' })])
        expect(lookupOsvByPackages(db, 'npm', ['lodash']).get('lodash')).toHaveLength(2)
    })

    it('returns an empty map for no package names', function () {
        upsertOsvAdvisories(db, [advisory()])
        expect(lookupOsvByPackages(db, 'npm', []).size).toBe(0)
    })

    it('omits a package with no advisories', function () {
        expect(lookupOsvByPackages(db, 'npm', ['lodash']).has('lodash')).toBe(false)
    })

    // Scoped to one ecosystem so an npm advisory can never match a same-named PyPI package.
    it('does not cross ecosystems', function () {
        upsertOsvAdvisories(db, [advisory({ ecosystem: 'npm', packageName: 'requests' })])
        expect(lookupOsvByPackages(db, 'PyPI', ['requests']).size).toBe(0)
    })

    // Withdrawn advisories stay in the cache but must stop matching.
    it('excludes a withdrawn advisory', function () {
        upsertOsvAdvisories(db, [advisory({ withdrawn: Date.UTC(2026, 0, 1) })])
        expect(lookupOsvByPackages(db, 'npm', ['lodash']).size).toBe(0)
        expect(countOsvAdvisories(db)).toBe(1)
    })

    // The lookup chunks at 500 names; this crosses that boundary to prove nothing is dropped at a seam.
    it('handles more package names than one query chunk', function () {
        const rows: OsvAdvisoryRow[] = []
        const names: string[] = []
        for (let i = 0; i < 600; i++) {
            rows.push(advisory({ packageName: 'pkg' + i }))
            names.push('pkg' + i)
        }
        upsertOsvAdvisories(db, rows)
        expect(lookupOsvByPackages(db, 'npm', names).size).toBe(600)
    })
})

describe('countOsvAdvisories', function () {
    it('counts every row when no ecosystem is given', function () {
        upsertOsvAdvisories(db, [advisory({ ecosystem: 'npm' }), advisory({ ecosystem: 'PyPI' })])
        expect(countOsvAdvisories(db)).toBe(2)
    })

    it('counts one ecosystem when asked', function () {
        upsertOsvAdvisories(db, [advisory({ ecosystem: 'npm' }), advisory({ ecosystem: 'PyPI' })])
        expect(countOsvAdvisories(db, 'npm')).toBe(1)
    })

    it('counts a withdrawn row', function () {
        upsertOsvAdvisories(db, [advisory({ withdrawn: Date.UTC(2026, 0, 1) })])
        expect(countOsvAdvisories(db)).toBe(1)
    })

    it('is zero on an empty cache', function () {
        expect(countOsvAdvisories(db)).toBe(0)
    })
})

describe('deleteOsvAdvisories', function () {
    it('removes every row of the given advisory', function () {
        upsertOsvAdvisories(db, [advisory({ packageName: 'a' }), advisory({ packageName: 'b' })])
        deleteOsvAdvisories(db, ['GHSA-1'])
        expect(countOsvAdvisories(db)).toBe(0)
    })

    it('leaves other advisories alone', function () {
        upsertOsvAdvisories(db, [advisory({ advisoryId: 'GHSA-1' }), advisory({ advisoryId: 'GHSA-2' })])
        deleteOsvAdvisories(db, ['GHSA-1'])
        expect(countOsvAdvisories(db)).toBe(1)
    })

    // One OSV record can affect several ecosystems, and each syncs independently — so a PyPI sync
    // clearing an advisory must not wipe that advisory's npm rows.
    it('scopes the delete to one ecosystem when asked', function () {
        upsertOsvAdvisories(db, [
            advisory({ ecosystem: 'npm', packageName: 'requests' }),
            advisory({ ecosystem: 'PyPI', packageName: 'requests' })
        ])
        deleteOsvAdvisories(db, ['GHSA-1'], 'PyPI')
        expect(countOsvAdvisories(db, 'npm')).toBe(1)
        expect(countOsvAdvisories(db, 'PyPI')).toBe(0)
    })

    it('does nothing for an empty id list', function () {
        upsertOsvAdvisories(db, [advisory()])
        deleteOsvAdvisories(db, [])
        expect(countOsvAdvisories(db)).toBe(1)
    })

    // Deletes chunk at 500 ids; this crosses that boundary.
    it('handles more advisory ids than one chunk', function () {
        const rows: OsvAdvisoryRow[] = []
        const ids: string[] = []
        for (let i = 0; i < 600; i++) {
            rows.push(advisory({ advisoryId: 'GHSA-' + i }))
            ids.push('GHSA-' + i)
        }
        upsertOsvAdvisories(db, rows)
        deleteOsvAdvisories(db, ids)
        expect(countOsvAdvisories(db)).toBe(0)
    })
})

describe('deleteOsvAdvisoriesForEcosystem', function () {
    it('clears one ecosystem entirely', function () {
        upsertOsvAdvisories(db, [advisory({ advisoryId: 'GHSA-1' }), advisory({ advisoryId: 'GHSA-2' })])
        deleteOsvAdvisoriesForEcosystem(db, 'npm')
        expect(countOsvAdvisories(db, 'npm')).toBe(0)
    })

    it('leaves other ecosystems intact', function () {
        upsertOsvAdvisories(db, [
            advisory({ ecosystem: 'npm', packageName: 'requests' }),
            advisory({ ecosystem: 'PyPI', packageName: 'requests' })
        ])
        deleteOsvAdvisoriesForEcosystem(db, 'npm')
        expect(countOsvAdvisories(db, 'PyPI')).toBe(1)
    })

    it('is a no-op for an ecosystem with no rows', function () {
        upsertOsvAdvisories(db, [advisory()])
        deleteOsvAdvisoriesForEcosystem(db, 'Go')
        expect(countOsvAdvisories(db)).toBe(1)
    })
})

describe('osv meta', function () {
    it('returns null for a key that was never set', function () {
        expect(getOsvMeta(db, 'nope')).toBeNull()
    })

    it.each([
        ['a string', 'hello'],
        ['a number', 42],
        ['a boolean', true],
        ['an object', { a: 1 }],
        ['an array', [1, 2, 3]],
        ['null', null]
    ] as Array<[string, unknown]>)('round-trips %s', function (_label, value) {
        setOsvMeta(db, 'k', value)
        expect(getOsvMeta(db, 'k')).toEqual(value)
    })

    it('overwrites an existing key', function () {
        setOsvMeta(db, 'k', 'first')
        setOsvMeta(db, 'k', 'second')
        expect(getOsvMeta(db, 'k')).toBe('second')
    })

    it('keeps distinct keys apart', function () {
        setOsvMeta(db, 'a', 1)
        setOsvMeta(db, 'b', 2)
        expect(getOsvMeta(db, 'a')).toBe(1)
        expect(getOsvMeta(db, 'b')).toBe(2)
    })
})

describe('osvMetaKeyFor', function () {
    it('suffixes the base key with the ecosystem', function () {
        expect(osvMetaKeyFor(OSV_META_KEYS.seedComplete, 'PyPI')).toBe('seedComplete.PyPI')
    })

    // All OSV state is per-ecosystem: each syncs from its own export with its own cursor and its own
    // normalizer stamp, so one ecosystem's seed flag must never be readable as another's.
    it('keeps per-ecosystem state separate', function () {
        setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.seedComplete, 'npm'), true)
        setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.seedComplete, 'PyPI'), false)
        expect(getOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.seedComplete, 'npm'))).toBe(true)
        expect(getOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.seedComplete, 'PyPI'))).toBe(false)
    })

    it('leaves an unseeded ecosystem reading null', function () {
        setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.seedComplete, 'npm'), true)
        expect(getOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.seedComplete, 'Go'))).toBeNull()
    })
})

// The JSON text columns are only ever written by upsertOsvAdvisories, so in normal operation they
// hold well-formed arrays. The parsers below exist for the mid-rebuild read: a normalizer-version
// bump re-seeds every ecosystem, and until an ecosystem's rows have been rewritten a lookup can
// still land on a row in the previous shape. Writing the column directly is the only way to reach
// them, so each case here corrupts one column and reads back through the public lookup.
describe('defensive column parsing', function () {
    function seed(): OsvAdvisoryRow | undefined {
        upsertOsvAdvisories(db, [advisory({ versions: ['1.0.0'] })])
        return lookupOsvByPackages(db, 'npm', ['lodash']).get('lodash')?.[0]
    }

    function corrupt(patch: Partial<{ aliasesJson: string; rangesJson: string; versionsJson: string }>): OsvAdvisoryRow | undefined {
        seed()
        db.update(osvAdvisories).set(patch).where(eq(osvAdvisories.packageName, 'lodash')).run()
        return lookupOsvByPackages(db, 'npm', ['lodash']).get('lodash')?.[0]
    }

    // The seed row is non-empty in all three columns, so every empty result below proves the parser
    // rejected what it read rather than the row simply having had nothing to report.
    it('seeds every parsed column non-empty', function () {
        const row = seed()
        expect(row?.aliases.length).toBeGreaterThan(0)
        expect(row?.ranges.length).toBeGreaterThan(0)
        expect(row?.versions.length).toBeGreaterThan(0)
    })

    it.each(['{}', 'null', '"a string"', '42'])('reads the non-array aliases_json %s as empty', function (json) {
        expect(corrupt({ aliasesJson: json })?.aliases).toEqual([])
    })

    it.each(['{}', 'null', '42'])('reads the non-array versions_json %s as empty', function (json) {
        expect(corrupt({ versionsJson: json })?.versions).toEqual([])
    })

    it.each(['{}', 'null', '42'])('reads the non-array ranges_json %s as empty', function (json) {
        expect(corrupt({ rangesJson: json })?.ranges).toEqual([])
    })

    it('drops a non-string entry from a string column', function () {
        expect(corrupt({ aliasesJson: '["CVE-1",7,null,"CVE-2"]' })?.aliases).toEqual(['CVE-1', 'CVE-2'])
        expect(corrupt({ versionsJson: '[1,"1.0.0",{}]' })?.versions).toEqual(['1.0.0'])
    })

    // A range with no `introduced` cannot bound anything. Dropping it is the safe reading —
    // defaulting the lower bound to "0" would make the advisory match every version of the package.
    it.each(['[null]', '[42]', '["a string"]', '[{"fixed":"1.0.0"}]', '[{"introduced":7}]'])(
        'drops the unusable range %s',
        function (json) {
            expect(corrupt({ rangesJson: json })?.ranges).toEqual([])
        }
    )

    // type/fixed/lastAffected were added after the first normalizer shape. A row written before they
    // existed must read back with defaults rather than undefined, or the matcher compares a bound
    // that is not there.
    it('defaults the fields an older normalizer never wrote', function () {
        expect(corrupt({ rangesJson: '[{"introduced":"0"}]' })?.ranges).toEqual([
            { type: 'SEMVER', introduced: '0', fixed: null, lastAffected: null }
        ])
    })

    it('defaults those fields again when they are present but not strings', function () {
        const json = '[{"introduced":"0","type":9,"fixed":9,"lastAffected":9}]'
        expect(corrupt({ rangesJson: json })?.ranges).toEqual([
            { type: 'SEMVER', introduced: '0', fixed: null, lastAffected: null }
        ])
    })

    it('keeps a well-formed range alongside a broken one', function () {
        const json = '[{"bogus":true},{"introduced":"1.0.0","type":"ECOSYSTEM","fixed":"2.0.0","lastAffected":null}]'
        expect(corrupt({ rangesJson: json })?.ranges).toEqual([
            { type: 'ECOSYSTEM', introduced: '1.0.0', fixed: '2.0.0', lastAffected: null }
        ])
    })
})
