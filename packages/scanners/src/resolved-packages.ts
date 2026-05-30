import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { z } from 'zod'
import type { DetectedLockfile } from './types'

// A single concrete installed package as resolved from the lockfile: the registry name, the exact
// installed version, prod/dev classification, and the dependency path (node-module segments) that led
// to it. This is the unit the OSV scanner matches advisories against — it deliberately mirrors the
// fields RawFinding needs so the scanner can build findings without re-reading anything.
export type ResolvedPackage = {
    name: string
    version: string
    isProd: boolean
    isDev: boolean
    depPath: string[]
}

// Result wrapper distinguishing "parsed, here are the packages" from "could not parse this lockfile
// kind" (today: yarn.lock). A null `packages` lets the scanner fail open with a clear reason code
// rather than silently reporting zero findings for a project it never actually inspected.
export type ResolvedPackagesResult = {
    packages: ResolvedPackage[] | null
}

const packageLockSchema = z
    .object({
        lockfileVersion: z.number().int().optional(),
        packages: z
            .record(
                z.string(),
                z
                    .object({
                        name: z.string().optional(),
                        version: z.string().optional(),
                        dev: z.boolean().optional(),
                        devOptional: z.boolean().optional()
                    })
                    .passthrough()
            )
            .optional()
    })
    .passthrough()

// Reads the project's lockfile and returns the flat list of resolved packages. package-lock.json and
// pnpm-lock.yaml are supported; yarn.lock returns { packages: null } (fail-open) because its bespoke
// format isn't parsed yet. Any read/parse error also returns null so the caller stays fail-open.
export async function parseResolvedPackages(
    projectPath: string,
    lockfile: DetectedLockfile
): Promise<ResolvedPackagesResult> {
    if (lockfile.kind === 'package-lock.json') {
        return parseNpmLock(projectPath, lockfile.absolutePath)
    }
    if (lockfile.kind === 'pnpm-lock.yaml') {
        return parsePnpmLock(lockfile.absolutePath)
    }
    return { packages: null }
}

async function parseNpmLock(projectPath: string, absolutePath: string): Promise<ResolvedPackagesResult> {
    let text: string
    try {
        text = await readFile(absolutePath, 'utf8')
    } catch {
        return { packages: null }
    }
    let parsed: unknown
    try {
        parsed = JSON.parse(text)
    } catch {
        return { packages: null }
    }
    const validation = packageLockSchema.safeParse(parsed)
    if (!validation.success) return { packages: null }
    const directDeps = await readDirectDeps(projectPath)
    const packages = validation.data.packages || {}
    const out: ResolvedPackage[] = []
    for (const nodePath of Object.keys(packages)) {
        // The "" root entry is the project itself — not an installed dependency.
        if (!nodePath) continue
        const entry = packages[nodePath]
        if (!entry || !entry.version) continue
        const name = entry.name || nameFromNodePath(nodePath)
        if (!name) continue
        const isDev = entry.dev === true || entry.devOptional === true
        out.push({
            name,
            version: entry.version,
            isProd: !isDev,
            isDev,
            depPath: [nodePath]
        })
    }
    return { packages: applyDirectDevFallback(out, directDeps) }
}

// pnpm-lock.yaml (v6/v9) carries a `packages` (and in v9 `snapshots`) map keyed by `/<name>@<version>`
// or `<name>@<version>`. We read the `packages` map for the concrete name@version set and treat
// `dev: true` entries as dev-only. Scoped names (@scope/name) keep their leading '@'.
const pnpmLockSchema = z
    .object({
        packages: z
            .record(
                z.string(),
                z
                    .object({
                        dev: z.boolean().optional(),
                        version: z.string().optional()
                    })
                    .passthrough()
            )
            .optional()
    })
    .passthrough()

async function parsePnpmLock(absolutePath: string): Promise<ResolvedPackagesResult> {
    let text: string
    try {
        text = await readFile(absolutePath, 'utf8')
    } catch {
        return { packages: null }
    }
    let parsed: unknown
    try {
        parsed = yaml.load(text)
    } catch {
        return { packages: null }
    }
    const validation = pnpmLockSchema.safeParse(parsed)
    if (!validation.success) return { packages: null }
    const packages = validation.data.packages || {}
    const out: ResolvedPackage[] = []
    for (const key of Object.keys(packages)) {
        const entry = packages[key]
        if (!entry) continue
        const parsedKey = parsePnpmKey(key)
        if (!parsedKey) continue
        const version = entry.version || parsedKey.version
        if (!version) continue
        const isDev = entry.dev === true
        out.push({
            name: parsedKey.name,
            version,
            isProd: !isDev,
            isDev,
            depPath: [key]
        })
    }
    return { packages: out }
}

// Parses a pnpm lock key into { name, version }. Handles a leading '/', scoped names, and the
// `(peer)` suffix pnpm appends, e.g. "/@babel/core@7.0.0(supports-color@8.0.0)" → @babel/core@7.0.0.
function parsePnpmKey(key: string): { name: string; version: string } | null {
    let s = key.trim()
    if (!s) return null
    if (s.startsWith('/')) s = s.slice(1)
    const parenIdx = s.indexOf('(')
    if (parenIdx >= 0) s = s.slice(0, parenIdx)
    const isScoped = s.startsWith('@')
    const atIdx = isScoped ? s.indexOf('@', 1) : s.indexOf('@')
    if (atIdx <= 0) return null
    const name = s.slice(0, atIdx)
    const version = s.slice(atIdx + 1)
    if (!name || !version) return null
    return { name, version }
}

// Pulls the package name out of an npm lockfile node path, e.g. "node_modules/@scope/pkg/node_modules/dep"
// → "dep". Returns the deepest node_modules segment (the actual installed package at that path).
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

// npm marks the dev flag on the lockfile entry, which we trust. But a direct dependency listed under
// `dependencies` should always read as prod even if some transitive shares its node — so when the
// package name is a known direct prod dep, force isProd. This mirrors the npm-audit classifier's
// preference for the lockfile flag with a package.json fallback.
function applyDirectDevFallback(packages: ResolvedPackage[], direct: DirectDeps): ResolvedPackage[] {
    if (direct.prod.size === 0 && direct.dev.size === 0) return packages
    for (const pkg of packages) {
        if (direct.prod.has(pkg.name)) {
            pkg.isProd = true
        }
        if (direct.dev.has(pkg.name) && !direct.prod.has(pkg.name)) {
            pkg.isDev = true
            pkg.isProd = false
        }
    }
    return packages
}
