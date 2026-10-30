import { describe, expect, it } from 'vitest'
import { ECOSYSTEMS } from '@sentinello/core'
import { goComparator, pep440Comparator, rubygemsComparator, semverComparator } from '@sentinello/versions'
import { acceptedRangeTypesForEcosystem, comparatorForEcosystem } from './index'

// This registry is the guard against comparing versions with the wrong semantics. Both functions return
// null for anything they cannot answer for, and every caller is required to treat that as "skip this
// ecosystem" rather than falling back to semver — PEP 440 and semver disagree about the ordering of
// "1.0.0-rc1" vs "1.0.0rc1", so a silent fallback mismatches quietly rather than loudly. Both tables are
// Records over the closed comparator-id union, so an ecosystem naming a comparator without an
// implementation or accepted range types does not compile.

describe('comparatorForEcosystem', function () {
    it.each([
        ['npm', semverComparator],
        ['crates.io', semverComparator],
        ['Go', goComparator],
        ['PyPI', pep440Comparator],
        ['RubyGems', rubygemsComparator]
    ] as Array<[string, unknown]>)('resolves %s', function (ecosystem, expected) {
        expect(comparatorForEcosystem(ecosystem)).toBe(expected)
    })

    // Null, not semver. An id the registry does not know must stop the match rather than being
    // compared under whatever comparator happens to be the default.
    it.each(['maven', '', 'NPM'])('returns null for the unknown ecosystem %j', function (ecosystem) {
        expect(comparatorForEcosystem(ecosystem)).toBeNull()
    })

    // Every registered ecosystem must resolve, or it would be listed as scannable while matching nothing.
    it('resolves a comparator for every registered ecosystem', function () {
        for (const eco of ECOSYSTEMS) {
            expect(comparatorForEcosystem(eco.id)?.id).toBe(eco.comparator)
        }
    })
})

describe('acceptedRangeTypesForEcosystem', function () {
    // semver and Go read both OSV range flavours; PEP 440 and RubyGems read only ECOSYSTEM, because a
    // SEMVER-typed range there carries version strings their comparator does not define.
    it('lets the semver-shaped ecosystems read both range types', function () {
        expect(acceptedRangeTypesForEcosystem('npm')).toEqual(['SEMVER', 'ECOSYSTEM'])
        expect(acceptedRangeTypesForEcosystem('Go')).toEqual(['SEMVER', 'ECOSYSTEM'])
    })

    it('restricts PyPI and RubyGems to ECOSYSTEM ranges', function () {
        expect(acceptedRangeTypesForEcosystem('PyPI')).toEqual(['ECOSYSTEM'])
        expect(acceptedRangeTypesForEcosystem('RubyGems')).toEqual(['ECOSYSTEM'])
    })

    it.each(['maven', ''])('returns null for the unknown ecosystem %j', function (ecosystem) {
        expect(acceptedRangeTypesForEcosystem(ecosystem)).toBeNull()
    })

    it('declares accepted types for every registered ecosystem', function () {
        for (const eco of ECOSYSTEMS) {
            expect(acceptedRangeTypesForEcosystem(eco.id)?.length).toBeGreaterThan(0)
        }
    })
})
