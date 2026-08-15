// The range type and the comparator contract both live in @sentinello/versions now. They used to be
// declared here, which put the engine's notion of a bound in a different file from the feeds' notion of
// one — and the two drifted: this file could only describe a half-open [introduced, fixed) interval, so
// every normalizer upstream had to round any other operator into that shape before it arrived.
export type { VersionRange, VersionComparator } from '@sentinello/versions'

import type { VersionRange } from '@sentinello/versions'

export type CanonicalAdvisory = {
    id: string
    source: string
    aliases: string[]
    ecosystem: string
    packageName: string
    // What the advisory says is affected. `exactVersions` is an enumerated list (how malware advisories
    // pin the compromised builds, e.g. ["4.4.2"]); `ranges` carries the bounded intervals.
    // A record may carry either, both, or (rarely) neither.
    affected: {
        ranges: VersionRange[]
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
