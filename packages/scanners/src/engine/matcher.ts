import type { Severity } from '@sentinello/core'
import { formatRange, isRefused, versionInSet, type FormatOptions, type SpecifierSemantics } from '@sentinello/versions'
import type { ResolvedPackage } from '../resolver/types'
import type { RawFinding } from '../types'
import { rangesReadable, type AffectedSet } from '../version-fix'
import type { CanonicalAdvisory, VersionComparator } from './types'

// The finding card shows the bottom of the version space as the shorter "0".
const DISPLAY_FORMAT: FormatOptions = { zero: '0' }

// THE matching engine. Given the resolved packages and the advisories affecting each (already normalized
// to CanonicalAdvisory by a feed adapter), decide which installed version is affected and build findings.
// One algorithm for everything: a version is affected iff it is in `exactVersions` OR inside any range.
// Malware is NOT special-cased — it's just an advisory whose affected set is usually an exact-version
// list. (The old OSV scanner flagged malware by package *presence*, ignoring the version entirely, which
// is what reported clean installs as compromised.)
// `acceptedRangeTypes`, when given, restricts which OSV `range.type` values the comparator is allowed to
// evaluate (e.g. semver accepts SEMVER+ECOSYSTEM, PEP 440 accepts ECOSYSTEM). A range whose type is not in
// the list — or that carries no type at all — is dropped before evaluation, so a comparator never silently
// interprets a range with the wrong version semantics. Omitted (sources with a single interval shape, e.g.
// gemnasium) means "evaluate every range", preserving the prior behavior for those sources.
export function matchAdvisories(
    packages: ResolvedPackage[],
    byPackage: Map<string, CanonicalAdvisory[]>,
    comparator: VersionComparator,
    acceptedRangeTypes?: readonly string[]
): RawFinding[] {
    const findings: RawFinding[] = []
    const exactSets = new Map<CanonicalAdvisory, ExactSet>()
    for (const pkg of packages) {
        const advisories = byPackage.get(pkg.name)
        if (!advisories || advisories.length === 0) continue
        const seen = new Set<string>()
        for (const advisory of advisories) {
            if (seen.has(advisory.id)) continue
            let exact = exactSets.get(advisory)
            if (exact === undefined) {
                exact = exactSetOf(advisory.affected.exactVersions, comparator)
                exactSets.set(advisory, exact)
            }
            const finding = matchOne(pkg, advisory, exact, comparator, acceptedRangeTypes)
            if (finding) {
                seen.add(advisory.id)
                findings.push(finding)
            }
        }
    }
    return findings
}

// Keep only the ranges the selected comparator may evaluate. `undefined` accepted-types = no filtering
// (every range kept). A range with no `type` is unclassified and is dropped whenever filtering is active —
// we never evaluate a range we can't confirm the comparator understands.
function applicableRanges(
    ranges: CanonicalAdvisory['affected']['ranges'],
    acceptedRangeTypes?: readonly string[]
): CanonicalAdvisory['affected']['ranges'] {
    if (!acceptedRangeTypes) return ranges
    return ranges.filter(function typeAccepted(range) {
        return range.type !== undefined && acceptedRangeTypes.includes(range.type)
    })
}

// An advisory's enumerated versions, as written and as the comparator reads them, built once per advisory.
// OSV's PyPI records enumerate every affected release — hundreds, sometimes thousands — and normalizing
// that list again for every installed copy and every fixed bound made matching one record quadratic.
type ExactSet = { raw: Set<string>; normalized: Set<string> }

function exactSetOf(exactVersions: readonly string[], comparator: VersionComparator): ExactSet {
    const normalized = new Set<string>()
    for (const raw of exactVersions) {
        const v = comparator.normalize(raw)
        if (v !== null) normalized.add(v)
    }
    return { raw: new Set(exactVersions), normalized }
}

function matchOne(
    pkg: ResolvedPackage,
    advisory: CanonicalAdvisory,
    exact: ExactSet,
    comparator: VersionComparator,
    acceptedRangeTypes?: readonly string[]
): RawFinding | null {
    // A withdrawn advisory is a claim upstream has retracted; it affects nothing, whatever versions it
    // still names. Enforced HERE, in the one place every source's advisories pass through, rather than in
    // each lookup's query — the portal filtered it in SQL and the CLI, reading the same rows from a file,
    // had nowhere to put the same filter and reported retracted advisories as live findings.
    if (advisory.withdrawn !== null) return null
    // Filter to the ranges this comparator may evaluate ONCE, then use the filtered set everywhere below
    // (matching, fix derivation, display) so a dropped range never leaks into any of them.
    const ranges = applicableRanges(advisory.affected.ranges, acceptedRangeTypes)
    const exactVersions = advisory.affected.exactVersions
    const specifier = advisory.affected.specifier
    // A refused part of the source's range states versions nobody here can read, so it is not version
    // data to match on — it only makes the affected set incomplete.
    const hasVersionData = ranges.some(function readable(range) { return !isRefused(range) }) || exactVersions.length > 0

    if (!hasVersionData) {
        // The advisory carries no version info at all. For malware we still surface it (a known-bad
        // package with an unbounded record is better loud than silent); for a regular vulnerability we
        // can't responsibly claim a clean version is affected, so we skip. This branch should be rare —
        // real OSV malware records enumerate the compromised versions.
        if (advisory.kind !== 'malware') return null
        // No version data on malware means every version is affected: the only way out is removal. But
        // "no data" is only true when the source supplied none. A record whose ranges were all dropped for
        // this comparator (a GIT range, an unclassified one) or refused by the parser did state versions we cannot read, so its
        // evidence is incomplete — unknown, never "every version is affected, no fix".
        const sourceStatedRanges = advisory.affected.ranges.length > 0
        const everyVersion = { introduced: '0', fixed: null, lastAffected: null }
        return buildFinding(pkg, advisory, 'critical', null, '*', { comparator: comparator.id, ranges: [everyVersion], exact: [], complete: !sourceStatedRanges })
    }

    if (!isAffected(pkg.version, ranges, exact, comparator, specifier)) return null

    const severity = advisory.kind === 'malware' ? 'critical' : mapSeverity(advisory.severity)
    const statedFix = statedFixFor(pkg.version, ranges, exact, comparator, specifier)
    const dropped = ranges.length !== advisory.affected.ranges.length
    return buildFinding(pkg, advisory, severity, statedFix, rangesToDisplay(ranges, exactVersions), affectedSetFor(ranges, exactVersions, dropped, comparator, specifier))
}

// A version is affected when it equals an enumerated exact version OR falls inside any range. Each bound
// is evaluated with the inclusivity the range declares — `>X` excludes X, `<=X` includes it — rather than
// being forced into a half-open interval and rounded. An exact version written exactly as installed matches
// even when the comparator cannot read it; everything else is versionInSet, the rule registry settlement
// applies too, so a fix it picks is never one this would still flag.
function isAffected(
    versionRaw: string,
    ranges: CanonicalAdvisory['affected']['ranges'],
    exact: ExactSet,
    comparator: VersionComparator,
    specifier: SpecifierSemantics | undefined
): boolean {
    if (exact.raw.has(versionRaw)) return true
    return versionInSet(versionRaw, ranges, exact.normalized, comparator, specifier)
}

// The fix the advisory STATES: the lowest `fixed` bound that is not below the install and is itself outside
// every range and every exact version (a multi-branch advisory can name a `fixed` that a later branch
// re-opens). Only `fixed` names a fix; a `lastAffected` bound means "no known fix", and nothing is ever
// derived from it — `<=3.0.3` does not make 3.0.4 a release.
//
// Ordered by the comparator, returned in the advisory's own spelling. The normalized form is an equality
// key, not a version anyone installs: PEP 440's for `4.2.0` is `4.2`, Gem's for `1.0.0` is `1`.
function statedFixFor(
    installedRaw: string,
    ranges: CanonicalAdvisory['affected']['ranges'],
    exact: ExactSet,
    comparator: VersionComparator,
    specifier: SpecifierSemantics | undefined
): string | null {
    // An exact version can match an install the comparator cannot read; with no floor to compare against,
    // no fix is stated.
    const installed = comparator.normalize(installedRaw)
    if (installed === null) return null
    let best: { normalized: string; spelled: string } | null = null
    for (const range of ranges) {
        if (!range.fixed) continue
        const fixed = comparator.normalize(range.fixed)
        if (fixed === null || comparator.lt(fixed, installed)) continue
        if (isAffected(range.fixed, ranges, exact, comparator, specifier)) continue
        if (best === null || comparator.lt(fixed, best.normalized)) best = { normalized: fixed, spelled: range.fixed }
    }
    return best === null ? null : best.spelled
}

// The whole affected set, for settling the fix against the registry: the same filtered ranges and exact
// versions this finding matched with, in the same comparator and under the same specifier semantics.
// Incomplete when a range was dropped for this comparator, when one of its bounds is one the comparator
// cannot read, or when the parser refused a part of the source's range — unknown, never "safe".
function affectedSetFor(
    ranges: CanonicalAdvisory['affected']['ranges'],
    exactVersions: string[],
    dropped: boolean,
    comparator: VersionComparator,
    specifier: SpecifierSemantics | undefined
): AffectedSet {
    const set: AffectedSet = {
        comparator: comparator.id,
        ranges: ranges.map(function copy(range) { return { ...range } }),
        exact: [...exactVersions],
        complete: !dropped && rangesReadable(ranges, comparator)
    }
    if (specifier !== undefined) set.specifier = specifier
    return set
}

function buildFinding(
    pkg: ResolvedPackage,
    advisory: CanonicalAdvisory,
    severity: Severity,
    fixVersion: string | null,
    vulnerableRange: string,
    affected: AffectedSet
): RawFinding {
    return {
        advisoryId: advisory.id,
        advisoryTitle: advisory.summary,
        advisoryUrl: advisory.url,
        packageName: pkg.name,
        // The installed package's ecosystem is authoritative for the finding's identity.
        ecosystem: pkg.ecosystem,
        installedVersion: pkg.version,
        installations: [{ manifestPath: pkg.manifestPath, version: pkg.version }],
        vulnerableRange,
        severity,
        fixAvailable: fixVersion !== null,
        fixVersion,
        fixInputs: {
            source: advisory.source,
            installed: [pkg.version],
            affected,
            patched: null,
            patchedSet: null,
            statedFix: fixVersion,
            fixViaParent: false
        },
        depPath: pkg.depPaths,
        isProd: pkg.scope.isProd,
        isDev: pkg.scope.isDev,
        aliases: advisory.aliases
    }
}

// Human-readable affected range for the finding card: enumerated versions render as `=X`, ranges through
// the shared formatter so the operator shown is the operator the advisory stated. Replaces the old
// hardcoded `*` for malware.
function rangesToDisplay(
    ranges: CanonicalAdvisory['affected']['ranges'],
    exactVersions: string[]
): string {
    const parts: string[] = []
    for (const v of exactVersions) parts.push('=' + v)
    for (const range of ranges) parts.push(formatRange(range, DISPLAY_FORMAT))
    // parts is never empty: the only caller sits behind the hasVersionData guard, and the no-version
    // path builds its '*' itself rather than routing through here.
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
