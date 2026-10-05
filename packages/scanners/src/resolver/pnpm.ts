import { readFile } from 'node:fs/promises'
import yaml from 'js-yaml'
import { makeGraph, parseDepKey, reachableFrom } from './graph'
import type { LockEdge, LockEdgeKind, LockNode, LockRoot, LockRootKind, NodeGraph, ResolvedGraph, ResolvedPackage } from './types'

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

    // Adjacency over snapshot keys, kept as typed edges for the node graph. A dependency value is
    // normally the child's version(+peers), so `childName@value` is the child's snapshot key; an aliased
    // dependency (`string-width-cjs: string-width@4.2.3`) carries the real key as its value.
    const edges: LockEdge[] = []
    const adjacency = new Map<string, string[]>()
    const optionalKeys = new Set<string>()
    for (const key of Object.keys(snapshots)) {
        const snap = snapshots[key]
        const children: string[] = []
        if (snap && typeof snap === 'object') {
            collectChildren(key, snap.dependencies, 'prod', snapshots, children, edges)
            collectChildren(key, snap.optionalDependencies, 'optional', snapshots, children, edges)
            if (snap.optional === true) optionalKeys.add(key)
        }
        adjacency.set(key, children)
    }

    // Roots: every importer (workspace) contributes its dependencies and optionalDependencies as prod
    // roots and its devDependencies as dev roots, one root per importer entry. `link:` values point at
    // another workspace, not a registry package — that workspace's own deps are already counted via its
    // own importer entry, so we skip link targets here rather than chase them.
    const roots: LockRoot[] = []
    for (const importerPath of Object.keys(importers)) {
        const importer = importers[importerPath]
        if (!importer || typeof importer !== 'object') continue
        collectRoots(importerPath, importer.dependencies, 'prod', snapshots, roots)
        collectRoots(importerPath, importer.optionalDependencies, 'optional', snapshots, roots)
        collectRoots(importerPath, importer.devDependencies, 'dev', snapshots, roots)
    }
    const prodRoots = roots.filter(function prod(r) { return r.kind !== 'dev' }).map(nodeIdOf)
    const devRoots = roots.filter(function dev(r) { return r.kind === 'dev' }).map(nodeIdOf)

    const prodReachable = reachableFrom(prodRoots, adjacency)
    const devReachable = reachableFrom(devRoots, adjacency)

    // Enumerate installed packages from the snapshot keys (the full resolved set), collapsing peer
    // variants of the same name@version into one row and unioning their scope. Each key stays its own
    // node in the node graph.
    const sourceKeys = Object.keys(snapshots).length > 0 ? Object.keys(snapshots) : Object.keys(packagesMap)
    const byId = new Map<string, ResolvedPackage>()
    const nodes: LockNode[] = []
    for (const key of sourceKeys) {
        const parsed = parseDepKey(key)
        if (!parsed) continue
        nodes.push({ id: key, name: parsed.name, version: parsed.version })
        const id = parsed.name + '@' + parsed.version
        const isProd = prodReachable.has(key)
        const isDev = devReachable.has(key)
        const isOptional = optionalKeys.has(key)
        const existing = byId.get(id)
        if (existing) {
            if (isProd) existing.scope.isProd = true
            if (isDev) existing.scope.isDev = true
            if (!isOptional) existing.scope.isOptional = false
            // No dedup check: sourceKeys comes from Object.keys, so a key is visited exactly once.
            existing.depPaths.push(key)
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
    const nodeGraph: NodeGraph = { nodes, edges, roots }
    return makeGraph(Array.from(byId.values()), nodeGraph)
}

function nodeIdOf(root: LockRoot): string {
    return root.nodeId
}

// The snapshot key a dependency value points at: `name@value`, or the value itself for an alias.
function snapshotKey(name: string, value: string, snapshots: Record<string, PnpmSnapshot>): string {
    const direct = name + '@' + value
    if (direct in snapshots) return direct
    return value in snapshots ? value : direct
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
        // No empty-version guard: parseDepKey already returned null for one (graph.ts:100), so
        // parsed.version is a non-empty string and the `||` result is always truthy.
        const version = entry.version || parsed.version
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

function collectChildren(
    from: string,
    deps: Record<string, string> | undefined,
    kind: LockEdgeKind,
    snapshots: Record<string, PnpmSnapshot>,
    out: string[],
    edges: LockEdge[]
): void {
    if (!deps || typeof deps !== 'object') return
    for (const name of Object.keys(deps)) {
        const version = deps[name]
        if (typeof version !== 'string' || !version) continue
        const to = snapshotKey(name, version, snapshots)
        out.push(to)
        edges.push({ from, to, kind })
    }
}

function collectRoots(
    importer: string,
    deps: Record<string, PnpmImporterDep> | undefined,
    kind: LockRootKind,
    snapshots: Record<string, PnpmSnapshot>,
    out: LockRoot[]
): void {
    if (!deps || typeof deps !== 'object') return
    for (const name of Object.keys(deps)) {
        const dep = deps[name]
        const version = dep && dep.version
        if (typeof version !== 'string' || !version) continue
        if (version.startsWith('link:')) continue
        out.push({ importer, nodeId: snapshotKey(name, version, snapshots), kind })
    }
}
