import { DEFAULT_ECOSYSTEM, escalatedSeverity, requireComparator, type FindingCorroboration, type FindingInstallation, type Severity } from '@sentinello/core'
import { compareVersions, highestVersion } from '@sentinello/versions'
import type { RawFinding } from '../types'
import type { FixEvidence } from '../version-fix'

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

// Enough of the surviving finding to locate its persisted row later. The corroborating source is
// recorded during the scanner loop but written at the END of the project scan, because each scanner
// persists its own findings in its own transaction — so by the time a later source agrees, the row it
// agrees with is already on disk.
export type ReportedAdvisory = {
    source: string
    advisoryId: string
    packageName: string
    ecosystem: string
    // The grade the SURVIVING source gave, captured before any escalation. Re-reading the finding's
    // current severity instead would ratchet: an escalation from one scan would become the baseline for
    // the next, and a source that softened its grade could never bring it back down.
    severity: Severity
    // The kept finding itself, so agreement can be attached to the object a caller already holds. The
    // CLI reports straight from these and has no database to re-read.
    finding: RawFinding
    // Every source's and every installed copy's fix evidence for this identity: the survivor's own first,
    // then each finding reconciled into it. The fix is settled against ALL of it once every source has
    // run, so it is outside every source's affected set and at or above every installed copy, whatever
    // order the sources ran in. In memory only.
    evidence: FixEvidence[]
}

// "Source X also reported the advisory that survived as Y."
export type CorroborationEvent = {
    target: ReportedAdvisory
    by: FindingCorroboration
}

export type ReconcileResult = {
    kept: RawFinding[]
    corroborations: CorroborationEvent[]
}

// The single cross-source reconciliation point. A finding whose advisory was already reported (by id or
// any alias) for the same (ecosystem, package) by an earlier source does not become a second finding —
// it becomes a corroboration of the first. Survivors are recorded so later sources reconcile against
// them too. The dedup map is keyed by findingPackageIdentity — ecosystem-scoped, so two same-named
// packages in different ecosystems never collapse even when an advisory alias overlaps.
//
// Sources are processed in a FIXED order (authoritative first), so the kept record is deterministic
// regardless of timing. The classification race this used to cause — prod/dev differing by which source
// won — is gone: every source now classifies from the one shared resolver graph, so the surviving
// record's scope is identical to the dropped one's.
//
// What changed when corroboration arrived: the loser used to be dropped outright, which discarded the
// single strongest signal in the system. Two thirds of findings on a real instance are reported by more
// than one database, and they rendered identically to the third that only one database has ever heard
// of. The finding is still ONE row; the agreement now travels with it.
export function reconcileAgainstReported(
    findings: RawFinding[],
    reportedByPackage: Map<string, Map<string, ReportedAdvisory>>,
    source: string
): ReconcileResult {
    const kept: RawFinding[] = []
    const corroborations: CorroborationEvent[] = []
    for (const finding of findings) {
        const packageKey = findingPackageIdentity(finding)
        const existing = reportedByPackage.get(packageKey) || new Map<string, ReportedAdvisory>()
        const keys = findingIdentityKeys(finding)
        const target = firstReported(existing, keys)
        if (target && target.source === source) {
            // The same source matched the same advisory through another installed copy — another manifest
            // (ios/ and android/ Gemfile.locks) or another copy in one lockfile. Still one finding: it lists
            // every installation. That is not agreement, so it is not a corroboration either.
            foldInstallation(target.finding, finding)
            target.evidence.push(finding.fixInputs)
            continue
        }
        if (target) {
            // Same vulnerability, already reported. Record who else saw it and how they graded it —
            // never a second finding.
            const by: FindingCorroboration = { source, advisoryId: finding.advisoryId, severity: finding.severity }
            corroborations.push({ target, by })
            // Attach to the survivor in place, and re-grade it to the worst any source gave. The worker
            // ALSO persists this through applyFindingCorroborations, because its copy of the survivor was
            // written to the database before this source ran; the CLI has only the object.
            const attached = target.finding.corroborations || []
            if (!attached.some(function already(c) { return c.source === by.source })) attached.push(by)
            target.finding.corroborations = attached
            target.finding.severity = escalatedSeverity(target.severity, attached)
            // A second source: its evidence still bears on the fix even though it is not a second finding.
            target.evidence.push(finding.fixInputs)
            continue
        }
        kept.push(finding)
        const reported: ReportedAdvisory = {
            source,
            advisoryId: finding.advisoryId,
            packageName: finding.packageName,
            ecosystem: finding.ecosystem ?? DEFAULT_ECOSYSTEM,
            severity: finding.severity,
            finding,
            evidence: [finding.fixInputs]
        }
        // Registered under EVERY key it answers to, so a later source matching on any alias finds it.
        for (const key of keys) existing.set(key, reported)
        reportedByPackage.set(packageKey, existing)
    }
    return { kept, corroborations }
}

// Folds another installed copy into the finding that survived for it (decision #4):
//   - `installations` lists every (manifest, version), each once;
//   - `installedVersion` is the lowest affected installed version, by the ecosystem's comparator;
//   - the stated fix is the highest of the copies' own stated fixes, so it covers every copy — or none when
//     some copy has no stated fix, since then no single version is known to fix them all (settlement decides
//     from every copy's evidence either way);
//   - the scope is the union: shipped if any copy ships it;
//   - the dependency chains are every copy's, each once.
function foldInstallation(survivor: RawFinding, copy: RawFinding): void {
    const comparator = requireComparator(survivor.ecosystem ?? DEFAULT_ECOSYSTEM)
    const installations = installationsOf(survivor)
    for (const installation of installationsOf(copy)) {
        if (!installations.some(function same(i) { return i.manifestPath === installation.manifestPath && i.version === installation.version })) installations.push(installation)
    }
    survivor.installations = installations
    if (compareVersions(copy.installedVersion, survivor.installedVersion, comparator) < 0) survivor.installedVersion = copy.installedVersion
    survivor.fixVersion = survivor.fixVersion === null || copy.fixVersion === null ? null : highestVersion([survivor.fixVersion, copy.fixVersion], comparator)
    survivor.fixAvailable = survivor.fixVersion !== null
    survivor.isProd = survivor.isProd || copy.isProd
    survivor.isDev = survivor.isDev || copy.isDev
    // A new array: the survivor's chain is the resolved package's own list, shared with the graph.
    survivor.depPath = survivor.depPath.concat(copy.depPath.filter(function unseen(step) { return !survivor.depPath.includes(step) }))
}

function installationsOf(finding: RawFinding): FindingInstallation[] {
    return finding.installations ? finding.installations.slice() : []
}

function firstReported(existing: Map<string, ReportedAdvisory>, keys: string[]): ReportedAdvisory | null {
    for (const key of keys) {
        const found = existing.get(key)
        if (found) return found
    }
    return null
}

// Re-exported from @sentinello/core, where the ONE implementation lives. It used to be declared here and
// again inside packages/db's applyFindingCorroborations — the scanner escalating its in-memory survivor
// and the writer persisting that escalation, computing the same rule twice with nothing tying them
// together. Keeping the name exported from here preserves every existing import site.
export { escalatedSeverity }
