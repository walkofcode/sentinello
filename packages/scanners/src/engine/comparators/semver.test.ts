import { describe, expect, it } from 'vitest'
import { semverComparator } from './semver'

// The npm-ecosystem comparator, and the one every non-PyPI ecosystem resolves to. pep440.ts has had
// its own suite since it was written; this one covers the normalize contract that gate keeps it.
//
// normalize() is the gate: gte/lt assume their inputs were already normalized, so anything normalize
// lets through at the wrong shape is compared with semver's loose rules rather than rejected. The
// two-step (strict `valid`, then lenient `coerce`) exists because advisory feeds and lockfiles both
// carry tag-style versions that are not valid semver but do name a real release.

describe('semverComparator.normalize', function () {
    it('passes a strictly valid version through unchanged', function () {
        expect(semverComparator.normalize('1.2.3')).toBe('1.2.3')
        expect(semverComparator.normalize('1.2.3-rc.1')).toBe('1.2.3-rc.1')
    })

    // The lenient second step. A leading `v` and a truncated release are both common in the wild —
    // git tags and Go pseudo-versions especially — and both name a version we can compare.
    it.each([
        ['v1.2.3', '1.2.3'],
        ['1.2', '1.2.0'],
        ['4', '4.0.0'],
        ['=1.2.3', '1.2.3']
    ])('coerces %j to %s', function (raw, expected) {
        expect(semverComparator.normalize(raw)).toBe(expected)
    })

    // Null, not a guess. A string with no version in it at all must stop the comparison rather than
    // resolve to 0.0.0, which would sort below every real release and match every range.
    it.each(['not-a-version', '', 'latest', 'workspace:*'])('returns null for %j', function (raw) {
        expect(semverComparator.normalize(raw)).toBeNull()
    })
})

describe('semverComparator ordering', function () {
    it('compares normalized versions', function () {
        expect(semverComparator.gte('1.2.3', '1.2.3')).toBe(true)
        expect(semverComparator.gte('1.2.4', '1.2.3')).toBe(true)
        expect(semverComparator.gte('1.2.2', '1.2.3')).toBe(false)
        expect(semverComparator.lt('1.2.2', '1.2.3')).toBe(true)
        expect(semverComparator.lt('1.2.3', '1.2.3')).toBe(false)
    })

    // A prerelease sorts below its release. This is what keeps "4.17.21-beta.1" from reading as
    // already fixed when the advisory says the fix landed in 4.17.21.
    it('sorts a prerelease below its release', function () {
        expect(semverComparator.lt('4.17.21-beta.1', '4.17.21')).toBe(true)
    })
})
