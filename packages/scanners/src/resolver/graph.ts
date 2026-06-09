import type { DepScope, ResolvedGraph, ResolvedPackage } from './types'

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
    while (stack.length > 0) {
        const node = stack.pop()
        if (node === undefined) break
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
export function makeGraph(packages: ResolvedPackage[]): ResolvedGraph {
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
    return { packages, classify, byName }
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
