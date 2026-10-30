import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { graphFromLock } from './graph'
import { isInsideProject } from './paths'
import { parseArrayOfTables, parseTomlSections, tomlArray, tomlString, tomlTable, type TomlTable } from './toml-lite'
import type { LockEdge, LockNode, LockRoot, ResolverResult } from './types'

// Rust resolver. `Cargo.lock` pins the FULL resolved dependency graph — every crate, its exact version, its
// source, and the crates it depends on — so it resolves to a graph with real chains. What it does not say
// is which edges are dev-only or where a crate with no source lives, and both are a property of ONE crate's
// manifest: the workspace's `Cargo.toml` files are read, each own crate's dependencies take their scope from
// that crate's own manifest, and reachability spreads it through the graph. A root manifest's
// `[dev-dependencies]` says nothing about what a member ships.
//
// Only crates from crates.io are matched. An advisory about crates.io's `openssl` says nothing about a
// crate of the same name built from a git checkout, a local path or another registry, so those are counted
// as cannot-be-audited (a partial graph, with details) instead of being compared against it.
//
// A crate with no `source` is the project's own only when its manifest is FOUND inside the project: the
// root package, a workspace member, or a path dependency of one of those that stays inside. One a manifest
// pulls in by a path OUTSIDE the project is someone's local checkout, and one whose manifest is not found at
// all (a member the workspace globs do not reach, a `[patch]` this reader does not follow, a lock with no
// Cargo.toml) cannot be shown to be the project's own — both are counted like a git crate, never assumed.
//
// Node identity is the crate's full Cargo package id — name, version AND source — because one lockfile can
// hold `x 1.0.0` from crates.io and `x 1.0.0` from git (https://doc.rust-lang.org/cargo/reference/pkgid-spec
// .html), and keying both as `x@1.0.0` would audit the git one as the registry release and merge their
// dependency edges and scope. Chains still read `name@version`.

const CRATES_ECOSYSTEM = 'crates.io'

// crates.io's index, as Cargo writes it in a lockfile: the git index and the sparse protocol.
const CRATES_IO_SOURCES = ['registry+https://github.com/rust-lang/crates.io-index', 'sparse+https://index.crates.io/']

// A workspace is a bounded thing, but globs and path dependencies are followed transitively; this keeps a
// pathological tree from turning one scan into an unbounded walk.
const MAX_MANIFESTS = 1000

type Crate = { id: string; name: string; version: string; source: string | null; dependencies: string[] }

export async function parseCargoLock(projectPath: string, absolutePath: string, manifestPath: string): Promise<ResolverResult> {
    let text: string
    try {
        text = await readFile(absolutePath, 'utf8')
    } catch {
        return unauditable('unsupported_lockfile', ['could not read ' + manifestPath])
    }
    const lockDir = dirname(absolutePath)
    const workspace = await readWorkspace(projectPath, lockDir)
    const crates: Crate[] = []
    for (const t of parseArrayOfTables(text, 'package')) {
        const name = tomlString(t.name)
        const version = tomlString(t.version)
        if (!name || !version) continue
        const source = tomlString(t.source)
        const sourced = source !== null && source.length > 0 ? source : null
        crates.push({ id: crateId(name, version, sourced), name, version, source: sourced, dependencies: tomlArray(t.dependencies).flatMap(asString) })
    }
    if (crates.length === 0) return unauditable('ambiguous_dependency_spec', ['no packages found in ' + manifestPath])

    const nodes: LockNode[] = []
    const edges: LockEdge[] = []
    const roots: LockRoot[] = []
    const auditable = new Set<string>()
    const cannotAudit: string[] = []
    let ownCrates = 0
    for (const crate of crates) {
        nodes.push({ id: crate.id, name: crate.name, version: crate.version })
        const origin = originOf(crate, workspace)
        if (origin === 'crates.io') auditable.add(crate.id)
        else if (origin !== 'own') cannotAudit.push(crate.name + ' (' + origin + ')')
        const manifest = origin === 'own' ? workspace.own.get(crate.name) as CargoManifest : null
        if (manifest !== null) ownCrates++
        for (const spec of crate.dependencies) {
            for (const target of resolveDependency(spec, crates)) {
                // An own crate's dependencies are roots, scoped by THAT crate's manifest.
                if (manifest !== null) roots.push({ importer: importerOf(lockDir, manifest.dir), nodeId: target.id, kind: manifest.devOnly.has(target.name) ? 'dev' : 'prod' })
                else edges.push({ from: crate.id, to: target.id, kind: 'prod' })
            }
        }
    }

    // A lockfile with none of the project's own crates in it (a hand-trimmed or partial one, or one with no
    // manifest found) has no root to start from; every crate nothing depends on is then a root, dev when the
    // root manifest says so.
    if (ownCrates === 0) {
        const dependedOn = new Set(edges.map(function to(edge) { return edge.to }))
        const devOnly = workspace.root?.devOnly ?? new Set<string>()
        for (const crate of crates) {
            if (!dependedOn.has(crate.id)) roots.push({ importer: '.', nodeId: crate.id, kind: devOnly.has(crate.name) ? 'dev' : 'prod' })
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

function crateId(name: string, version: string, source: string | null): string {
    return source === null ? name + '@' + version : name + '@' + version + ' (' + source + ')'
}

function originOf(crate: Crate, workspace: Workspace): 'crates.io' | 'own' | 'git' | 'path' | 'registry' {
    const source = crate.source
    if (source === null) return !workspace.external.has(crate.name) && workspace.own.has(crate.name) ? 'own' : 'path'
    if (CRATES_IO_SOURCES.some(function prefix(p) { return source.startsWith(p) })) return 'crates.io'
    return source.startsWith('git+') ? 'git' : 'registry'
}

// A Cargo.lock dependency is `name`, `name version` or `name version (source)` — the extra parts appear
// only when the name alone would be ambiguous. Every crate matching all the parts written is a target: one
// for a lockfile Cargo wrote, and all of them — never an arbitrary first — for one it did not.
function resolveDependency(spec: string, crates: Crate[]): Crate[] {
    const match = /^(\S+)(?: (\S+))?(?: \((.+)\))?$/.exec(spec.trim())
    if (match === null) return []
    const [, name, version, source] = match
    return crates.filter(function matches(crate) {
        return crate.name === name
            && (version === undefined || crate.version === version)
            && (source === undefined || (crate.source !== null && sameSource(crate.source, source)))
    })
}

// A git source's `#<commit>` is the precise revision; a dependency reference may be written with or
// without it, and either way names the same source.
function sameSource(a: string, b: string): boolean {
    return a === b || a.split('#')[0] === b.split('#')[0]
}

function importerOf(lockDir: string, dir: string): string {
    const rel = relative(lockDir, dir).split(sep).join('/')
    return rel === '' ? '.' : rel
}

type CargoManifest = {
    dir: string
    // `[package] name`, or null for a virtual workspace manifest.
    name: string | null
    // Crates the manifest names only as dev-dependencies.
    devOnly: Set<string>
    // Every dependency it pulls in by `path`, with its crate name (a `package = "…"` rename wins), from
    // its dependency tables, `[workspace.dependencies]` and `[patch.*]`.
    pathDependencies: Array<{ name: string; path: string }>
    // `[workspace] members` and `exclude`, as written.
    members: string[]
    exclude: string[]
}

type Workspace = {
    root: CargoManifest | null
    // The project's own crates, by package name, each with the manifest that declares it.
    own: Map<string, CargoManifest>
    // Crates some manifest pulls in by a path outside the project.
    external: Set<string>
}

// Every manifest of the workspace the lockfile belongs to: the one beside it, its `[workspace] members`, and
// — transitively — every path dependency that stays inside the project (Cargo makes those members too).
async function readWorkspace(projectPath: string, lockDir: string): Promise<Workspace> {
    const own = new Map<string, CargoManifest>()
    const external = new Set<string>()
    let root: CargoManifest | null = null
    const queue: string[] = [resolve(lockDir)]
    const seen = new Set<string>()
    for (let dir = queue.shift(); dir !== undefined && seen.size < MAX_MANIFESTS; dir = queue.shift()) {
        if (seen.has(dir)) continue
        seen.add(dir)
        const manifest = await readCargoManifest(dir)
        if (manifest === null) continue
        if (seen.size === 1) {
            root = manifest
            queue.push(...await expandMembers(projectPath, dir, manifest.members, manifest.exclude))
        }
        if (manifest.name !== null) own.set(manifest.name, mergeManifests(own.get(manifest.name), manifest))
        for (const dep of manifest.pathDependencies) {
            if (isInsideProject(projectPath, dir, dep.path)) queue.push(resolve(dir, dep.path))
            else external.add(dep.name)
        }
    }
    return { root, own, external }
}

// Two manifests declaring one package name (a fork vendored beside the original, say) cannot be told apart
// by the lockfile, which names crates only. A dependency is dev-only for that name only when it is dev-only
// in both: prod wins, as it does within one manifest.
function mergeManifests(existing: CargoManifest | undefined, next: CargoManifest): CargoManifest {
    if (existing === undefined) return next
    return { ...existing, devOnly: new Set([...existing.devOnly].filter(function both(name) { return next.devOnly.has(name) })) }
}

// The directories `[workspace] members` names, read relative to the workspace root. A segment may be a
// glob of `*` and `?` (Cargo's `crates/*`); `exclude` removes paths. A member the patterns do not reach
// (Cargo's `**`, character classes) is simply not found, and its crate is then not assumed to be own code.
async function expandMembers(projectPath: string, rootDir: string, patterns: string[], exclude: string[]): Promise<string[]> {
    const excluded = new Set(exclude.map(function abs(path) { return resolve(rootDir, path) }))
    const out: string[] = []
    for (const pattern of patterns) {
        let dirs = [rootDir]
        for (const segment of pattern.split('/').filter(function nonEmpty(s) { return s.length > 0 && s !== '.' })) {
            if (!/[*?]/.test(segment)) {
                dirs = dirs.map(function into(dir) { return join(dir, segment) })
                continue
            }
            const matcher = new RegExp('^' + segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
            const next: string[] = []
            for (const dir of dirs) next.push(...await subdirectories(dir, matcher))
            dirs = next
        }
        for (const dir of dirs) {
            const absolute = resolve(dir)
            if (!excluded.has(absolute) && isInsideProject(projectPath, rootDir, absolute)) out.push(absolute)
        }
    }
    return out
}

async function subdirectories(dir: string, matcher: RegExp): Promise<string[]> {
    try {
        const entries = await readdir(dir, { withFileTypes: true })
        return entries.filter(function matches(e) { return e.isDirectory() && matcher.test(e.name) }).map(function path(e) { return join(dir, e.name) })
    } catch {
        return []
    }
}

// A manifest's package name, workspace member list and dependency tables: `[dependencies]`,
// `[dev-dependencies]`, `[build-dependencies]`, their `[target.'cfg(…)'.…]` forms, and the dotted-header form
// that gives one crate its own table (`[dev-dependencies.serde]`, whose keys are that crate's options, not
// crate names). `[workspace.dependencies]` and `[patch.*]` only declare where a crate comes from, so they
// contribute paths but no scope. Null when there is no readable Cargo.toml in the directory.
async function readCargoManifest(dir: string): Promise<CargoManifest | null> {
    let text: string
    try {
        text = await readFile(join(dir, 'Cargo.toml'), 'utf8')
    } catch {
        return null
    }
    const dev = new Set<string>()
    const nonDev = new Set<string>()
    const pathDependencies: Array<{ name: string; path: string }> = []
    let name: string | null = null
    let members: string[] = []
    let exclude: string[] = []
    function record(key: string, spec: TomlTable | null, scope: 'dev' | 'prod' | null): void {
        const crate = (spec !== null ? tomlString(spec.package) : null) ?? key
        if (scope !== null) (scope === 'dev' ? dev : nonDev).add(crate)
        const path = spec !== null ? tomlString(spec.path) : null
        if (path !== null) pathDependencies.push({ name: crate, path })
    }
    for (const section of parseTomlSections(text)) {
        if (section.header === 'package') {
            name = tomlString(section.values.name)
            continue
        }
        if (section.header === 'workspace') {
            members = tomlArray(section.values.members).flatMap(asString)
            exclude = tomlArray(section.values.exclude).flatMap(asString)
            continue
        }
        if (/^(patch\..+|replace)$/.test(section.header)) {
            for (const [key, value] of Object.entries(section.values)) record(key, tomlTable(value), null)
            continue
        }
        const table = /(?:^|\.)((?:dev-|build-)?dependencies)(?:\.(.+))?$/.exec(section.header)
        if (!table) continue
        const scope = section.header.startsWith('workspace.') ? null : table[1] === 'dev-dependencies' ? 'dev' : 'prod'
        const single = table[2]
        if (single !== undefined) {
            record(unquote(single), section.values, scope)
            continue
        }
        for (const [key, value] of Object.entries(section.values)) record(key, tomlTable(value), scope)
    }
    const devOnly = new Set([...dev].filter(function only(crate) { return !nonDev.has(crate) }))
    return { dir, name, devOnly, pathDependencies, members, exclude }
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
