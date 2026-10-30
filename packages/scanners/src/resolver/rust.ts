import { readdir, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { graphFromLock } from './graph'
import { isInsideProject } from './paths'
import { parseArrayOfTables, parseTomlDocument, tomlArray, tomlString, tomlTable, type TomlTable } from './toml-lite'
import type { LockEdge, LockNode, LockRoot, ResolverResult } from './types'

// Rust resolver. `Cargo.lock` pins the FULL resolved dependency graph — every crate, its exact version, its
// source, and the crates it depends on — so it resolves to a graph with real chains. What it does not say
// is which edges are dev-only or where a crate with no source lives, and both are a property of ONE crate's
// manifest: the workspace's `Cargo.toml` files are read, each own crate's dependencies take their scope from
// that crate's own manifest, and reachability spreads it through the graph. A root manifest's
// `[dev-dependencies]` says nothing about what a member ships. A declaration is read whatever its spelling
// (`bytes = "1"`, `bytes.workspace = true`, `[dependencies.bytes]`, a top-level `dependencies.bytes`), and
// one inherited with `workspace = true` names the crate the `[workspace.dependencies]` entry of the manifest's
// OWN workspace names — found as Cargo finds it, which is not always the workspace beside the lockfile.
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
    // Every dependency it pulls in by `path` (absolute), with its crate name (a `package = "…"` rename wins),
    // from its dependency tables, `[workspace.dependencies]`, `[patch.*]` and `[replace]`.
    pathDependencies: Array<{ name: string; path: string }>
    // Its `[workspace]`, when it is a workspace root.
    workspace: WorkspaceRoot | null
}

// A manifest's workspace configuration, as Cargo's `WorkspaceConfig` reads it: a root, from its `[workspace]`
// table, or a member that may name its root's directory with `package.workspace`.
type WorkspaceConfig = WorkspaceRoot | { kind: 'member'; pointer: string | null }

// Cargo's `WorkspaceRootConfig`: the root's directory (which inherited paths are relative to), its raw
// `members` and `exclude` entries, and the `[workspace.dependencies]` its members inherit.
type WorkspaceRoot = { kind: 'root'; rootDir: string; members: string[]; exclude: string[]; dependencies: TomlTable }

// Parsed Cargo.toml documents by directory, each read once however many manifests look it up.
type ManifestLoader = (dir: string) => Promise<TomlTable | null>

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
    const load = manifestLoader()
    const queue: string[] = [resolve(lockDir)]
    const seen = new Set<string>()
    for (let dir = queue.shift(); dir !== undefined && seen.size < MAX_MANIFESTS; dir = queue.shift()) {
        if (seen.has(dir)) continue
        seen.add(dir)
        const manifest = await readCargoManifest(projectPath, dir, load)
        if (manifest === null) continue
        if (seen.size === 1) {
            root = manifest
            if (manifest.workspace !== null) queue.push(...await expandMembers(projectPath, manifest.workspace))
        }
        if (manifest.name !== null) own.set(manifest.name, mergeManifests(own.get(manifest.name), manifest))
        for (const dep of manifest.pathDependencies) {
            if (isInsideProject(projectPath, dir, dep.path)) queue.push(dep.path)
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

function manifestLoader(): ManifestLoader {
    const cache = new Map<string, Promise<TomlTable | null>>()
    return function load(dir) {
        let doc = cache.get(dir)
        if (doc === undefined) {
            doc = readFile(join(dir, 'Cargo.toml'), 'utf8').then(parseTomlDocument, function unreadable() { return null })
            cache.set(dir, doc)
        }
        return doc
    }
}

// The directories `[workspace] members` names, read relative to the workspace root. A segment may be a
// glob of `*` and `?` (Cargo's `crates/*`); `exclude` removes paths. A member the patterns do not reach
// (Cargo's `**`, character classes) is simply not found, and its crate is then not assumed to be own code.
async function expandMembers(projectPath: string, root: WorkspaceRoot): Promise<string[]> {
    const out: string[] = []
    for (const pattern of root.members) {
        let dirs = [root.rootDir]
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
            if (!isExcluded(root, join(absolute, 'Cargo.toml')) && isInsideProject(projectPath, root.rootDir, absolute)) out.push(absolute)
        }
    }
    return out
}

// The lookups below are Cargo's own, from src/cargo/core/workspace.rs and src/cargo/util/toml/mod.rs
// (https://rust.googlesource.com/cargo/+/f8984e1169dc670fd1c002d68c8c5efee63ff514), with the branches left
// out recorded in the plan's decisions (#34). Only manifests inside the project are read: a root Cargo would
// find above it, or one a pointer names outside it, is no owner.

// `to_workspace_config`. A manifest with both a `[workspace]` and a `package.workspace` is one Cargo refuses
// outright; it is read as the root it declares.
function workspaceConfig(dir: string, doc: TomlTable): WorkspaceConfig {
    const workspace = tomlTable(doc.workspace)
    if (workspace === null) return { kind: 'member', pointer: tomlString(tomlTable(doc.package)?.workspace) }
    return {
        kind: 'root',
        rootDir: dir,
        members: tomlArray(workspace.members).flatMap(asString),
        exclude: tomlArray(workspace.exclude).flatMap(asString),
        dependencies: tomlTable(workspace.dependencies) ?? {}
    }
}

// `WorkspaceRootConfig::is_excluded`: a manifest at or under an `exclude` entry is out of the workspace unless
// it is at or under a raw (unexpanded) `members` entry too.
function isExcluded(root: WorkspaceRoot, manifestPath: string): boolean {
    const path = pathComponents(manifestPath, sep)
    function holds(entry: string): boolean {
        const base = isAbsolute(entry) ? pathComponents(entry, '/') : [...pathComponents(root.rootDir, sep), ...pathComponents(entry, '/')]
        return base.every(function same(component, i) { return path[i] === component })
    }
    return !root.members.some(holds) && root.exclude.some(holds)
}

// A path's components as Rust's `Path` sees them for `join` and `starts_with`: `.` and empty components drop
// out, `..` stays a component and is never resolved, so an entry that climbs out of the root (`../ws/vendor`)
// is a prefix of no normalized manifest path, in Cargo as here.
function pathComponents(path: string, separator: string): string[] {
    return path.split(separator).filter(function kept(component) { return component !== '' && component !== '.' })
}

// `WorkspaceConfig::get_ws_root`: the root manifest a configuration at `selfPath` names on behalf of the
// manifest at `lookFrom` — itself when it is a root that does not exclude `lookFrom`, its pointer's target, or
// nothing.
function wsRootOf(config: WorkspaceConfig, selfPath: string, lookFrom: string): string | null {
    if (config.kind === 'root') return isExcluded(config, lookFrom) ? null : selfPath
    return config.pointer === null ? null : readRootPointer(selfPath, config.pointer)
}

// `read_root_pointer`: `package.workspace` is read relative to the manifest that writes it.
function readRootPointer(memberManifest: string, rootLink: string): string {
    return join(resolve(dirname(memberManifest), rootLink), 'Cargo.toml')
}

// `load_inheritable_fields`: the workspace a manifest's `workspace = true` declarations inherit from — its own
// `[workspace]`, else the root its `package.workspace` names, else the one `find_workspace_root` finds.
// `ambiguous` is set when that last lookup could have answered otherwise in Cargo: before walking the
// ancestors, `find_workspace_root_with_loader` returns any root Cargo has already loaded (`gctx.ws_roots`)
// that is an ancestor of the manifest and does not exclude it, and which roots are loaded depends on what
// Cargo read first. With another such root in the project besides the one the walk lands on, the owner is
// not known (SENTINEL-136).
async function owningWorkspace(projectPath: string, dir: string, config: WorkspaceConfig, load: ManifestLoader): Promise<{ owner: WorkspaceRoot | null; ambiguous: boolean }> {
    if (config.kind === 'root') return { owner: config, ambiguous: false }
    const manifestPath = join(dir, 'Cargo.toml')
    if (config.pointer !== null) return { owner: await inheritableFrom(projectPath, readRootPointer(manifestPath, config.pointer), load), ambiguous: false }
    const rootManifest = await findWorkspaceRoot(projectPath, manifestPath, load)
    if (rootManifest === null) return { owner: null, ambiguous: false }
    const owner = await inheritableFrom(projectPath, rootManifest, load)
    return { owner, ambiguous: await hasCompetingRoot(projectPath, manifestPath, dirname(rootManifest), load) }
}

// Whether an ancestor of the manifest inside the project, other than `chosenDir`, is a workspace root that does
// not exclude it: one Cargo may have loaded first and would then pick from its cache (`gctx.ws_roots`).
async function hasCompetingRoot(projectPath: string, manifestPath: string, chosenDir: string, load: ManifestLoader): Promise<boolean> {
    for (let ancestor = dirname(manifestPath); isInsideProject(projectPath, ancestor, '..');) {
        ancestor = dirname(ancestor)
        if (ancestor === chosenDir) continue
        const doc = await load(ancestor)
        const config = doc === null ? null : workspaceConfig(ancestor, doc)
        if (config?.kind === 'root' && !isExcluded(config, manifestPath)) return true
    }
    return false
}

// `find_workspace_root_with_loader` over `find_root_iter`: the ancestors of the manifest's directory, nearest
// first, that hold a Cargo.toml, each asked `get_ws_root` on the manifest's behalf — so an ancestor root that
// excludes it is passed over and an ancestor's `package.workspace` pointer is followed. The walk stops at a
// `target/package` directory, where `cargo package` unpacks a crate to verify it.
async function findWorkspaceRoot(projectPath: string, manifestPath: string, load: ManifestLoader): Promise<string | null> {
    for (let ancestor = dirname(manifestPath); isInsideProject(projectPath, ancestor, '..');) {
        ancestor = dirname(ancestor)
        if (pathComponents(ancestor, sep).slice(-2).join('/') === 'target/package') return null
        const doc = await load(ancestor)
        const root = doc === null ? null : wsRootOf(workspaceConfig(ancestor, doc), join(ancestor, 'Cargo.toml'), manifestPath)
        if (root !== null) return root
    }
    return null
}

// `inheritable_from_path`: the manifest a lookup lands on must be a workspace root; Cargo stops with "root of a
// workspace inferred but wasn't a root" otherwise.
async function inheritableFrom(projectPath: string, rootManifest: string, load: ManifestLoader): Promise<WorkspaceRoot | null> {
    const rootDir = dirname(rootManifest)
    if (!isInsideProject(projectPath, rootDir, '.')) return null
    const config = workspaceConfig(rootDir, await load(rootDir) ?? {})
    return config.kind === 'root' ? config : null
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
// `[dev-dependencies]`, `[build-dependencies]` (and Cargo's older `dev_dependencies`/`build_dependencies`),
// and their `[target.'cfg(…)'.…]` forms. `[workspace.dependencies]`, `[patch.*]` and `[replace]` only declare
// where a crate comes from, so they contribute paths but no scope. A declaration with `workspace = true`
// is resolved against the manifest's owning workspace, its inherited path relative to that root. Null when
// there is no readable Cargo.toml in the directory.
async function readCargoManifest(projectPath: string, dir: string, load: ManifestLoader): Promise<CargoManifest | null> {
    const doc = await load(dir)
    if (doc === null) return null
    const config = workspaceConfig(dir, doc)
    const workspace = config.kind === 'root' ? config : null
    const { owner, ambiguous } = await owningWorkspace(projectPath, dir, config, load)
    const pathDependencies: Array<{ name: string; path: string }> = []
    function recordPath(name: string | null, spec: TomlTable | null, from = dir): void {
        const path = tomlString(spec?.path)
        if (name !== null && path !== null) pathDependencies.push({ name, path: resolve(from, path) })
    }
    const dev = new Set<string>()
    const nonDev = new Set<string>()
    let unresolvedProd = false
    let inherits = false
    for (const { table, scope } of dependencyTables(doc)) {
        for (const [key, value] of Object.entries(table)) {
            const spec = tomlTable(value)
            const into = scope === 'dev' ? dev : nonDev
            if (tomlString(spec?.workspace) !== 'true') {
                into.add(crateName(key, spec))
                recordPath(crateName(key, spec), spec)
                continue
            }
            inherits = true
            const from = owner !== null && Object.hasOwn(owner.dependencies, key) ? owner : null
            if (from !== null) {
                const base = tomlTable(from.dependencies[key])
                into.add(crateName(key, base))
                recordPath(crateName(key, base), base, from.rootDir)
            } else if (scope === 'prod') unresolvedProd = true
        }
    }
    for (const [key, value] of Object.entries(workspace?.dependencies ?? {})) recordPath(crateName(key, tomlTable(value)), tomlTable(value))
    for (const patches of Object.values(tomlTable(doc.patch) ?? {})) {
        for (const [key, value] of Object.entries(tomlTable(patches) ?? {})) recordPath(crateName(key, tomlTable(value)), tomlTable(value))
    }
    for (const [key, value] of Object.entries(tomlTable(doc.replace) ?? {})) recordPath(pkgidName(key), tomlTable(value))
    // An inherited production declaration its workspace does not define — or with no owning workspace found —
    // names a crate this reader cannot know, so nothing in the manifest is claimed dev-only: over-reporting,
    // never hiding what ships. So does any inherited declaration when another workspace might own the manifest
    // in Cargo (`ambiguous`): it could name a different crate there.
    const devOnly = unresolvedProd || ambiguous && inherits ? new Set<string>() : new Set([...dev].filter(function only(crate) { return !nonDev.has(crate) }))
    return {
        dir,
        name: tomlString(tomlTable(doc.package)?.name),
        devOnly,
        pathDependencies,
        workspace
    }
}

const DEPENDENCY_SCOPES: Array<[string, 'dev' | 'prod']> = [
    ['dependencies', 'prod'],
    ['build-dependencies', 'prod'],
    ['build_dependencies', 'prod'],
    ['dev-dependencies', 'dev'],
    ['dev_dependencies', 'dev']
]

// Every dependency table of a manifest, top-level and per target, with the scope it gives.
function dependencyTables(doc: TomlTable): Array<{ table: TomlTable; scope: 'dev' | 'prod' }> {
    const targets = Object.values(tomlTable(doc.target) ?? {}).flatMap(function asTable(value): TomlTable[] {
        const table = tomlTable(value)
        return table === null ? [] : [table]
    })
    return [doc, ...targets].flatMap(function tables(holder) {
        return DEPENDENCY_SCOPES.flatMap(function table([key, scope]) {
            const table = tomlTable(holder[key])
            return table === null ? [] : [{ table, scope }]
        })
    })
}

// The locked crate a declaration names: its key, unless a `package = "…"` rename says otherwise.
function crateName(key: string, spec: TomlTable | null): string {
    return tomlString(spec?.package) ?? key
}

// A `[replace]` key is a package id spec (https://doc.rust-lang.org/cargo/reference/pkgid-spec.html): `name`,
// `name:version`, `name@version`, or a source URL — with an optional `kind+` prefix and `?branch=…`-style
// query — with the name after `#`, or, when the fragment is only a version (`…/cargo?branch=main#0.52.0`) or
// absent, as the URL's last PATH segment. A crate name never starts with a digit, a version always does. Null
// for a URL that does not parse or has no path, which Cargo rejects too.
function pkgidName(spec: string): string | null {
    const hash = spec.indexOf('#')
    const fragment = hash === -1 ? null : spec.slice(hash + 1)
    const head = hash === -1 ? spec : spec.slice(0, hash)
    if (fragment !== null && !/^[0-9]/.test(fragment)) return nameOfPkgname(fragment)
    if (!head.includes('://')) return nameOfPkgname(head)
    const segments = (URL.parse(head)?.pathname ?? '').split('/').filter(function nonEmpty(s) { return s.length > 0 })
    return segments.at(-1) ?? null
}

function nameOfPkgname(pkgname: string): string {
    return pkgname.split(/[@:]/)[0] as string
}

function asString(value: unknown): string[] {
    return typeof value === 'string' ? [value] : []
}

function unauditable(reasonCode: 'unsupported_lockfile' | 'ambiguous_dependency_spec', details: string[]): ResolverResult {
    return { status: 'unauditable', ecosystem: CRATES_ECOSYSTEM, reasonCode, details }
}
