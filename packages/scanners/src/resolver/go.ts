import { readFile } from 'node:fs/promises'
import { makeGraph } from './graph'
import type { ResolvedPackage, ResolverResult } from './types'

// Go resolver. Offline we parse `go.mod`'s `require` directives (which, after `go mod tidy`, list direct
// AND indirect modules with their MVS-selected versions) — falling back to `go.sum` when `go.mod` carries
// no requires. We do NOT shell out to `go list -m all`, so we can't *prove* the parsed set equals the
// fully-pruned build graph (Go 1.17+ module-graph pruning); the result is therefore classified `partial`
// to disclose that limit rather than imply a complete transitive resolution. Go has no dev/test scope
// distinction at the module level, so every module is treated as prod. Module paths are the OSV key; the
// `v`-prefixed versions are normalized by the semver comparator (Go rides semver per the registry).

const GO_ECOSYSTEM = 'Go'

export async function parseGoMod(kind: string, absolutePath: string): Promise<ResolverResult> {
    let text: string
    try {
        text = await readFile(absolutePath, 'utf8')
    } catch {
        return unauditable(['could not read ' + kind])
    }
    const packages = kind === 'go.sum' ? fromGoSum(text) : fromGoMod(text)
    if (packages.length === 0) {
        return unauditable(['no modules found in ' + kind])
    }
    return {
        status: 'partial',
        ecosystem: GO_ECOSYSTEM,
        graph: makeGraph(packages),
        reasonCode: 'partial_dependency_graph',
        details: ['Go modules parsed from ' + kind + ' offline; the fully-pruned transitive graph is not guaranteed without `go list -m all`']
    }
}

function fromGoMod(text: string): ResolvedPackage[] {
    const out: ResolvedPackage[] = []
    const seen = new Set<string>()
    let inBlock = false
    for (const rawLine of text.split(/\r?\n/)) {
        const line = stripComment(rawLine).trim()
        if (line.length === 0) continue
        if (inBlock) {
            if (line === ')') {
                inBlock = false
                continue
            }
            addModule(line, out, seen)
            continue
        }
        if (line === 'require (') {
            inBlock = true
            continue
        }
        if (line.startsWith('require ')) {
            addModule(line.slice('require '.length).trim(), out, seen)
        }
    }
    return out
}

// go.sum lists `module version hash` (and a second `module version/go.mod hash` line per module). We take
// the module + version and de-dupe; this is the most conservative fallback (it can include versions not in
// the final build list), hence the `partial` classification.
function fromGoSum(text: string): ResolvedPackage[] {
    const out: ResolvedPackage[] = []
    const seen = new Set<string>()
    for (const rawLine of text.split(/\r?\n/)) {
        const parts = rawLine.trim().split(/\s+/)
        const name = parts[0]
        const rawVersion = parts[1]
        if (!name || !rawVersion) continue
        addModuleParts(name, rawVersion.replace(/\/go\.mod$/, ''), out, seen)
    }
    return out
}

// One `require`-block / single-require entry: `<module> <version> [// indirect]`. The comment is already
// stripped by the caller for block lines; for single-require lines `// indirect` is rare but handled.
function addModule(spec: string, out: ResolvedPackage[], seen: Set<string>): void {
    const parts = spec.split(/\s+/).filter(function nonEmpty(s) { return s.length > 0 })
    const name = parts[0]
    const version = parts[1]
    if (!name || !version) return
    addModuleParts(name, version, out, seen)
}

function addModuleParts(name: string, version: string, out: ResolvedPackage[], seen: Set<string>): void {
    if (!name || !version) return
    const key = name + '@' + version
    if (seen.has(key)) return
    seen.add(key)
    out.push({
        ecosystem: GO_ECOSYSTEM,
        name,
        version,
        scope: { isProd: true, isDev: false, isOptional: false },
        depPaths: [key]
    })
}

function stripComment(line: string): string {
    const idx = line.indexOf('//')
    return idx >= 0 ? line.slice(0, idx) : line
}

function unauditable(details: string[]): ResolverResult {
    return { status: 'unauditable', ecosystem: GO_ECOSYSTEM, reasonCode: 'ambiguous_dependency_spec', details }
}
