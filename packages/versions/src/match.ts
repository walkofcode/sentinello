import type { VersionComparator } from './comparator'
import { isZeroVersion, type VersionRange } from './range'

// Does this version fall inside this range? The one place bound inclusivity is evaluated.
//
// It lives here, beside the type that declares the bounds, rather than inside the matcher — because a
// range's meaning is a property of the range, and every other reader of one (the matcher, the fix picker,
// the tests that check us against node-semver) has to agree on it exactly. When this logic lived in the
// matcher alone it could only ever ask `gte` and `lt`, which is why every normalizer upstream had to round
// its bounds before handing them over.
//
// Returns false — never a guess — when a bound cannot be understood by the comparator: an unreadable bound
// bounds nothing, and treating it as 0 would match every version of the package.
export function versionInRange(version: string, range: VersionRange, comparator: VersionComparator): boolean {
    const installed = comparator.normalize(version)
    if (installed === null) return false

    if (!aboveLowerBound(installed, range, comparator)) return false

    // `fixed` is exclusive and is also the remediation target; `lastAffected` is inclusive and means there
    // is no fix above it. A range carries one or the other, and `fixed` wins when both somehow appear.
    if (range.fixed !== null && range.fixed !== undefined) {
        const fixed = comparator.normalize(range.fixed)
        return fixed !== null && comparator.lt(installed, fixed)
    }
    const lastAffectedRaw = range.lastAffected
    if (lastAffectedRaw !== null && lastAffectedRaw !== undefined) {
        const lastAffected = comparator.normalize(lastAffectedRaw)
        return lastAffected !== null && comparator.lte(installed, lastAffected)
    }
    // No upper bound at all: vulnerable from `introduced` onward with no known fix.
    return true
}

// An INCLUSIVE lower bound of "0" is the bottom of the version space, and nothing is below the bottom —
// so there is no comparison to make. Normalizing it instead produced the release `0.0.0`, which every
// prerelease of 0.0.0 sorts beneath: a Go module at a pseudo-version (`v0.0.0-20180523222229-09b5706aa936`)
// therefore failed the lower bound of every advisory that starts at zero, which is nearly all of them. It
// matched nothing at all — not even an open-ended range — and reported as a clean, successful scan. Rust
// crates on `0.0.0-alpha.N` had the same hole.
//
// An EXCLUSIVE `>0` is left to the comparator: it names a real boundary the advisory chose to exclude.
function aboveLowerBound(installed: string, range: VersionRange, comparator: VersionComparator): boolean {
    if (range.introducedExclusive !== true && isZeroVersion(range.introduced)) return true
    const introduced = comparator.normalize(range.introduced)
    if (introduced === null) return false
    return range.introducedExclusive === true
        ? comparator.gt(installed, introduced)
        : comparator.gte(installed, introduced)
}
