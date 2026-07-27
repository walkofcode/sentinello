import { describe, expect, it } from 'vitest'
import {
    DEFAULT_ECOSYSTEM,
    ECOSYSTEMS,
    ecosystemForOsvId,
    getEcosystem,
    getSource,
    SOURCE_IDS,
    SOURCES,
    sourceSupportsEcosystem,
    sourcesForEcosystem
} from './ecosystems'

// This is the registry every other layer reads: which languages exist, which sources can answer for
// them, and what an unset (source, ecosystem) cell defaults to. The invariants below are the ones that
// would silently mis-render the Settings matrix or mis-route a resolver if they drifted.

describe('the ecosystem registry', function () {
    it('has a unique id per ecosystem', function () {
        const ids = ECOSYSTEMS.map(function id(e) { return e.id })
        expect(new Set(ids).size).toBe(ids.length)
    })

    it('has a unique OSV feed id per ecosystem', function () {
        const ids = ECOSYSTEMS.map(function osv(e) { return e.osvEcosystem })
        expect(new Set(ids).size).toBe(ids.length)
    })

    // A resolver kind claimed by two ecosystems would make lockfile routing ambiguous.
    it('never claims the same resolver kind from two ecosystems', function () {
        const kinds = ECOSYSTEMS.flatMap(function resolverKinds(e) { return e.resolverKinds })
        expect(new Set(kinds).size).toBe(kinds.length)
    })

    it('gives every ecosystem a comparator and at least one resolver kind', function () {
        for (const eco of ECOSYSTEMS) {
            expect(eco.comparator.length).toBeGreaterThan(0)
            expect(eco.resolverKinds.length).toBeGreaterThan(0)
        }
    })

    it('names a default ecosystem that is actually registered', function () {
        expect(getEcosystem(DEFAULT_ECOSYSTEM)).not.toBeNull()
    })
})

describe('getEcosystem', function () {
    it('finds a registered ecosystem by id', function () {
        expect(getEcosystem('npm')?.language).toBe('javascript')
        expect(getEcosystem('PyPI')?.comparator).toBe('pep440')
    })

    it('returns null for an unknown id', function () {
        expect(getEcosystem('Hackage')).toBeNull()
    })

    // Ids are persisted values, so a case-insensitive match would silently accept bad data.
    it('is case sensitive', function () {
        expect(getEcosystem('pypi')).toBeNull()
    })
})

describe('ecosystemForOsvId', function () {
    it('resolves a canonical OSV feed id back to its ecosystem', function () {
        expect(ecosystemForOsvId('PyPI')?.id).toBe('PyPI')
        expect(ecosystemForOsvId('crates.io')?.id).toBe('crates.io')
    })

    it('returns null for an OSV id we do not carry', function () {
        expect(ecosystemForOsvId('Packagist')).toBeNull()
    })
})

describe('the source registry', function () {
    it('lists every source id in SOURCE_IDS', function () {
        const defined = SOURCES.map(function id(s) { return s.id }).sort()
        expect([...SOURCE_IDS].sort()).toEqual(defined)
    })

    it('resolves every SOURCE_IDS entry to a definition', function () {
        for (const id of SOURCE_IDS) {
            expect(getSource(id)).not.toBeNull()
        }
    })

    // npm-audit is authoritative and runs live, so it is the only source enabled by default; the
    // cache-backed sources stay off until the operator opts in and the cache is downloaded.
    it('enables only npm-audit by default', function () {
        expect(getSource('npm-audit')?.defaultEnabled).toBe(true)
        expect(getSource('osv')?.defaultEnabled).toBe(false)
        expect(getSource('gemnasium')?.defaultEnabled).toBe(false)
    })

    it('marks exactly the cache-backed sources as cache-backed', function () {
        expect(getSource('npm-audit')?.cacheBacked).toBe(false)
        expect(getSource('osv')?.cacheBacked).toBe(true)
        expect(getSource('gemnasium')?.cacheBacked).toBe(true)
    })
})

describe('getSource', function () {
    it('finds a registered source', function () {
        expect(getSource('osv')?.displayName).toBe('OSV')
    })

    it('returns null for an unknown source', function () {
        expect(getSource('snyk')).toBeNull()
    })
})

describe('sourceSupportsEcosystem', function () {
    // npm-audit shells out to a JavaScript package manager, so it can only ever answer for npm.
    it('restricts npm-audit to the npm ecosystem', function () {
        expect(sourceSupportsEcosystem('npm-audit', 'npm')).toBe(true)
        expect(sourceSupportsEcosystem('npm-audit', 'PyPI')).toBe(false)
        expect(sourceSupportsEcosystem('npm-audit', 'Go')).toBe(false)
        expect(sourceSupportsEcosystem('npm-audit', 'crates.io')).toBe(false)
    })

    // A null supportedEcosystems means polyglot — every registered ecosystem.
    it.each(['osv', 'gemnasium'] as Array<'osv' | 'gemnasium'>)('lets %s answer for every ecosystem', function (source) {
        for (const eco of ECOSYSTEMS) {
            expect(sourceSupportsEcosystem(source, eco.id)).toBe(true)
        }
    })
})

describe('sourcesForEcosystem', function () {
    it('returns the sources for npm in dedup-priority order', function () {
        expect(sourcesForEcosystem('npm')).toEqual(['npm-audit', 'osv', 'gemnasium'])
    })

    it('omits npm-audit for a non-JavaScript ecosystem', function () {
        expect(sourcesForEcosystem('PyPI')).toEqual(['osv', 'gemnasium'])
        expect(sourcesForEcosystem('Go')).toEqual(['osv', 'gemnasium'])
    })

    // Every ecosystem must have at least one source, or it could never be scanned at all.
    it('gives every registered ecosystem at least one source', function () {
        for (const eco of ECOSYSTEMS) {
            expect(sourcesForEcosystem(eco.id).length).toBeGreaterThan(0)
        }
    })
})
