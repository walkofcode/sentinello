import { describe, expect, it } from 'vitest'
import { compareVersions, goComparator, highestVersion, pep440Comparator, rubygemsComparator, semverComparator } from './index'

function bySemver(a: string, b: string): number {
    return compareVersions(a, b, semverComparator)
}

// The three portal copies this replaces disagreed on exactly the cases below, which is why each one is
// pinned rather than left to "semver handles it".

describe('compareVersions', function () {
    it('orders by release precedence, not string order', function () {
        expect(compareVersions('1.2.3', '1.2.4', semverComparator)).toBeLessThan(0)
        expect(compareVersions('1.10.0', '1.9.0', semverComparator)).toBeGreaterThan(0)
        expect(compareVersions('2.0.0', '10.0.0', semverComparator)).toBeLessThan(0)
        expect(compareVersions('1.2.3', '1.2.3', semverComparator)).toBe(0)
    })

    // One copy compared `split('.')` segments and never looked at the prerelease, so these two sorted
    // EQUAL — which silently collapsed them in the version list shown beside a finding.
    it('sorts a prerelease below its release', function () {
        expect(compareVersions('1.0.0-rc1', '1.0.0', semverComparator)).toBeLessThan(0)
        expect(compareVersions('1.0.0', '1.0.0-rc1', semverComparator)).toBeGreaterThan(0)
    })

    // Another copy ordered prerelease tags with localeCompare, which puts "rc.10" BEFORE "rc.2".
    it('orders numeric prerelease identifiers numerically', function () {
        expect(compareVersions('1.0.0-rc.2', '1.0.0-rc.10', semverComparator)).toBeLessThan(0)
    })

    it('reads a leading v', function () {
        expect(compareVersions('v1.2.3', '1.2.3', semverComparator)).toBe(0)
        expect(compareVersions('v2.0.0', '1.9.9', semverComparator)).toBeGreaterThan(0)
    })

    it('treats a truncated release as its zero-padded form', function () {
        expect(compareVersions('1.2', '1.2.0', semverComparator)).toBe(0)
    })

    // Total ordering matters here: this feeds Array.prototype.sort, and an inconsistent comparator gives
    // an implementation-defined order that can differ between renders.
    //
    // The DIRECTION matters too, and is not merely cosmetic: the same comparator picks the "upgrade to"
    // version shown beside a finding, so sorting unreadable values HIGH would recommend a wildcard like
    // "4.17.x" over the real 4.17.21. Below every readable version is the only safe end for them.
    it('sorts unreadable values below readable ones, deterministically', function () {
        expect(compareVersions('workspace:*', '1.0.0', semverComparator)).toBeLessThan(0)
        expect(compareVersions('1.0.0', 'workspace:*', semverComparator)).toBeGreaterThan(0)
        expect(compareVersions('aaa', 'bbb', semverComparator)).toBeLessThan(0)
        expect(compareVersions('bbb', 'aaa', semverComparator)).toBeGreaterThan(0)
        expect(compareVersions('aaa', 'aaa', semverComparator)).toBe(0)
    })

    it('sorts a mixed list stably', function () {
        const sorted = ['9.9.9', 'garbage', '1.0.0-rc1', '1.0.0', '2.0.0'].sort(bySemver)
        expect(sorted).toEqual(['garbage', '1.0.0-rc1', '1.0.0', '2.0.0', '9.9.9'])
    })
})

describe('highestVersion', function () {
    it('picks the highest by precedence', function () {
        expect(highestVersion(['1.0.0', '10.0.0', '2.0.0'], semverComparator)).toBe('10.0.0')
        expect(highestVersion(['1.0.0-rc1', '1.0.0'], semverComparator)).toBe('1.0.0')
    })

    it('returns null for an empty list', function () {
        expect(highestVersion([], semverComparator)).toBeNull()
    })

    it('returns the only entry even when it is unreadable', function () {
        expect(highestVersion(['not-a-version'], semverComparator)).toBe('not-a-version')
    })

    // Never recommend an upgrade target we could not parse when a real one is on offer.
    it('prefers a readable version over an unreadable one', function () {
        expect(highestVersion(['4.17.x', '4.17.21'], semverComparator)).toBe('4.17.21')
        expect(highestVersion(['4.17.21', '4.17.x'], semverComparator)).toBe('4.17.21')
    })
})

// Relocated verbatim from apps/web/components/findings/group-by-library.test.ts, which pinned one of the
// three copies this replaces. Its cases were good; only its home was wrong.
describe('compareVersions — cases inherited from the portal copy', function () {
    it.each([
        ['1.0.1', '1.0.0'],
        ['1.1.0', '1.0.9'],
        ['2.0.0', '1.99.99'],
        ['1.0.10', '1.0.9'],
        ['1.0.0', '1.0.0-beta'],
        ['1.0.0-beta', '1.0.0-alpha'],
        ['1.0.1', '1.0'],
        ['v2.0.0', '1.0.0']
    ] as Array<[string, string]>)('ranks %s above %s', function (higher, lower) {
        expect(compareVersions(higher, lower, semverComparator)).toBeGreaterThan(0)
        expect(compareVersions(lower, higher, semverComparator)).toBeLessThan(0)
    })

    it.each([
        ['1.0.0', '1.0.0'],
        ['1.0.0', 'v1.0.0'],
        ['1.0.0', '=1.0.0'],
        ['1.0', '1.0.0'],
        ['1.0.0-beta', '1.0.0-beta']
    ] as Array<[string, string]>)('ranks %s equal to %s', function (a, b) {
        expect(compareVersions(a, b, semverComparator)).toBe(0)
    })

    // CHANGED from the copy this replaces, which asserted "1.x.0" compares EQUAL to "1.0.0" — it read the
    // wildcard segment as a zero. A wildcard is range syntax, not a version, so it now sorts below every
    // real version instead of silently impersonating one.
    it('sorts a wildcard segment below a real version rather than reading it as zero', function () {
        expect(compareVersions('1.x.0', '1.0.0', semverComparator)).toBeLessThan(0)
    })
})

// The comparator is the whole point of the argument: the same two strings order differently per ecosystem,
// and picking the "upgrade to" version under the wrong one is how a Django 4.2 advisory recommended 3.2.x.
describe('compareVersions — under each ecosystem\'s comparator', function () {
    it('orders PEP 440 releases, pre-releases and post-releases by PEP 440', function () {
        expect(highestVersion(['3.2.23', '4.2', '4.2.11'], pep440Comparator)).toBe('4.2.11')
        expect(compareVersions('4.2', '4.2.0', pep440Comparator)).toBe(0)
        expect(compareVersions('1.0rc1', '1.0', pep440Comparator)).toBeLessThan(0)
        expect(compareVersions('1.0.post1', '1.0', pep440Comparator)).toBeGreaterThan(0)
    })

    it('orders Go pseudo-versions below the tag they precede', function () {
        expect(compareVersions('v0.0.0-20180523222229-09b5706aa936', 'v0.1.0', goComparator)).toBeLessThan(0)
        expect(compareVersions('v1.2.4-0.20190101000000-abcdefabcdef', 'v1.2.3', goComparator)).toBeGreaterThan(0)
        expect(highestVersion(['v1.9.0', 'v1.10.0'], goComparator)).toBe('v1.10.0')
    })

    // Go reads no partial version, so "1.2" is unreadable there and sorts below every real one.
    it('does not coerce a partial Go version', function () {
        expect(compareVersions('1.2', 'v1.0.0', goComparator)).toBeLessThan(0)
    })

    it('orders RubyGems prereleases below their release', function () {
        expect(compareVersions('7.1.0.rc1', '7.1.0', rubygemsComparator)).toBeLessThan(0)
        expect(highestVersion(['7.0.8.1', '7.1.0.beta1', '7.0.8'], rubygemsComparator)).toBe('7.1.0.beta1')
    })
})
