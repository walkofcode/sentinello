import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import ignoreFactory from 'ignore'
import { STABLE_ECOSYSTEMS, type EcosystemId, type PackageManager } from '@sentinello/core'

// Project discovery: walk a directory tree and report every directory that carries at least one
// ecosystem's manifest. Shared by the worker (which walks mounted /roots on a schedule and reconciles the
// result into SQLite) and the CLI (which walks wherever the user is standing and reconciles nothing).
// Neither the walk nor its ignore rules should ever differ between the two products, which is why this
// lives here rather than being implemented twice.
//
// It sits in @sentinello/scanners rather than @sentinello/core because it reads the filesystem: core is
// imported by the Next.js portal, and pulling `node:fs` into that dependency graph is how a package that
// must stay browser-safe stops being browser-safe.

const LOCKFILE_TO_PM: Record<string, PackageManager> = {
    'pnpm-lock.yaml': 'pnpm',
    'package-lock.json': 'npm',
    'yarn.lock': 'yarn'
}

// Never descended, under any configuration. `node_modules` holds dependencies, not user-authored
// projects, and walking it would report thousands of phantom projects; `.git` holds no manifests at all.
const ALWAYS_SKIP = new Set(['node_modules', '.git'])

const SENTINELLO_IGNORE_FILENAME = '.sentinelloignore'
const GITIGNORE_FILENAME = '.gitignore'

export type DiscoveredProject = {
    // Absolute path of the project directory.
    absolutePath: string
    // Path relative to the walk root; '.' when the root itself is a project.
    relPath: string
    // Directory basename — the project's display name before any user alias.
    name: string
    // The JavaScript lockfile's package manager, or 'unknown' for a package.json with no recognized lock
    // (or a directory with no JavaScript at all). Drives which audit command the npm-audit scanner runs.
    packageManager: PackageManager
    nvmrcVersion: string | null
    gitBranch: string | null
    ecosystems: EcosystemId[]
}

export type DiscoverySkipSource = 'gitignore' | 'sentinelloignore' | 'excludes'

export type DiscoverySkip = {
    path: string
    source: DiscoverySkipSource
}

export type DiscoveryOptions = {
    // Absolute path to walk.
    rootPath: string
    // Explicit exclude patterns (the portal's configured global ignore list, or the CLI's --exclude flags).
    // Gitignore syntax, applied from the root down. These are the operator speaking directly, so unlike
    // ignore FILES they cannot be negated by a deeper .sentinelloignore.
    excludes?: string[]
    // Maximum directory levels to descend below the root. null/undefined means unlimited (the default, and
    // what the portal has always done). 0 examines only the root directory itself.
    maxDepth?: number | null
    // Called for each directory skipped because of an ignore rule. The CLI and worker both surface this,
    // because "Sentinello found nothing" is otherwise indistinguishable from "Sentinello skipped it".
    onSkip?: (skip: DiscoverySkip) => void
}

type IgnoreLayer = {
    baseDir: string
    // .gitignore and .sentinelloignore for ONE directory, composed into a single matcher. This composition
    // is load-bearing: `ignore` resolves negations against the rule list it was given, so keeping the two
    // files in separate layers (where "ignored by ANY layer" wins) would make a `!` rule in
    // .sentinelloignore incapable of ever re-including something .gitignore excluded — the escape hatch
    // would silently not exist. Gitignore rules are added first so .sentinelloignore always has the last
    // word for the directory it lives in.
    matcher: ReturnType<typeof ignoreFactory>
    // Which files contributed, so a skip can be attributed to the right source in diagnostics.
    hasGitignore: boolean
    hasSentinelloIgnore: boolean
}

// Walks the tree and returns every project found, in encounter order. Pure: it reads the filesystem and
// nothing else — no database, no network, no mutation.
export function discoverProjectsInTree(options: DiscoveryOptions): DiscoveredProject[] {
    const rootPath = resolve(options.rootPath)
    if (!existsSync(rootPath)) return []
    const out: DiscoveredProject[] = []
    const excludeMatcher = ignoreFactory()
    if (options.excludes && options.excludes.length > 0) excludeMatcher.add(options.excludes)
    const layers: IgnoreLayer[] = []
    walk({
        rootPath,
        currentDir: rootPath,
        depth: 0,
        maxDepth: options.maxDepth ?? null,
        excludeMatcher,
        hasExcludes: Boolean(options.excludes && options.excludes.length > 0),
        layers,
        onSkip: options.onSkip,
        out
    })
    return out
}

type WalkState = {
    rootPath: string
    currentDir: string
    depth: number
    maxDepth: number | null
    excludeMatcher: ReturnType<typeof ignoreFactory>
    hasExcludes: boolean
    layers: IgnoreLayer[]
    onSkip: ((skip: DiscoverySkip) => void) | undefined
    out: DiscoveredProject[]
}

function walk(state: WalkState): void {
    const project = detectProject(state.rootPath, state.currentDir)
    if (project) {
        state.out.push(project)
        // Do not descend into a project's children — projects do not nest. A monorepo root is therefore one
        // project, which is also how `pnpm audit` sees it.
        return
    }
    if (state.maxDepth !== null && state.depth >= state.maxDepth) return
    // An ignore file in this directory governs its descendants, so push the layer before reading entries.
    const localLayer = loadIgnoreLayer(state.currentDir)
    const layers = localLayer ? state.layers.concat([localLayer]) : state.layers
    for (const entry of safeReaddir(state.currentDir)) {
        if (!entry.isDirectory()) continue
        if (ALWAYS_SKIP.has(entry.name)) continue
        const childPath = join(state.currentDir, entry.name)
        const skip = classifySkip(childPath, state.rootPath, layers, state.excludeMatcher, state.hasExcludes)
        if (skip) {
            if (state.onSkip) state.onSkip({ path: childPath, source: skip })
            continue
        }
        walk({ ...state, currentDir: childPath, depth: state.depth + 1, layers })
    }
}

// Returns which rule source excluded this path, or null when it is not excluded. Explicit excludes are
// checked first and are final; ignore FILES are then checked from the innermost layer outward, so the
// closest ignore file to the path decides — matching how a developer expects nested ignore files to read.
function classifySkip(
    absolutePath: string,
    rootPath: string,
    layers: IgnoreLayer[],
    excludeMatcher: ReturnType<typeof ignoreFactory>,
    hasExcludes: boolean
): DiscoverySkipSource | null {
    if (hasExcludes) {
        // Exclude patterns are always rooted at the WALK ROOT, never at whichever directory happens to be
        // in scope — deriving the base from the ignore-layer stack would silently match `deep/one` against
        // just `one` in any tree whose root carries no ignore file.
        const rel = relative(rootPath, absolutePath)
        if (rel && !rel.startsWith('..') && (excludeMatcher.ignores(rel) || excludeMatcher.ignores(rel + '/'))) {
            return 'excludes'
        }
    }
    for (let i = layers.length - 1; i >= 0; i--) {
        const layer = layers[i]!
        // No containment guard on `rel`. The only caller passes join(currentDir, entry.name) and every
        // layer's baseDir is currentDir or one of its ancestors, so rel is always a non-empty descendant
        // path — it can be neither '' nor '..'-prefixed, and both checks this used to carry were dead.
        const rel = relative(layer.baseDir, absolutePath)
        // `ignore` needs a trailing slash to apply directory-only rules (e.g. "dist/") correctly.
        if (!layer.matcher.ignores(rel) && !layer.matcher.ignores(rel + '/')) continue
        if (layer.hasSentinelloIgnore && !layer.hasGitignore) return 'sentinelloignore'
        if (layer.hasGitignore && !layer.hasSentinelloIgnore) return 'gitignore'
        // Both files contributed to this matcher; the composed rules cannot say which one matched, and
        // attributing it to the file the user is more likely to be surprised by is the useful default.
        return 'gitignore'
    }
    return null
}

// Composes this directory's .gitignore and .sentinelloignore into one matcher, or returns null when
// neither exists. Order matters — see the IgnoreLayer comment.
function loadIgnoreLayer(dir: string): IgnoreLayer | null {
    const gitignore = readIgnoreFile(join(dir, GITIGNORE_FILENAME))
    const sentinelloIgnore = readIgnoreFile(join(dir, SENTINELLO_IGNORE_FILENAME))
    if (gitignore === null && sentinelloIgnore === null) return null
    const matcher = ignoreFactory()
    if (gitignore !== null) matcher.add(gitignore)
    if (sentinelloIgnore !== null) matcher.add(sentinelloIgnore)
    return {
        baseDir: dir,
        matcher,
        hasGitignore: gitignore !== null,
        hasSentinelloIgnore: sentinelloIgnore !== null
    }
}

function readIgnoreFile(path: string): string | null {
    if (!existsSync(path)) return null
    try {
        return readFileSync(path, 'utf8')
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

function detectProject(rootPath: string, dir: string): DiscoveredProject | null {
    // A project is any directory carrying at least one ecosystem's manifest.
    const ecosystems = detectEcosystems(dir)
    if (ecosystems.length === 0) return null
    const relPath = relative(rootPath, dir) || '.'
    return {
        absolutePath: dir,
        relPath,
        name: basenameOf(dir),
        packageManager: detectPackageManager(dir),
        nvmrcVersion: readNvmrcVersion(dir),
        gitBranch: readGitBranch(dir, rootPath),
        ecosystems
    }
}

// The set of ecosystems whose manifests exist in this directory, bound to the central registry. npm is
// keyed on `package.json` (a JS project may have no lockfile yet but is still an npm project — the scanner
// records the coverage gap); every other ecosystem is keyed on the presence of any of its resolver kinds.
export function detectEcosystems(dir: string): EcosystemId[] {
    const out: EcosystemId[] = []
    for (const eco of STABLE_ECOSYSTEMS) {
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

export function detectPackageManager(dir: string): PackageManager {
    for (const [lockfile, pm] of Object.entries(LOCKFILE_TO_PM)) {
        if (existsSync(join(dir, lockfile))) return pm
    }
    return 'unknown'
}

function basenameOf(dir: string): string {
    return basename(resolve(dir))
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
        // The capture cannot be blank: the pattern has no `m` flag, so `$` is end-of-input and `.`
        // cannot cross a newline — the group therefore ends on head's last character, and head was
        // already trimmed.
        if (ref && ref[1]) return ref[1].trim()
        // Detached HEAD stores a bare commit sha; the short form is what a developer recognises.
        if (/^[0-9a-f]{40}$/i.test(head)) return head.slice(0, 7)
        return null
    } catch {
        return null
    }
}

// Locates the git directory for `dir`, walking up no further than the walk root. The walk matters
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
