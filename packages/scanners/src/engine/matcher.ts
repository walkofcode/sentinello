import type { Severity } from '@sentinello/core'
import type { ResolvedPackage } from '../resolver/types'
import type { RawFinding } from '../types'
import { pickSafeFixVersion } from '../version-fix'
import type { CanonicalAdvisory, VersionComparator } from './types'

// THE matching engine. Given the resolved packages and the advisories affecting each (already normalized
// to CanonicalAdvisory by a feed adapter), decide which installed version is affected and build findings.
// One algorithm for everything: a version is affected iff it is in `exactVersions` OR inside any range.
// Malware is NOT special-cased — it's just an advisory whose affected set is usually an exact-version
// list. (The old OSV scanner flagged malware by package *presence*, ignoring the version entirely, which
// is what reported clean installs as compromised.)
export function matchAdvisories(
    packages: ResolvedPackage[],
    byPackage: Map<string, CanonicalAdvisory[]>,
    comparator: VersionComparator
): RawFinding[] {
    const findings: RawFinding[] = []
    for (const pkg of packages) {
        const advisories = byPackage.get(pkg.name)
        if (!advisories || advisories.length === 0) continue
        const seen = new Set<string>()
        for (const advisory of advisories) {
            if (seen.has(advisory.id)) continue
            const finding = matchOne(pkg, advisory, comparator)
            if (finding) {
                seen.add(advisory.id)
                findings.push(finding)
            }
        }
    }
    return findings
}

type AffectedHit = {
    affected: boolean
    firstFixed: string | null
}

function matchOne(
    pkg: ResolvedPackage,
    advisory: CanonicalAdvisory,
    comparator: VersionComparator
): RawFinding | null {
    const ranges = advisory.affected.ranges
    const exactVersions = advisory.affected.exactVersions
    const hasVersionData = ranges.length > 0 || exactVersions.length > 0

    if (!hasVersionData) {
        // The advisory carries no version info at all. For malware we still surface it (a known-bad
        // package with an unbounded record is better loud than silent); for a regular vulnerability we
        // can't responsibly claim a clean version is affected, so we skip. This branch should be rare —
        // real OSV malware records enumerate the compromised versions.
        if (advisory.kind !== 'malware') return null
        return buildFinding(pkg, advisory, 'critical', null, '*')
    }

    const hit = isAffected(pkg.version, ranges, exactVersions, comparator)
    if (!hit.affected) return null

    const severity = advisory.kind === 'malware' ? 'critical' : mapSeverity(advisory.severity)
    const fixVersion = pickSafeFixVersion({
        patched: null,
        recommendation: hit.firstFixed,
        vulnerable: vulnerableRangeForFix(ranges),
        installed: pkg.version
    })
    return buildFinding(pkg, advisory, severity, fixVersion, rangesToDisplay(ranges, exactVersions))
}

// A version is affected when it equals an enumerated exact version OR falls in [introduced, fixed) for
// any range. We track the lowest `fixed` boundary at/above the install as the fix target.
function isAffected(
    installedRaw: string,
    ranges: CanonicalAdvisory['affected']['ranges'],
    exactVersions: string[],
    comparator: VersionComparator
): AffectedHit {
    const installed = comparator.normalize(installedRaw)

    for (const raw of exactVersions) {
        if (raw === installedRaw) return { affected: true, firstFixed: null }
        const v = comparator.normalize(raw)
        if (v !== null && installed !== null && v === installed) return { affected: true, firstFixed: null }
    }

    if (installed === null) return { affected: false, firstFixed: null }

    let affected = false
    let firstFixed: string | null = null
    for (const range of ranges) {
        const introduced = range.introduced === '0' ? '0.0.0' : comparator.normalize(range.introduced)
        const fixed = range.fixed ? comparator.normalize(range.fixed) : null
        if (introduced === null) continue
        if (!comparator.gte(installed, introduced)) continue
        if (fixed === null) {
            affected = true
            continue
        }
        if (comparator.lt(installed, fixed)) {
            affected = true
            if (firstFixed === null || comparator.lt(fixed, firstFixed)) {
                firstFixed = fixed
            }
        }
    }
    return { affected, firstFixed }
}

function buildFinding(
    pkg: ResolvedPackage,
    advisory: CanonicalAdvisory,
    severity: Severity,
    fixVersion: string | null,
    vulnerableRange: string
): RawFinding {
    return {
        advisoryId: advisory.id,
        advisoryTitle: advisory.summary,
        advisoryUrl: advisory.url,
        packageName: pkg.name,
        installedVersion: pkg.version,
        vulnerableRange,
        severity,
        fixAvailable: fixVersion !== null,
        fixVersion,
        depPath: pkg.depPaths,
        isProd: pkg.scope.isProd,
        isDev: pkg.scope.isDev,
        aliases: advisory.aliases
    }
}

// Human-readable affected range for the finding card: enumerated versions render as `=X`, ranges as the
// half-open `>=lo <hi` (or `>=lo` when open-ended). Replaces the old hardcoded `*` for malware.
function rangesToDisplay(
    ranges: CanonicalAdvisory['affected']['ranges'],
    exactVersions: string[]
): string {
    const parts: string[] = []
    for (const v of exactVersions) parts.push('=' + v)
    for (const range of ranges) {
        const lo = range.introduced === '0' ? '0' : range.introduced
        if (range.fixed) {
            parts.push('>=' + lo + ' <' + range.fixed)
        } else {
            parts.push('>=' + lo)
        }
    }
    return parts.length > 0 ? parts.join(' || ') : '*'
}

// pickSafeFixVersion can derive a fix from the vulnerable range's upper bound, so feed it the ranges as a
// semver string (exact-version-only advisories have no range and thus no derivable fix target).
function vulnerableRangeForFix(ranges: CanonicalAdvisory['affected']['ranges']): string {
    const parts: string[] = []
    for (const range of ranges) {
        const lo = range.introduced === '0' ? '0.0.0' : range.introduced
        if (range.fixed) {
            parts.push('>=' + lo + ' <' + range.fixed)
        } else {
            parts.push('>=' + lo)
        }
    }
    return parts.join(' || ')
}

// OSV/GHSA severity buckets are upper-case (CRITICAL/HIGH/MODERATE/LOW). Map to our lower-case union;
// anything unknown or absent falls back to 'moderate' so a real advisory is never silently downgraded.
function mapSeverity(severity: Severity | string | null): Severity {
    if (!severity) return 'moderate'
    const s = String(severity).trim().toLowerCase()
    if (s === 'critical') return 'critical'
    if (s === 'high') return 'high'
    if (s === 'moderate' || s === 'medium') return 'moderate'
    if (s === 'low') return 'low'
    if (s === 'info' || s === 'none') return 'info'
    return 'moderate'
}
