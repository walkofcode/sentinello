// The canonical advisory shape every advisory-feed source normalizes into. The matcher only ever sees
// this — it never knows whether a record came from OSV, the GitHub Advisory DB, or a future feed. A new
// feed source is "implement an adapter that yields these"; it cannot re-implement matching wrong because
// it owns no matching code.
export type CanonicalRange = {
    introduced: string
    fixed: string | null
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
