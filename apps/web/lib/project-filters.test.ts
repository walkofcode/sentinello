import { describe, expect, test } from 'vitest'
import {
    buildProjectFiltersUrl,
    mergeProjectFiltersIntoParams,
    parseCsvParam,
    parseProjectFiltersFromSearch,
    upsertParam,
    type ProjectFiltersState
} from './project-filters'

const UNIVERSE = { roots: ['r1', 'r2', 'r3'], tags: ['prod', 'frontend'] }

const EMPTY: ProjectFiltersState = {
    query: '',
    roots: [],
    tags: [],
    minSeverity: '',
    showHealthy: false,
    showMuted: false,
    sort: 'severity',
    depType: 'prod'
}

const LOCATION = { pathname: '/', search: '', hash: '' }

describe('parseCsvParam', function suite() {
    test('returns nothing for an absent or blank param', function noParam() {
        expect(parseCsvParam(null, UNIVERSE.roots)).toEqual([])
        expect(parseCsvParam(undefined, UNIVERSE.roots)).toEqual([])
        expect(parseCsvParam('', UNIVERSE.roots)).toEqual([])
    })

    test('trims entries and drops empties left by a trailing comma', function trims() {
        expect(parseCsvParam(' r1 , r2 ,', UNIVERSE.roots)).toEqual(['r1', 'r2'])
    })

    test('drops ids that are not in the available universe', function intersects() {
        // A root deleted in Settings leaves a stale id in a bookmarked URL; filtering the table to
        // nothing would be worse than ignoring it.
        expect(parseCsvParam('r1,gone', UNIVERSE.roots)).toEqual(['r1'])
        expect(parseCsvParam('gone', UNIVERSE.roots)).toEqual([])
    })

    test('returns the universe order, not the param order', function ordered() {
        expect(parseCsvParam('r3,r1', UNIVERSE.roots)).toEqual(['r1', 'r3'])
    })
})

describe('parseProjectFiltersFromSearch', function suite() {
    test('reads every param it owns', function all() {
        const parsed = parseProjectFiltersFromSearch(
            '?pq=checkout&proot=r1,r2&ptag=prod&psev=high&phealthy=1&pmuted=1&psort=name&pdep=all',
            UNIVERSE
        )
        expect(parsed).toEqual({
            query: 'checkout',
            roots: ['r1', 'r2'],
            tags: ['prod'],
            minSeverity: 'high',
            showHealthy: true,
            showMuted: true,
            sort: 'name',
            depType: 'all'
        })
    })

    test('returns nothing for a bare URL so component defaults stand', function none() {
        expect(parseProjectFiltersFromSearch('', UNIVERSE)).toEqual({})
    })

    test('ignores values outside each param’s allowed set', function invalid() {
        const parsed = parseProjectFiltersFromSearch('?psev=spicy&psort=colour&pdep=maybe&pq=', UNIVERSE)
        expect(parsed).toEqual({})
    })

    test('omits a multi-select whose every id was intersected away', function staleOnly() {
        expect(parseProjectFiltersFromSearch('?proot=gone&ptag=gone', UNIVERSE)).toEqual({})
    })

    test('treats any value other than 1 as unset for the boolean toggles', function booleans() {
        expect(parseProjectFiltersFromSearch('?phealthy=true&pmuted=0', UNIVERSE)).toEqual({})
    })
})

describe('mergeProjectFiltersIntoParams', function suite() {
    test('writes nothing for a default state', function defaults() {
        const params = mergeProjectFiltersIntoParams(new URLSearchParams(), EMPTY, 'prod')
        expect(params.toString()).toBe('')
    })

    test('writes every non-default value', function populated() {
        const params = mergeProjectFiltersIntoParams(
            new URLSearchParams(),
            {
                query: 'checkout',
                roots: ['r1', 'r2'],
                tags: ['prod', 'frontend'],
                minSeverity: 'high',
                showHealthy: true,
                showMuted: true,
                sort: 'name',
                depType: 'dev'
            },
            'prod'
        )
        expect(Object.fromEntries(params)).toEqual({
            pq: 'checkout',
            proot: 'r1,r2',
            ptag: 'prod,frontend',
            psev: 'high',
            phealthy: '1',
            pmuted: '1',
            psort: 'name',
            pdep: 'dev'
        })
    })

    test('omits pdep when it equals the instance default and writes it when it does not', function dep() {
        const atDefault = mergeProjectFiltersIntoParams(new URLSearchParams(), { ...EMPTY, depType: 'dev' }, 'dev')
        expect(atDefault.has('pdep')).toBe(false)
        const away = mergeProjectFiltersIntoParams(new URLSearchParams(), { ...EMPTY, depType: 'dev' }, 'all')
        expect(away.get('pdep')).toBe('dev')
    })

    test('clears params that fall back to their default', function clears() {
        const params = new URLSearchParams('pq=old&proot=r1&ptag=prod&psev=low&phealthy=1&pmuted=1&psort=name&pdep=all')
        mergeProjectFiltersIntoParams(params, EMPTY, 'prod')
        expect(params.toString()).toBe('')
    })

    test('leaves params belonging to other views alone', function siblings() {
        const params = new URLSearchParams('ldep=dev&lq=lodash')
        mergeProjectFiltersIntoParams(params, { ...EMPTY, query: 'checkout' }, 'prod')
        expect(Object.fromEntries(params)).toEqual({ ldep: 'dev', lq: 'lodash', pq: 'checkout' })
    })
})

describe('upsertParam', function suite() {
    test('sets a truthy value and deletes on false or undefined', function both() {
        const params = new URLSearchParams('a=1&b=2')
        upsertParam(params, 'a', 'kept')
        upsertParam(params, 'b', false)
        upsertParam(params, 'c', undefined)
        expect(params.toString()).toBe('a=kept')
    })
})

describe('buildProjectFiltersUrl', function suite() {
    test('drops the question mark entirely when no params survive', function bare() {
        expect(buildProjectFiltersUrl(LOCATION, EMPTY, 'prod')).toBe('/')
    })

    test('preserves the pathname and hash around the rebuilt query', function around() {
        const url = buildProjectFiltersUrl(
            { pathname: '/', search: '?ldep=dev', hash: '#projects' },
            { ...EMPTY, query: 'checkout' },
            'prod'
        )
        expect(url).toBe('/?ldep=dev&pq=checkout#projects')
    })
})
