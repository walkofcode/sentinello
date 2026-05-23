import type { ScannerPlugin } from './types'
import { npmAuditPlugin } from './npm-audit'

export * from './types'
export { npmAuditPlugin, runNpmAudit } from './npm-audit'
export { filterFindingsByLockfileResolution } from './lockfile-cross-check'
export type { CrossCheckResult } from './lockfile-cross-check'

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
