import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { ECOSYSTEMS } from '@sentinello/core'
import type { DetectedLockfile } from '../types'
import { parseGoMod } from './go'
import { makeGraph } from './graph'
import { parseNpmLock } from './npm-lock'
import { parsePnpmLock } from './pnpm'
import { parsePythonLock } from './python'
import { parseCargoLock } from './rust'
import type { DetectedManifest, ResolvedGraph, ResolvedPackage, ResolverResult } from './types'

export type { DepScope, DetectedManifest, ResolvedGraph, ResolvedPackage, ResolverResult } from './types'

// Resolves a project's lockfile into the canonical ResolvedGraph once per scan. Every advisory source
// shares the result, so prod/dev classification is computed a single way. yarn.lock and any unparseable
// lock return null (fail-open) — callers treat that as "unauditable", same posture as before. Kept for the
// JavaScript-only callers; the polyglot runner uses resolveProjectGraphs instead.
export async function resolveProject(
    projectPath: string,
    lockfile: DetectedLockfile
): Promise<ResolvedGraph | null> {
    if (lockfile.kind === 'package-lock.json') {
        return parseNpmLock(projectPath, lockfile.absolutePath)
    }
    if (lockfile.kind === 'pnpm-lock.yaml') {
        return parsePnpmLock(lockfile.absolutePath)
    }
    return null
}

// Multi-manifest discovery for one project directory. For each ecosystem in the central registry, find the
// first present manifest (in the registry's preference order) and record it — one manifest per ecosystem,
// so a single directory yields one project spanning JavaScript + Python + Go + Rust. The runner resolves
// each of these into its own graph.
export async function detectManifests(projectPath: string): Promise<DetectedManifest[]> {
    const out: DetectedManifest[] = []
    for (const eco of ECOSYSTEMS) {
        for (const kind of eco.resolverKinds) {
            const absolutePath = join(projectPath, kind)
            if (await fileExists(absolutePath)) {
                out.push({ kind, ecosystem: eco.id, absolutePath })
                break
            }
        }
    }
    return out
}

// Resolve one detected manifest into a classified ResolverResult, dispatching by ecosystem + lockfile kind.
// Binds ecosystem ids to the central registry — resolver output stamps the registry ecosystem id so it
// matches the advisory rows OSV/gemnasium key on.
export async function resolveManifest(projectPath: string, manifest: DetectedManifest): Promise<ResolverResult> {
    const { ecosystem, kind, absolutePath } = manifest
    if (ecosystem === 'npm') {
        if (kind === 'package-lock.json') {
            return wrapNpm(ecosystem, await parseNpmLock(projectPath, absolutePath), kind)
        }
        if (kind === 'pnpm-lock.yaml') {
            return wrapNpm(ecosystem, await parsePnpmLock(absolutePath), kind)
        }
        // yarn.lock (and anything else) is not parsed — unauditable, same posture as the JS-only path.
        return { status: 'unauditable', ecosystem, reasonCode: 'unsupported_lockfile', details: [kind + ' is not a supported JavaScript lockfile format'] }
    }
    if (ecosystem === 'PyPI') return parsePythonLock(kind, absolutePath)
    if (ecosystem === 'Go') return parseGoMod(kind, absolutePath)
    if (ecosystem === 'crates.io') return parseCargoLock(projectPath, absolutePath)
    return { status: 'unauditable', ecosystem, reasonCode: 'unsupported_lockfile', details: ['no resolver for ecosystem ' + ecosystem] }
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

async function fileExists(path: string): Promise<boolean> {
    try {
        await access(path)
        return true
    } catch {
        return false
    }
}
