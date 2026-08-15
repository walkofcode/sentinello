// Per-ecosystem version semantics, injected into the matcher. npm/Go/crates.io use semver; PyPI uses
// PEP 440. Keeping this a plug point means a new ecosystem is a new comparator, not a new matcher.
//
// All four orderings are declared, not just the two a half-open interval needs. The previous contract
// offered only `gte` and `lt`, which meant an exclusive lower bound was not merely unimplemented — it was
// INEXPRESSIBLE, so the normalizers had no choice but to round `>` to `>=` no matter how carefully they
// parsed it. A representation gap upstream is unfixable while the vocabulary downstream is missing.
//
// `normalize` returns null when a value cannot be understood, and the matcher treats null as "no match" —
// never a false positive. The ordering functions assume inputs that already passed `normalize`.
export type VersionComparator = {
    normalize(raw: string): string | null
    gt(a: string, b: string): boolean
    gte(a: string, b: string): boolean
    lt(a: string, b: string): boolean
    lte(a: string, b: string): boolean
}
