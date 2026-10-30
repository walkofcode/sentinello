import { describe, expect, it } from 'vitest'
import {
    affectedSetContains,
    evaluableAffected,
    patchedVersionSet,
    rangesReadable,
    splitInstalled,
    versionSetFromSemverRange,
    type AffectedSet
} from './version-fix'
import { goComparator, pep440Comparator } from '@sentinello/versions'

// The affected set as the scanners hand it to settlement (@sentinello/fixes): what it contains, how one is
// built from a source's range string, and how installed copies are read. A set speaks its ecosystem's
// comparator, so every question below is answered by that comparator and never by semver by default.

function semverSet(range: string, overrides: Partial<AffectedSet> = {}): AffectedSet {
    return { ...versionSetFromSemverRange(range), ...overrides }
}

describe('affectedSetContains', function () {
    it('reads ranges and exact versions together', function () {
        const set = semverSet('<1.1.0', { exact: ['1.1.0'] })
        expect(affectedSetContains(set, '1.0.0')).toBe(true)
        expect(affectedSetContains(set, '1.1.0')).toBe(true)
        expect(affectedSetContains(set, '1.2.0')).toBe(false)
    })

    // A prerelease inside the bounds is affected whatever its tag.
    it('counts a prerelease inside the bounds as affected', function () {
        expect(affectedSetContains(semverSet('>=1.0.0 <2.0.0'), '1.5.0-beta.1')).toBe(true)
    })

    // issue 011: `v1.2.1` and `1.2.1+build` are the release 1.2.1 and must not slip past an exact entry for it.
    it('normalizes the candidate, and answers null for one it cannot read', function () {
        const exactOnly: AffectedSet = { comparator: 'semver', ranges: [], exact: ['1.2.1'], complete: true }
        expect(affectedSetContains(exactOnly, 'v1.2.1')).toBe(true)
        expect(affectedSetContains(exactOnly, '1.2.1+build.7')).toBe(true)
        expect(affectedSetContains(exactOnly, '1.2.2')).toBe(false)
        expect(affectedSetContains(exactOnly, 'not a version >=')).toBeNull()
    })

    it('answers null, never false, for a set it cannot evaluate', function () {
        expect(affectedSetContains(semverSet('<1.1.0', { complete: false }), '9.9.9')).toBeNull()
        expect(affectedSetContains(semverSet('>>>'), '9.9.9')).toBeNull()
        // A bound the set's own comparator cannot read makes the set unevaluable, even when it is marked
        // complete.
        expect(affectedSetContains({ comparator: 'go', ranges: [{ introduced: '0', fixed: '1.2', lastAffected: null }], exact: [], complete: true }, 'v1.0.0')).toBeNull()
        expect(affectedSetContains({ comparator: 'semver', ranges: [], exact: ['nope'], complete: true }, '1.0.0')).toBeNull()
    })

    // The whole point of carrying the comparator: PEP 440 orders 4.2 above 3.2.23 and a post-release above
    // its release; Go orders a pseudo-version below the tag it precedes.
    it('evaluates in the set\'s own comparator', function () {
        const django: AffectedSet = { comparator: 'pep440', ranges: [{ introduced: '4.2', fixed: '4.2.7', lastAffected: null }], exact: [], complete: true }
        expect(affectedSetContains(django, '4.2')).toBe(true)
        expect(affectedSetContains(django, '4.2.0.post1')).toBe(true)
        expect(affectedSetContains(django, '3.2.23')).toBe(false)
        expect(affectedSetContains(django, '4.2.7')).toBe(false)
        const goSet: AffectedSet = { comparator: 'go', ranges: [{ introduced: '0', fixed: '0.0.0-20210101000000-abcdefabcdef', lastAffected: null }], exact: [], complete: true }
        expect(affectedSetContains(goSet, 'v0.0.0-20200101000000-abcdefabcdef')).toBe(true)
        expect(affectedSetContains(goSet, 'v0.1.0')).toBe(false)
    })
})

describe('versionSetFromSemverRange', function () {
    // node-semver parses the string; each comparator set becomes one interval with the inclusivity it
    // states.
    it('reads each comparator set as one interval', function () {
        expect(versionSetFromSemverRange(' <=3.0.3 ')).toEqual({ comparator: 'semver', ranges: [{ introduced: '0', fixed: null, lastAffected: '3.0.3' }], exact: [], complete: true })
        expect(versionSetFromSemverRange('>1.0.0 <2.0.0 || >=3.0.0')).toEqual({
            comparator: 'semver',
            ranges: [
                { introduced: '1.0.0', introducedExclusive: true, fixed: '2.0.0', lastAffected: null },
                { introduced: '3.0.0', fixed: null, lastAffected: null }
            ],
            exact: [],
            complete: true
        })
        expect(versionSetFromSemverRange('*').ranges).toEqual([{ introduced: '0', fixed: null, lastAffected: null }])
    })

    // Several bounds of one side intersect to the tightest; at a tie the strict one is tighter.
    it('intersects repeated bounds', function () {
        expect(versionSetFromSemverRange('>=1.0.0 >1.0.0 >=0.5.0 <=2.0.0 <2.0.0 <3.0.0').ranges).toEqual([{ introduced: '1.0.0', introducedExclusive: true, fixed: '2.0.0', lastAffected: null }])
        expect(versionSetFromSemverRange('>1.0.0 >=1.0.0 <2.0.0 <=2.0.0').ranges).toEqual([{ introduced: '1.0.0', introducedExclusive: true, fixed: '2.0.0', lastAffected: null }])
    })

    // A pin is an exact version, kept only when the rest of its comparator set admits it.
    it('reads a pin as an exact version inside its bounds', function () {
        expect(versionSetFromSemverRange('1.2.3 || =2.0.0')).toMatchObject({ ranges: [], exact: ['1.2.3', '2.0.0'] })
        expect(versionSetFromSemverRange('>=1.0.0 =1.5.0 <2.0.0').exact).toEqual(['1.5.0'])
        expect(versionSetFromSemverRange('>=2.0.0 =1.5.0').exact).toEqual([])
        expect(versionSetFromSemverRange('>1.5.0 =1.5.0').exact).toEqual([])
        expect(versionSetFromSemverRange('<1.5.0 =1.5.0').exact).toEqual([])
        expect(versionSetFromSemverRange('<=1.5.0 =1.5.0').exact).toEqual(['1.5.0'])
        expect(versionSetFromSemverRange('=1.5.0 =1.6.0').exact).toEqual([])
    })

    it.each([
        ['an empty range', ''],
        ['an unparseable range', 'all versions'],
        ['the no-patch sentinel in the vulnerable field', '<0.0.0']
    ])('marks %s incomplete', function (_label, input) {
        expect(versionSetFromSemverRange(input)).toEqual({ comparator: 'semver', ranges: [], exact: [], complete: false })
    })
})

describe('patchedVersionSet', function () {
    it('is null when the source states no patched range', function () {
        expect(patchedVersionSet(null)).toBeNull()
        expect(patchedVersionSet('  ')).toBeNull()
        expect(patchedVersionSet('<0.0.0')).toBeNull()
    })

    it('reads a stated one, and marks an unreadable one incomplete', function () {
        expect(patchedVersionSet('>=1.2.0')?.ranges).toEqual([{ introduced: '1.2.0', fixed: null, lastAffected: null }])
        expect(patchedVersionSet('fixed in the next release')?.complete).toBe(false)
    })
})

describe('rangesReadable', function () {
    it('needs no reading of the bottom of the version space, and every other bound', function () {
        expect(rangesReadable([{ introduced: '0', fixed: 'v1.2.3', lastAffected: null }], goComparator)).toBe(true)
        // An exclusive zero is a real bound, read as 0.0.0 even by Go, which reads no partial version.
        expect(rangesReadable([{ introduced: '0', introducedExclusive: true, fixed: 'v1.2.3', lastAffected: null }], goComparator)).toBe(true)
        expect(rangesReadable([{ introduced: '1.2', fixed: 'v1.2.3', lastAffected: null }], goComparator)).toBe(false)
        expect(rangesReadable([{ introduced: '1.0', fixed: null, lastAffected: '4.2-20.el8_6' }], pep440Comparator)).toBe(false)
        expect(rangesReadable([{ introduced: 'x', fixed: null, lastAffected: null }], pep440Comparator)).toBe(false)
    })

    it('is what evaluableAffected refuses on', function () {
        expect(evaluableAffected({ comparator: 'pep440', ranges: [{ introduced: '1.0', fixed: '1.0.x', lastAffected: null }], exact: [], complete: true })).toBeNull()
    })
})

describe('splitInstalled', function () {
    it('splits comma- and space-joined copies and drops empties', function () {
        expect(splitInstalled(' 1.0.0, 1.5.0  2.0.0 ,')).toEqual(['1.0.0', '1.5.0', '2.0.0'])
        expect(splitInstalled('')).toEqual([])
        expect(splitInstalled(null)).toEqual([])
    })
})
