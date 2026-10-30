import { describe, expect, it } from 'vitest'
import { pep440Comparator, refusedRange, semverComparator, specifierCandidate, versionInRange, versionInSet, type VersionRange } from './index'

// The one place bound inclusivity is decided. Every case here is a boundary case, because boundaries are
// the only place `>` differs from `>=` and `<` from `<=` — and rounding those was producing both false
// positives (a clean version reported as critical malware) and false negatives (an affected version missed)
// depending on which direction got rounded.

function range(over: Partial<VersionRange>): VersionRange {
    return { introduced: '0', fixed: null, lastAffected: null, ...over }
}

describe('versionInRange — lower bound', function () {
    it('includes its own bound when inclusive', function () {
        const r = range({ introduced: '1.2.8' })
        expect(versionInRange('1.2.8', r, semverComparator)).toBe(true)
    })

    // npm/rc GMS-2021-3 in one assertion.
    it('excludes its own bound when exclusive', function () {
        const r = range({ introduced: '1.2.8', introducedExclusive: true })
        expect(versionInRange('1.2.8', r, semverComparator)).toBe(false)
        expect(versionInRange('1.2.9', r, semverComparator)).toBe(true)
    })

    it('excludes everything below the bound either way', function () {
        expect(versionInRange('1.2.7', range({ introduced: '1.2.8' }), semverComparator)).toBe(false)
        const exclusive = range({ introduced: '1.2.8', introducedExclusive: true })
        expect(versionInRange('1.2.7', exclusive, semverComparator)).toBe(false)
    })
})

describe('versionInRange — upper bound', function () {
    it('excludes the fixed version', function () {
        const r = range({ introduced: '1.0.0', fixed: '2.0.0' })
        expect(versionInRange('1.9.9', r, semverComparator)).toBe(true)
        expect(versionInRange('2.0.0', r, semverComparator)).toBe(false)
    })

    it('includes the last-affected version', function () {
        const r = range({ introduced: '1.0.0', lastAffected: '2.0.0' })
        expect(versionInRange('2.0.0', r, semverComparator)).toBe(true)
        expect(versionInRange('2.0.1', r, semverComparator)).toBe(false)
    })

    it('matches everything above the lower bound when unbounded above', function () {
        const r = range({ introduced: '1.0.0' })
        expect(versionInRange('9999.0.0', r, semverComparator)).toBe(true)
    })

    // A range that names exactly one version. Under the old model `<=X` collapsed into an exclusive
    // `fixed: X`, making this interval look empty — and the whole advisory was discarded because of it.
    it('matches the single version named by a coincident inclusive interval', function () {
        const r = range({ introduced: '1.5.0', lastAffected: '1.5.0' })
        expect(versionInRange('1.5.0', r, semverComparator)).toBe(true)
        expect(versionInRange('1.5.1', r, semverComparator)).toBe(false)
        expect(versionInRange('1.4.9', r, semverComparator)).toBe(false)
    })

    it('prefers the exclusive bound when a range carries both', function () {
        const r = range({ introduced: '1.0.0', fixed: '2.0.0', lastAffected: '3.0.0' })
        expect(versionInRange('2.5.0', r, semverComparator)).toBe(false)
    })
})

// Null, never a guess. A bound we cannot read bounds nothing — treating it as 0 would match every version
// of the package, which is the worst possible direction for an unreadable input.
describe('versionInRange — unreadable input', function () {
    it('does not match when the installed version is unreadable', function () {
        const r = range({ introduced: '1.0.0' })
        expect(versionInRange('workspace:*', r, semverComparator)).toBe(false)
    })

    it('does not match when the lower bound is unreadable', function () {
        expect(versionInRange('1.5.0', range({ introduced: 'not-a-version' }), semverComparator)).toBe(false)
    })

    it('does not match when an upper bound is unreadable', function () {
        const fixedJunk = range({ introduced: '1.0.0', fixed: 'not-a-version' })
        expect(versionInRange('1.5.0', fixedJunk, semverComparator)).toBe(false)
        const lastJunk = range({ introduced: '1.0.0', lastAffected: 'not-a-version' })
        expect(versionInRange('1.5.0', lastJunk, semverComparator)).toBe(false)
    })
})

// The bottom of the version space is spelled several ways upstream; all of them must bound from zero.
describe('versionInRange — zero lower bound', function () {
    it.each(['0', '0.0', '0.0.0'])('treats %j as the bottom of the version space', function (introduced) {
        const r = range({ introduced, fixed: '2.0.0' })
        expect(versionInRange('1.0.0', r, semverComparator)).toBe(true)
    })

    // A prerelease of 0.0.0 sorts BELOW the release 0.0.0, so normalizing the bound to `0.0.0` and asking
    // `gte` excluded it. Go modules without a tagged release are all pinned to exactly this shape, which
    // made them match no advisory at all — the scan reported ok with zero findings.
    it.each([
        ['v0.0.0-20180523222229-09b5706aa936', 'a Go pseudo-version'],
        ['0.0.0-alpha.1', 'a Rust pre-1.0 alpha'],
        ['0.0.0-experimental-cb5084d1c', 'an npm experimental build']
    ])('matches %s (%s) against a range starting at zero', function (installed) {
        expect(versionInRange(installed, range({ introduced: '0', fixed: '2.0.0' }), semverComparator)).toBe(true)
        expect(versionInRange(installed, range({ introduced: '0', fixed: null }), semverComparator)).toBe(true)
    })

    // The Go case the advisories themselves state: "everything up to this commit". Both bounds are 0.0.0
    // prereleases, so the interval is real and ordering between them decides it.
    it('bounds one Go pseudo-version against another', function () {
        const r = range({ introduced: '0', fixed: '0.0.0-20180523222229-09b5706aa936' })
        expect(versionInRange('v0.0.0-20180101000000-aaaaaaaaaaaa', r, semverComparator)).toBe(true)
        expect(versionInRange('v0.0.0-20190101000000-bbbbbbbbbbbb', r, semverComparator)).toBe(false)
    })

    // `>0` names a boundary the advisory deliberately excluded, so it is still compared, not waved through.
    it('still applies an exclusive zero lower bound', function () {
        const r = range({ introduced: '0.0.0', introducedExclusive: true, fixed: '2.0.0' })
        expect(versionInRange('0.0.0', r, semverComparator)).toBe(false)
        expect(versionInRange('1.0.0', r, semverComparator)).toBe(true)
    })
})

// The same bound rules, driven by a comparator with entirely different version semantics — which is the
// point of keeping the rules and the ordering separate.
describe('versionInRange — PEP 440', function () {
    it('applies exclusivity with PEP 440 ordering', function () {
        const r = range({ introduced: '1.0', introducedExclusive: true, lastAffected: '2.0' })
        expect(versionInRange('1.0.0', r, pep440Comparator)).toBe(false)
        expect(versionInRange('1.5', r, pep440Comparator)).toBe(true)
        expect(versionInRange('2.0.0', r, pep440Comparator)).toBe(true)
        expect(versionInRange('2.0.1', r, pep440Comparator)).toBe(false)
    })
})

describe('versionInRange — refused parts', function () {
    // Even a refused part whose text a lenient comparator would coerce into a version.
    it('selects no version', function () {
        expect(versionInRange('2.0', refusedRange('~=2.0'), pep440Comparator)).toBe(false)
        expect(versionInRange('1.0.0', refusedRange('1.0.0'), semverComparator)).toBe(false)
    })
})

// The membership rule the matcher and registry settlement share.
describe('versionInSet', function () {
    const normalized = function exactOf(...versions: string[]): Set<string> {
        return new Set(versions.map(function n(v) { return pep440Comparator.normalize(v) as string }))
    }

    // SENTINEL-127, the reviewer's reproduction: gemnasium `==2.2.0` and `<=2.2.0` against torch's CPU build.
    // PEP 440: a public specifier ignores the candidate's local label.
    it('selects a local build under PEP 440 specifier semantics', function () {
        expect(versionInSet('2.2.0+cpu', [], normalized('2.2.0'), pep440Comparator, 'pep440')).toBe(true)
        expect(versionInSet('2.2.0+cpu', [range({ lastAffected: '2.2.0' })], new Set(), pep440Comparator, 'pep440')).toBe(true)
        // `>2.2.0` must not select a local build of 2.2.0; `<2.2.0` does not select it either.
        expect(versionInSet('2.2.0+cpu', [range({ introduced: '2.2.0', introducedExclusive: true })], new Set(), pep440Comparator, 'pep440')).toBe(false)
        expect(versionInSet('2.2.0+cpu', [range({ fixed: '2.2.0' })], new Set(), pep440Comparator, 'pep440')).toBe(false)
        expect(versionInSet('2.1.9+cpu', [range({ fixed: '2.2.0' })], new Set(), pep440Comparator, 'pep440')).toBe(true)
    })

    // OSV's intervals are the ordering, under which the local build sorts above its public version.
    it('orders a local build above its public version without specifier semantics', function () {
        expect(versionInSet('2.2.0+cpu', [], normalized('2.2.0'), pep440Comparator, undefined)).toBe(false)
        expect(versionInSet('2.2.0+cpu', [range({ lastAffected: '2.2.0' })], new Set(), pep440Comparator, undefined)).toBe(false)
        expect(versionInSet('2.2.0+cpu', [range({ introduced: '2.2.0', introducedExclusive: true })], new Set(), pep440Comparator, undefined)).toBe(true)
    })

    // A pin that names a local label matches that build strictly, never the public version or another build.
    it('matches a local pin strictly', function () {
        expect(versionInSet('1.0.0+abc', [], normalized('1.0+abc'), pep440Comparator, 'pep440')).toBe(true)
        expect(versionInSet('1.0', [], normalized('1.0+abc'), pep440Comparator, 'pep440')).toBe(false)
        expect(versionInSet('1.0+abd', [], normalized('1.0+abc'), pep440Comparator, 'pep440')).toBe(false)
    })

    it('never matches a version the comparator cannot read', function () {
        expect(versionInSet('not a version', [range({})], new Set(), pep440Comparator, 'pep440')).toBe(false)
    })

    it('projects only under specifier semantics', function () {
        expect(specifierCandidate('2.2+cpu', 'pep440')).toBe('2.2')
        expect(specifierCandidate('2.2', 'pep440')).toBe('2.2')
        expect(specifierCandidate('1.0.0+build', undefined)).toBe('1.0.0+build')
    })
})
