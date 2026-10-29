// Per-ecosystem version semantics, injected into the matcher, the fix picker and every other reader of a
// version. npm and crates.io use semver; PyPI uses PEP 440; Go uses semver with its own `v`, pseudo-version
// and `+incompatible` rules; RubyGems uses Gem::Version. Keeping this a plug point means a new ecosystem
// is a new comparator, not a new matcher.
//
// All four orderings are declared, not just the two a half-open interval needs. The previous contract
// offered only `gte` and `lt`, which meant an exclusive lower bound was not merely unimplemented — it was
// INEXPRESSIBLE, so the normalizers had no choice but to round `>` to `>=` no matter how carefully they
// parsed it. A representation gap upstream is unfixable while the vocabulary downstream is missing.
//
// `normalize` returns null when a value cannot be understood, and the matcher treats null as "no match" —
// never a false positive. The ordering functions, `compare` and `releaseKind` assume inputs that already
// passed `normalize`.

// The registry's `comparator` field names one of these (packages/core/src/ecosystems.ts).
export type ComparatorId = 'semver' | 'pep440' | 'go' | 'rubygems'

// What a version is, for the one question that depends on it: may the fix picker recommend it?
//   release    — an ordinary release;
//   prerelease — a tagged prerelease (`-rc.1`, `a1`, `.dev0`, `.pre`), never recommended as a fix;
//   pseudo     — a Go pseudo-version (`v0.0.0-20180523222229-09b5706aa936`), a commit rather than a tag.
//                Go is the only ecosystem whose fixes are sometimes published only this way, so the fix
//                picker admits one when the advisory itself states it (SENTINEL-126).
export type ReleaseKind = 'release' | 'prerelease' | 'pseudo'

export type VersionComparator = {
    id: ComparatorId
    normalize(raw: string): string | null
    // Negative, zero or positive, like Array.prototype.sort expects.
    compare(a: string, b: string): number
    gt(a: string, b: string): boolean
    gte(a: string, b: string): boolean
    lt(a: string, b: string): boolean
    lte(a: string, b: string): boolean
    releaseKind(version: string): ReleaseKind
}

// The four orderings, derived from one total `compare`. A comparator whose `compare` is total on its
// normalized values has no reason to restate them, and restating them is how two of them come to disagree.
export function orderingsFrom(compare: (a: string, b: string) => number): Pick<VersionComparator, 'gt' | 'gte' | 'lt' | 'lte'> {
    return {
        gt(a: string, b: string): boolean {
            return compare(a, b) > 0
        },
        gte(a: string, b: string): boolean {
            return compare(a, b) >= 0
        },
        lt(a: string, b: string): boolean {
            return compare(a, b) < 0
        },
        lte(a: string, b: string): boolean {
            return compare(a, b) <= 0
        }
    }
}
