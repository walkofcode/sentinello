import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { normalizePyName } from '@sentinello/versions'
import { graphFromLock, makeGraph } from './graph'
import { isInsideProject } from './paths'
import { parseArrayTableEntries, parseTomlSections, tomlArray, tomlString, tomlTable, type ArrayTableEntry, type TomlTable, type TomlValue } from './toml-lite'
import type { DepScope, LockEdge, LockNode, LockRoot, LockRootKind, ResolvedPackage, ResolverResult } from './types'

// Python (PyPI) resolver. True lockfiles (poetry.lock / Pipfile.lock / uv.lock) pin exact versions, so
// they resolve to an `ok` graph; `requirements.txt` is a free-form install list that may mix `==` pins
// with ranges, unpinned names, `-e` editables, `-r`/`-c` includes, and environment markers — we scan only
// the `==`-pinned subset and classify the result `partial`/`unauditable` so coverage is never overstated.
// Package names are keyed on their PEP 503 canonical form, the one normalizePyName every PyPI reader shares,
// so a lockfile's `PyYAML` meets the advisory's `pyyaml`.
//
// poetry.lock and uv.lock carry the dependency graph, so their packages get real chains and graph-derived
// prod/dev; Pipfile.lock and requirements.txt do not, and keep the flat list.
//
// A package from somewhere other than a package index — a git checkout, a URL, a local directory or file —
// is not the PyPI release of the same name, so it is never matched against PyPI advisories. A local one
// inside the project is the project's own code (uv's editable/virtual workspace members, a poetry path
// dependency on a sibling package) and is not a dependency at all; the rest are counted as
// cannot-be-audited.

const PYPI_ECOSYSTEM = 'PyPI'

export async function parsePythonLock(projectPath: string, kind: string, absolutePath: string, manifestPath: string): Promise<ResolverResult> {
    let text: string
    try {
        text = await readFile(absolutePath, 'utf8')
    } catch {
        return unauditable('unsupported_lockfile', ['could not read ' + manifestPath])
    }
    const lockDir = dirname(absolutePath)
    const context: LockContext = { projectPath, lockDir, manifestPath }
    if (kind === 'poetry.lock') return fromPoetryLock(text, context, await readPyprojectRoots(join(lockDir, 'pyproject.toml')))
    if (kind === 'uv.lock') return fromUvLock(text, context)
    if (kind === 'Pipfile.lock') return fromPipfileLock(text, manifestPath)
    if (kind === 'requirements.txt') return fromRequirements(text, manifestPath)
    return unauditable('unsupported_lockfile', ['unsupported Python manifest: ' + kind])
}

type LockContext = { projectPath: string; lockDir: string; manifestPath: string }

// What a lockfile entry's source makes it: an index package to audit, the project's own code, or
// something no advisory database covers.
type Origin = 'index' | 'own' | 'git' | 'url' | 'path'

// A locked package as both lockfiles describe it: node id, the dependency names its entry lists (each with
// a version when the lockfile disambiguates one), and its origin.
type LockedPackage = { id: string; name: string; version: string; origin: Origin; deps: Array<{ name: string; version: string | null }> }

// poetry.lock: `[[package]]` entries, each followed by `[package.dependencies]` (name → constraint) and,
// for a package not from an index, `[package.source]` (`type` git | url | file | directory). The project
// itself is not in the lock, so the roots come from pyproject.toml; without one, every package nothing else
// depends on is a root, prod unless the legacy `category = "dev"` says otherwise.
function fromPoetryLock(text: string, context: LockContext, pyprojectRoots: PyprojectRoots | null): ResolverResult {
    const entries = parseArrayTableEntries(text, 'package')
    const locked: LockedPackage[] = []
    const categories = new Map<string, string>()
    // Poetry marks a package installed only for an extra `optional = true`.
    const optionalIds = new Set<string>()
    for (const entry of entries) {
        const name = tomlString(entry.values.name)
        const version = tomlString(entry.values.version)
        if (!name || !version) continue
        const canonical = normalizePyName(name)
        const id = canonical + '@' + version
        const deps = Object.keys(entry.sub.dependencies ?? {}).map(function dep(key) { return { name: normalizePyName(key), version: null } })
        locked.push({ id, name: canonical, version, origin: poetryOrigin(entry, context), deps })
        const category = tomlString(entry.values.category)
        if (category !== null) categories.set(id, category)
        if (tomlString(entry.values.optional) === 'true') optionalIds.add(id)
    }
    const roots: LockRoot[] = []
    if (pyprojectRoots !== null) {
        for (const [name, kind] of pyprojectRoots) {
            for (const pkg of locked) {
                if (pkg.name === name) roots.push({ importer: '.', nodeId: pkg.id, kind })
            }
        }
    } else {
        const dependedOn = new Set(locked.flatMap(function names(pkg) { return pkg.deps.map(function name(d) { return d.name }) }))
        for (const pkg of locked) {
            if (!dependedOn.has(pkg.name)) roots.push({ importer: '.', nodeId: pkg.id, kind: poetryRootKind(pkg.id, categories, optionalIds) })
        }
    }
    return fromLockedPackages(locked, roots, context)
}

function poetryRootKind(id: string, categories: Map<string, string>, optionalIds: Set<string>): LockRootKind {
    if (categories.get(id) === 'dev') return 'dev'
    return optionalIds.has(id) ? 'optional' : 'prod'
}

function poetryOrigin(entry: ArrayTableEntry, context: LockContext): Origin {
    const source = entry.sub.source
    // No `[package.source]` at all is the default index.
    if (source === undefined) return 'index'
    const type = tomlString(source.type)
    if (type === null || type === 'legacy') return 'index'
    if (type === 'git') return 'git'
    if (type === 'url') return 'url'
    const url = tomlString(source.url)
    return url !== null && isInsideProject(context.projectPath, context.lockDir, url) ? 'own' : 'path'
}

// uv.lock: `[[package]]` entries whose `source` is an inline table — `{ registry = … }` for an index
// package, `{ editable = … }` / `{ virtual = … }` for a workspace member, `{ directory | path = … }` for a
// local one, `{ git | url = … }` otherwise. Dependencies are inline tables (`{ name = "x" }`, with
// `version` when two versions are locked). The workspace members are the roots: their `dependencies` and
// optional dependencies are prod, their `[package.dev-dependencies]` groups dev.
function fromUvLock(text: string, context: LockContext): ResolverResult {
    const entries = parseArrayTableEntries(text, 'package')
    const locked: LockedPackage[] = []
    const members: Array<{ id: string; entry: ArrayTableEntry }> = []
    for (const entry of entries) {
        const name = tomlString(entry.values.name)
        const version = tomlString(entry.values.version)
        if (!name) continue
        const canonical = normalizePyName(name)
        const origin = uvOrigin(tomlTable(entry.values.source), context)
        // A workspace member may be locked without a version (a virtual project has none).
        const id = canonical + '@' + (version ?? '')
        const optional = Object.values(entry.sub['optional-dependencies'] ?? {}).flatMap(uvDependencies)
        locked.push({ id, name: canonical, version: version ?? '', origin, deps: [...uvDependencies(entry.values.dependencies), ...optional] })
        if (origin === 'own') members.push({ id, entry })
    }
    const roots: LockRoot[] = []
    for (const member of members) {
        const groups: Array<{ deps: TomlValue | undefined; kind: LockRootKind }> = [
            { deps: member.entry.values.dependencies, kind: 'prod' },
            ...Object.values(member.entry.sub['optional-dependencies'] ?? {}).map(function opt(deps) { return { deps, kind: 'optional' as const } }),
            ...Object.values(member.entry.sub['dev-dependencies'] ?? {}).map(function dev(deps) { return { deps, kind: 'dev' as const } })
        ]
        for (const group of groups) {
            for (const dep of uvDependencies(group.deps)) {
                const target = resolveLocked(dep, locked)
                if (target !== null) roots.push({ importer: '.', nodeId: target.id, kind: group.kind })
            }
        }
    }
    // A uv.lock with no workspace member to start from still has a graph; every package nothing depends on
    // is a prod root, as for a poetry.lock without its pyproject.toml.
    if (members.length === 0) {
        const dependedOn = new Set(locked.flatMap(function names(pkg) { return pkg.deps.map(function name(d) { return d.name }) }))
        for (const pkg of locked) {
            if (!dependedOn.has(pkg.name)) roots.push({ importer: '.', nodeId: pkg.id, kind: 'prod' })
        }
    }
    return fromLockedPackages(locked, roots, context)
}

function uvOrigin(source: TomlTable | null, context: LockContext): Origin {
    if (source === null || tomlString(source.registry) !== null) return 'index'
    if (tomlString(source.git) !== null) return 'git'
    if (tomlString(source.url) !== null) return 'url'
    const local = tomlString(source.editable) ?? tomlString(source.virtual) ?? tomlString(source.directory) ?? tomlString(source.path)
    return local !== null && isInsideProject(context.projectPath, context.lockDir, local) ? 'own' : 'path'
}

function uvDependencies(value: TomlValue | undefined): Array<{ name: string; version: string | null }> {
    return tomlArray(value).flatMap(function dep(item) {
        const table = tomlTable(item)
        const name = table !== null ? tomlString(table.name) : null
        return name === null ? [] : [{ name: normalizePyName(name), version: tomlString((table as TomlTable).version) }]
    })
}

function resolveLocked(dep: { name: string; version: string | null }, locked: LockedPackage[]): LockedPackage | null {
    for (const pkg of locked) {
        if (pkg.name === dep.name && (dep.version === null || pkg.version === dep.version)) return pkg
    }
    return null
}

function fromLockedPackages(locked: LockedPackage[], roots: LockRoot[], context: LockContext): ResolverResult {
    const nodes: LockNode[] = []
    const edges: LockEdge[] = []
    const cannotAudit: string[] = []
    for (const pkg of locked) {
        nodes.push({ id: pkg.id, name: pkg.name, version: pkg.version })
        if (pkg.origin !== 'index' && pkg.origin !== 'own') cannotAudit.push(pkg.name + ' (' + pkg.origin + ')')
        for (const dep of pkg.deps) {
            const target = resolveLocked(dep, locked)
            if (target !== null) edges.push({ from: pkg.id, to: target.id, kind: 'prod' })
        }
    }
    const byId = new Map(locked.map(function entry(pkg) { return [pkg.id, pkg] as const }))
    const graph = graphFromLock({
        ecosystem: PYPI_ECOSYSTEM,
        manifestPath: context.manifestPath,
        nodes,
        edges,
        roots,
        auditable(nodeId: string) { return byId.get(nodeId)?.origin === 'index' }
    })
    const details = cannotAudit.length === 0 ? [] : [cannotAudit.length + ' packages from git, URL or local sources cannot be audited: ' + cannotAudit.sort().join(', ')]
    if (graph.packages.length === 0) return unauditable('ambiguous_dependency_spec', details.length > 0 ? details : ['no packages found in ' + context.manifestPath])
    if (details.length === 0) return { status: 'ok', ecosystem: PYPI_ECOSYSTEM, graph }
    return { status: 'partial', ecosystem: PYPI_ECOSYSTEM, graph, reasonCode: 'partial_dependency_graph', details }
}

// The project's direct dependencies, by canonical name, as pyproject.toml declares them: PEP 621
// `[project] dependencies` (prod) and `[project.optional-dependencies]` (optional), PEP 735
// `[dependency-groups]` (dev), and Poetry's `[tool.poetry.dependencies]` (prod), `[tool.poetry.dev-dependencies]`
// and `[tool.poetry.group.<name>.dependencies]` (dev, except the `main` group). A name declared both ways is
// prod. Null when there is no readable pyproject.toml or it declares nothing.
type PyprojectRoots = Map<string, LockRootKind>

async function readPyprojectRoots(path: string): Promise<PyprojectRoots | null> {
    let text: string
    try {
        text = await readFile(path, 'utf8')
    } catch {
        return null
    }
    const roots: PyprojectRoots = new Map()
    function add(name: string | null, kind: LockRootKind): void {
        if (name === null || name === 'python') return
        const canonical = normalizePyName(name)
        const existing = roots.get(canonical)
        if (existing === 'prod' || (existing === 'optional' && kind === 'dev')) return
        roots.set(canonical, kind)
    }
    for (const section of parseTomlSections(text)) {
        if (section.header === 'project') {
            for (const spec of tomlArray(section.values.dependencies)) add(requirementName(spec), 'prod')
        } else if (section.header === 'project.optional-dependencies') {
            for (const list of Object.values(section.values)) for (const spec of tomlArray(list)) add(requirementName(spec), 'optional')
        } else if (section.header === 'dependency-groups') {
            for (const list of Object.values(section.values)) for (const spec of tomlArray(list)) add(requirementName(spec), 'dev')
        } else if (section.header === 'tool.poetry.dependencies' || section.header === 'tool.poetry.group.main.dependencies') {
            for (const [name, spec] of Object.entries(section.values)) add(name, tomlString(tomlTable(spec)?.optional) === 'true' ? 'optional' : 'prod')
        } else if (section.header === 'tool.poetry.dev-dependencies' || /^tool\.poetry\.group\.[^.]+\.dependencies$/.test(section.header)) {
            for (const name of Object.keys(section.values)) add(name, 'dev')
        }
    }
    return roots.size === 0 ? null : roots
}

// The project name at the front of a PEP 508 requirement string: `requests[socks]>=2.0; python_version>"3"`
// names `requests`.
function requirementName(spec: TomlValue): string | null {
    if (typeof spec !== 'string') return null
    const match = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(spec)
    return match ? match[1] as string : null
}

type PipfileLock = {
    default?: Record<string, { version?: string }>
    develop?: Record<string, { version?: string }>
}

// Pipfile.lock is JSON: `default` (prod) + `develop` (dev), each name → { version: "==1.2.3" }. Pipenv
// normally pins every entry; any non-`==` version (e.g. "*") makes the result partial.
function fromPipfileLock(text: string, manifestPath: string): ResolverResult {
    let parsed: unknown
    try {
        parsed = JSON.parse(text)
    } catch {
        return unauditable('unsupported_lockfile', ['Pipfile.lock is not valid JSON'])
    }
    if (!parsed || typeof parsed !== 'object') return unauditable('unsupported_lockfile', ['Pipfile.lock is not an object'])
    const doc = parsed as PipfileLock
    const out: ResolvedPackage[] = []
    let ambiguous = 0
    collectPipfileGroup(doc.default, false, manifestPath, out, function onAmbiguous() { ambiguous++ })
    collectPipfileGroup(doc.develop, true, manifestPath, out, function onAmbiguous() { ambiguous++ })
    if (out.length === 0) return unauditable('ambiguous_dependency_spec', ['no pinned packages in Pipfile.lock'])
    if (ambiguous > 0) {
        return { status: 'partial', ecosystem: PYPI_ECOSYSTEM, graph: makeGraph(out), reasonCode: 'partial_dependency_graph', details: [ambiguous + ' Pipfile.lock entries were not pinned to an exact version'] }
    }
    return { status: 'ok', ecosystem: PYPI_ECOSYSTEM, graph: makeGraph(out) }
}

function collectPipfileGroup(
    group: Record<string, { version?: string }> | undefined,
    isDev: boolean,
    manifestPath: string,
    out: ResolvedPackage[],
    onAmbiguous: () => void
): void {
    if (!group || typeof group !== 'object') return
    for (const name of Object.keys(group)) {
        const raw = group[name] && typeof group[name].version === 'string' ? String(group[name].version) : ''
        const version = exactPin(raw)
        if (version === null) {
            onAmbiguous()
            continue
        }
        out.push(pkg(name, version, { isProd: !isDev, isDev, isOptional: false }, manifestPath))
    }
}

// requirements.txt: scan only `==`-pinned lines. Ranged/unpinned/editable/include/marker-gated lines make
// the result partial (we scan the pinned subset); if nothing is pinnable the file is unauditable.
function fromRequirements(text: string, manifestPath: string): ResolverResult {
    const out: ResolvedPackage[] = []
    let ambiguous = 0
    for (const rawLine of text.split(/\r?\n/)) {
        const line = stripReqComment(rawLine).trim()
        if (line.length === 0) continue
        // Options/includes/editables: `-r other.txt`, `-c constraints.txt`, `-e .`, `--hash=...` lines.
        if (line.startsWith('-')) {
            ambiguous++
            continue
        }
        const parsed = parseRequirementLine(line)
        if (!parsed) {
            ambiguous++
            continue
        }
        out.push(pkg(parsed.name, parsed.version, { isProd: true, isDev: false, isOptional: false }, manifestPath))
        // A line that pins but is gated by an environment marker we can't evaluate offline still counts as
        // covered (we surface it conservatively) but flags partial so the limit is disclosed.
        if (parsed.markerGated) ambiguous++
    }
    if (out.length === 0) return unauditable('ambiguous_dependency_spec', ['requirements.txt has no exact (==) version pins'])
    if (ambiguous > 0) {
        return { status: 'partial', ecosystem: PYPI_ECOSYSTEM, graph: makeGraph(out), reasonCode: 'partial_dependency_graph', details: [ambiguous + ' requirements.txt lines were ranged, unpinned, included, editable, or marker-gated and were not audited'] }
    }
    return { status: 'ok', ecosystem: PYPI_ECOSYSTEM, graph: makeGraph(out) }
}

type RequirementLine = { name: string; version: string; markerGated: boolean }

function parseRequirementLine(line: string): RequirementLine | null {
    // Strip an environment marker (`; python_version < "3.8"`) but remember it gated the install.
    const semi = line.indexOf(';')
    const markerGated = semi >= 0
    const spec = (markerGated ? line.slice(0, semi) : line).trim()
    // Only exact pins. `==` (and the arbitrary-equality `===`) are the auditable operators; a `*` wildcard
    // version (`==1.2.*`) is not exact. Everything else (>=, ~=, !=, <, bare name) is not a pin.
    const eq = spec.indexOf('==')
    if (eq < 0) return null
    const rawName = spec.slice(0, eq).trim()
    let version = spec.slice(eq + 2).trim()
    if (version.startsWith('=')) version = version.slice(1).trim() // `===arbitrary`
    if (version.length === 0 || version.includes('*')) return null
    // Strip extras: `requests[security]` → `requests`.
    const bracket = rawName.indexOf('[')
    const baseName = bracket >= 0 ? rawName.slice(0, bracket) : rawName
    if (baseName.length === 0 || !/^[A-Za-z0-9._-]+$/.test(baseName)) return null
    return { name: baseName, version, markerGated }
}

function stripReqComment(line: string): string {
    const idx = line.indexOf('#')
    return idx >= 0 ? line.slice(0, idx) : line
}

// Strip a leading `==` / `===` from a Pipfile.lock version string; null when it isn't an exact pin.
function exactPin(raw: string): string | null {
    const s = raw.trim()
    if (s.startsWith('===')) return s.slice(3).trim() || null
    if (s.startsWith('==')) {
        const v = s.slice(2).trim()
        return v.length > 0 && !v.includes('*') ? v : null
    }
    return null
}

function pkg(name: string, version: string, scope: DepScope, manifestPath: string): ResolvedPackage {
    return { ecosystem: PYPI_ECOSYSTEM, name: normalizePyName(name), version, scope, depPaths: [name], manifestPath }
}

function unauditable(reasonCode: 'unsupported_lockfile' | 'ambiguous_dependency_spec', details: string[]): ResolverResult {
    return { status: 'unauditable', ecosystem: PYPI_ECOSYSTEM, reasonCode, details }
}
