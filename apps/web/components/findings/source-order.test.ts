import { describe, expect, it } from 'vitest'
import { ECOSYSTEMS } from '@sentinello/core'
import { orderEcosystems, orderSources, parseEcosystemParam, parseSourceParam } from './source-order'

describe('orderSources', function () {
    it('puts npm-audit before osv before gemnasium regardless of input order', function () {
        expect(orderSources(['gemnasium', 'osv', 'npm-audit'])).toEqual(['npm-audit', 'osv', 'gemnasium'])
    })

    it('deduplicates', function () {
        expect(orderSources(['osv', 'osv', 'npm-audit'])).toEqual(['npm-audit', 'osv'])
    })

    // Unknown sources all share rank 9, so the localeCompare tiebreak is what keeps them stable.
    it('sorts unknown sources alphabetically after the known ones', function () {
        expect(orderSources(['zeta', 'alpha', 'osv'])).toEqual(['osv', 'alpha', 'zeta'])
    })

    it('accepts any iterable', function () {
        expect(orderSources(new Set(['osv', 'npm-audit']))).toEqual(['npm-audit', 'osv'])
    })

    it('returns an empty list for no sources', function () {
        expect(orderSources([])).toEqual([])
    })
})

describe('parseSourceParam', function () {
    it('selects the requested sources, in available order', function () {
        expect(parseSourceParam('osv,npm-audit', ['npm-audit', 'osv', 'gemnasium'])).toEqual(['npm-audit', 'osv'])
    })

    it('tolerates whitespace around the entries', function () {
        expect(parseSourceParam(' osv , npm-audit ', ['npm-audit', 'osv'])).toEqual(['npm-audit', 'osv'])
    })

    // A source that was disabled after the URL was bookmarked must not resurrect itself.
    it('ignores a requested source that is not available', function () {
        expect(parseSourceParam('osv,retired', ['npm-audit', 'osv'])).toEqual(['osv'])
    })

    it.each([null, undefined, ''])('treats %j as "all" by returning an empty selection', function (raw) {
        expect(parseSourceParam(raw, ['npm-audit', 'osv'])).toEqual([])
    })

    it('returns an empty selection when nothing requested is available', function () {
        expect(parseSourceParam('nope', ['npm-audit'])).toEqual([])
    })
})

describe('orderEcosystems', function () {
    it('follows registry order', function () {
        const ids = ECOSYSTEMS.map(function id(eco) {
            return eco.id
        })
        const shuffled = [...ids].reverse()
        expect(orderEcosystems(shuffled)).toEqual(ids)
    })

    it('sorts an unknown ecosystem after the registered ones', function () {
        const first = ECOSYSTEMS[0]
        expect(first).toBeDefined()
        if (!first) return
        expect(orderEcosystems(['Hackage', first.id])).toEqual([first.id, 'Hackage'])
    })

    // Two unknowns share the same rank, so the registry order cannot separate them and the name
    // tie-break is what stops their order depending on which one the caller happened to list first.
    it('breaks a tie between two unknown ecosystems by name', function () {
        expect(orderEcosystems(['Pub', 'Hackage'])).toEqual(['Hackage', 'Pub'])
        expect(orderEcosystems(['Hackage', 'Pub'])).toEqual(['Hackage', 'Pub'])
    })

    it('deduplicates', function () {
        const first = ECOSYSTEMS[0]
        expect(first).toBeDefined()
        if (!first) return
        expect(orderEcosystems([first.id, first.id])).toEqual([first.id])
    })
})

describe('parseEcosystemParam', function () {
    it('selects the requested ecosystems, in available order', function () {
        expect(parseEcosystemParam('Go,npm', ['npm', 'PyPI', 'Go'])).toEqual(['npm', 'Go'])
    })

    it('ignores a requested ecosystem that is not available', function () {
        expect(parseEcosystemParam('npm,Hackage', ['npm', 'PyPI'])).toEqual(['npm'])
    })

    it.each([null, undefined, ''])('treats %j as "all" by returning an empty selection', function (raw) {
        expect(parseEcosystemParam(raw, ['npm'])).toEqual([])
    })
})
