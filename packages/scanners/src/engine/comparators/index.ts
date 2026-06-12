import { getEcosystem } from '@sentinello/core'
import type { VersionComparator } from '../types'
import { pep440Comparator } from './pep440'
import { semverComparator } from './semver'

// The ecosystem → version-comparator routing the OSV matcher uses. Keyed by the central registry's
// `comparator` id (not the ecosystem id) so several ecosystems can share one implementation: npm, Go, and
// Rust all use semver. Phase 4 adds 'pep440' for Python, so PyPI now matches with PEP 440 semantics
// instead of being skipped. A comparator id with no entry here still returns null from
// `comparatorForEcosystem`, so the OSV scanner SKIPS that ecosystem rather than mis-matching versions.
const COMPARATORS: Record<string, VersionComparator> = {
    semver: semverComparator,
    pep440: pep440Comparator
}

// The OSV `range.type` values each comparator is allowed to evaluate, keyed by the same comparator id as
// COMPARATORS. The matcher consults this to reject ranges a comparator cannot interpret BEFORE evaluating
// them (Phase 3 / Issue #017): a PEP 440 comparator must not silently evaluate a SEMVER-typed range, and a
// semver comparator must not evaluate a PEP 440 (ECOSYSTEM-on-PyPI) range.
//   - semver (npm/Go/crates.io): OSV expresses these ecosystems' ranges as SEMVER, and occasionally as
//     ECOSYSTEM with the same semver-parseable version strings; the semver comparator handles both, and its
//     `normalize` safely yields null (→ no match, never a false positive) for any string it can't parse. The
//     old npm-only path filtered to SEMVER alone, which is exactly the limitation Phase 3 removes — keeping
//     ECOSYSTEM here lets a semver ecosystem's ECOSYSTEM-typed advisories finally match.
//   - pep440 (PyPI): OSV expresses PyPI ranges as ECOSYSTEM with PEP 440 strings; SEMVER is rejected. The
//     comparator itself lands in Phase 4 — this entry is the contract it binds to.
// GIT ranges (commit hashes) are accepted by no comparator and are already dropped in normalization.
const ACCEPTED_RANGE_TYPES: Record<string, string[]> = {
    semver: ['SEMVER', 'ECOSYSTEM'],
    pep440: ['ECOSYSTEM']
}

// Resolve the comparator for an ecosystem id ('npm' | 'PyPI' | 'Go' | 'crates.io'). Returns null when the
// ecosystem is unknown or its comparator is not yet implemented — callers must treat null as "cannot match
// this ecosystem yet" and skip it, never fall back to semver.
export function comparatorForEcosystem(ecosystem: string): VersionComparator | null {
    const def = getEcosystem(ecosystem)
    if (!def) return null
    return COMPARATORS[def.comparator] ?? null
}

// The OSV `range.type` values the ecosystem's comparator may evaluate. Returns null for an unknown ecosystem
// or a comparator with no declared accepted types — callers pass an empty list as "match no ranges" so an
// unconfigured comparator can never silently evaluate ranges with the wrong version semantics.
export function acceptedRangeTypesForEcosystem(ecosystem: string): string[] | null {
    const def = getEcosystem(ecosystem)
    if (!def) return null
    return ACCEPTED_RANGE_TYPES[def.comparator] ?? null
}
