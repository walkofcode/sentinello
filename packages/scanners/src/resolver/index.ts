import { statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { getEcosystem, STABLE_ECOSYSTEMS, type EcosystemDefinition } from '@sentinello/core'
import type { DetectedLockfile } from '../types'
import { parseGoMod } from './go'
import { makeGraph } from './graph'
import { parseNpmLock } from './npm-lock'
import { manifestPathOf } from './paths'
import { parsePnpmLock } from './pnpm'
import { parsePythonLock } from './python'
import { parseGemfileLock } from './ruby'
import { parseCargoLock } from './rust'
import type { DetectedManifest, ResolvedGraph, ResolvedPackage, ResolverResult } from './types'

export type { DepScope, DetectedManifest, LockEdge, LockEdgeKind, LockNode, LockRoot, LockRootKind, NodeGraph, ResolvedGraph, ResolvedPackage, ResolverResult } from './types'

// Resolves a project's lockfile into the canonical ResolvedGraph once per scan. Every advisory source
// shares the result, so prod/dev classification is computed a single way. yarn.lock and any unparseable
// lock return null (fail-open) — callers treat that as "unauditable", same posture as before. Kept for the
// JavaScript-only callers; the polyglot runner uses resolveProjectGraphs instead.
export async function resolveProject(
    projectPath: string,
    lockfile: DetectedLockfile
): Promise<ResolvedGraph | null> {
    const manifestPath = manifestPathOf(projectPath, lockfile.absolutePath)
    if (lockfile.kind === 'package-lock.json') {
        return parseNpmLock(projectPath, lockfile.absolutePath, manifestPath)
    }
    if (lockfile.kind === 'pnpm-lock.yaml') {
        return parsePnpmLock(lockfile.absolutePath, manifestPath)
    }
    return null
}

// Multi-manifest discovery for one project directory. For each OFFERED ecosystem, find the first present
// lockfile (in the registry's preference order) and record it — one per ecosystem, so a single directory
// can yield one project spanning several. The runner resolves each of these into its own graph.
//
// Preview ecosystems are skipped rather than detected-and-then-ignored. Detecting them stamped their id
// onto the project and produced per-ecosystem coverage rows for an ecosystem no source would ever answer
// for, which reads to an operator as "found and handled" when nothing was scanned at all.
//
// A manifest with no lockfile covering it (a package.json, Gemfile, Cargo.toml, pyproject.toml or Pipfile
// on its own) is detected too, and resolves to `unauditable / no_lockfile`. Detecting nothing left the
// scan with no coverage at all, and so no recorded reason why the project could not be read.
export async function detectManifests(projectPath: string): Promise<DetectedManifest[]> {
    return detectManifestsIn(projectPath, projectPath, STABLE_ECOSYSTEMS)
}

// The same, for one directory inside a project — the project's own directory, or one below it. `ecosystems`
// is the set to look for; discovery passes the stable ones.
export async function detectManifestsIn(dir: string, projectPath: string, ecosystems: readonly EcosystemDefinition[]): Promise<DetectedManifest[]> {
    return Promise.resolve(detectManifestsInSync(dir, projectPath, ecosystems))
}

// The synchronous form, for project discovery, whose walk is synchronous end to end. It IS the rule set:
// the async form above returns its answer, so what a directory holds is decided in one place.
export function detectManifestsInSync(dir: string, projectPath: string, ecosystems: readonly EcosystemDefinition[]): DetectedManifest[] {
    const out: DetectedManifest[] = []
    for (const eco of ecosystems) {
        const kind = firstPresent(dir, eco.resolverKinds)
        if (kind !== null) {
            out.push({ kind, ecosystem: eco.id, absolutePath: join(dir, kind) })
            continue
        }
        const manifest = firstPresent(dir, eco.manifestKinds)
        if (manifest !== null && !coveredByLock(eco, manifest, dir, projectPath)) {
            out.push({ kind: manifest, ecosystem: eco.id, absolutePath: join(dir, manifest) })
        }
    }
    return out
}

// Whether a manifest with no lockfile beside it is still covered by one (decision SENTINEL-118). Only a
// Cargo workspace member is: Cargo writes ONE Cargo.lock at the workspace root for every member, so a
// member's Cargo.toml is covered by a Cargo.lock in any directory above it — up to the owning project's
// directory and never above it, because a lock outside the project is another project's. Bundler and the
// Python tools lock beside the manifest, so for them "no lockfile beside it" is the whole test.
function coveredByLock(eco: EcosystemDefinition, manifest: string, dir: string, projectPath: string): boolean {
    if (manifest !== 'Cargo.toml') return false
    const root = resolve(projectPath)
    for (let current = dirname(resolve(dir)); isWithin(root, current); current = dirname(current)) {
        if (firstPresent(current, eco.resolverKinds) !== null) return true
        if (current === root) break
    }
    return false
}

function isWithin(root: string, path: string): boolean {
    const rel = relative(root, path)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function firstPresent(dir: string, kinds: readonly string[]): string | null {
    for (const kind of kinds) {
        if (fileExists(join(dir, kind))) return kind
    }
    return null
}

// Resolve one detected manifest into a classified ResolverResult, dispatching by ecosystem + lockfile kind.
// Binds ecosystem ids to the central registry — resolver output stamps the registry ecosystem id so it
// matches the advisory rows OSV/gemnasium key on.
export async function resolveManifest(projectPath: string, manifest: DetectedManifest): Promise<ResolverResult> {
    const { ecosystem, kind, absolutePath } = manifest
    const manifestPath = manifestPathOf(projectPath, absolutePath)
    const lockless = locklessDetail(ecosystem, kind, manifestPath)
    if (lockless !== null) return { status: 'unauditable', ecosystem, reasonCode: 'no_lockfile', details: [lockless] }
    if (ecosystem === 'npm') {
        if (kind === 'package-lock.json') {
            return wrapNpm(ecosystem, await parseNpmLock(projectPath, absolutePath, manifestPath), kind)
        }
        if (kind === 'pnpm-lock.yaml') {
            return wrapNpm(ecosystem, await parsePnpmLock(absolutePath, manifestPath), kind)
        }
        // yarn.lock (and anything else) is not parsed — unauditable, same posture as the JS-only path.
        return { status: 'unauditable', ecosystem, reasonCode: 'unsupported_lockfile', details: [kind + ' is not a supported JavaScript lockfile format'] }
    }
    if (ecosystem === 'PyPI') return parsePythonLock(projectPath, kind, absolutePath, manifestPath)
    if (ecosystem === 'Go') return parseGoMod(kind, absolutePath, manifestPath)
    if (ecosystem === 'crates.io') return parseCargoLock(projectPath, absolutePath, manifestPath)
    if (ecosystem === 'RubyGems') return parseGemfileLock(projectPath, absolutePath, manifestPath)
    return { status: 'unauditable', ecosystem, reasonCode: 'unsupported_lockfile', details: ['no resolver for ecosystem ' + ecosystem] }
}

// The `no_lockfile` detail for a manifest kind, naming the lockfiles that would have covered it; null for
// a lockfile kind.
function locklessDetail(ecosystem: string, kind: string, manifestPath: string): string | null {
    const eco = getEcosystem(ecosystem)
    if (eco === null || !eco.manifestKinds.includes(kind)) return null
    return manifestPath + ' has no lockfile covering it (' + eco.resolverKinds.join(', ') + ')'
}

// Resolve every detected manifest into its classified result (one per ecosystem present). The runner uses
// these to build per-source graphs and to record per-ecosystem coverage.
export async function resolveProjectGraphs(projectPath: string, manifests: DetectedManifest[]): Promise<ResolverResult[]> {
    const results: ResolverResult[] = []
    for (const manifest of manifests) {
        results.push(await resolveManifest(projectPath, manifest))
    }
    return results
}

// Merge the resolved graphs of several ecosystems into one ResolvedGraph (ok + partial results contribute
// their packages; unauditable results have no graph). Advisory-feed scanners (OSV, gemnasium) answer for
// every ecosystem, group the packages by ecosystem internally, and match each with its own comparator — so
// they take this merged view. Returns null when no ecosystem resolved any package.
export function mergeResolvedGraphs(results: ResolverResult[]): ResolvedGraph | null {
    const packages: ResolvedPackage[] = []
    for (const r of results) {
        if (r.status === 'ok' || r.status === 'partial') {
            for (const pkg of r.graph.packages) packages.push(pkg)
        }
    }
    if (packages.length === 0) return null
    // No node graph: node ids are per lockfile, and the feed scanners this view is for never walk one.
    // The way-out guidance reads the npm graph itself (graphForEcosystem).
    return makeGraph(packages)
}

// Pull the graph for a single ecosystem out of the resolver results (used to hand npm-audit only the
// JavaScript graph). Returns null when that ecosystem produced no auditable graph.
export function graphForEcosystem(results: ResolverResult[], ecosystem: string): ResolvedGraph | null {
    for (const r of results) {
        if (r.ecosystem !== ecosystem) continue
        if (r.status === 'ok' || r.status === 'partial') return r.graph
    }
    return null
}

function wrapNpm(ecosystem: string, graph: ResolvedGraph | null, kind: string): ResolverResult {
    if (!graph) return { status: 'unauditable', ecosystem, reasonCode: 'unsupported_lockfile', details: ['could not parse ' + kind] }
    return { status: 'ok', ecosystem, graph }
}

// A directory that happens to carry a manifest's name is not a manifest, and one that cannot be stat'ed
// (missing, unreadable parent, gone mid-walk) is not present.
function fileExists(path: string): boolean {
    try {
        return statSync(path).isFile()
    } catch {
        return false
    }
}
