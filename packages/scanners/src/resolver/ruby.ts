import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { graphFromLock } from './graph'
import { isInsideProject } from './paths'
import type { LockEdge, LockNode, LockRoot, ResolverResult } from './types'

// Ruby (RubyGems) resolver: Bundler's Gemfile.lock, read line by line — it is a fixed, indentation-based
// format with no general grammar to need a parser for:
//
//   GEM                                 a source section: GEM (a gem server), GIT, or PATH
//     remote: https://rubygems.org/
//     specs:
//       rack (2.2.8)                    a locked gem, four spaces in: `name (version[-platform])`
//       nokogiri (1.16.0-arm64-darwin)  the same gem once per platform it was resolved for
//         racc (~> 1.4)                 its dependency, six spaces in, with Bundler's constraint
//
//   DEPENDENCIES                        the Gemfile's own gems: the roots; `name!` comes from GIT/PATH
//     rails (~> 7.1)
//
// Bundler locks one version per gem name, so a dependency edge resolves by name.
//
// GIT and PATH gems are not matched against RubyGems advisories: a gem built from someone's checkout is not
// the release of the same name, so a version comparison against the registry's advisories means nothing.
// They stay nodes, so what they depend on is still reached, and they are counted as cannot-be-audited —
// except a PATH inside the project (the gem the project develops, an engine it vendors), which is the
// project's own code and no dependency at all.
//
// Scope comes from the sibling Gemfile's groups (readGemfileGroups) spread through the graph. With no
// readable Gemfile, everything is prod: over-reporting, never under-reporting.

const RUBYGEMS_ECOSYSTEM = 'RubyGems'

type SourceKind = 'GEM' | 'GIT' | 'PATH'
type Spec = { name: string; version: string; source: SourceKind; localRemote: string | null; deps: string[] }

export async function parseGemfileLock(projectPath: string, absolutePath: string, manifestPath: string): Promise<ResolverResult> {
    let text: string
    try {
        text = await readFile(absolutePath, 'utf8')
    } catch {
        return unauditable('unsupported_lockfile', ['could not read ' + manifestPath])
    }
    const lock = readLock(text)
    if (lock.specs.size === 0) return unauditable('ambiguous_dependency_spec', ['no gems found in ' + manifestPath])
    const lockDir = dirname(absolutePath)
    const devGems = await readGemfileGroups(join(lockDir, 'Gemfile'))

    const nodes: LockNode[] = []
    const edges: LockEdge[] = []
    const roots: LockRoot[] = []
    const auditable = new Set<string>()
    const cannotAudit: string[] = []
    for (const spec of lock.specs.values()) {
        const id = spec.name + '@' + spec.version
        nodes.push({ id, name: spec.name, version: spec.version })
        if (spec.source === 'GEM') auditable.add(id)
        else if (!(spec.source === 'PATH' && spec.localRemote !== null && isInsideProject(projectPath, lockDir, spec.localRemote))) {
            cannotAudit.push(spec.name + ' (' + spec.source.toLowerCase() + ')')
        }
        for (const dep of spec.deps) {
            const target = lock.specs.get(dep)
            if (target) edges.push({ from: id, to: target.name + '@' + target.version, kind: 'prod' })
        }
    }
    for (const name of lock.dependencies) {
        const target = lock.specs.get(name)
        if (target) roots.push({ importer: '.', nodeId: target.name + '@' + target.version, kind: devGems.has(name) ? 'dev' : 'prod' })
    }

    const graph = graphFromLock({
        ecosystem: RUBYGEMS_ECOSYSTEM,
        manifestPath,
        nodes,
        edges,
        roots,
        auditable(nodeId: string) { return auditable.has(nodeId) }
    })
    if (cannotAudit.length === 0) return { status: 'ok', ecosystem: RUBYGEMS_ECOSYSTEM, graph }
    const details = [cannotAudit.length + ' gems from git or local path sources cannot be audited: ' + cannotAudit.sort().join(', ')]
    if (graph.packages.length === 0) return unauditable('ambiguous_dependency_spec', details)
    return { status: 'partial', ecosystem: RUBYGEMS_ECOSYSTEM, graph, reasonCode: 'partial_dependency_graph', details }
}

type Lock = { specs: Map<string, Spec>; dependencies: string[] }

const SPEC_LINE = /^ {4}([^\s(]+) \(([^)]+)\)$/
const DEP_LINE = /^ {6}([^\s(]+)(?: \([^)]*\))?$/
const ROOT_LINE = /^ {2}([^\s(!]+)!?(?: \([^)]*\))?$/

function readLock(text: string): Lock {
    const specs = new Map<string, Spec>()
    const dependencies: string[] = []
    let section: string | null = null
    let remote: string | null = null
    let current: Spec | null = null
    for (const line of text.split(/\r?\n/)) {
        if (line.length === 0) continue
        if (!line.startsWith(' ')) {
            section = line.trim()
            remote = null
            current = null
            continue
        }
        if (section === 'DEPENDENCIES') {
            const root = ROOT_LINE.exec(line)
            if (root) dependencies.push(root[1] as string)
            continue
        }
        if (section !== 'GEM' && section !== 'GIT' && section !== 'PATH') continue
        const remoteLine = /^ {2}remote: (.+)$/.exec(line)
        if (remoteLine) {
            remote = (remoteLine[1] as string).trim()
            continue
        }
        const spec = SPEC_LINE.exec(line)
        if (spec) {
            const name = spec[1] as string
            // `1.16.0-arm64-darwin`: a gem version never contains a `-` in a lockfile (Gem writes a
            // prerelease as `1.0.0.pre`), so the first one starts the platform.
            const version = (spec[2] as string).split('-')[0] as string
            // The same gem resolved for several platforms is one locked version, listed once per platform.
            const existing = specs.get(name)
            current = existing ?? { name, version, source: section, localRemote: section === 'PATH' ? remote : null, deps: [] }
            if (!existing) specs.set(name, current)
            continue
        }
        const dep = DEP_LINE.exec(line)
        if (dep && current && !current.deps.includes(dep[1] as string)) current.deps.push(dep[1] as string)
    }
    return { specs, dependencies }
}

// Bundler's development and test groups. Any other group (`:production`, `:assets`, a custom one) is
// installed by default and ships with the app, so it reads as prod.
const DEV_GROUPS = new Set(['development', 'test'])

// The gems a Gemfile declares ONLY in development/test groups — through a `group :development, :test do`
// block or an inline `group:`/`groups:` option. A regex read, not Ruby evaluation: a Gemfile is Ruby, and a
// gem declared in a way this does not follow reads as prod, the safe direction. A gem declared in more than
// one place is dev only when every declaration is.
export async function readGemfileGroups(gemfilePath: string): Promise<Set<string>> {
    let text: string
    try {
        text = await readFile(gemfilePath, 'utf8')
    } catch {
        return new Set()
    }
    const declarations = new Map<string, boolean>()
    // One entry per open `do`/`if`/... block: the groups it puts its gems in, or null for a block that is
    // not a group (a `source ... do`, `platforms ... do`, an `if`).
    const blocks: Array<string[] | null> = []
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.replace(/#.*$/, '').trim()
        if (line.length === 0) continue
        const group = /^group\s+(.+?)\s+do(\s*\|[^|]*\|)?$/.exec(line)
        if (group) {
            blocks.push(symbolsIn(group[1] as string))
            continue
        }
        if (/^end\b/.test(line)) {
            blocks.pop()
            continue
        }
        const gem = /^gem\s*\(?\s*['"]([^'"]+)['"](.*)$/.exec(line)
        if (gem) {
            const inline = /\bgroups?\s*(?::|=>)\s*(\[[^\]]*\]|:\w+|['"]\w+['"])/.exec(gem[2] as string)
            const groups = [...blocks.flatMap(function groupsOf(b) { return b ?? [] }), ...(inline ? symbolsIn(inline[1] as string) : [])]
            const devOnly = groups.length > 0 && groups.every(function dev(g) { return DEV_GROUPS.has(g) })
            const name = gem[1] as string
            declarations.set(name, (declarations.get(name) ?? true) && devOnly)
            if (/\bdo(\s*\|[^|]*\|)?$/.test(line)) blocks.push(null)
            continue
        }
        if (/\bdo(\s*\|[^|]*\|)?$/.test(line) || /^(if|unless|case|begin|while|until)\b/.test(line)) blocks.push(null)
    }
    const dev = new Set<string>()
    for (const [name, devOnly] of declarations) {
        if (devOnly) dev.add(name)
    }
    return dev
}

// `:development, :test`, `[:development, :test]`, `"test"` → ['development', 'test']. Keyword options after
// the groups (`optional: true`) are not groups.
function symbolsIn(text: string): string[] {
    const groups = text.split(/,\s*\w+:\s/)[0] as string
    return (groups.match(/:?['"]?(\w+)['"]?/g) ?? []).map(function bare(token) { return token.replace(/[:'"]/g, '') })
}

function unauditable(reasonCode: 'unsupported_lockfile' | 'ambiguous_dependency_spec', details: string[]): ResolverResult {
    return { status: 'unauditable', ecosystem: RUBYGEMS_ECOSYSTEM, reasonCode, details }
}
