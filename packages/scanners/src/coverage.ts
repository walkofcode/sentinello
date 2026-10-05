import type { ReasonCode } from '@sentinello/core'
import type { EcosystemCoverage } from './types'

// Why an advisory-feed source got no dependency graph to match: the reason the resolver gave for the first
// ecosystem it could not read (an unparseable package-lock is `unsupported_lockfile`, not a missing one),
// and `no_lockfile` only when the resolver recorded nothing at all. Saying "no lockfile" about a project
// whose lockfile is right there sends the reader to fix the wrong thing.
export function unresolvedGraphReason(coverage: readonly EcosystemCoverage[] | undefined): ReasonCode {
    for (const entry of coverage ?? []) {
        if (entry.status === 'unauditable' && entry.reasonCode) return entry.reasonCode
    }
    return 'no_lockfile'
}

// The summary a feed source records for a scan that had no graph to match: the coverage it was given, so the
// scan says which ecosystem could not be read and why, as an ok scan does.
export function unresolvedGraphRawJson(source: string, coverage: readonly EcosystemCoverage[] | undefined): string {
    return JSON.stringify({ source, packageCount: null, findingCount: 0, coverage: coverage ?? [] })
}
