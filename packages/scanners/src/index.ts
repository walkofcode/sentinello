import type { ScannerPlugin } from './types'
import { npmAuditPlugin } from './npm-audit'

export * from './types'
export { npmAuditPlugin, runNpmAudit, detectLockfile } from './npm-audit'
export { filterFindingsByLockfileResolution } from './lockfile-cross-check'
export type { CrossCheckResult } from './lockfile-cross-check'
export { parseResolvedPackages } from './resolved-packages'
export type { ResolvedPackage, ResolvedPackagesResult } from './resolved-packages'
export { createOsvScanner, matchPackages, OSV_SCANNER_NAME } from './osv'
export type { OsvAdvisory, OsvLookup, OsvRange, OsvScannerDeps } from './osv'

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
