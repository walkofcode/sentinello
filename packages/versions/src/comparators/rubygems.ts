import { orderingsFrom, type VersionComparator } from '../comparator'

// The RubyGems version comparator: a reimplementation of Gem::Version's ordering
// (rubygems/lib/rubygems/version.rb), with no runtime dependency.
//
// A gem version is not semver. It is any number of dot-separated segments, each split further wherever
// digits meet letters, so `1.0.0.pre1` is the segments [1, 0, 0, "pre", 1]:
//   - a STRING segment marks a prerelease, and a string sorts BELOW any number at the same position, which
//     is what puts 1.0.0.pre1 before 1.0.0 (whose missing fourth segment reads as 0);
//   - TRAILING ZEROS are insignificant, separately in the numeric part and in the part after the first
//     string, so 1.0 == 1.0.0 and 1.0.a == 1.0.a.0;
//   - a `-` is Gem's own shorthand for `.pre.`, so 1.0.0-rc1 is 1.0.0.pre.rc1.
// Segments are compared pairwise up to the longer list, a missing one reading as 0; two strings compare
// byte-wise, as Ruby's String#<=> does.

type Segment = number | string

// Gem::Version::ANCHORED_VERSION_PATTERN, minus the empty version (which Gem reads as "0" and which, in an
// advisory or a lockfile, is indistinguishable from a field nobody filled in).
const GEM_VERSION = /^[0-9]+(?:\.[0-9a-zA-Z]+)*(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

function segmentsOf(raw: string): Segment[] | null {
    const trimmed = raw.trim()
    if (!GEM_VERSION.test(trimmed)) return null
    // GEM_VERSION starts with a digit, so there is always at least one token.
    const tokens = trimmed.replace(/-/g, '.pre.').match(/[0-9]+|[a-z]+/gi) as string[]
    return tokens.map(function segment(token) {
        return /^[0-9]+$/.test(token) ? Number(token) : token
    })
}

function dropTrailingZeros(segments: Segment[]): Segment[] {
    let end = segments.length
    while (end > 0 && segments[end - 1] === 0) end--
    return segments.slice(0, end)
}

// Gem::Version#canonical_segments: the numeric part and the part from the first string onward, each
// without its trailing zeros. Two versions with the same canonical segments are the same version.
function canonicalSegments(segments: Segment[]): Segment[] {
    const firstString = segments.findIndex(function isString(s) { return typeof s === 'string' })
    if (firstString < 0) return dropTrailingZeros(segments)
    return [...dropTrailingZeros(segments.slice(0, firstString)), ...dropTrailingZeros(segments.slice(firstString))]
}

function compareSegments(left: Segment[], right: Segment[]): number {
    const length = Math.max(left.length, right.length)
    for (let i = 0; i < length; i++) {
        const lhs = left[i] ?? 0
        const rhs = right[i] ?? 0
        if (lhs === rhs) continue
        if (typeof lhs === 'string' && typeof rhs === 'number') return -1
        if (typeof lhs === 'number' && typeof rhs === 'string') return 1
        return lhs < rhs ? -1 : 1
    }
    return 0
}

// The canonical spelling, joined back with dots. It re-parses to the same canonical segments, so it is both
// an equality key and a valid input to the orderings. A version whose numeric part is all zeros has none
// left once they are dropped, and a gem version must start with a digit, so a leading 0 is put back: "0"
// for the bottom of the version space, "0.pre.1" for a prerelease of it.
function canonicalSpelling(segments: Segment[]): string {
    const canonical = canonicalSegments(segments)
    if (canonical.length === 0) return '0'
    return (typeof canonical[0] === 'string' ? ['0', ...canonical] : canonical).join('.')
}

export function normalizeRubyGems(raw: string): string | null {
    const segments = segmentsOf(raw)
    return segments === null ? null : canonicalSpelling(segments)
}

function compareRubyGems(a: string, b: string): number {
    const left = segmentsOf(a)
    const right = segmentsOf(b)
    if (left === null || right === null) return 0
    return compareSegments(canonicalSegments(left), canonicalSegments(right))
}

export const rubygemsComparator: VersionComparator = {
    id: 'rubygems',
    normalize: normalizeRubyGems,
    compare: compareRubyGems,
    ...orderingsFrom(compareRubyGems),
    // Gem::Version#prerelease?: any letter anywhere.
    releaseKind(version: string) {
        return /[a-zA-Z]/.test(version) ? 'prerelease' : 'release'
    }
}
