import { describe, expect, it } from 'vitest'
import { pep440Comparator, semverComparator, versionInRange, type VersionRange } from './index'

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
