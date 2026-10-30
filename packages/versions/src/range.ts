// The single representation of "which versions an advisory affects". Every feed normalizes into this, and
// the matcher is the only thing that reads it.
//
// Bounds carry their inclusivity EXPLICITLY, and that is the whole point of this type. The model it
// replaces was a bare half-open interval [introduced, fixed) with no way to say anything else, so every
// operator that did not fit got rounded to whatever was representable — and each rounding was defended in a
// comment as the safe direction. It is not: rounding a bound only chooses WHICH wrong answer to give.
//   - `>X` was stored as `>=X`, so the boundary version was reported as affected. gemnasium states the 2021
//     `rc` hijack as `>1.2.8`, and 1.2.8 is the last CLEAN release — the version the advisory itself tells
//     you to stay on. Rounding reported it as critical malware across every project that had it.
//   - `<=X` and maven `[a,b]` lost the boundary the other way, silently missing a genuinely affected version.
//
// Upper bounds come in two kinds, and they are not interchangeable: `fixed` is exclusive AND names a
// remediation target, while `lastAffected` is inclusive and means "vulnerable through here, no known fix".
// A range carries one or the other, never both.
export type VersionRange = {
    // OSV `range.type` ('SEMVER' | 'ECOSYSTEM' | 'GIT') when the source preserves it. The matcher only
    // evaluates a range whose type the selected comparator declares it understands, so a PEP 440 comparator
    // never silently evaluates a SEMVER-typed range. Sources that emit a single interval shape (gemnasium)
    // leave it unset; an unset type is "unclassified" and is skipped whenever type-filtering is active.
    type?: string
    introduced: string
    // True for a strict `>` lower bound: `introduced` itself is NOT affected. Absent/false means `>=`.
    introducedExclusive?: boolean
    // Exclusive upper bound that is also the fix target: versions below it are affected, this one is not.
    fixed: string | null
    // Inclusive upper bound with no known fix: vulnerable THROUGH this version. Null/absent for the common
    // `fixed` case.
    lastAffected?: string | null
    // Set when this entry is NOT an interval but a part of the source's affected set the parser refused to
    // read: a disjunct in a syntax no dialect here implements (`~=2.0`, `===1.0`), or a bound no comparator
    // reads. It holds the source's own text, which is all there is to show.
    //
    // A refused part is kept rather than dropped because dropping it is not neutral. The surviving parts
    // still match what they match, but a set missing a branch would tell the fix picker that a candidate
    // inside the lost branch is safe — `<1.0 || ~=2.0` read as `<1.0` "proves" 2.0 clean. So a range with
    // this set selects no version (versionInRange) and makes every set holding it incomplete
    // (rangesReadable), which leaves settlement unknown. `introduced` carries the same text, so a reader that
    // forgets to check this field still meets a bound it cannot read rather than a bottom-of-space `0`.
    refused?: string
}

// A refused part of a source's affected set, in the one shape every reader recognises. See `refused`.
export function refusedRange(text: string, type?: string): VersionRange {
    const range: VersionRange = { introduced: text, fixed: null, lastAffected: null, refused: text }
    if (type !== undefined) range.type = type
    return range
}

export function isRefused(range: VersionRange): boolean {
    return range.refused !== undefined
}

// "0", "0.0", "0.0.0" — the bottom of the version space, however upstream spelled it. Feeds write this as
// the lower bound of any advisory that affects a package from its very first release.
//
// It is NOT the release 0.0.0, and the difference is load-bearing: under semver a prerelease sorts BELOW
// its release, so `>= 0.0.0` excludes 0.0.0-anything. Every Go module without a tagged release is pinned to
// a pseudo-version (v0.0.0-20180523222229-09b5706aa936), which is exactly that shape — so comparing against
// the release 0.0.0 made such a module fail the lower bound of every advisory, including open-ended ones.
export function isZeroVersion(version: string): boolean {
    return /^0(\.0)*$/.test(version.trim())
}

export type FormatOptions = {
    // How to spell the bottom of the version space. Display prefers the short "0"; a string destined for
    // node-semver's Range parser needs a full "0.0.0" triple.
    zero: string
}

// Render one range back to comparator syntax. This is the ONLY place bound operators are turned into text.
// It used to exist twice — a display copy that honoured `lastAffected` and a fix-derivation copy ten lines
// away that dropped it, which meant no `lastAffected` advisory ever got a fix version suggested. One
// function is what stops that from happening again.
export function formatRange(range: VersionRange, options: FormatOptions): string {
    if (range.refused !== undefined) return range.refused
    const lo = range.introduced === '0' ? options.zero : range.introduced
    const lower = (range.introducedExclusive === true ? '>' : '>=') + lo
    if (range.fixed !== null && range.fixed !== undefined) return lower + ' <' + range.fixed
    const lastAffected = range.lastAffected
    if (lastAffected !== null && lastAffected !== undefined) return lower + ' <=' + lastAffected
    return lower
}

// `||`-joined disjunction, the syntax every consumer (node-semver included) already reads.
export function formatRanges(ranges: readonly VersionRange[], options: FormatOptions): string {
    return ranges.map(function one(range) {
        return formatRange(range, options)
    }).join(' || ')
}
