import { describe, expect, it } from 'vitest'
import { parseVersionRanges } from './index'

// Both advisory caches store ranges as a JSON blob and read them back through this. It is one function for
// a specific reason: the two stores previously each had their own copy that rebuilt the range field by
// field, and a field-by-field rebuild fails silently — a new field compiles, writes fine, and is then
// dropped on read with no error and no failing test. The gemnasium copy reconstructed exactly two fields,
// so it would have discarded every bound-inclusivity flag written to it.

describe('parseVersionRanges', function () {
    // THE regression this function exists to prevent.
    it('carries every declared field back out', function () {
        const json = JSON.stringify([
            { type: 'SEMVER', introduced: '1.2.8', introducedExclusive: true, fixed: null, lastAffected: '1.9.9' }
        ])
        expect(parseVersionRanges(json)).toEqual([
            { type: 'SEMVER', introduced: '1.2.8', introducedExclusive: true, fixed: null, lastAffected: '1.9.9' }
        ])
    })

    it('round-trips what the formatter-facing shape writes', function () {
        const written = [
            { introduced: '0', fixed: '4.17.21', lastAffected: null },
            { introduced: '1.2.8', introducedExclusive: true, fixed: null, lastAffected: null }
        ]
        expect(parseVersionRanges(JSON.stringify(written))).toEqual(written)
    })

    // Absent and `false` mean the same thing, so only `true` is ever stored — otherwise the shape read back
    // would differ from the shape written and every round-trip assertion would need to know which it got.
    it('normalizes an explicit false exclusivity flag to absent', function () {
        const json = '[{"introduced":"1.0.0","introducedExclusive":false,"fixed":null,"lastAffected":null}]'
        expect(parseVersionRanges(json)).toEqual([{ introduced: '1.0.0', fixed: null, lastAffected: null }])
    })

    it('leaves type absent for a source that has no such concept', function () {
        const parsed = parseVersionRanges('[{"introduced":"1.0.0","fixed":"2.0.0","lastAffected":null}]')
        expect(parsed).toEqual([{ introduced: '1.0.0', fixed: '2.0.0', lastAffected: null }])
        expect(parsed[0] && 'type' in parsed[0]).toBe(false)
    })

    it('defaults both upper bounds to null when absent or not strings', function () {
        expect(parseVersionRanges('[{"introduced":"1.0.0"}]')).toEqual([
            { introduced: '1.0.0', fixed: null, lastAffected: null }
        ])
        expect(parseVersionRanges('[{"introduced":"1.0.0","fixed":9,"lastAffected":true,"type":7}]')).toEqual([
            { introduced: '1.0.0', fixed: null, lastAffected: null }
        ])
    })

    // Defensive: the blob is cache content, and a corrupt row must cost that row, not the whole lookup.
    it('skips entries without a usable lower bound', function () {
        expect(parseVersionRanges('[null,42,"str",{"fixed":"1.0.0"},{"introduced":7}]')).toEqual([])
    })

    it('keeps a well-formed range alongside a broken one', function () {
        const json = '[{"bogus":true},{"introduced":"1.0.0","fixed":"2.0.0"}]'
        expect(parseVersionRanges(json)).toEqual([{ introduced: '1.0.0', fixed: '2.0.0', lastAffected: null }])
    })

    it('returns nothing for JSON that is not an array', function () {
        expect(parseVersionRanges('{}')).toEqual([])
        expect(parseVersionRanges('"nope"')).toEqual([])
        expect(parseVersionRanges('null')).toEqual([])
    })
})
