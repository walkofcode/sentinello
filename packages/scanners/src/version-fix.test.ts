import { describe, expect, it } from 'vitest'
import { pickSafeFixVersion } from './version-fix'

// This produces the "upgrade to this version" advice shown next to every finding, so both ways of
// being wrong are bad in a specific way: naming a version that is still inside the vulnerable range
// tells someone they are safe when they are not, and naming a version below what is installed tells
// them to downgrade. The function answers null rather than guessing, and these cases pin that.
//
// The three constraints are: satisfies `patched` (when parseable), does NOT satisfy `vulnerable`
// (when parseable), and is >= `installed` (when known).

function pick(args: Partial<Parameters<typeof pickSafeFixVersion>[0]> = {}): string | null {
    return pickSafeFixVersion({
        patched: null,
        recommendation: null,
        vulnerable: '<4.17.21',
        installed: null,
        ...args
    })
}

describe('pickSafeFixVersion — deriving from the vulnerable range', function () {
    // The upper bound of the vulnerable range is usually the actual fix.
    it('takes the exclusive upper bound as the fix', function () {
        expect(pick({ vulnerable: '<4.17.21' })).toBe('4.17.21')
    })

    // '<=X' means X is still vulnerable, so the fix is the next patch.
    it('bumps past an inclusive upper bound', function () {
        expect(pick({ vulnerable: '<=4.17.20' })).toBe('4.17.21')
    })

    it('handles a bounded vulnerable range', function () {
        expect(pick({ vulnerable: '>=4.0.0 <4.17.21' })).toBe('4.17.21')
    })

    it('picks the lowest safe version across a disjoint vulnerable range', function () {
        expect(pick({ vulnerable: '<1.2.3 || >=2.0.0 <2.3.4' })).toBe('1.2.3')
    })
})

describe('pickSafeFixVersion — the patched range', function () {
    it('takes the lower bound of an inclusive patched range', function () {
        expect(pick({ patched: '>=4.17.21', vulnerable: '<4.17.21' })).toBe('4.17.21')
    })

    // '>X' means X itself is not patched, so the approximation is the next patch version.
    it('bumps past an exclusive patched lower bound', function () {
        expect(pick({ patched: '>1.2.3', vulnerable: '<=1.2.3' })).toBe('1.2.4')
    })

    it('accepts an exact patched version', function () {
        expect(pick({ patched: '=2.0.0', vulnerable: '<2.0.0' })).toBe('2.0.0')
    })

    it('accepts a bare patched version', function () {
        expect(pick({ patched: '2.0.0', vulnerable: '<2.0.0' })).toBe('2.0.0')
    })

    // Range.set is an OR of ANDs; each conjunction contributes its own lower bound, and the lowest
    // qualifying one wins.
    it('considers every branch of a disjoint patched range', function () {
        expect(pick({ patched: '>=1.2.3 <2.0.0 || >=3.0.0', vulnerable: '<1.2.3' })).toBe('1.2.3')
    })

    it('falls through to a later branch when the earlier one is still vulnerable', function () {
        expect(pick({ patched: '>=1.2.3 <2.0.0 || >=3.0.0', vulnerable: '<2.0.0' })).toBe('3.0.0')
    })

    it('takes the highest bound within a single conjunction', function () {
        expect(pick({ patched: '>=1.0.0 >=1.5.0', vulnerable: '<1.5.0' })).toBe('1.5.0')
    })

    it('never proposes a version outside the patched range', function () {
        // 5.0.0 would clear the vulnerable range, but the patched range excludes it.
        expect(pick({ patched: '>=2.0.0 <3.0.0', vulnerable: '<2.0.0 || >=5.0.0' })).toBe('2.0.0')
    })
})

describe('pickSafeFixVersion — unparseable input', function () {
    // pnpm audit writes '<0.0.0' to mean "no fix available"; treating it as a real range would
    // produce nonsense bounds.
    it('does not treat the pnpm no-fix sentinel as a range', function () {
        expect(pick({ patched: '<0.0.0', vulnerable: '<1.0.0', installed: '0.5.0' })).toBe('1.0.0')
    })

    // A range semver cannot parse still often contains a usable literal.
    it('falls back to literal versions in an unparseable patched string', function () {
        expect(pick({ patched: 'fixed in 1.2.3', vulnerable: '<1.2.3' })).toBe('1.2.3')
    })

    it('falls back to literal versions in an unparseable vulnerable string', function () {
        expect(pick({ patched: null, vulnerable: 'all versions before 2.0.0', recommendation: '2.0.0' })).toBe('2.0.0')
    })

    it('reads a recommendation string', function () {
        expect(pick({ recommendation: 'upgrade to 4.17.21', vulnerable: '<4.17.21' })).toBe('4.17.21')
    })

    it('ignores version-like text that is not a valid semver', function () {
        expect(pick({ patched: null, vulnerable: 'unknown', recommendation: 'not a version' })).toBeNull()
    })

    it('returns null when there is nothing to work from', function () {
        expect(pick({ vulnerable: '', recommendation: null, patched: null })).toBeNull()
    })

    it('treats a whitespace-only range as absent', function () {
        expect(pick({ patched: '   ', vulnerable: '<1.0.0' })).toBe('1.0.0')
    })
})

describe('pickSafeFixVersion — never a downgrade', function () {
    it('will not suggest a version below what is installed', function () {
        // 1.2.3 clears the vulnerable range but is older than the installed 2.0.0.
        expect(pick({ vulnerable: '<1.2.3', installed: '2.0.0' })).toBeNull()
    })

    it('allows a fix equal to the installed version', function () {
        expect(pick({ vulnerable: '<4.17.21', installed: '4.17.21' })).toBe('4.17.21')
    })

    // The same package hoisted at several versions arrives comma-joined; the highest is the floor, so
    // no installed copy is ever told to downgrade.
    it('uses the highest of several installed versions as the floor', function () {
        expect(pick({ vulnerable: '<2.0.0', installed: '1.0.0, 3.0.0' })).toBeNull()
        expect(pick({ vulnerable: '<4.0.0', installed: '1.0.0, 3.0.0' })).toBe('4.0.0')
    })

    it('tolerates whitespace-separated installed versions', function () {
        expect(pick({ vulnerable: '<4.0.0', installed: '1.0.0  3.0.0' })).toBe('4.0.0')
    })

    it('ignores unparseable entries in the installed list', function () {
        expect(pick({ vulnerable: '<4.0.0', installed: 'unknown, 3.0.0' })).toBe('4.0.0')
    })

    it('treats a wholly unparseable installed string as unknown', function () {
        expect(pick({ vulnerable: '<4.17.21', installed: 'not-a-version' })).toBe('4.17.21')
    })
})

describe('pickSafeFixVersion — never still vulnerable', function () {
    it('rejects every candidate that remains in the vulnerable range', function () {
        expect(pick({ patched: '>=1.0.0', vulnerable: '>=0.0.0' })).toBeNull()
    })

    it('skips a candidate caught by a disjoint vulnerable range', function () {
        // 2.0.0 comes from the patched range but is vulnerable again in the second branch.
        expect(pick({ patched: '>=2.0.0 || >=3.0.0', vulnerable: '<2.0.0 || >=2.0.0 <3.0.0' })).toBe('3.0.0')
    })

    it('prefers the lowest qualifying candidate', function () {
        expect(pick({ patched: '>=1.0.0 || >=2.0.0 || >=3.0.0', vulnerable: '<1.0.0' })).toBe('1.0.0')
    })
})
