import type { DepScope, LockEdge, LockNode, LockRoot, NodeGraph, ResolvedGraph, ResolvedPackage } from './types'

// Generic forward reachability over a string-keyed adjacency map: returns every node reachable from any
// of `roots`, the roots themselves included. Used to mark which lockfile nodes are pulled in by prod vs
// dev dependency roots. Iterative (explicit stack) so a deep tree never overflows the call stack.
export function reachableFrom(roots: Iterable<string>, adjacency: Map<string, string[]>): Set<string> {
    const visited = new Set<string>()
    const stack: string[] = []
    for (const root of roots) {
        if (!visited.has(root)) {
            visited.add(root)
            stack.push(root)
        }
    }
    // pop() drives the loop directly rather than a separate length check plus an undefined guard: the
    // guard could never fire (the stack only ever holds strings), while this form's exit test is the
    // same expression and is exercised on every walk.
    for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
        const children = adjacency.get(node)
        if (!children) continue
        for (const child of children) {
            if (!visited.has(child)) {
                visited.add(child)
                stack.push(child)
            }
        }
    }
    return visited
}

// Splits an installed-version field into concrete versions. npm-audit can hand us a comma/space-joined
// list when the same package is hoisted at multiple versions (see pickInstalledVersion in npm-audit.ts);
// a null/range/empty value yields [] so classify() falls back to unioning every version of the name.
export function splitVersions(version: string | null): string[] {
    if (!version) return []
    const out: string[] = []
    for (const raw of version.split(/[\s,]+/)) {
        const part = raw.trim()
        if (part) out.push(part)
    }
    return out
}

// Builds the ResolvedGraph lookups over a flat package list. classify(name, version) unions the scope
// across every matching package row; an unknown package (not in the lockfile) defaults to prod so a real
// finding is never hidden, mirroring the prior fail-open default.
export function makeGraph(packages: ResolvedPackage[], nodeGraph: NodeGraph | null = null): ResolvedGraph {
    const byNameMap = new Map<string, ResolvedPackage[]>()
    for (const pkg of packages) {
        const list = byNameMap.get(pkg.name)
        if (list) {
            list.push(pkg)
        } else {
            byNameMap.set(pkg.name, [pkg])
        }
    }
    function byName(name: string): ResolvedPackage[] {
        return byNameMap.get(name) || []
    }
    function classify(name: string, version: string | null): DepScope {
        const list = byNameMap.get(name)
        if (!list || list.length === 0) return { isProd: true, isDev: false, isOptional: false }
        const versions = splitVersions(version)
        let matches: ResolvedPackage[] = []
        if (versions.length > 0) {
            for (const pkg of list) {
                if (versions.includes(pkg.version)) matches.push(pkg)
            }
        }
        // Version unknown or no exact hit (hoisting / version drift) — union across all versions so the
        // classification stays conservative rather than silently dropping to the default.
        if (matches.length === 0) matches = list
        let isProd = false
        let isDev = false
        let isOptional = true
        for (const pkg of matches) {
            if (pkg.scope.isProd) isProd = true
            if (pkg.scope.isDev) isDev = true
            if (!pkg.scope.isOptional) isOptional = false
        }
        if (!isProd && !isDev) isProd = true
        return { isProd, isDev, isOptional }
    }
    return { packages, classify, byName, nodeGraph }
}

// Parses a pnpm/npm dependency key into { name, version } with peer suffixes and a leading slash
// stripped, e.g. "/@babel/core@7.0.0(supports-color@8.0.0)" → { '@babel/core', '7.0.0' }. Returns null
// for unrecognizable keys.
export function parseDepKey(key: string): { name: string; version: string } | null {
    let s = key.trim()
    if (!s) return null
    if (s.startsWith('/')) s = s.slice(1)
    const parenIdx = s.indexOf('(')
    if (parenIdx >= 0) s = s.slice(0, parenIdx)
    const isScoped = s.startsWith('@')
    const atIdx = isScoped ? s.indexOf('@', 1) : s.indexOf('@')
    if (atIdx <= 0) return null
    const name = s.slice(0, atIdx)
    const version = s.slice(atIdx + 1)
    if (!name || !version) return null
    return { name, version }
}

// A lockfile that carries its dependency graph (Cargo.lock, poetry.lock, uv.lock, Gemfile.lock), turned into
// a ResolvedGraph whose scope and chains both come from that graph.
//
//   - Scope is REACHABILITY: a package is prod when a prod root reaches it, dev when a dev root does, both
//     when both do. One no root reaches (a cycle, a root the manifest did not name) is prod, the resolver's
//     fail-open posture: a finding in the wrong bucket beats a finding not shown.
//   - `depPaths` is the shortest chain from any root to the package, each step written `name@version`, so a
//     finding reads `rails@7.1.0 → actionpack@7.1.0 → rack@2.2.8` instead of the bare package it is about.
//     The chain is found over node ids, which a resolver may qualify beyond name and version (a Cargo
//     crate's id carries its source, so a git `x@1.0.0` and the crates.io one stay two nodes); the label is
//     only how a step reads.
//
// `auditable` says which nodes become packages: a node from a source no advisory database covers (a git
// checkout, a local path) still carries edges, so what it depends on is still reached, but it is never
// matched as though it were the registry package of the same name.
export type LockGraphInput = {
    ecosystem: string
    manifestPath: string
    nodes: LockNode[]
    edges: LockEdge[]
    roots: LockRoot[]
    auditable(nodeId: string): boolean
}

export function graphFromLock(input: LockGraphInput): ResolvedGraph {
    const adjacency = new Map<string, string[]>()
    for (const edge of input.edges) {
        const children = adjacency.get(edge.from)
        if (children) children.push(edge.to)
        else adjacency.set(edge.from, [edge.to])
    }
    function rootsOf(kind: LockRoot['kind']): string[] {
        return input.roots.filter(function ofKind(r) { return r.kind === kind }).map(function id(r) { return r.nodeId })
    }
    const prod = reachableFrom(rootsOf('prod'), adjacency)
    const optional = reachableFrom(rootsOf('optional'), adjacency)
    const dev = reachableFrom(rootsOf('dev'), adjacency)
    const chains = shortestChains(input.roots.map(function id(r) { return r.nodeId }), adjacency)
    const labels = new Map(input.nodes.map(function label(node) { return [node.id, node.name + '@' + node.version] as const }))
    // Every chain step is a node: roots and edges only ever name the nodes a resolver handed in.
    function chainOf(nodeId: string): string[] {
        return (chains.get(nodeId) ?? [nodeId]).map(function step(id) { return labels.get(id) as string })
    }
    const packages: ResolvedPackage[] = []
    for (const node of input.nodes) {
        if (!input.auditable(node.id)) continue
        const reached = prod.has(node.id) || optional.has(node.id) || dev.has(node.id)
        packages.push({
            ecosystem: input.ecosystem,
            name: node.name,
            version: node.version,
            scope: {
                isProd: prod.has(node.id) || optional.has(node.id) || !reached,
                isDev: dev.has(node.id),
                isOptional: optional.has(node.id) && !prod.has(node.id)
            },
            depPaths: chainOf(node.id),
            manifestPath: input.manifestPath
        })
    }
    return makeGraph(packages, { nodes: input.nodes, edges: input.edges, roots: input.roots })
}

// Breadth-first from every root at once, so each node's chain is a shortest one.
function shortestChains(roots: string[], adjacency: Map<string, string[]>): Map<string, string[]> {
    const chains = new Map<string, string[]>()
    const queue: string[] = []
    for (const root of roots) {
        if (chains.has(root)) continue
        chains.set(root, [root])
        queue.push(root)
    }
    for (let head = 0; head < queue.length; head++) {
        const node = queue[head] as string
        const chain = chains.get(node) as string[]
        for (const child of adjacency.get(node) ?? []) {
            if (chains.has(child)) continue
            chains.set(child, [...chain, child])
            queue.push(child)
        }
    }
    return chains
}
