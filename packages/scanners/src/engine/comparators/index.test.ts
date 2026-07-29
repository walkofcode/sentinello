import { describe, expect, it } from 'vitest'
import { ECOSYSTEMS } from '@sentinello/core'
import { acceptedRangeTypesForEcosystem, comparatorForEcosystem } from './index'
import { semverComparator } from './semver'
import { pep440Comparator } from './pep440'

// This registry is the guard against comparing versions with the wrong semantics. Both functions
// return null for anything they cannot answer for, and every caller is required to treat that as
// "skip this ecosystem" rather than falling back to semver — PEP 440 and semver disagree about the
// ordering of "1.0.0-rc1" vs "1.0.0rc1", so a silent fallback mismatches quietly rather than loudly.

describe('comparatorForEcosystem', function () {
    it.each([
        ['npm', semverComparator],
        ['Go', semverComparator],
        ['crates.io', semverComparator],
        ['PyPI', pep440Comparator]
    ] as Array<[string, unknown]>)('resolves %s', function (ecosystem, expected) {
        expect(comparatorForEcosystem(ecosystem)).toBe(expected)
    })

    // Null, not semver. An id the registry does not know must stop the match rather than being
    // compared under whatever comparator happens to be the default.
    it.each(['maven', 'RubyGems', '', 'NPM'])('returns null for the unknown ecosystem %j', function (ecosystem) {
        expect(comparatorForEcosystem(ecosystem)).toBeNull()
    })

    // Every registered ecosystem must resolve, or it would be listed in the UI as scannable while
    // silently matching nothing.
    it('resolves a comparator for every registered ecosystem', function () {
        for (const eco of ECOSYSTEMS) {
            expect(comparatorForEcosystem(eco.id)).not.toBeNull()
        }
    })
})

describe('acceptedRangeTypesForEcosystem', function () {
    // semver ecosystems read both OSV range flavours; PEP 440 reads only ECOSYSTEM, because a
    // SEMVER-typed range on a PyPI advisory carries version strings its comparator cannot evaluate.
    it('lets the semver ecosystems read both range types', function () {
        expect(acceptedRangeTypesForEcosystem('npm')).toEqual(['SEMVER', 'ECOSYSTEM'])
    })

    it('restricts PyPI to ECOSYSTEM ranges', function () {
        expect(acceptedRangeTypesForEcosystem('PyPI')).toEqual(['ECOSYSTEM'])
    })

    it.each(['maven', 'RubyGems', ''])('returns null for the unknown ecosystem %j', function (ecosystem) {
        expect(acceptedRangeTypesForEcosystem(ecosystem)).toBeNull()
    })

    it('declares accepted types for every registered ecosystem', function () {
        for (const eco of ECOSYSTEMS) {
            expect(acceptedRangeTypesForEcosystem(eco.id)?.length).toBeGreaterThan(0)
        }
    })
})
