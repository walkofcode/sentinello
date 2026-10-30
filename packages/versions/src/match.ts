import type { VersionComparator } from './comparator'
import { isZeroVersion, type VersionRange } from './range'

// How a source's ranges are MATCHED, beyond how its versions are ordered. Most sources state an affected
// set as intervals of the ecosystem's version order (OSV's events, by its own schema), and ordering is the
// whole of their meaning. A source that writes its ranges in an ecosystem's REQUIREMENT syntax means what
// that syntax means, which can differ from the ordering:
//
//   pep440 — PEP 440 version specifiers (https://packaging.python.org/en/latest/specifications/
//            version-specifiers/#version-matching). A public specifier ignores the candidate's local label:
//            `==2.2.0` and `<=2.2.0` both select the local build `2.2.0+cpu`, which the ordering places
//            ABOVE 2.2.0, and `>2.2.0` does not select it. gemnasium writes PyPI ranges this way.
//
// The ordering comparator itself is never changed: choosing an upgrade needs the total order, local labels
// included. Only the candidate a specifier is evaluated against is.
export type SpecifierSemantics = 'pep440'

// The version a specifier is evaluated against. For PEP 440 that is the public version: everything before
// the `+` that starts a local label (the only place `+` can appear). Works on raw and normalized spellings
// alike. A local label in a SPECIFIER is refused by the dialect for every operator but `==`, whose exact
// entry is matched strictly against the whole version (see versionInSet).
export function specifierCandidate(version: string, specifier: SpecifierSemantics | undefined): string {
    if (specifier === undefined) return version
    const plus = version.indexOf('+')
    return plus < 0 ? version : version.slice(0, plus)
}

// Whether a version is in an affected set: equal to one of its exact versions, or inside one of its ranges.
// The ONE implementation the matcher and registry settlement share, so the two can never disagree about a
// set's meaning. `exact` holds the exact versions already normalized by the same comparator.
//
// An exact entry is matched against the whole version first, which is the strict reading a pin with a local
// label (`==1.0+abc`) requires; then, under specifier semantics, against the public candidate, which is how
// a public pin (`==2.2.0`) selects a local build of it. Ranges see only the candidate.
export function versionInSet(
    version: string,
    ranges: readonly VersionRange[],
    exact: ReadonlySet<string>,
    comparator: VersionComparator,
    specifier: SpecifierSemantics | undefined
): boolean {
    const installed = comparator.normalize(version)
    if (installed === null) return false
    if (exact.has(installed)) return true
    const candidate = specifierCandidate(installed, specifier)
    if (candidate !== installed && exact.has(candidate)) return true
    return ranges.some(function contains(range) {
        return versionInRange(candidate, range, comparator)
    })
}

// A bound as the comparator reads it. Zero, however upstream spelled it, is the release 0.0.0 in every
// comparator — including Go's, which reads no partial version and so would refuse a bare "0", turning
// gemnasium's `>0` ("every version") into a bound that matches nothing.
export function normalizeBound(bound: string, comparator: VersionComparator): string | null {
    const normalized = comparator.normalize(bound)
    if (normalized !== null || !isZeroVersion(bound)) return normalized
    return comparator.normalize('0.0.0')
}

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
//
// A refused part of a source's affected set (`range.refused`) selects nothing: the parser could not say what
// it selects, and a guess in either direction is a wrong answer.
export function versionInRange(version: string, range: VersionRange, comparator: VersionComparator): boolean {
    if (range.refused !== undefined) return false
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
    const introduced = normalizeBound(range.introduced, comparator)
    if (introduced === null) return false
    return range.introducedExclusive === true
        ? comparator.gt(installed, introduced)
        : comparator.gte(installed, introduced)
}
