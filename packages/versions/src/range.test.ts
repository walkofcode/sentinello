import { describe, expect, it } from 'vitest'
import { formatRange, formatRanges, type VersionRange } from './index'

// Rendering a range back to text is where a rounded bound becomes visible to a human: the finding card and
// the MCP/export output both show this string, and it is also what the fix picker re-parses to derive a fix
// version. It used to exist as two separate functions ten lines apart, and they disagreed — the display
// copy honoured an inclusive upper bound while the fix-derivation copy silently dropped it, so no
// `lastAffected` advisory ever produced a fix suggestion. These tests pin BOTH callers' shapes.

const DISPLAY = { zero: '0' }
const SEMVER = { zero: '0.0.0' }

function range(over: Partial<VersionRange>): VersionRange {
    return { introduced: '0', fixed: null, lastAffected: null, ...over }
}

describe('formatRange', function () {
    it('renders an inclusive lower bound with >=', function () {
        expect(formatRange(range({ introduced: '1.0.0' }), DISPLAY)).toBe('>=1.0.0')
    })

    // The rc case, at the display layer. Upstream said `>1.2.8`; showing `>=1.2.8` misreports the advisory
    // to the operator even once matching is correct.
    it('renders an exclusive lower bound with >', function () {
        expect(formatRange(range({ introduced: '1.2.8', introducedExclusive: true }), DISPLAY)).toBe('>1.2.8')
    })

    it('renders an exclusive upper bound with <', function () {
        expect(formatRange(range({ introduced: '1.0.0', fixed: '2.0.0' }), DISPLAY)).toBe('>=1.0.0 <2.0.0')
    })

    it('renders an inclusive upper bound with <=', function () {
        expect(formatRange(range({ introduced: '1.0.0', lastAffected: '2.0.0' }), DISPLAY)).toBe('>=1.0.0 <=2.0.0')
    })

    it('combines both exclusive bounds', function () {
        const r = range({ introduced: '1.0.0', introducedExclusive: true, fixed: '2.0.0' })
        expect(formatRange(r, DISPLAY)).toBe('>1.0.0 <2.0.0')
    })

    // `fixed` names a remediation target and wins when a range somehow carries both, matching how the
    // matcher evaluates it.
    it('prefers the exclusive bound when both upper bounds are present', function () {
        const r = range({ introduced: '1.0.0', fixed: '2.0.0', lastAffected: '1.9.9' })
        expect(formatRange(r, DISPLAY)).toBe('>=1.0.0 <2.0.0')
    })

    // The one difference between the two callers. A display string reads better as `>=0`; a string about to
    // be handed to node-semver's Range parser needs a full triple.
    it('spells the bottom of the version space per the caller', function () {
        expect(formatRange(range({ introduced: '0', fixed: '2.0.0' }), DISPLAY)).toBe('>=0 <2.0.0')
        expect(formatRange(range({ introduced: '0', fixed: '2.0.0' }), SEMVER)).toBe('>=0.0.0 <2.0.0')
    })

    it('leaves a non-zero lower bound alone whichever spelling is requested', function () {
        expect(formatRange(range({ introduced: '1.0.0' }), SEMVER)).toBe('>=1.0.0')
    })
})

describe('formatRanges', function () {
    it('joins disjoint ranges with ||', function () {
        const ranges = [
            range({ introduced: '1.0.0', fixed: '2.0.0' }),
            range({ introduced: '3.0.0', introducedExclusive: true, lastAffected: '4.0.0' })
        ]
        expect(formatRanges(ranges, DISPLAY)).toBe('>=1.0.0 <2.0.0 || >3.0.0 <=4.0.0')
    })

    it('renders an empty list as an empty string', function () {
        expect(formatRanges([], DISPLAY)).toBe('')
    })
})
