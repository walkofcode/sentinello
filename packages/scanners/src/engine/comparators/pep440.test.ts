import { describe, expect, it } from 'vitest'
import { parsePep440, pep440Comparator } from './pep440'

// The canonical ordering example from PEP 440 itself, in strictly ascending order. Every adjacent pair is
// asserted in both directions, which is what makes this table worth more than the sum of its rows: it pins
// epoch, release padding, pre/post/dev interaction and local versions in one pass. A comparator bug here is
// a silent false negative — the advisory simply stops matching — so the ordering IS the contract.
const ASCENDING = [
    '1.0.dev456',
    '1.0a1',
    '1.0a2.dev456',
    '1.0a12.dev456',
    '1.0a12',
    '1.0b1.dev456',
    '1.0b2',
    '1.0b2.post345.dev456',
    '1.0b2.post345',
    '1.0rc1.dev456',
    '1.0rc1',
    '1.0',
    '1.0+abc.5',
    '1.0+abc.7',
    '1.0+5',
    '1.0.post456.dev34',
    '1.0.post456',
    '1.1.dev1',
    '1.1a1',
    '1.1',
    '2.0',
    '1!1.0'
]

function ascendingPairs(): Array<[string, string]> {
    const pairs: Array<[string, string]> = []
    for (let i = 0; i + 1 < ASCENDING.length; i++) {
        const lower = ASCENDING[i]
        const higher = ASCENDING[i + 1]
        if (lower === undefined || higher === undefined) continue
        pairs.push([lower, higher])
    }
    return pairs
}

const PAIRS = ascendingPairs()

// [raw, folded letter, folded number]
const PRE_SPELLINGS: Array<[string, string, number]> = [
    ['1.0alpha1', 'a', 1],
    ['1.0a1', 'a', 1],
    ['1.0beta2', 'b', 2],
    ['1.0b2', 'b', 2],
    ['1.0c3', 'rc', 3],
    ['1.0rc3', 'rc', 3],
    ['1.0pre3', 'rc', 3],
    ['1.0preview3', 'rc', 3]
]

const POST_SPELLINGS: Array<[string, number]> = [
    ['1.0.post1', 1],
    ['1.0-1', 1],
    ['1.0rev2', 2],
    ['1.0r3', 3]
]

const UNPARSEABLE = ['', 'abc', 'not-a-version', '1.0.0-SNAPSHOT', 'v', '..', '1.0+']

// Pairs that must compare equal despite differing spelling.
const EQUIVALENT: Array<[string, string]> = [
    ['1.0', '1.0.0'],
    ['1', '1.0.0.0'],
    ['1.0rc1', '1.0.0rc1'],
    ['1.0c1', '1.0rc1'],
    ['1.0alpha1', '1.0a1'],
    ['1.0-1', '1.0.post1'],
    ['1.0.post', '1.0.post0']
]

const UNCOMPARABLE: Array<[string, string]> = [
    ['garbage', '1.0'],
    ['1.0', 'garbage'],
    ['garbage', 'garbage']
]

describe('parsePep440', function () {
    it('parses a plain release', function () {
        expect(parsePep440('1.2.3')).toEqual({ epoch: 0, release: [1, 2, 3], pre: null, post: null, dev: null, local: null })
    })

    it('parses an epoch', function () {
        expect(parsePep440('1!2.0')?.epoch).toBe(1)
    })

    it('accepts an optional leading v and surrounding whitespace', function () {
        expect(parsePep440('  v1.2.3  ')?.release).toEqual([1, 2, 3])
    })

    // alpha/beta/c/pre/preview are all spellings of a/b/rc. Folding them is what lets `1.0c1` and `1.0rc1`
    // compare equal rather than sorting as unrelated letters.
    it.each(PRE_SPELLINGS)('folds the pre-release spelling in %s to %s%d', function (raw, letter, n) {
        expect(parsePep440(raw)?.pre).toEqual({ letter, n })
    })

    it('defaults an omitted pre-release number to zero', function () {
        expect(parsePep440('1.0rc')?.pre).toEqual({ letter: 'rc', n: 0 })
    })

    it.each(POST_SPELLINGS)('reads the post-release in %s as %d', function (raw, post) {
        expect(parsePep440(raw)?.post).toBe(post)
    })

    it('defaults an omitted post-release number to zero', function () {
        expect(parsePep440('1.0.post')?.post).toBe(0)
    })

    it('defaults an omitted dev-release number to zero', function () {
        expect(parsePep440('1.0.dev')?.dev).toBe(0)
    })

    // Local segments split on any of [-_.] and numeric parts become numbers, because numeric segments
    // outrank string ones during comparison.
    it('splits local version segments, keeping numbers numeric', function () {
        expect(parsePep440('1.0+ubuntu.1-foo_2')?.local).toEqual(['ubuntu', 1, 'foo', 2])
    })

    it.each(UNPARSEABLE)('returns null for the unparseable %j', function (raw) {
        expect(parsePep440(raw)).toBeNull()
    })
})

describe('pep440Comparator.normalize', function () {
    it('returns the trimmed input when it parses', function () {
        expect(pep440Comparator.normalize('  1.2.3 ')).toBe('1.2.3')
    })

    // Returning null makes the matcher skip the version rather than guess at it — a miss is always
    // preferable to a false positive here.
    it('returns null when it does not parse', function () {
        expect(pep440Comparator.normalize('not-a-version')).toBeNull()
    })
})

describe('pep440Comparator ordering', function () {
    // Guards the table itself: if the pair builder ever dropped an entry the suite would quietly test
    // less than it claims to.
    it('derives one pair per adjacent entry in the ordering table', function () {
        expect(PAIRS).toHaveLength(ASCENDING.length - 1)
    })

    it.each(PAIRS)('orders %s below %s', function (lower, higher) {
        expect(pep440Comparator.lt(lower, higher)).toBe(true)
        expect(pep440Comparator.gte(higher, lower)).toBe(true)
        expect(pep440Comparator.lt(higher, lower)).toBe(false)
        expect(pep440Comparator.gte(lower, higher)).toBe(false)
    })

    // Trailing zeros are not significant in a PEP 440 release tuple, so these are the same version.
    it.each(EQUIVALENT)('treats %s and %s as equal', function (a, b) {
        expect(pep440Comparator.gte(a, b)).toBe(true)
        expect(pep440Comparator.gte(b, a)).toBe(true)
        expect(pep440Comparator.lt(a, b)).toBe(false)
        expect(pep440Comparator.lt(b, a)).toBe(false)
    })

    it('sorts a longer release above its prefix', function () {
        expect(pep440Comparator.lt('1.0', '1.0.1')).toBe(true)
    })

    // A numeric local segment outranks a string one at the same position.
    it('sorts a numeric local segment above an alphanumeric one', function () {
        expect(pep440Comparator.lt('1.0+foo', '1.0+1')).toBe(true)
    })

    it('sorts a local version above the release without one', function () {
        expect(pep440Comparator.lt('1.0', '1.0+local')).toBe(true)
    })

    it('sorts a shorter local segment list below its extension', function () {
        expect(pep440Comparator.lt('1.0+abc', '1.0+abc.1')).toBe(true)
    })

    it('orders an epoch above everything in a lower epoch', function () {
        expect(pep440Comparator.lt('999.0', '1!0.1')).toBe(true)
    })

    // gte/lt take normalized input from the matcher; an unparseable side yields false from BOTH, which
    // leaves the range unsatisfied rather than fabricating a match.
    it.each(UNCOMPARABLE)('returns false from gte and lt when %j cannot be compared to %j', function (a, b) {
        expect(pep440Comparator.gte(a, b)).toBe(false)
        expect(pep440Comparator.lt(a, b)).toBe(false)
    })
})
