import type { OsvAdvisoryLink } from '@sentinello/core'
import { isRefused, versionInSet, type VersionComparator } from '@sentinello/versions'
import type { GemnasiumAdvisory } from './gemnasium'

// gemnasium-db has no withdrawn field, so an advisory GitHub withdrew stays live there indefinitely (its
// title heuristics only catch a withdrawal that gemnasium itself rewrote into the title). OSV mirrors
// GitHub's `withdrawn_at`, so the OSV cache is the withdrawal record for gemnasium: an advisory is stamped
// withdrawn when the OSV records linked to it are withdrawn, and the shared matcher then drops it the way
// it drops any withdrawn advisory, in the portal and the CLI alike.
//
// A linked record is an OSV row of the SAME package whose id or aliases share an identifier with the
// gemnasium advisory's id or aliases, in either direction (gemnasium keys by CVE and lists the GHSA as an
// alias; OSV keys by GHSA and lists the CVE). The advisory is stamped only when EVERY linked record is
// withdrawn: GitHub withdraws a duplicate GHSA-A in favour of GHSA-B, both aliasing CVE-X, and gemnasium's
// CVE-X is still real then. No linked record at all means OSV has nothing to say, and nothing is stamped.
//
// CONTRACT: the links must come from a COMPLETE snapshot, seeded at the current normalizer version. A
// snapshot mid-rebuild may hold the withdrawn GHSA-A and not yet the active GHSA-B, and would then
// suppress a live advisory. This function cannot tell; its callers gate on the snapshot's completeness.
//
// Limits, by design: a withdrawn OSV record with no affected package for the ecosystem (identity-only) is
// absent from the per-ecosystem cache and cannot be linked, and the per-package scope means a GHSA
// withdrawn for one package never suppresses the same advisory on another.

// Stamps one package's gemnasium advisories from that package's OSV links. The stamped value is the
// latest linked withdrawal, so it reads as "withdrawn as of the last retraction".
export function stampWithdrawn(advisories: readonly GemnasiumAdvisory[], links: readonly OsvAdvisoryLink[]): GemnasiumAdvisory[] {
    return advisories.map(function stamp(advisory): GemnasiumAdvisory {
        const withdrawn = withdrawnAt(advisory, links)
        if (withdrawn !== null) return { ...advisory, withdrawn }
        const osvRecords = liveLinks(advisory, links)
        return osvRecords.length === 0 ? advisory : { ...advisory, osvRecords }
    })
}

// The per-package map form both lookups hold: each package's advisories stamped from that package's links
// only. A package with no OSV rows keeps its advisories untouched.
export function stampWithdrawnByPackage(
    byPackage: ReadonlyMap<string, readonly GemnasiumAdvisory[]>,
    linksByPackage: ReadonlyMap<string, readonly OsvAdvisoryLink[]>
): Map<string, GemnasiumAdvisory[]> {
    const out = new Map<string, GemnasiumAdvisory[]>()
    for (const [name, advisories] of byPackage.entries()) {
        out.set(name, stampWithdrawn(advisories, linksByPackage.get(name) ?? []))
    }
    return out
}

// The linked OSV records still live: the second opinion clearedByOsv reads after matching.
function liveLinks(advisory: GemnasiumAdvisory, links: readonly OsvAdvisoryLink[]): OsvAdvisoryLink[] {
    const identity = new Set<string>([advisory.advisoryId, ...advisory.aliases])
    return links.filter(function live(link) { return link.withdrawn === null && sharesIdentifier(identity, link) })
}

// gemnasium's ranges go stale where upstream renumbered: it says u-root `<=7.0.0`, and u-root's newer releases
// sort below 7.0.0, so the current v0.14.0 reads as affected by CVEs fixed in 0.9.0 (SENTINEL-169). When OSV has
// a live record of the same advisory for this package, and none of those records contains the installed
// version, OSV has cleared it and the match is dropped.
//
// Clearing takes proof. No linked record means OSV has nothing to say, and gemnasium stands alone. A version no
// comparator can read, a record with no version data, an enumerated version it cannot read, a refused range part,
// a range of a type this comparator may not evaluate and a range the normalizer had to discard each count as
// containing the version: an incomplete affected set never clears anything. Same complete-snapshot contract as the
// stamp above, since these records are stamped with it.
export function clearedByOsv(records: readonly OsvAdvisoryLink[] | undefined, version: string, comparator: VersionComparator, acceptedRangeTypes: readonly string[]): boolean {
    if (records === undefined || records.length === 0) return false
    if (comparator.normalize(version) === null) return false
    return !records.some(function contains(record) {
        if (record.rangesDiscarded === true) return true
        if (record.ranges.length === 0 && record.versions.length === 0) return true
        if (record.versions.includes(version)) return true
        if (record.ranges.some(function unreadable(range) { return isRefused(range) || range.type === undefined || !acceptedRangeTypes.includes(range.type) })) return true
        const exact = new Set<string>()
        for (const raw of record.versions) {
            const normalized = comparator.normalize(raw)
            if (normalized === null) return true
            exact.add(normalized)
        }
        return versionInSet(version, record.ranges, exact, comparator, undefined)
    })
}

function withdrawnAt(advisory: GemnasiumAdvisory, links: readonly OsvAdvisoryLink[]): number | null {
    const identity = new Set<string>([advisory.advisoryId, ...advisory.aliases])
    // Stays null when nothing links: OSV saying nothing about an advisory is not a withdrawal.
    let latest: number | null = null
    for (const link of links) {
        if (!sharesIdentifier(identity, link)) continue
        if (link.withdrawn === null) return null
        if (latest === null || link.withdrawn > latest) latest = link.withdrawn
    }
    return latest
}

function sharesIdentifier(identity: ReadonlySet<string>, link: OsvAdvisoryLink): boolean {
    if (identity.has(link.advisoryId)) return true
    return link.aliases.some(function inIdentity(alias): boolean {
        return identity.has(alias)
    })
}
