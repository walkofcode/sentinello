import type { ScannerPlugin } from './types'
import { npmAuditPlugin } from './npm-audit'

export * from './types'
export { npmAuditPlugin, runNpmAudit, detectLockfile } from './npm-audit'
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
export type { DepScope, DetectedManifest, ResolvedGraph, ResolvedPackage, ResolverResult } from './resolver'
export { createOsvScanner, matchPackages, OSV_SCANNER_NAME } from './osv'
export type { OsvAdvisory, OsvLookup, OsvRange, OsvScannerDeps } from './osv'
export { createGemnasiumScanner, GEMNASIUM_SCANNER_NAME } from './gemnasium'
export type { GemnasiumAdvisory, GemnasiumLookup, GemnasiumRange, GemnasiumScannerDeps } from './gemnasium'
export { matchAdvisories } from './engine/matcher'
export { semverComparator } from './engine/comparators/semver'
export { pep440Comparator } from './engine/comparators/pep440'
export { reconcileAgainstReported, findingIdentityKeys } from './engine/reconcile'
export type { CanonicalAdvisory, CanonicalRange, VersionComparator } from './engine/types'

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
