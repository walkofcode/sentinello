import { describe, expect, it } from 'vitest'
import { affectedSetContains, affectedSetFromRange, splitInstalled, type AffectedSet } from './version-fix'

// The affected set as the scanners hand it to settlement (@sentinello/fixes): what it contains, how one is
// built from a source's range string, and how installed copies are read.

function affected(overrides: Partial<AffectedSet> = {}): AffectedSet {
    return { ranges: '<1.1.0', exact: [], complete: true, ...overrides }
}

describe('affectedSetContains', function () {
    it('reads ranges and exact versions together', function () {
        const set = affected({ ranges: '<1.1.0', exact: ['1.1.0'] })
        expect(affectedSetContains(set, '1.0.0')).toBe(true)
        expect(affectedSetContains(set, '1.1.0')).toBe(true)
        expect(affectedSetContains(set, '1.2.0')).toBe(false)
    })

    // A prerelease inside the bounds is affected whatever its tag.
    it('counts a prerelease inside the bounds as affected', function () {
        expect(affectedSetContains(affected({ ranges: '>=1.0.0 <2.0.0' }), '1.5.0-beta.1')).toBe(true)
    })

    // issue 011: `v1.2.1` and `1.2.1+build` are the release 1.2.1 and must not slip past an exact entry for it.
    it('normalizes the candidate, and answers null for one it cannot read', function () {
        const exactOnly: AffectedSet = { ranges: null, exact: ['1.2.1'], complete: true }
        expect(affectedSetContains(exactOnly, 'v1.2.1')).toBe(true)
        expect(affectedSetContains(exactOnly, '1.2.1+build.7')).toBe(true)
        expect(affectedSetContains(exactOnly, '1.2.2')).toBe(false)
        expect(affectedSetContains(exactOnly, 'not a version >=')).toBeNull()
    })

    it('answers null, never false, for a set it cannot evaluate', function () {
        expect(affectedSetContains(affected({ complete: false }), '9.9.9')).toBeNull()
        expect(affectedSetContains(affected({ ranges: '>>>' }), '9.9.9')).toBeNull()
    })
})

describe('affectedSetFromRange', function () {
    it('keeps a parseable range as complete', function () {
        expect(affectedSetFromRange(' <=3.0.3 ')).toEqual({ ranges: '<=3.0.3', exact: [], complete: true })
    })

    it.each([
        ['an empty range', '', null],
        ['an unparseable range', 'all versions', 'all versions'],
        ['the no-patch sentinel in the vulnerable field', '<0.0.0', '<0.0.0']
    ])('marks %s incomplete', function (_label, input, ranges) {
        expect(affectedSetFromRange(input as string)).toEqual({ ranges, exact: [], complete: false })
    })
})

describe('splitInstalled', function () {
    it('splits comma- and space-joined copies and drops empties', function () {
        expect(splitInstalled(' 1.0.0, 1.5.0  2.0.0 ,')).toEqual(['1.0.0', '1.5.0', '2.0.0'])
        expect(splitInstalled('')).toEqual([])
        expect(splitInstalled(null)).toEqual([])
    })
})
