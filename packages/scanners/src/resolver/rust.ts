import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { graphFromLock } from './graph'
import { isInsideProject } from './paths'
import { parseArrayOfTables, parseTomlSections, tomlArray, tomlString, tomlTable, type TomlTable } from './toml-lite'
import type { LockEdge, LockNode, LockRoot, ResolverResult } from './types'

// Rust resolver. `Cargo.lock` pins the FULL resolved dependency graph — every crate, its exact version, its
// source, and the crates it depends on — so it resolves to a graph with real chains. What it does not say
// is which edges are dev-only, so the `Cargo.toml` beside it names the direct dev crates, and reachability
// spreads that through the graph.
//
// Only crates from crates.io are matched. An advisory about crates.io's `openssl` says nothing about a
// crate of the same name built from a git checkout, a local path or another registry, so those are counted
// as cannot-be-audited (a partial graph, with details) instead of being compared against it. A crate with no
// `source` at all is the project's own — a workspace member, or a path dependency inside the project — and
// is a root, not a dependency; one that `Cargo.toml` pulls in by a path OUTSIDE the project is someone's
// local checkout, and is counted like a git crate.

const CRATES_ECOSYSTEM = 'crates.io'

// crates.io's index, as Cargo writes it in a lockfile: the git index and the sparse protocol.
const CRATES_IO_SOURCES = ['registry+https://github.com/rust-lang/crates.io-index', 'sparse+https://index.crates.io/']

type Crate = { id: string; name: string; version: string; source: string | null; dependencies: string[] }

export async function parseCargoLock(projectPath: string, absolutePath: string, manifestPath: string): Promise<ResolverResult> {
    let text: string
    try {
        text = await readFile(absolutePath, 'utf8')
    } catch {
        return unauditable('unsupported_lockfile', ['could not read ' + manifestPath])
    }
    const lockDir = dirname(absolutePath)
    const manifest = await readCargoManifest(join(lockDir, 'Cargo.toml'))
    const crates: Crate[] = []
    for (const t of parseArrayOfTables(text, 'package')) {
        const name = tomlString(t.name)
        const version = tomlString(t.version)
        if (!name || !version) continue
        crates.push({ id: name + '@' + version, name, version, source: tomlString(t.source), dependencies: tomlArray(t.dependencies).flatMap(asString) })
    }
    if (crates.length === 0) return unauditable('ambiguous_dependency_spec', ['no packages found in ' + manifestPath])

    const external = new Set<string>()
    for (const dep of manifest.pathDependencies) {
        if (!isInsideProject(projectPath, lockDir, dep.path)) external.add(dep.name)
    }
    const nodes: LockNode[] = []
    const edges: LockEdge[] = []
    const roots: LockRoot[] = []
    const auditable = new Set<string>()
    const cannotAudit: string[] = []
    for (const crate of crates) {
        nodes.push({ id: crate.id, name: crate.name, version: crate.version })
        const origin = originOf(crate, external)
        if (origin === 'crates.io') auditable.add(crate.id)
        else if (origin !== 'own') cannotAudit.push(crate.name + ' (' + origin + ')')
        for (const spec of crate.dependencies) {
            const target = resolveDependency(spec, crates)
            if (target === null) continue
            if (origin === 'own') roots.push({ importer: '.', nodeId: target.id, kind: manifest.devOnly.has(target.name) ? 'dev' : 'prod' })
            else edges.push({ from: crate.id, to: target.id, kind: 'prod' })
        }
    }

    // A lockfile with none of the project's own crates in it (a hand-trimmed or partial one) has no root to
    // start from; every crate nothing depends on is then a root, dev when the manifest says so.
    if (!crates.some(function own(crate) { return originOf(crate, external) === 'own' })) {
        const dependedOn = new Set(edges.map(function to(edge) { return edge.to }))
        for (const crate of crates) {
            if (!dependedOn.has(crate.id)) roots.push({ importer: '.', nodeId: crate.id, kind: manifest.devOnly.has(crate.name) ? 'dev' : 'prod' })
        }
    }
    const graph = graphFromLock({
        ecosystem: CRATES_ECOSYSTEM,
        manifestPath,
        nodes,
        edges,
        roots,
        auditable(nodeId: string) { return auditable.has(nodeId) }
    })
    if (cannotAudit.length === 0 && graph.packages.length > 0) return { status: 'ok', ecosystem: CRATES_ECOSYSTEM, graph }
    if (graph.packages.length === 0) {
        return unauditable('ambiguous_dependency_spec', cannotAudit.length === 0 ? ['no crates.io packages found in ' + manifestPath] : [cannotAuditDetail(cannotAudit)])
    }
    return { status: 'partial', ecosystem: CRATES_ECOSYSTEM, graph, reasonCode: 'partial_dependency_graph', details: [cannotAuditDetail(cannotAudit)] }
}

function cannotAuditDetail(cannotAudit: string[]): string {
    return cannotAudit.length + ' crates from git, local path or other registry sources cannot be audited: ' + [...cannotAudit].sort().join(', ')
}

function originOf(crate: Crate, external: Set<string>): 'crates.io' | 'own' | 'git' | 'path' | 'registry' {
    const source = crate.source
    if (source === null || source.length === 0) return external.has(crate.name) ? 'path' : 'own'
    if (CRATES_IO_SOURCES.some(function prefix(p) { return source.startsWith(p) })) return 'crates.io'
    return source.startsWith('git+') ? 'git' : 'registry'
}

// A Cargo.lock dependency is `name`, `name version` or `name version (source)` — the extra parts appear
// only when the name alone would be ambiguous.
function resolveDependency(spec: string, crates: Crate[]): Crate | null {
    const [name, version] = spec.split(' ')
    for (const crate of crates) {
        if (crate.name === name && (version === undefined || crate.version === version)) return crate
    }
    return null
}

type CargoManifest = {
    // Crates the manifest names only as dev-dependencies.
    devOnly: Set<string>
    // Every dependency it pulls in by `path`, with its crate name (a `package = "…"` rename wins).
    pathDependencies: Array<{ name: string; path: string }>
}

// The manifest's dependency tables: `[dependencies]`, `[dev-dependencies]`, `[build-dependencies]`,
// `[workspace.dependencies]`, their `[target.'cfg(…)'.…]` forms, and the dotted-header form that gives one
// crate its own table (`[dev-dependencies.serde]`, whose keys are that crate's options, not crate names).
// An absent or unreadable Cargo.toml just means "all prod, no path dependencies".
async function readCargoManifest(path: string): Promise<CargoManifest> {
    let text: string
    try {
        text = await readFile(path, 'utf8')
    } catch {
        return { devOnly: new Set(), pathDependencies: [] }
    }
    const dev = new Set<string>()
    const nonDev = new Set<string>()
    const pathDependencies: Array<{ name: string; path: string }> = []
    function record(key: string, spec: TomlTable | null, isDev: boolean): void {
        const name = (spec !== null ? tomlString(spec.package) : null) ?? key
        ;(isDev ? dev : nonDev).add(name)
        const path = spec !== null ? tomlString(spec.path) : null
        if (path !== null) pathDependencies.push({ name, path })
    }
    for (const section of parseTomlSections(text)) {
        const table = /(?:^|\.)((?:dev-|build-)?dependencies)(?:\.(.+))?$/.exec(section.header)
        if (!table) continue
        const isDev = table[1] === 'dev-dependencies'
        const single = table[2]
        if (single !== undefined) {
            record(unquote(single), section.values, isDev)
            continue
        }
        for (const [key, value] of Object.entries(section.values)) record(key, tomlTable(value), isDev)
    }
    const devOnly = new Set([...dev].filter(function only(name) { return !nonDev.has(name) }))
    return { devOnly, pathDependencies }
}

function unquote(key: string): string {
    return key.replace(/^["']|["']$/g, '')
}

function asString(value: unknown): string[] {
    return typeof value === 'string' ? [value] : []
}

function unauditable(reasonCode: 'unsupported_lockfile' | 'ambiguous_dependency_spec', details: string[]): ResolverResult {
    return { status: 'unauditable', ecosystem: CRATES_ECOSYSTEM, reasonCode, details }
}
