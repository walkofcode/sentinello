import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setConfigValue } from '@sentinello/db'
import { closePortalTestDb, openPortalTestDb, type PortalTestDb } from './portal-test-db.fixture'
import { FILTER_DEFAULTS_CONFIG_KEY, getFilterDefaults, parseDepTypeParam } from './filter-defaults'

// Every filter default lives in one appConfig JSON blob, so Settings writes one row and the listing
// pages read one row. The consequence worth testing is that the blob is third-party-ish input as far
// as this reader is concerned — it is whatever was last written, possibly by an older version — so
// each field is validated INDEPENDENTLY and falls back on its own rather than discarding the whole
// object. A partially-stale blob must still contribute its valid half.

let handle: PortalTestDb

beforeEach(async function setup() {
    handle = await openPortalTestDb('filter-defaults')
})

afterEach(async function teardown() {
    await closePortalTestDb(handle)
})

function write(value: unknown): void {
    setConfigValue(handle.db, FILTER_DEFAULTS_CONFIG_KEY, value)
}

describe('getFilterDefaults', function () {
    it('returns the built-in defaults when nothing has been configured', function () {
        expect(getFilterDefaults(handle.db)).toEqual({ depType: 'prod', minSeverity: '', sort: 'severity' })
    })

    it('returns every configured value', function () {
        write({ depType: 'all', minSeverity: 'high', sort: 'name' })
        expect(getFilterDefaults(handle.db)).toEqual({ depType: 'all', minSeverity: 'high', sort: 'name' })
    })

    it.each(['all', 'prod', 'dev'])('accepts the dep type %s', function (depType) {
        write({ depType })
        expect(getFilterDefaults(handle.db).depType).toBe(depType)
    })

    it.each(['', 'critical', 'high', 'moderate', 'low', 'info'])('accepts the severity floor %j', function (minSeverity) {
        write({ minSeverity })
        expect(getFilterDefaults(handle.db).minSeverity).toBe(minSeverity)
    })

    it.each([
        ['a non-object', 'nonsense'],
        ['a number', 42],
        ['null', null]
    ])('falls back to the built-ins for %s', function (_label, value) {
        write(value)
        expect(getFilterDefaults(handle.db)).toEqual({ depType: 'prod', minSeverity: '', sort: 'severity' })
    })

    // Per-field, not all-or-nothing: an unrecognised depType must not also discard a valid severity.
    it('keeps the valid fields of a partially invalid blob', function () {
        write({ depType: 'nonsense', minSeverity: 'critical', sort: 'name' })
        expect(getFilterDefaults(handle.db)).toEqual({ depType: 'prod', minSeverity: 'critical', sort: 'name' })
    })

    it.each([
        ['an unknown dep type', { depType: 'peer' }],
        ['a non-string dep type', { depType: 3 }],
        ['an unknown severity', { minSeverity: 'catastrophic' }],
        ['a non-string severity', { minSeverity: true }]
    ])('ignores %s and keeps that field on its built-in', function (_label, blob) {
        const out = getFilterDefaults(handle.db)
        write(blob)
        const after = getFilterDefaults(handle.db)
        expect(after.depType).toBe(out.depType)
        expect(after.minSeverity).toBe(out.minSeverity)
    })

    it('ignores extra keys it does not know about', function () {
        write({ depType: 'dev', somethingNew: 'ignored' })
        expect(getFilterDefaults(handle.db)).toEqual({ depType: 'dev', minSeverity: '', sort: 'severity' })
    })

    // Worth stating explicitly because it differs from the other two fields: `sort` is accepted as ANY
    // string with no allowlist, so an unknown sort key reaches the listing page rather than being
    // corrected here.
    it('accepts any string as the sort key, with no allowlist', function () {
        write({ sort: 'not-a-real-sort-key' })
        expect(getFilterDefaults(handle.db).sort).toBe('not-a-real-sort-key')
    })

    it('rejects a non-string sort key', function () {
        write({ sort: 5 })
        expect(getFilterDefaults(handle.db).sort).toBe('severity')
    })

    it('does not mutate the built-in defaults between reads', function () {
        write({ depType: 'dev', minSeverity: 'low', sort: 'name' })
        expect(getFilterDefaults(handle.db).depType).toBe('dev')
        write(null)
        expect(getFilterDefaults(handle.db)).toEqual({ depType: 'prod', minSeverity: '', sort: 'severity' })
    })
})

describe('parseDepTypeParam', function () {
    it.each(['all', 'prod', 'dev'])('accepts the URL value %s', function (value) {
        expect(parseDepTypeParam(value)).toBe(value)
    })

    // null means "not specified in the URL", which the caller resolves against the configured default —
    // distinct from any particular dep type.
    it.each([
        ['undefined', undefined],
        ['null', null],
        ['empty', ''],
        ['an unknown value', 'peer'],
        ['a differently-cased value', 'PROD']
    ])('returns null for %s', function (_label, value) {
        expect(parseDepTypeParam(value as string | null | undefined)).toBeNull()
    })
})
