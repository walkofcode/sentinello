import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { makeGraph } from './graph'
import type { ResolvedGraph, ResolvedPackage } from './types'

const NPM_ECOSYSTEM = 'npm'

type NpmLockEntry = {
    name?: string
    version?: string
    dev?: boolean
    devOptional?: boolean
    optional?: boolean
}
type NpmLockDoc = {
    packages?: Record<string, NpmLockEntry>
}

// package-lock.json resolver. npm marks each `packages[nodePath]` with a `dev`/`devOptional` flag we
// trust, then we force any name listed under the root package.json `dependencies` back to prod (a direct
// prod dep should always read as prod even when a dev tree shares the same node). Returns null on
// read/parse failure so the caller fails open.
export async function parseNpmLock(projectPath: string, absolutePath: string): Promise<ResolvedGraph | null> {
    let text: string
    try {
        text = await readFile(absolutePath, 'utf8')
    } catch {
        return null
    }
    let parsed: unknown
    try {
        parsed = JSON.parse(text)
    } catch {
        return null
    }
    if (!parsed || typeof parsed !== 'object') return null
    const doc = parsed as NpmLockDoc
    const packages = doc.packages || {}
    const direct = await readDirectDeps(projectPath)
    const out: ResolvedPackage[] = []
    for (const nodePath of Object.keys(packages)) {
        // The "" root entry is the project itself — not an installed dependency.
        if (!nodePath) continue
        const entry = packages[nodePath]
        if (!entry || !entry.version) continue
        const name = entry.name || nameFromNodePath(nodePath)
        if (!name) continue
        // npm's own flag is the authority on reachability, and the root manifest may only ADD to it —
        // never take prod away.
        //
        // `dev: true` means "reachable ONLY from devDependencies". Its ABSENCE therefore means npm proved
        // the node is reachable from production, which is a stronger statement than anything the manifest
        // can make. Clearing isProd because the name also appears under devDependencies contradicted that
        // proof, and it fired precisely when npm was right: on a package that is a direct dev dependency
        // AND pulled in transitively by a prod one. Measured across 130 real npm projects, it demoted 142
        // package nodes — lodash, semver, postcss, tailwindcss, @babel/runtime — out of the production view
        // in 97 of them, hiding genuinely shipped vulnerabilities from the prod-only filter.
        //
        // A lockfile carrying no flags at all still degrades to "everything prod", which is the resolver's
        // documented fail-open posture: a finding shown in the wrong bucket beats a finding not shown.
        const lockSaysDevOnly = entry.dev === true || entry.devOptional === true
        let isProd = !lockSaysDevOnly
        let isDev = lockSaysDevOnly
        if (direct.prod.has(name)) isProd = true
        if (direct.dev.has(name)) isDev = true
        out.push({
            ecosystem: NPM_ECOSYSTEM,
            name,
            version: entry.version,
            scope: { isProd, isDev, isOptional: entry.optional === true || entry.devOptional === true },
            depPaths: [nodePath]
        })
    }
    return makeGraph(out)
}

type DirectDeps = {
    prod: Set<string>
    dev: Set<string>
}

async function readDirectDeps(projectPath: string): Promise<DirectDeps> {
    const prod = new Set<string>()
    const dev = new Set<string>()
    try {
        const text = await readFile(join(projectPath, 'package.json'), 'utf8')
        const parsed = JSON.parse(text) as {
            dependencies?: Record<string, unknown>
            devDependencies?: Record<string, unknown>
            optionalDependencies?: Record<string, unknown>
            peerDependencies?: Record<string, unknown>
        }
        if (parsed.dependencies) for (const k of Object.keys(parsed.dependencies)) prod.add(k)
        if (parsed.optionalDependencies) for (const k of Object.keys(parsed.optionalDependencies)) prod.add(k)
        if (parsed.peerDependencies) for (const k of Object.keys(parsed.peerDependencies)) prod.add(k)
        if (parsed.devDependencies) for (const k of Object.keys(parsed.devDependencies)) dev.add(k)
    } catch {
        // No package.json or unparseable — leave both sets empty.
    }
    return { prod, dev }
}

// Pulls the package name out of an npm lockfile node path, e.g.
// "node_modules/@scope/pkg/node_modules/dep" → "dep" (the deepest node_modules segment).
function nameFromNodePath(nodePath: string): string | null {
    const marker = 'node_modules/'
    const idx = nodePath.lastIndexOf(marker)
    if (idx < 0) return null
    const tail = nodePath.slice(idx + marker.length)
    if (!tail) return null
    if (tail.startsWith('@')) {
        const slash = tail.indexOf('/')
        if (slash < 0) return tail
        const second = tail.indexOf('/', slash + 1)
        return second < 0 ? tail : tail.slice(0, second)
    }
    const slash = tail.indexOf('/')
    return slash < 0 ? tail : tail.slice(0, slash)
}
