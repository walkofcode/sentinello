import { describe, expect, it } from 'vitest'
import { makeGraph, parseDepKey, reachableFrom, splitVersions } from './graph'
import type { DepScope, ResolvedPackage } from './types'

function pkg(name: string, version: string, scope: Partial<DepScope> = {}): ResolvedPackage {
    return {
        ecosystem: 'npm',
        name,
        version,
        scope: { isProd: true, isDev: false, isOptional: false, ...scope },
        depPaths: []
    }
}

describe('reachableFrom', function () {
    it('includes the roots themselves', function () {
        expect([...reachableFrom(['a'], new Map())]).toEqual(['a'])
    })

    it('walks transitively', function () {
        const adjacency = new Map([
            ['a', ['b']],
            ['b', ['c']],
            ['c', ['d']]
        ])
        expect([...reachableFrom(['a'], adjacency)].sort()).toEqual(['a', 'b', 'c', 'd'])
    })

    // Iterative with an explicit visited set, so a cycle must terminate rather than hang.
    it('terminates on a cycle', function () {
        const adjacency = new Map([
            ['a', ['b']],
            ['b', ['a']]
        ])
        expect([...reachableFrom(['a'], adjacency)].sort()).toEqual(['a', 'b'])
    })

    it('does not reach nodes outside the roots', function () {
        const adjacency = new Map([
            ['a', ['b']],
            ['x', ['y']]
        ])
        expect([...reachableFrom(['a'], adjacency)].sort()).toEqual(['a', 'b'])
    })

    it('unions several roots and deduplicates a shared child', function () {
        const adjacency = new Map([
            ['a', ['shared']],
            ['b', ['shared']]
        ])
        expect([...reachableFrom(['a', 'b'], adjacency)].sort()).toEqual(['a', 'b', 'shared'])
    })

    it('handles a duplicated root', function () {
        expect([...reachableFrom(['a', 'a'], new Map())]).toEqual(['a'])
    })

    it('returns nothing for no roots', function () {
        expect([...reachableFrom([], new Map([['a', ['b']]]))]).toEqual([])
    })
})

describe('splitVersions', function () {
    it('splits a comma-joined list', function () {
        expect(splitVersions('1.0.0, 2.0.0')).toEqual(['1.0.0', '2.0.0'])
    })

    it('splits on whitespace too', function () {
        expect(splitVersions('1.0.0 2.0.0')).toEqual(['1.0.0', '2.0.0'])
    })

    it('returns a single version unchanged', function () {
        expect(splitVersions('1.0.0')).toEqual(['1.0.0'])
    })

    it.each([null, '', '   '])('returns an empty list for %j', function (raw) {
        expect(splitVersions(raw)).toEqual([])
    })
})

describe('makeGraph.byName', function () {
    it('returns every package sharing a name', function () {
        const graph = makeGraph([pkg('a', '1.0.0'), pkg('a', '2.0.0'), pkg('b', '1.0.0')])
        expect(graph.byName('a').map(function version(p) { return p.version })).toEqual(['1.0.0', '2.0.0'])
    })

    it('returns an empty list for an unknown name', function () {
        expect(makeGraph([]).byName('nope')).toEqual([])
    })

    it('exposes the package list as given', function () {
        const packages = [pkg('a', '1.0.0')]
        expect(makeGraph(packages).packages).toBe(packages)
    })
})

describe('makeGraph.classify', function () {
    // Fail-open: a finding on a package the lockfile does not mention must not be hidden, so it
    // defaults to prod rather than being filtered out as dev-only.
    it('defaults an unknown package to prod', function () {
        expect(makeGraph([]).classify('ghost', '1.0.0')).toEqual({ isProd: true, isDev: false, isOptional: false })
    })

    it('reads the scope of an exact name+version match', function () {
        const graph = makeGraph([pkg('a', '1.0.0', { isProd: false, isDev: true })])
        expect(graph.classify('a', '1.0.0')).toEqual({ isProd: false, isDev: true, isOptional: false })
    })

    it('picks the matching version out of several', function () {
        const graph = makeGraph([
            pkg('a', '1.0.0', { isProd: true, isDev: false }),
            pkg('a', '2.0.0', { isProd: false, isDev: true })
        ])
        expect(graph.classify('a', '2.0.0')).toEqual({ isProd: false, isDev: true, isOptional: false })
    })

    // Version unknown — union across every version of the name rather than guessing one.
    it('unions across all versions when the version is null', function () {
        const graph = makeGraph([
            pkg('a', '1.0.0', { isProd: true, isDev: false }),
            pkg('a', '2.0.0', { isProd: false, isDev: true })
        ])
        expect(graph.classify('a', null)).toEqual({ isProd: true, isDev: true, isOptional: false })
    })

    // Hoisting / version drift: the reported version is not in the lockfile, so fall back to the union
    // instead of silently dropping to the unknown-package default.
    it('unions across all versions when no version matches', function () {
        const graph = makeGraph([
            pkg('a', '1.0.0', { isProd: false, isDev: true }),
            pkg('a', '2.0.0', { isProd: false, isDev: true })
        ])
        expect(graph.classify('a', '9.9.9')).toEqual({ isProd: false, isDev: true, isOptional: false })
    })

    it('classifies a comma-joined version list across every match', function () {
        const graph = makeGraph([
            pkg('a', '1.0.0', { isProd: true, isDev: false }),
            pkg('a', '2.0.0', { isProd: false, isDev: true }),
            pkg('a', '3.0.0', { isProd: false, isDev: false })
        ])
        expect(graph.classify('a', '1.0.0, 2.0.0')).toEqual({ isProd: true, isDev: true, isOptional: false })
    })

    // isOptional starts true and is cleared by any non-optional match — a package that is optional on
    // one path and required on another is required.
    it('treats a package as optional only when every match is optional', function () {
        const allOptional = makeGraph([pkg('a', '1.0.0', { isOptional: true }), pkg('a', '2.0.0', { isOptional: true })])
        expect(allOptional.classify('a', null).isOptional).toBe(true)

        const mixed = makeGraph([pkg('a', '1.0.0', { isOptional: true }), pkg('a', '2.0.0', { isOptional: false })])
        expect(mixed.classify('a', null).isOptional).toBe(false)
    })

    // A row that is neither prod nor dev would classify a finding into nothing and hide it, so prod wins.
    it('falls back to prod when a match is neither prod nor dev', function () {
        const graph = makeGraph([pkg('a', '1.0.0', { isProd: false, isDev: false })])
        expect(graph.classify('a', '1.0.0')).toEqual({ isProd: true, isDev: false, isOptional: false })
    })
})

describe('parseDepKey', function () {
    it.each([
        ['lodash@4.17.21', 'lodash', '4.17.21'],
        ['/lodash@4.17.21', 'lodash', '4.17.21'],
        ['@babel/core@7.0.0', '@babel/core', '7.0.0'],
        ['/@babel/core@7.0.0', '@babel/core', '7.0.0'],
        ['/@babel/core@7.0.0(supports-color@8.0.0)', '@babel/core', '7.0.0'],
        ['lodash@4.17.21(peer@1.0.0)', 'lodash', '4.17.21'],
        ['  lodash@4.17.21  ', 'lodash', '4.17.21']
    ] as Array<[string, string, string]>)('parses %s', function (key, name, version) {
        expect(parseDepKey(key)).toEqual({ name, version })
    })

    it.each(['', '   ', 'lodash', '@scope', '@babel/core', '/', '@1.0.0'])(
        'returns null for the unparseable %j',
        function (key) {
            expect(parseDepKey(key)).toBeNull()
        }
    )
})
