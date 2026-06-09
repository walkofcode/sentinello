import { readFile } from 'node:fs/promises'
import yaml from 'js-yaml'
import { makeGraph, parseDepKey, reachableFrom } from './graph'
import type { ResolvedGraph, ResolvedPackage } from './types'

const NPM_ECOSYSTEM = 'npm'

// pnpm-lock.yaml resolver. v9 (lockfileVersion 9.0) dropped the per-package `dev:` flag — prod/dev is
// now only derivable from `importers` (the roots) + `snapshots` (the graph) by reachability, which is
// what parsePnpmV9 does. v6 and earlier still carry `dev:` on each `packages` entry, handled by the
// legacy path. Returns null on read/parse failure so the caller fails open.
export async function parsePnpmLock(absolutePath: string): Promise<ResolvedGraph | null> {
    let text: string
    try {
        text = await readFile(absolutePath, 'utf8')
    } catch {
        return null
    }
    let doc: unknown
    try {
        doc = yaml.load(text)
    } catch {
        return null
    }
    if (!doc || typeof doc !== 'object') return null
    const root = doc as PnpmLockDoc
    // v9 is identified by the presence of `importers`/`snapshots`; older locks carry neither and put the
    // dev flag on `packages` entries instead.
    if (root.importers || root.snapshots) {
        return parsePnpmV9(root)
    }
    return parsePnpmLegacy(root)
}

type PnpmImporterDep = { version?: string }
type PnpmImporter = {
    dependencies?: Record<string, PnpmImporterDep>
    optionalDependencies?: Record<string, PnpmImporterDep>
    devDependencies?: Record<string, PnpmImporterDep>
}
type PnpmSnapshot = {
    dependencies?: Record<string, string>
    optionalDependencies?: Record<string, string>
    optional?: boolean
}
type PnpmLegacyPackage = {
    dev?: boolean
    optional?: boolean
    version?: string
}
type PnpmLockDoc = {
    importers?: Record<string, PnpmImporter>
    snapshots?: Record<string, PnpmSnapshot>
    packages?: Record<string, PnpmLegacyPackage>
}

function parsePnpmV9(root: PnpmLockDoc): ResolvedGraph {
    const importers = root.importers || {}
    const snapshots = root.snapshots || {}
    const packagesMap = root.packages || {}

    // Adjacency over snapshot keys: each snapshot's dependency value is the child's version(+peers), so
    // `childName@value` reconstructs the child's snapshot key exactly (pnpm keys are deterministic).
    const adjacency = new Map<string, string[]>()
    const optionalKeys = new Set<string>()
    for (const key of Object.keys(snapshots)) {
        const snap = snapshots[key]
        const children: string[] = []
        if (snap && typeof snap === 'object') {
            collectChildren(snap.dependencies, children)
            collectChildren(snap.optionalDependencies, children)
            if (snap.optional === true) optionalKeys.add(key)
        }
        adjacency.set(key, children)
    }

    // Roots: every importer (workspace) contributes its prod deps (dependencies + optionalDependencies)
    // as prod roots and its devDependencies as dev roots. `link:` values point at another workspace, not
    // a registry package — that workspace's own deps are already counted via its own importer entry, so
    // we skip link targets here rather than chase them.
    const prodRoots: string[] = []
    const devRoots: string[] = []
    for (const importer of Object.values(importers)) {
        if (!importer || typeof importer !== 'object') continue
        collectRoots(importer.dependencies, prodRoots)
        collectRoots(importer.optionalDependencies, prodRoots)
        collectRoots(importer.devDependencies, devRoots)
    }

    const prodReachable = reachableFrom(prodRoots, adjacency)
    const devReachable = reachableFrom(devRoots, adjacency)

    // Enumerate installed packages from the snapshot keys (the full resolved set), collapsing peer
    // variants of the same name@version into one row and unioning their scope.
    const sourceKeys = Object.keys(snapshots).length > 0 ? Object.keys(snapshots) : Object.keys(packagesMap)
    const byId = new Map<string, ResolvedPackage>()
    for (const key of sourceKeys) {
        const parsed = parseDepKey(key)
        if (!parsed) continue
        const id = parsed.name + '@' + parsed.version
        const isProd = prodReachable.has(key)
        const isDev = devReachable.has(key)
        const isOptional = optionalKeys.has(key)
        const existing = byId.get(id)
        if (existing) {
            if (isProd) existing.scope.isProd = true
            if (isDev) existing.scope.isDev = true
            if (!isOptional) existing.scope.isOptional = false
            if (!existing.depPaths.includes(key)) existing.depPaths.push(key)
        } else {
            byId.set(id, {
                ecosystem: NPM_ECOSYSTEM,
                name: parsed.name,
                version: parsed.version,
                scope: { isProd, isDev, isOptional },
                depPaths: [key]
            })
        }
    }
    return makeGraph(Array.from(byId.values()))
}

// pnpm v6/earlier: the `packages` map keys are `/name@version` and each entry carries `dev`/`optional`.
function parsePnpmLegacy(root: PnpmLockDoc): ResolvedGraph {
    const packages = root.packages || {}
    const out: ResolvedPackage[] = []
    for (const key of Object.keys(packages)) {
        const entry = packages[key]
        if (!entry) continue
        const parsed = parseDepKey(key)
        if (!parsed) continue
        const version = entry.version || parsed.version
        if (!version) continue
        const isDev = entry.dev === true
        out.push({
            ecosystem: NPM_ECOSYSTEM,
            name: parsed.name,
            version,
            scope: { isProd: !isDev, isDev, isOptional: entry.optional === true },
            depPaths: [key]
        })
    }
    return makeGraph(out)
}

function collectChildren(deps: Record<string, string> | undefined, out: string[]): void {
    if (!deps || typeof deps !== 'object') return
    for (const name of Object.keys(deps)) {
        const version = deps[name]
        if (typeof version === 'string' && version) out.push(name + '@' + version)
    }
}

function collectRoots(deps: Record<string, PnpmImporterDep> | undefined, out: string[]): void {
    if (!deps || typeof deps !== 'object') return
    for (const name of Object.keys(deps)) {
        const dep = deps[name]
        const version = dep && dep.version
        if (typeof version !== 'string' || !version) continue
        if (version.startsWith('link:')) continue
        out.push(name + '@' + version)
    }
}
