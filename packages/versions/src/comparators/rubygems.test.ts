import { describe, expect, it } from 'vitest'
import { normalizeRubyGems, rubygemsComparator } from './rubygems'

// Gem::Version's ordering, pinned by a table worked out from rubygems/lib/rubygems/version.rb: a string
// segment is a prerelease and sorts below any number at the same position, trailing zeros are
// insignificant, and a `-` is `.pre.`. Every adjacent pair is asserted both ways.
const ASCENDING = [
    '0.pre1',
    '0',
    '0.9',
    '1.0.0.a',
    '1.0.0.a1',
    '1.0.0.b',
    // [1, 'pre', 'rc', 1] against [1, 'pre']: the missing segment reads as 0, and a number outranks a
    // string, so the longer prerelease sorts first.
    '1.0.0.pre.rc1',
    '1.0.0.pre',
    '1.0.0.pre1',
    '1.0.0.rc1',
    '1.0.0',
    '1.0.0.1',
    '1.0.1',
    '1.2',
    '1.10',
    '2.0.0.beta1',
    '2.0.0.beta2',
    '2'
]

const PAIRS = ASCENDING.slice(1).map(function pair(higher, i) { return [ASCENDING[i] as string, higher] as const })

// Spellings Gem reads as one version.
const EQUIVALENT: Array<[string, string]> = [
    ['1', '1.0'],
    ['1.0', '1.0.0.0'],
    ['1.0.a', '1.0.a.0'],
    ['1.0.0-rc1', '1.0.0.pre.rc1'],
    ['0', '0.0.0']
]

describe('rubygemsComparator ordering', function () {
    it.each(PAIRS)('orders %s below %s', function (lower, higher) {
        expect(rubygemsComparator.lt(lower, higher)).toBe(true)
        expect(rubygemsComparator.lte(lower, higher)).toBe(true)
        expect(rubygemsComparator.gt(higher, lower)).toBe(true)
        expect(rubygemsComparator.gte(higher, lower)).toBe(true)
        expect(rubygemsComparator.gt(lower, higher)).toBe(false)
    })

    it.each(EQUIVALENT)('treats %s and %s as one version', function (a, b) {
        expect(rubygemsComparator.compare(a, b)).toBe(0)
        expect(normalizeRubyGems(a)).toBe(normalizeRubyGems(b))
    })

    // Byte-wise, as Ruby's String#<=> compares: upper case before lower.
    it('compares string segments byte-wise', function () {
        expect(rubygemsComparator.lt('1.0.A', '1.0.a')).toBe(true)
    })

    // Only for normalized inputs; an unparseable side has no order to give.
    it('ranks an unparseable side as equal in compare', function () {
        expect(rubygemsComparator.compare('nope', '1.0')).toBe(0)
    })
})

describe('rubygemsComparator.normalize', function () {
    it('returns a canonical spelling that parses back to itself', function () {
        for (const v of ASCENDING) {
            const canonical = normalizeRubyGems(v) as string
            expect(normalizeRubyGems(canonical)).toBe(canonical)
        }
        expect(normalizeRubyGems('1.0.0')).toBe('1')
        expect(normalizeRubyGems('7.1.0.rc1')).toBe('7.1.rc.1')
    })

    it.each(['', ' ', 'v1.0', '1..0', '>= 1.0', 'latest', '1.0 x'])('refuses %j', function (raw) {
        expect(normalizeRubyGems(raw)).toBeNull()
    })
})

describe('rubygemsComparator.releaseKind', function () {
    it('reads any letter as a prerelease, as Gem::Version#prerelease? does', function () {
        expect(rubygemsComparator.releaseKind('1.0.0')).toBe('release')
        expect(rubygemsComparator.releaseKind('1.0.0.rc1')).toBe('prerelease')
        expect(rubygemsComparator.releaseKind('1.0.0.pre')).toBe('prerelease')
    })
})
