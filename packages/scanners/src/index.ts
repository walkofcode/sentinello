import type { ScannerPlugin } from './types'
import { npmAuditPlugin } from './npm-audit'

export * from './types'
export { npmAuditPlugin, createNpmAuditScanner, runNpmAudit, detectLockfile, type NpmAuditDeps } from './npm-audit'
export { filterFindingsByLockfileResolution } from './lockfile-cross-check'
export type { CrossCheckResult } from './lockfile-cross-check'
export {
    resolveProject,
    resolveManifest,
    resolveProjectGraphs,
    detectManifests,
    mergeResolvedGraphs,
    graphForEcosystem
} from './resolver'
export type { DepScope, DetectedManifest, LockEdge, LockEdgeKind, LockNode, LockRoot, LockRootKind, NodeGraph, ResolvedGraph, ResolvedPackage, ResolverResult } from './resolver'
export {
    detectEcosystems,
    detectPackageManager,
    discoverProjectsInTree,
    readGitBranch
} from './discovery'
export type { DiscoveredProject, DiscoveryOptions, DiscoverySkip, DiscoverySkipSource } from './discovery'
export { createOsvScanner, matchPackages, OSV_SCANNER_NAME } from './osv'
export type { OsvAdvisory, OsvLookup, OsvRange, OsvScannerDeps } from './osv'
export { createGemnasiumScanner, GEMNASIUM_SCANNER_NAME } from './gemnasium'
export type { GemnasiumAdvisory, GemnasiumLookup, GemnasiumRange, GemnasiumScannerDeps } from './gemnasium'
export { matchAdvisories } from './engine/matcher'
export { normalizeOneVulnerability, type DepClassifier, type Vulnerability } from './npm-audit-parse'
// Version semantics live in @sentinello/versions; re-exported here so existing consumers keep one import.
export { semverComparator, pep440Comparator } from '@sentinello/versions'
export { reconcileAgainstReported, findingIdentityKeys, escalatedSeverity } from './engine/reconcile'
export {
    pickStatedFix,
    affectedSetContains,
    evaluableAffected,
    evaluableContains,
    isNoPatchedSentinel,
    parseRangeSafely,
    NO_PATCHED_VERSION_SENTINEL,
    type AffectedSet,
    type EvaluableAffected,
    type FixEvidence
} from './version-fix'
export type { CorroborationEvent, ReconcileResult, ReportedAdvisory } from './engine/reconcile'
export type { CanonicalAdvisory, VersionRange, VersionComparator } from './engine/types'

const registry = new Map<string, ScannerPlugin>()
registry.set(npmAuditPlugin.name, npmAuditPlugin)

export function registerScanner(plugin: ScannerPlugin): void {
    registry.set(plugin.name, plugin)
}

export function getScanner(name: string): ScannerPlugin | undefined {
    return registry.get(name)
}

export function listScanners(): ScannerPlugin[] {
    return Array.from(registry.values())
}
