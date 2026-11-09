import { readFile } from 'node:fs/promises'
import { graphFromLock } from './graph'
import type { LockEdge, LockEdgeKind, LockNode, LockRoot, LockRootKind, ResolverResult } from './types'

// bun.lock resolver: the text lockfile Bun has written since 1.2. It is JSON with trailing commas and, by
// the format's own promise, room for comments, so it goes through a small string-aware reader here rather than
// a dependency: the CLI ships with none.
//
//   workspaces  { "<path>": { name, dependencies, devDependencies, optionalDependencies, peerDependencies } },
//               "" being the project itself. Every entry is one importer of the graph's roots.
//   packages    { "<key>": ["name@version", "<registry>", { dependencies, ... }, "<integrity>"] }.
//               A key is the path a dependency resolves through: `semver` is the hoisted copy, and
//               `@babel/core/semver` the copy @babel/core gets instead. Its first element, not the key, names
//               the package, so an aliased dependency keeps the real name.
//
// A dependency resolves the way Bun laid it out: the nearest key walking up from the dependent's own, so a
// nested copy is the one its parent really loads. A workspace entry (`x@workspace:packages/x`) is not an
// installed package; its dependencies are counted from its own `workspaces` entry, so edges into it are not
// followed, as in the npm and pnpm resolvers.
//
// An entry from anywhere else (`github:`, `file:`, a tarball URL) still has edges, so what it depends on is
// reached, but no advisory database covers it: the graph is partial and says which, as Cargo's git crates do.
// The same goes for an entry this reader cannot make sense of.

const NPM_ECOSYSTEM = 'npm'

type BunDependencies = Record<string, unknown>
type BunMeta = { dependencies?: BunDependencies; optionalDependencies?: BunDependencies; peerDependencies?: BunDependencies }
type BunWorkspace = BunMeta & { name?: unknown; devDependencies?: BunDependencies }
type BunEntry = { key: string; name: string; spec: string; meta: BunMeta }

export async function parseBunLock(absolutePath: string, manifestPath: string): Promise<ResolverResult> {
    let doc: unknown
    try {
        doc = parseJsonc(await readFile(absolutePath, 'utf8'))
    } catch {
        return { status: 'unauditable', ecosystem: NPM_ECOSYSTEM, reasonCode: 'unsupported_lockfile', details: ['could not read ' + manifestPath] }
    }
    const packages = recordOf(recordOf(doc).packages)
    const workspaces = recordOf(recordOf(doc).workspaces)
    const entries = new Map<string, BunEntry>()
    const cannotAudit: string[] = []
    for (const key of Object.keys(packages)) {
        const entry = readEntry(key, packages[key])
        if (entry === null) cannotAudit.push(key)
        else if (!entry.spec.startsWith('workspace:')) entries.set(key, entry)
    }
    const nodes: LockNode[] = []
    const edges: LockEdge[] = []
    const auditable = new Set<string>()
    for (const entry of entries.values()) {
        nodes.push({ id: entry.key, name: entry.name, version: entry.spec })
        if (entry.spec.includes(':')) cannotAudit.push(entry.name + '@' + entry.spec)
        else auditable.add(entry.key)
        const chain = packageChain(entry.key)
        addEdges(entry.key, chain, entry.meta.dependencies, 'prod', entries, edges)
        addEdges(entry.key, chain, entry.meta.optionalDependencies, 'optional', entries, edges)
        addEdges(entry.key, chain, entry.meta.peerDependencies, 'peer', entries, edges)
    }
    const roots: LockRoot[] = []
    for (const path of Object.keys(workspaces)) {
        const workspace = recordOf(workspaces[path]) as BunWorkspace
        const importer = path === '' ? '.' : path
        const chain = typeof workspace.name === 'string' ? [workspace.name] : []
        addRoots(importer, chain, workspace.dependencies, 'prod', entries, roots)
        addRoots(importer, chain, workspace.peerDependencies, 'prod', entries, roots)
        addRoots(importer, chain, workspace.optionalDependencies, 'optional', entries, roots)
        addRoots(importer, chain, workspace.devDependencies, 'dev', entries, roots)
    }
    const graph = graphFromLock({
        ecosystem: NPM_ECOSYSTEM,
        manifestPath,
        nodes,
        edges,
        roots,
        auditable(nodeId: string) { return auditable.has(nodeId) }
    })
    if (cannotAudit.length === 0) return { status: 'ok', ecosystem: NPM_ECOSYSTEM, graph }
    return {
        status: 'partial',
        ecosystem: NPM_ECOSYSTEM,
        graph,
        reasonCode: 'partial_dependency_graph',
        details: [cannotAudit.length + ' packages from git, local path or URL sources cannot be audited: ' + cannotAudit.sort().join(', ')]
    }
}

// `["name@spec", ...]`, whatever follows it: a registry entry has its registry first, then the metadata; a
// git or file entry has the metadata straight after the name. The first `@` past the start ends the name,
// since only a scope's comes before it.
function readEntry(key: string, value: unknown): BunEntry | null {
    if (!Array.isArray(value) || typeof value[0] !== 'string') return null
    const at = value[0].indexOf('@', 1)
    if (at < 0 || at === value[0].length - 1) return null
    const meta = value.slice(1).find(function isMeta(part) { return part !== null && typeof part === 'object' && !Array.isArray(part) }) as BunMeta | undefined
    return { key, name: value[0].slice(0, at), spec: value[0].slice(at + 1), meta: meta ?? {} }
}

// The package names a key walks through: `@babel/core/semver` is @babel/core, then semver.
function packageChain(key: string): string[] {
    const chain: string[] = []
    const parts = key.split('/')
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i] as string
        if (part.startsWith('@') && i + 1 < parts.length) {
            chain.push(part + '/' + (parts[i + 1] as string))
            i += 1
        } else {
            chain.push(part)
        }
    }
    return chain
}

// The key `child` resolves to from below `chain`: the deepest one holding it, up to the hoisted copy. Null
// for one that is not installed (an absent optional or peer) or is a workspace.
function resolveFrom(chain: readonly string[], child: string, entries: ReadonlyMap<string, BunEntry>): string | null {
    for (let depth = chain.length; depth >= 0; depth--) {
        const key = [...chain.slice(0, depth), child].join('/')
        if (entries.has(key)) return key
    }
    return null
}

function addEdges(from: string, chain: readonly string[], deps: BunDependencies | undefined, kind: LockEdgeKind, entries: ReadonlyMap<string, BunEntry>, out: LockEdge[]): void {
    for (const child of Object.keys(deps ?? {})) {
        const to = resolveFrom(chain, child, entries)
        if (to !== null) out.push({ from, to, kind })
    }
}

function addRoots(importer: string, chain: readonly string[], deps: BunDependencies | undefined, kind: LockRootKind, entries: ReadonlyMap<string, BunEntry>, out: LockRoot[]): void {
    for (const child of Object.keys(deps ?? {})) {
        const nodeId = resolveFrom(chain, child, entries)
        if (nodeId !== null) out.push({ importer, nodeId, kind })
    }
}

function recordOf(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

// JSON with comments and trailing commas. Whatever is inside a string is left alone, so a URL's `//` and a
// `,]` in a value survive; the rest goes to JSON.parse, which throws on anything else that is wrong.
export function parseJsonc(text: string): unknown {
    let out = ''
    let i = 0
    while (i < text.length) {
        const c = text[i] as string
        if (c === '"') {
            const end = stringEnd(text, i)
            out += text.slice(i, end)
            i = end
        } else if (c === '/' && text[i + 1] === '/') {
            const newline = text.indexOf('\n', i)
            i = newline < 0 ? text.length : newline
        } else if (c === '/' && text[i + 1] === '*') {
            const close = text.indexOf('*/', i + 2)
            i = close < 0 ? text.length : close + 2
        } else {
            if (c === '}' || c === ']') out = out.replace(/,\s*$/, '')
            out += c
            i += 1
        }
    }
    return JSON.parse(out)
}

// The index just past the string opening at `start`; the end of the text when it never closes, which
// JSON.parse then refuses.
function stringEnd(text: string, start: number): number {
    let i = start + 1
    while (i < text.length) {
        if (text[i] === '\\') i += 2
        else if (text[i] === '"') return i + 1
        else i += 1
    }
    return text.length
}
