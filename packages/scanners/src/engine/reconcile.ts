import { DEFAULT_ECOSYSTEM } from '@sentinello/core'
import type { RawFinding } from '../types'

// Canonical identity for a finding: the advisory id plus any cross-reference aliases (CVE/GHSA),
// lower-cased so casing never defeats a match. Two findings that share ANY key are the same advisory —
// e.g. npm-audit's numeric id and OSV's GHSA id for one CVE collapse to a single finding.
export function findingIdentityKeys(finding: RawFinding): string[] {
    const keys = [finding.advisoryId.toLowerCase()]
    if (finding.aliases) {
        for (const alias of finding.aliases) keys.push(alias.toLowerCase())
    }
    return keys
}

// The package half of cross-source identity. Dedup is scoped to ONE library — and a library is
// (ecosystem, packageName), never the bare name. With Phase 4 a single feed scan can carry npm + PyPI +
// Go + crates packages at once, so an npm `requests` and a PyPI `requests` that happen to share a CVE/GHSA
// alias are different libraries and must NOT suppress each other. npm-audit findings carry no ecosystem, so
// they fall back to the npm default (the only ecosystem npm-audit answers for), keeping its dedup against
// OSV's npm findings intact.
export function findingPackageIdentity(finding: RawFinding): string {
    return (finding.ecosystem ?? DEFAULT_ECOSYSTEM) + '|' + finding.packageName
}

// The single cross-source reconciliation point. Drops a finding whose advisory was already reported (by
// id or any alias) for the same (ecosystem, package) by an earlier source, and records survivors so later
// sources dedup against them too. The dedup map is keyed by findingPackageIdentity — ecosystem-scoped, so
// two same-named packages in different ecosystems never collapse even when an advisory alias overlaps.
// Sources are processed in a FIXED order (authoritative first), so the kept record is deterministic
// regardless of timing. The classification race this used to cause — prod/dev differing by which source
// won — is gone: every source now classifies from the one shared resolver graph, so the surviving record's
// scope is identical to the dropped one's.
export function reconcileAgainstReported(
    findings: RawFinding[],
    reportedByPackage: Map<string, Set<string>>
): RawFinding[] {
    const kept: RawFinding[] = []
    for (const finding of findings) {
        const packageKey = findingPackageIdentity(finding)
        const existing = reportedByPackage.get(packageKey)
        const keys = findingIdentityKeys(finding)
        const isDup = existing ? keys.some(function seen(k) { return existing.has(k) }) : false
        if (isDup) continue
        kept.push(finding)
        const set = existing || new Set<string>()
        for (const k of keys) set.add(k)
        reportedByPackage.set(packageKey, set)
    }
    return kept
}
