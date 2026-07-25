import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ignoreFactory from 'ignore'
import { ECOSYSTEMS, type EcosystemId, type PackageManager, type Project } from '@sentinello/core'
import {
    type DrizzleDb,
    type Root,
    listProjects,
    deleteProject,
    upsertProject,
    projectId as makeProjectId
} from '@sentinello/db'

// Discovery applies the global ignore list AND per-directory `.sentinelloignore` files
// layered with gitignore semantics. Each `.sentinelloignore` only applies to descendants of
// the directory it lives in — we maintain a stack of (baseDir, ignorer) tuples while walking
// and check each candidate path against every applicable ignorer.

export type DiscoveryInput = {
    db: DrizzleDb
    roots: Root[]
    globalIgnore: string[]
    at: number
}

export type DiscoveryResult = {
    discoveredProjects: Project[]
    newProjectIds: string[]
    deletedProjectIds: string[]
}

const LOCKFILE_TO_PM: Record<string, PackageManager> = {
    'pnpm-lock.yaml': 'pnpm',
    'package-lock.json': 'npm',
    'yarn.lock': 'yarn'
}

const ALWAYS_SKIP = new Set(['node_modules', '.git'])
const PER_DIR_IGNORE_FILENAME = '.sentinelloignore'

type StackedIgnorer = {
    baseDir: string
    ig: ReturnType<typeof ignoreFactory>
}

export function discoverProjects(input: DiscoveryInput): DiscoveryResult {
    const discoveredByPath = new Map<string, Project>()
    for (const root of input.roots) {
        if (!existsSync(root.path)) continue
        const globalIg = ignoreFactory()
        globalIg.add(input.globalIgnore)
        const stack: StackedIgnorer[] = [{ baseDir: root.path, ig: globalIg }]
        walkRoot(root, root.path, stack, input.at, discoveredByPath)
    }
    // Reconciliation is scoped to the roots we actually walked. Otherwise a per-root sweep would
    // mark every project under unrelated roots as "missing" just because we didn't visit them.
    const walkedRootIds = new Set(input.roots.map(function id(r): string { return r.id }))
    const existing = listProjects(input.db).filter(function inScope(p): boolean {
        return walkedRootIds.has(p.rootId)
    })
    const existingById = new Map(existing.map(function pair(p): [string, Project] {
        return [p.id, p]
    }))
    const discovered = Array.from(discoveredByPath.values())
    const newProjectIds: string[] = []
    for (const project of discovered) {
        const prior = existingById.get(project.id)
        if (!prior) {
            upsertProject(input.db, project)
            newProjectIds.push(project.id)
            continue
        }
        // Preserve user-controlled fields (muted, tags, alias) and createdAt.
        const merged: Project = {
            ...project,
            alias: prior.alias,
            muted: prior.muted,
            tags: prior.tags,
            createdAt: prior.createdAt
        }
        upsertProject(input.db, merged)
    }
    const discoveredIds = new Set(discovered.map(function id(p): string {
        return p.id
    }))
    const deletedProjectIds: string[] = []
    for (const prior of existing) {
        if (discoveredIds.has(prior.id)) continue
        // The project's root was walked but the folder is gone, so the project is genuinely gone.
        // Sentinello keeps only what it currently sees: hard-delete the project and all of its
        // history (scans, findings, notification events/deliveries, mutes). An unmounted root never
        // reaches here — it is skipped above and excluded from `existing`, so its projects survive.
        deleteProject(input.db, prior.id)
        deletedProjectIds.push(prior.id)
    }
    return { discoveredProjects: discovered, newProjectIds, deletedProjectIds }
}

function walkRoot(
    root: Root,
    currentDir: string,
    stack: StackedIgnorer[],
    at: number,
    out: Map<string, Project>
): void {
    if (isIgnoredByStack(stack, currentDir)) return
    const project = detectProject(root, currentDir, at)
    if (project) {
        out.set(currentDir, project)
        // Do not descend into a project's children — projects do not nest in v1.
        return
    }
    // If this directory carries a .sentinelloignore, push a new layer scoped to its subtree.
    const localIgnorer = loadLocalIgnoreFile(currentDir)
    const effectiveStack = localIgnorer ? stack.concat([localIgnorer]) : stack
    const entries = safeReaddir(currentDir)
    for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (ALWAYS_SKIP.has(entry.name)) continue
        const childPath = join(currentDir, entry.name)
        walkRoot(root, childPath, effectiveStack, at, out)
    }
}

function isIgnoredByStack(stack: StackedIgnorer[], absolutePath: string): boolean {
    for (const layer of stack) {
        const rel = relative(layer.baseDir, absolutePath)
        if (rel === '' || rel.startsWith('..')) continue
        if (layer.ig.ignores(rel)) return true
    }
    return false
}

function loadLocalIgnoreFile(dir: string): StackedIgnorer | null {
    const path = join(dir, PER_DIR_IGNORE_FILENAME)
    if (!existsSync(path)) return null
    try {
        const raw = readFileSync(path, 'utf8')
        const ig = ignoreFactory()
        ig.add(raw)
        return { baseDir: dir, ig }
    } catch {
        return null
    }
}

function safeReaddir(dir: string) {
    try {
        return readdirSync(dir, { withFileTypes: true })
    } catch {
        return []
    }
}

function detectProject(root: Root, dir: string, at: number): Project | null {
    // A project is any directory carrying at least one ecosystem's manifest — JavaScript (package.json),
    // Python, Go, or Rust (Phase 4). One directory spans many ecosystems; projects still do not nest.
    const ecosystems = detectEcosystems(dir)
    if (ecosystems.length === 0) return null
    // `packageManager` stays the JavaScript/npm-audit detail (the lockfile that drives `npm audit`/nvm);
    // it is 'unknown' for a project with package.json but no recognized lockfile, or one with no JS at all.
    const pm = detectPackageManager(dir)
    const folderName = resolveBasename(dir)
    const nvmrcVersion = readNvmrcVersion(dir)
    const gitBranch = readGitBranch(dir, root.path)
    const relPath = relative(root.path, dir) || '.'
    const id = makeProjectId(root.id, relPath)
    return {
        id,
        rootId: root.id,
        relPath,
        name: folderName,
        alias: null,
        packageManager: pm,
        nvmrcVersion,
        gitBranch,
        ecosystems,
        muted: false,
        tags: [],
        createdAt: at,
        updatedAt: at
    }
}

// The set of ecosystems whose manifests exist in this directory, bound to the central registry. npm is
// keyed on `package.json` (a JS project may have no lockfile yet but is still an npm project — the scanner
// records the coverage gap); every other ecosystem is keyed on the presence of any of its resolver kinds.
function detectEcosystems(dir: string): EcosystemId[] {
    const out: EcosystemId[] = []
    for (const eco of ECOSYSTEMS) {
        if (eco.id === 'npm') {
            if (existsFile(join(dir, 'package.json'))) out.push(eco.id)
            continue
        }
        for (const kind of eco.resolverKinds) {
            if (existsFile(join(dir, kind))) {
                out.push(eco.id)
                break
            }
        }
    }
    return out
}

function existsFile(path: string): boolean {
    return existsSync(path) && isFile(path)
}

function detectPackageManager(dir: string): PackageManager {
    for (const [lockfile, pm] of Object.entries(LOCKFILE_TO_PM)) {
        if (existsSync(join(dir, lockfile))) return pm
    }
    return 'unknown'
}

function resolveBasename(dir: string): string {
    const abs = resolve(dir)
    const parts = abs.split('/')
    return parts[parts.length - 1] || abs
}

function readNvmrcVersion(dir: string): string | null {
    const nvmrcPath = join(dir, '.nvmrc')
    if (!existsSync(nvmrcPath)) return null
    try {
        const raw = readFileSync(nvmrcPath, 'utf8').trim()
        return raw.length > 0 && raw || null
    } catch {
        return null
    }
}

// The checked-out branch for a project, read straight off the filesystem. We never shell out to
// `git`: the runtime image carries no git binary, roots are mounted read-only, and reading a file
// is both faster and safe. Returns null for anything that is not a git checkout, which is a normal
// state (a plain directory of manifests), not an error.
export function readGitBranch(dir: string, rootPath: string): string | null {
    const gitDir = findGitDir(dir, rootPath)
    if (!gitDir) return null
    try {
        const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
        // Attached HEAD: "ref: refs/heads/<name>". Branch names may themselves contain slashes
        // (feature/foo), so take everything after the refs/heads/ prefix rather than the last segment.
        const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/)
        if (ref && ref[1]) return ref[1].trim() || null
        // Detached HEAD stores a bare commit sha; the short form is what a developer recognises.
        if (/^[0-9a-f]{40}$/i.test(head)) return head.slice(0, 7)
        return null
    } catch {
        return null
    }
}

// Locates the git directory for `dir`, walking up no further than the mounted root. The walk matters
// because a project can be a package inside a repository rather than the repository root, and a
// worktree or submodule stores `.git` as a FILE containing `gitdir: <path>` instead of a directory.
function findGitDir(dir: string, rootPath: string): string | null {
    const stopAt = resolve(rootPath)
    let current = resolve(dir)
    for (;;) {
        const candidate = join(current, '.git')
        if (existsSync(candidate)) {
            if (!isFile(candidate)) return candidate
            const resolved = readGitFilePointer(candidate, current)
            if (resolved) return resolved
        }
        if (current === stopAt) return null
        const parent = dirname(current)
        // dirname('/') === '/' — guards against an unbounded loop if dir ever escapes the root.
        if (parent === current) return null
        current = parent
    }
}

function readGitFilePointer(gitFile: string, baseDir: string): string | null {
    try {
        const raw = readFileSync(gitFile, 'utf8').trim()
        const match = raw.match(/^gitdir:\s*(.+)$/)
        if (!match || !match[1]) return null
        const target = match[1].trim()
        return resolve(baseDir, target)
    } catch {
        return null
    }
}

function isFile(path: string): boolean {
    try {
        return statSync(path).isFile()
    } catch {
        return false
    }
}
