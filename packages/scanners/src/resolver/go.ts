import { readFile } from 'node:fs/promises'
import { goComparator } from '@sentinello/versions'
import { makeGraph } from './graph'
import type { ResolvedPackage, ResolverResult } from './types'

// Go resolver, offline: we never shell out to `go list -m all`, so the build list is read from the files.
//
// `go.mod` is complete on its own from Go 1.17 on. Module graph pruning made the `go` directive a contract:
// a module that declares `go 1.17` or later lists, in its own `require` blocks, every module that provides
// a package its build imports — direct and indirect, at the version MVS selected (`go mod tidy` keeps it
// that way, and `go build` refuses a go.mod that is not). So a 1.17+ go.mod resolves `ok`. Before 1.17 the
// file names only what the module requires directly and the rest comes from dependencies' go.mod files,
// which are not here: partial.
//
// `replace` is applied as the toolchain applies it. A module-version replacement builds the replacement
// instead, so that is the module and version matched (a fork at another path is matched under ITS path,
// because that is the code compiled in). A replacement by a local directory builds whatever is on disk —
// no version, nothing an advisory can be compared against — so it is counted as cannot-be-audited.
//
// `go.sum` is only the fallback for a project with no go.mod. It is a checksum database, not a build list:
// it holds a `/go.mod` line for every module version MVS merely consulted, and can hold several versions of
// one module — an upgrade, a revert, a version another requirement path asked for — none of which says which
// one the build selected. MVS selects from the requirement graph (https://go.dev/ref/mod#minimal-version-
// selection), and that graph is exactly what is missing here, so the highest checksum is no evidence of the
// selected version. Every content-hash line (a version whose source was downloaded) is therefore kept as a
// CANDIDATE, `/go.mod`-only lines excluded: a lower version that is affected stays visible beside a fixed
// higher one rather than being discarded on a guess. Always partial, and the detail says the versions are
// checksummed, not proven built.
//
// Go has no dev/test scope at the module level, so every module is prod. Module paths are the OSV key
// verbatim; a major-version suffix (`/v2`) is part of the path and so of the name.

const GO_ECOSYSTEM = 'Go'
const MODULE_GRAPH_PRUNING = { major: 1, minor: 17 }

export async function parseGoMod(kind: string, absolutePath: string, manifestPath: string): Promise<ResolverResult> {
    let text: string
    try {
        text = await readFile(absolutePath, 'utf8')
    } catch {
        return unauditable(['could not read ' + manifestPath])
    }
    return kind === 'go.sum' ? fromGoSum(text, manifestPath) : fromGoMod(text, manifestPath)
}

type Requirement = { path: string; version: string }
type Replacement = { path: string; version: string | null; target: string; targetVersion: string | null }

function fromGoMod(text: string, manifestPath: string): ResolverResult {
    const directives = readDirectives(text)
    const requires: Requirement[] = []
    const replaces: Replacement[] = []
    let goVersion: string | null = null
    for (const { verb, args } of directives) {
        if (verb === 'go') goVersion = args[0] ?? null
        else if (verb === 'require' && args.length >= 2) requires.push({ path: args[0] as string, version: args[1] as string })
        else if (verb === 'replace') {
            const replace = readReplace(args)
            if (replace !== null) replaces.push(replace)
        }
    }

    const packages: ResolvedPackage[] = []
    const seen = new Set<string>()
    const local: string[] = []
    for (const req of requires) {
        const replace = replaces.find(function applies(r) { return r.path === req.path && (r.version === null || r.version === req.version) })
        if (replace !== undefined && replace.targetVersion === null) {
            local.push(req.path + ' => ' + replace.target)
            continue
        }
        const path = replace !== undefined ? replace.target : req.path
        const version = replace !== undefined ? replace.targetVersion as string : req.version
        addModule(path, version, manifestPath, packages, seen)
    }
    if (packages.length === 0 && local.length === 0) return unauditable(['no modules found in ' + manifestPath])

    const details: string[] = []
    if (!completeBuildList(goVersion)) {
        details.push(manifestPath + ' declares ' + (goVersion === null ? 'no go version' : 'go ' + goVersion) + ', before Go 1.17, so it does not list every module the build needs')
    }
    if (local.length > 0) details.push(local.length + ' modules replaced by a local directory cannot be audited: ' + local.sort().join(', '))
    if (packages.length === 0) return unauditable(details)
    if (details.length === 0) return { status: 'ok', ecosystem: GO_ECOSYSTEM, graph: makeGraph(packages) }
    return { status: 'partial', ecosystem: GO_ECOSYSTEM, graph: makeGraph(packages), reasonCode: 'partial_dependency_graph', details }
}

function fromGoSum(text: string, manifestPath: string): ResolverResult {
    const packages: ResolvedPackage[] = []
    const seen = new Set<string>()
    for (const rawLine of text.split(/\r?\n/)) {
        const [path, version] = rawLine.trim().split(/\s+/)
        // `<module> <version>/go.mod <hash>` records only that the module's go.mod was read.
        if (!path || !version || version.endsWith('/go.mod')) continue
        if (goComparator.normalize(version) === null) continue
        addModule(path, version, manifestPath, packages, seen)
    }
    if (packages.length === 0) return unauditable(['no modules found in ' + manifestPath])
    return {
        status: 'partial',
        ecosystem: GO_ECOSYSTEM,
        graph: makeGraph(packages),
        reasonCode: 'partial_dependency_graph',
        details: ['Go modules read from ' + manifestPath + ' with no go.mod: every checksummed module version is a candidate, not proof of what the build selects, and can include modules the build does not use']
    }
}

// A `go` directive of 1.17 or later.
function completeBuildList(goVersion: string | null): boolean {
    if (goVersion === null) return false
    const match = /^(\d+)\.(\d+)/.exec(goVersion)
    if (!match) return false
    const major = Number(match[1])
    const minor = Number(match[2])
    return major > MODULE_GRAPH_PRUNING.major || (major === MODULE_GRAPH_PRUNING.major && minor >= MODULE_GRAPH_PRUNING.minor)
}

type Directive = { verb: string; args: string[] }

// Every directive, single-line (`require a v1`) and block (`require (` … `)`) alike, with comments
// (`// indirect`) stripped and a quoted path unquoted.
function readDirectives(text: string): Directive[] {
    const out: Directive[] = []
    let block: string | null = null
    for (const rawLine of text.split(/\r?\n/)) {
        const line = stripComment(rawLine).trim()
        if (line.length === 0) continue
        if (block !== null) {
            if (line === ')') block = null
            else out.push({ verb: block, args: tokens(line) })
            continue
        }
        const parts = tokens(line)
        const verb = parts[0] as string
        if (parts[1] === '(' && parts.length === 2) {
            block = verb
            continue
        }
        out.push({ verb, args: parts.slice(1) })
    }
    return out
}

// `old [v] => new [v]`. A target with no version is a local directory (go.mod requires a version on any
// module-path replacement).
function readReplace(args: string[]): Replacement | null {
    const arrow = args.indexOf('=>')
    if (arrow < 1) return null
    const left = args.slice(0, arrow)
    const right = args.slice(arrow + 1)
    const target = right[0]
    if (target === undefined) return null
    return { path: left[0] as string, version: left[1] ?? null, target, targetVersion: right[1] ?? null }
}

function tokens(line: string): string[] {
    return line.split(/\s+/).filter(function nonEmpty(s) { return s.length > 0 }).map(function unquote(s) { return s.replace(/^"(.*)"$/, '$1') })
}

function addModule(path: string, version: string, manifestPath: string, out: ResolvedPackage[], seen: Set<string>): void {
    const key = path + '@' + version
    if (seen.has(key)) return
    seen.add(key)
    out.push({
        ecosystem: GO_ECOSYSTEM,
        name: path,
        version,
        scope: { isProd: true, isDev: false, isOptional: false },
        depPaths: [key],
        manifestPath
    })
}

function stripComment(line: string): string {
    const idx = line.indexOf('//')
    return idx >= 0 ? line.slice(0, idx) : line
}

function unauditable(details: string[]): ResolverResult {
    return { status: 'unauditable', ecosystem: GO_ECOSYSTEM, reasonCode: 'ambiguous_dependency_spec', details }
}
