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

    // The guard that only lockfile-cross-check used to have. coerce() will happily read the operator off
    // the front and hand back the number behind it, so '<4.17.21' becomes 4.17.21 — the first FIXED
    // version, the exact opposite of what is installed. The comparator the matcher itself runs had no such
    // check, which meant it silently converted range syntax into a concrete version.
    it.each(['<4.17.21', '>1.2.8', '>=1.0.0 <2.0.0', '^1.5.0', '~1.5.0', '1.5.x', '1.5.0 || 3.0.0', '1.0.0 - 1.9.0', '*'])(
        'refuses the range expression %j',
        function (raw) {
            expect(semverComparator.normalize(raw)).toBeNull()
        }
    )

    // `=` is the one operator that survives, and the distinction is the guard's actual rule: every other
    // operator names a version OTHER than the one written after it, so coercing discards the meaning.
    // '=1.2.3' names exactly 1.2.3, so coercing it is lossless.
    it('still reads an exact pin, which names the version it contains', function () {
        expect(semverComparator.normalize('=1.2.3')).toBe('1.2.3')
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

    // The strict pair. Without these an exclusive lower bound and an inclusive upper bound are not merely
    // unimplemented — they are inexpressible, which is what forced the normalizers to round their bounds.
    it('distinguishes strict from non-strict at the boundary', function () {
        expect(semverComparator.gt('1.2.3', '1.2.3')).toBe(false)
        expect(semverComparator.gt('1.2.4', '1.2.3')).toBe(true)
        expect(semverComparator.lte('1.2.3', '1.2.3')).toBe(true)
        expect(semverComparator.lte('1.2.4', '1.2.3')).toBe(false)
    })
})
