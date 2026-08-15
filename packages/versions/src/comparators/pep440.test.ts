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
    it('returns a canonical form when it parses', function () {
        expect(pep440Comparator.normalize('  1.2.3 ')).toBe('1.2.3')
    })

    // Returning null makes the matcher skip the version rather than guess at it — a miss is always
    // preferable to a false positive here.
    it('returns null when it does not parse', function () {
        expect(pep440Comparator.normalize('not-a-version')).toBeNull()
    })

    // REGRESSION. This used to return the trimmed input verbatim, so the matcher's exact-version check — a
    // string comparison on the normalized values — never matched "1.0" against an advisory that enumerated
    // "1.0.0", even though PEP 440 says they ARE the same version. Malware advisories are precisely the
    // ones that pin exact versions, so the miss landed where exactness matters most.
    it.each([
        ['1.0', '1.0.0'],
        ['1.0.0', '1'],
        ['1.0.0.0', '1.0'],
        ['v1.0', '1.0.0'],
        ['1.0.0-rc1', '1.0rc1'],
        ['1!2.0', '1!2'],
        ['1.0.post1', '1.0.0.post1'],
        ['1.0+ubuntu.1', '1.0.0+ubuntu-1']
    ])('gives %j and %j the same canonical form', function (a, b) {
        const canonical = pep440Comparator.normalize(a)
        expect(canonical).not.toBeNull()
        expect(pep440Comparator.normalize(b)).toBe(canonical)
    })

    it('keeps genuinely different versions distinct', function () {
        expect(pep440Comparator.normalize('1.0.1')).not.toBe(pep440Comparator.normalize('1.0'))
        expect(pep440Comparator.normalize('1.0rc1')).not.toBe(pep440Comparator.normalize('1.0'))
        expect(pep440Comparator.normalize('1!1.0')).not.toBe(pep440Comparator.normalize('1.0'))
        expect(pep440Comparator.normalize('1.0.dev1')).not.toBe(pep440Comparator.normalize('1.0'))
    })

    // The canonical form is fed straight back into the ordering functions, so it has to remain parseable.
    it('produces a form that parses back to the same canonical form', function () {
        for (const raw of ['1.0', '1.0rc1', '1!2.0', '1.0.post1', '1.0.dev1', '1.0+ubuntu.1']) {
            const once = pep440Comparator.normalize(raw)
            expect(once).not.toBeNull()
            expect(pep440Comparator.normalize(once as string)).toBe(once)
        }
    })
})

describe('pep440Comparator strict orderings', function () {
    it('distinguishes strict from non-strict at the boundary', function () {
        expect(pep440Comparator.gt('1.0', '1.0.0')).toBe(false)
        expect(pep440Comparator.gt('1.0.1', '1.0')).toBe(true)
        expect(pep440Comparator.lte('1.0', '1.0.0')).toBe(true)
        expect(pep440Comparator.lte('1.0.1', '1.0')).toBe(false)
    })

    // An unparseable side yields false from every ordering, so a bad bound can never be read as "matches".
    it('returns false from both strict orderings when a side does not parse', function () {
        expect(pep440Comparator.gt('nope', '1.0')).toBe(false)
        expect(pep440Comparator.gt('1.0', 'nope')).toBe(false)
        expect(pep440Comparator.lte('nope', '1.0')).toBe(false)
        expect(pep440Comparator.lte('1.0', 'nope')).toBe(false)
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

    // Equal numeric segments must fall through to the next position rather than deciding the
    // comparison. Returning early on the first pair would make every local version that shares a
    // leading segment compare as equal.
    it('moves past equal numeric local segments to the next one', function () {
        expect(pep440Comparator.lt('1.0+1.2', '1.0+1.3')).toBe(true)
        expect(pep440Comparator.lt('1.0+1.3', '1.0+1.2')).toBe(false)
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

describe('pep440Comparator — the arms the canonical table does not reach', function () {
    // The PEP 440 table walks one path through the comparator. These are the branches it never takes,
    // and each is a real PyPI version string. A comparator that gets one wrong produces a SILENT false
    // negative — the advisory range simply stops matching the installed version, and the project reads
    // as clean.

    // The dev/post/local comparisons are each asymmetric in a different direction, which is exactly
    // what makes them easy to write backwards: absent-post sorts BELOW any post, absent-dev sorts
    // ABOVE any dev, absent-local sorts BELOW any local.
    it.each([
        ['a post release above its final', '1.0', '1.0.post1'],
        ['a higher post above a lower', '1.0.post1', '1.0.post2'],
        ['a dev release below its final', '1.0.dev1', '1.0'],
        ['a higher dev above a lower', '1.0.dev1', '1.0.dev2'],
        ['a dev of a post below the post', '1.0.post1.dev1', '1.0.post1']
    ])('orders %s correctly', function (_label, lower, higher) {
        expect(pep440Comparator.lt(lower as string, higher as string)).toBe(true)
        expect(pep440Comparator.lt(higher as string, lower as string)).toBe(false)
    })

    // Same post and dev on both sides: every comparison falls through to equal, which is the arm that
    // returns 0 rather than picking a side.
    it.each([
        ['identical posts', '1.0.post1', '1.0.post1'],
        ['identical devs', '1.0.dev1', '1.0.dev1'],
        ['identical locals', '1.0+abc', '1.0+abc'],
        ['identical pre-releases', '1.0a1', '1.0a1']
    ])('treats %s as equal', function (_label, a, b) {
        expect(pep440Comparator.gte(a as string, b as string)).toBe(true)
        expect(pep440Comparator.lt(a as string, b as string)).toBe(false)
    })

    // Local version segments compare pairwise, and a shorter prefix sorts below its extension.
    it.each([
        ['a longer local above its prefix', '1.0+ubuntu', '1.0+ubuntu.1'],
        ['a higher numeric local segment', '1.0+build.1', '1.0+build.2'],
        ['a higher string local segment', '1.0+alpha', '1.0+beta']
    ])('orders %s', function (_label, lower, higher) {
        expect(pep440Comparator.lt(lower as string, higher as string)).toBe(true)
        expect(pep440Comparator.lt(higher as string, lower as string)).toBe(false)
    })

    // Pre-release letters fold to a/b/rc before ranking, so every spelling of the same stage sorts
    // together. Missing a spelling would place a "1.0preview1" above a "1.0" rather than below it.
    it.each([
        ['alpha', '1.0alpha1'],
        ['a', '1.0a1'],
        ['beta', '1.0beta1'],
        ['b', '1.0b1'],
        ['c', '1.0c1'],
        ['rc', '1.0rc1'],
        ['pre', '1.0pre1'],
        ['preview', '1.0preview1']
    ])('sorts the %s spelling below the final release', function (_label, version) {
        expect(pep440Comparator.lt(version as string, '1.0')).toBe(true)
    })

    it.each([
        ['alpha below beta', '1.0alpha1', '1.0beta1'],
        ['beta below rc', '1.0beta1', '1.0rc1'],
        ['c ranks as rc', '1.0b9', '1.0c1'],
        ['pre ranks as rc', '1.0b9', '1.0pre1']
    ])('ranks %s', function (_label, lower, higher) {
        expect(pep440Comparator.lt(lower as string, higher as string)).toBe(true)
    })

    // A pre-release with no number is treated as number 0.
    it('treats a numberless pre-release as zero', function () {
        expect(pep440Comparator.lt('1.0a', '1.0a1')).toBe(true)
    })

    // post/rev/r are the three accepted spellings, plus the bare `-N` shorthand.
    it.each([
        ['the post spelling', '1.0.post1'],
        ['the rev spelling', '1.0.rev1'],
        ['the r spelling', '1.0.r1'],
        ['the dash shorthand', '1.0-1']
    ])('reads %s as a post release above the final', function (_label, version) {
        expect(pep440Comparator.lt('1.0', version as string)).toBe(true)
    })

    // Unparseable input must not throw and must not compare as equal-to-everything, which would make
    // every range match. Returning false in both directions is what keeps a typo from silently
    // widening an advisory's blast radius.
    it.each([
        ['an empty string', ''],
        ['a non-numeric release', 'not-a-version'],
        ['a git sha', 'abcdef0'],
        ['a date-like string', '2026-07-29'],
        ['a bare pre-release with no release', 'a1']
    ])('refuses to order %s', function (_label, bad) {
        expect(pep440Comparator.lt(bad as string, '1.0')).toBe(false)
        expect(pep440Comparator.lt('1.0', bad as string)).toBe(false)
    })

    // Not a rejection: the semver spelling of a pre-release is also VALID PEP 440, because the
    // grammar accepts `-` as a separator and `alpha` as a pre-release letter. So `1.0.0-alpha.1` and
    // `1.0.0a1` are the same version here, and both sort below `1.0.0`. Worth stating, because it
    // looks like the sort of input that ought to be rejected.
    it('reads a semver-style pre-release as the PEP 440 one it happens to be', function () {
        expect(pep440Comparator.lt('1.0.0-alpha.1', '1.0.0')).toBe(true)
        expect(pep440Comparator.gte('1.0.0-alpha.1', '1.0.0a1')).toBe(true)
        expect(pep440Comparator.lt('1.0.0-alpha.1', '1.0.0a1')).toBe(false)
    })

    it('tolerates surrounding whitespace and a leading v', function () {
        expect(pep440Comparator.lt('  v1.0  ', '1.1')).toBe(true)
    })
})
