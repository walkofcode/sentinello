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

// The resolved graph plus the two lookups every consumer needs: the full package list (the OSV matcher
// walks it) and a classifier keyed by name+version (npm-audit maps each pre-matched finding back to its
// scope). `version` may be null or a comma-joined list — classify unions the scope across matches.
export type ResolvedGraph = {
    packages: ResolvedPackage[]
    classify(name: string, version: string | null): DepScope
    byName(name: string): ResolvedPackage[]
}
