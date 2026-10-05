import type { ReasonCode } from '@sentinello/core'

// The canonical, source-agnostic view of one project's installed dependencies. Every advisory source
// (OSV feed, npm-audit, future feeds) consumes this same graph so prod/dev classification is computed
// once, the same way, instead of each source re-deriving it from the lockfile and disagreeing.

// Where a package sits in the dependency tree. A package can be reachable from BOTH prod and dev roots
// (e.g. a util used by a shipped lib and a test helper), so these are independent booleans, not an enum.
export type DepScope = {
    isProd: boolean
    isDev: boolean
    isOptional: boolean
}

// One concrete installed package: registry name, exact resolved version (peer suffixes stripped), its
// scope, and the raw lockfile node keys it was resolved from (kept for display/debugging only).
export type ResolvedPackage = {
    ecosystem: string
    name: string
    version: string
    scope: DepScope
    depPaths: string[]
}

// The lockfile as a graph of installed nodes, for the questions the collapsed package list cannot answer:
// which importer a dependency path starts from, through which parent, and whether ANY production root
// reaches a node. A node is one installed copy, identified by its stable lockfile key — the full pnpm
// snapshot key including its peer suffix (two peer variants of one name@version are two nodes), or the
// npm lock path (`node_modules/a/node_modules/b`, so hoisted and nested copies stay distinct). For these
// lockfiles a ResolvedPackage's `depPaths` are exactly its node ids.
export type LockNode = { id: string; name: string; version: string }
export type LockEdgeKind = 'prod' | 'optional' | 'peer'
export type LockEdge = { from: string; to: string; kind: LockEdgeKind }
export type LockRootKind = 'prod' | 'dev' | 'optional'
// One entry per importer dependency, never pooled across importers: `importer` is the workspace path
// ('.' for the project itself).
export type LockRoot = { importer: string; nodeId: string; kind: LockRootKind }
export type NodeGraph = { nodes: LockNode[]; edges: LockEdge[]; roots: LockRoot[] }

// The resolved graph plus the two lookups every consumer needs: the full package list (the OSV matcher
// walks it) and a classifier keyed by name+version (npm-audit maps each pre-matched finding back to its
// scope). `version` may be null or a comma-joined list — classify unions the scope across matches.
// `nodeGraph` is null where the lockfile carries no node graph (pnpm < v9, every non-JavaScript
// resolver): what depends on it is then "not determined", never guessed.
export type ResolvedGraph = {
    packages: ResolvedPackage[]
    classify(name: string, version: string | null): DepScope
    byName(name: string): ResolvedPackage[]
    nodeGraph: NodeGraph | null
}

// A manifest/lockfile discovery hit: the file we found, the ecosystem (registry EcosystemId) it belongs
// to, and its absolute path. The resolver dispatches on `kind`; the runner stamps `ecosystem` onto scans.
export type DetectedManifest = {
    kind: string
    ecosystem: string
    absolutePath: string
}

// The classified outcome of resolving one ecosystem's manifest (Phase 4 offline honesty). Not every
// listed manifest yields exact installed versions offline, so the resolver must say whether its graph is
// complete (`ok`), a scanned-subset of an otherwise-ambiguous manifest (`partial`), or yields nothing
// auditable at all (`unauditable`). `partial`/`unauditable` carry a stable ReasonCode + human `details`
// so the runner can record the gap and the UI (Phase 5) can disclose it per ecosystem rather than imply
// full coverage. `ecosystem` is the registry EcosystemId on every variant so the caller knows which
// ecosystem an `unauditable` (graph-less) result refers to.
export type ResolverResult =
    | { status: 'ok'; ecosystem: string; graph: ResolvedGraph }
    | { status: 'partial'; ecosystem: string; graph: ResolvedGraph; reasonCode: ReasonCode; details: string[] }
    | { status: 'unauditable'; ecosystem: string; reasonCode: ReasonCode; details: string[] }
