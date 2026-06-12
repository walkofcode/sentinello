// The canonical advisory shape every advisory-feed source normalizes into. The matcher only ever sees
// this — it never knows whether a record came from OSV, the GitHub Advisory DB, or a future feed. A new
// feed source is "implement an adapter that yields these"; it cannot re-implement matching wrong because
// it owns no matching code.
export type CanonicalRange = {
    // OSV `range.type` ('SEMVER' | 'ECOSYSTEM' | 'GIT') when the source preserves it (OSV does). The matcher
    // only evaluates a range whose type the selected comparator declares it understands (see the matcher's
    // `acceptedRangeTypes` param), so e.g. a PEP 440 comparator never silently evaluates a SEMVER-typed range
    // and vice versa. Optional: sources that emit a single semver-interval shape (gemnasium) leave it unset,
    // and an unset type is treated as "unclassified" — skipped when type-filtering is active.
    type?: string
    introduced: string
    fixed: string | null
    // OSV `last_affected`: an inclusive upper bound used by non-SEMVER ecosystems (PyPI/Go/Rust) when an
    // advisory has no clean `fixed` version — the range is vulnerable through this version inclusive. Null
    // / absent for the common half-open `[introduced, fixed)` case (npm advisories, gemnasium). Optional so
    // sources that only produce half-open ranges (gemnasium) need not set it.
    lastAffected?: string | null
}

export type CanonicalAdvisory = {
    id: string
    source: string
    aliases: string[]
    ecosystem: string
    packageName: string
    // What the advisory says is affected. `exactVersions` is an enumerated list (how malware advisories
    // pin the compromised builds, e.g. ["4.4.2"]); `ranges` is the half-open [introduced, fixed) form.
    // A record may carry either, both, or (rarely) neither.
    affected: {
        ranges: CanonicalRange[]
        exactVersions: string[]
    }
    kind: 'vulnerability' | 'malware'
    // Raw severity bucket as the source expresses it (e.g. OSV's upper-case "MODERATE"); the matcher
    // normalizes it. Sources differ on severity vocabulary, so this stays a free string, not our union.
    severity: string | null
    summary: string | null
    url: string | null
    withdrawn: number | null
}

// Per-ecosystem version semantics, injected into the matcher. npm uses semver; PyPI (PEP440), Go, etc.
// would each supply their own. Keeping this a plug point now means multi-ecosystem support later is a new
// comparator, not a new matcher. `normalize` returns null when a value can't be understood.
export type VersionComparator = {
    normalize(raw: string): string | null
    gte(a: string, b: string): boolean
    lt(a: string, b: string): boolean
}
