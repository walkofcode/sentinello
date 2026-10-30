import { comparatorForEcosystem, getEcosystem } from '@sentinello/core'
import type { ComparatorId } from '@sentinello/versions'

// The ecosystem → comparator lookup lives in the registry (packages/core/src/ecosystems.ts); it is
// re-exported here because every scanner already imports its matching contract from this module.
export { comparatorForEcosystem }

// The OSV `range.type` values each comparator is allowed to evaluate, keyed by comparator id. The matcher
// consults this to reject ranges a comparator cannot interpret BEFORE evaluating them (Phase 3 / Issue
// #017): a PEP 440 comparator must not silently evaluate a SEMVER-typed range, and a semver comparator must
// not evaluate a PEP 440 (ECOSYSTEM-on-PyPI) range.
//   - semver (npm/crates.io) and go: OSV expresses these ecosystems' ranges as SEMVER, and occasionally as
//     ECOSYSTEM with the same semver-parseable version strings; the comparator handles both, and its
//     `normalize` safely yields null (→ no match, never a false positive) for any string it can't parse.
//   - pep440 (PyPI) and rubygems: OSV expresses these ranges as ECOSYSTEM with the registry's own version
//     strings; SEMVER is rejected.
// GIT ranges (commit hashes) are accepted by no comparator and are already dropped in normalization.
// A Record over the closed id union, so a new comparator cannot ship without declaring what it reads.
const ACCEPTED_RANGE_TYPES: Record<ComparatorId, string[]> = {
    semver: ['SEMVER', 'ECOSYSTEM'],
    go: ['SEMVER', 'ECOSYSTEM'],
    pep440: ['ECOSYSTEM'],
    rubygems: ['ECOSYSTEM']
}

// The OSV `range.type` values the ecosystem's comparator may evaluate, or null for an unknown ecosystem —
// callers pass an empty list as "match no ranges" so an unknown ecosystem can never silently evaluate
// ranges with the wrong version semantics.
export function acceptedRangeTypesForEcosystem(ecosystem: string): string[] | null {
    const def = getEcosystem(ecosystem)
    return def === null ? null : ACCEPTED_RANGE_TYPES[def.comparator]
}
