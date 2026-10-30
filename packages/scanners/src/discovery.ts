import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import ignoreFactory from 'ignore'
import {
    manifestDirOf,
    packageManagerOfManifest,
    requireEcosystemId,
    STABLE_ECOSYSTEMS,
    type EcosystemDefinition,
    type EcosystemId,
    type PackageManager,
    type ProjectManifest
} from '@sentinello/core'
import { detectManifestsInSync, type DetectedManifest } from './resolver'
import { isWithin } from './resolver/paths'

// Project discovery: walk a directory tree and report every project in it, with every manifest it owns.
// Shared by the worker (which walks mounted /roots on a schedule and reconciles the
// result into SQLite) and the CLI (which walks wherever the user is standing and reconciles nothing).
// Neither the walk nor its ignore rules should ever differ between the two products, which is why this
// lives here rather than being implemented twice.
//
// Where a project begins (decision #3 of the 3.8 plan):
//   1. A directory with a package.json is a project, detected exactly as before 3.8, and no project nests
//      under it.
//   2. Below any project, every non-npm manifest at any depth belongs to the nearest enclosing project
//      (ios/Gemfile.lock, scripts/requirements.txt), outside the directories in MANIFEST_SKIP.
//   3. A directory with a non-npm manifest and no enclosing project is a project anchored there.
//   4. Below such a non-npm project the walk still looks for package.json directories, and each is its own
//      project owning its own subtree.
// So a repo-root requirements.txt can never swallow the npm projects beside it: they keep their ids, and
// the worker, which hard-deletes a project that stops being discovered, never sees them disappear.
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

// Never searched for a project's sub-manifests: installed dependencies, virtualenvs and build output, all
// of which carry manifests the project did not write. They are still walked for package.json directories
// when no npm project encloses them, because before 3.8 they were, and npm discovery does not change.
const MANIFEST_SKIP = new Set(['node_modules', 'vendor', '.venv', 'venv', 'target', 'Pods', 'build', 'dist'])

const SENTINELLO_IGNORE_FILENAME = '.sentinelloignore'
const GITIGNORE_FILENAME = '.gitignore'

export type DiscoveredProject = {
    // Absolute path of the project directory.
    absolutePath: string
    // Path relative to the walk root; '.' when the root itself is a project.
    relPath: string
    // Directory basename — the project's display name before any user alias.
    name: string
    // For a package.json project, the JavaScript lockfile's package manager, or 'unknown' with no recognized
    // lock; it drives which audit command the npm-audit scanner runs. For any other project, the manager of
    // its anchor manifest (the first one in its own directory).
    packageManager: PackageManager
    nvmrcVersion: string | null
    gitBranch: string | null
    // The distinct ecosystems of `manifests`, in registry order.
    ecosystems: EcosystemId[]
    // Every manifest the project owns: its own directory's first, then its sub-manifests by directory.
    manifests: ProjectManifest[]
}

export type DiscoverySkipSource = 'gitignore' | 'sentinelloignore' | 'excludes'

export type DiscoverySkip = {
    path: string
    source: DiscoverySkipSource
}

// A directory the walk could not read. Its subtree is missing from the result, so a caller that deletes
// what it no longer sees must not trust this walk to say what is gone.
export type DiscoveryError = {
    path: string
    message: string
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
    // Called for each directory that could not be read. The walk carries on without it.
    onError?: (error: DiscoveryError) => void
    // The ecosystems to look for; the stable ones by default. Tests pass preview ones to exercise them.
    ecosystems?: readonly EcosystemDefinition[]
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
    const ecosystems = options.ecosystems ?? STABLE_ECOSYSTEMS
    walk({
        rootPath,
        currentDir: rootPath,
        depth: 0,
        maxDepth: options.maxDepth ?? null,
        excludeMatcher,
        hasExcludes: Boolean(options.excludes && options.excludes.length > 0),
        layers,
        onSkip: options.onSkip,
        onError: options.onError,
        ecosystems,
        npmOn: ecosystems.some(isNpm),
        subEcosystems: ecosystems.filter(function nonNpm(eco) { return !isNpm(eco) }),
        owner: null,
        manifestsOff: false,
        out
    })
    for (const project of out) finishProject(project, ecosystems)
    return out
}

export type ProjectRediscoveryOptions = {
    // The walk root the project was discovered under, and the project's own directory below it.
    rootPath: string
    projectPath: string
    excludes?: string[]
    ecosystems?: readonly EcosystemDefinition[]
}

export type ProjectRediscovery = {
    // The project as a discovery pass would record it now; null when its directory no longer anchors one.
    project: DiscoveredProject | null
    // Directories below the project that could not be read: see withUnreadManifests.
    errors: DiscoveryError[]
}

// Re-reads ONE known project exactly as a discovery pass would — the same rules, the ignore files of every
// directory from the root down, the same excludes — without walking the rest of the root. A scan requested
// between sweeps (the watcher, a manual scan) uses it, so a lockfile added since the last sweep is scanned
// now (a uv.lock beside a bare pyproject.toml, a new ios/Gemfile.lock), and which manifests a project owns is
// still decided in one place: an appended file name would bypass lockfile precedence and nested-project
// ownership.
export function rediscoverProject(options: ProjectRediscoveryOptions): ProjectRediscovery {
    const rootPath = resolve(options.rootPath)
    const projectPath = resolve(options.projectPath)
    const errors: DiscoveryError[] = []
    if (!isWithin(rootPath, projectPath) || !existsSync(projectPath)) return { project: null, errors }
    const rel = relative(rootPath, projectPath)
    const excludeMatcher = ignoreFactory()
    if (options.excludes && options.excludes.length > 0) excludeMatcher.add(options.excludes)
    // The ignore layers the root-down walk would have stacked above the project; walk() adds the project's own.
    const layers: IgnoreLayer[] = []
    const segments = rel === '' ? [] : rel.split(sep)
    let dir = rootPath
    for (const segment of segments) {
        const layer = loadIgnoreLayer(dir)
        if (layer) layers.push(layer)
        dir = join(dir, segment)
    }
    const ecosystems = options.ecosystems ?? STABLE_ECOSYSTEMS
    const out: DiscoveredProject[] = []
    walk({
        rootPath,
        currentDir: projectPath,
        depth: segments.length,
        maxDepth: null,
        excludeMatcher,
        hasExcludes: Boolean(options.excludes && options.excludes.length > 0),
        layers,
        onSkip: undefined,
        onError: function record(error) {
            errors.push(error)
        },
        ecosystems,
        npmOn: ecosystems.some(isNpm),
        subEcosystems: ecosystems.filter(function nonNpm(eco) { return !isNpm(eco) }),
        owner: null,
        manifestsOff: false,
        out
    })
    // The walk also reaches the npm projects nested below a non-npm one (rule 4); they are not this project's.
    const project = out.find(function self(p) { return p.absolutePath === projectPath }) ?? null
    if (project !== null) finishProject(project, ecosystems)
    return { project, errors }
}

// A walk that could not read some directory cannot say what is below it, so a recorded manifest there is
// kept rather than dropped: the project still has to answer for it, and dropping it would let the next scan
// read the project as fully covered, or resolve what was found in it, when nothing looked (SENTINEL-140). A
// directory whose listing failed may hide its own files too (a mode-000 directory cannot be stat'ed into),
// so a manifest in the unreadable directory itself is kept as well. Returns the project with those manifests
// added back and its ecosystems derived again; unchanged when the walk was complete.
export function withUnreadManifests(
    project: DiscoveredProject,
    recorded: readonly ProjectManifest[],
    errors: readonly DiscoveryError[],
    ecosystems: readonly EcosystemDefinition[] = STABLE_ECOSYSTEMS
): DiscoveredProject {
    if (errors.length === 0) return project
    const manifests = project.manifests.slice()
    for (const manifest of recorded) {
        if (manifests.some(function same(m) { return m.path === manifest.path })) continue
        const dir = dirname(join(project.absolutePath, manifest.path))
        if (!errors.some(function hides(error) { return isWithin(resolve(error.path), dir) })) continue
        manifests.push(manifest)
    }
    const out: DiscoveredProject = { ...project, manifests }
    finishProject(out, ecosystems)
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
    onError: ((error: DiscoveryError) => void) | undefined
    ecosystems: readonly EcosystemDefinition[]
    // Whether npm is looked for at all, and the other ecosystems, which are looked for below projects too.
    npmOn: boolean
    subEcosystems: readonly EcosystemDefinition[]
    // The nearest enclosing project, which owns any sub-manifest found here.
    owner: Owner | null
    // Inside a MANIFEST_SKIP directory of the owner: nothing here is the owner's, or anchors a project.
    manifestsOff: boolean
    out: DiscoveredProject[]
}

type Owner = {
    project: DiscoveredProject
    npm: boolean
}

function walk(state: WalkState): void {
    const owner = claimDirectory(state)
    // A project starts its own subtree, so the skip directories count from it.
    const manifestsOff = owner === state.owner && state.manifestsOff
    // Projects do not nest under an npm project — a monorepo root is ONE project, which is also how
    // `pnpm audit` sees it — so below one the walk only looks for sub-manifests, and with no ecosystem
    // besides npm to look for there is nothing below it to find.
    if (owner?.npm && state.subEcosystems.length === 0) return
    if (state.maxDepth !== null && state.depth >= state.maxDepth) return
    // An ignore file in this directory governs its descendants, so push the layer before reading entries.
    const localLayer = loadIgnoreLayer(state.currentDir)
    const layers = localLayer ? state.layers.concat([localLayer]) : state.layers
    for (const entry of readEntries(state.currentDir, state.onError)) {
        if (!entry.isDirectory()) continue
        if (ALWAYS_SKIP.has(entry.name)) continue
        const childManifestsOff = manifestsOff || MANIFEST_SKIP.has(entry.name)
        // Below an npm project only sub-manifests are looked for, and a skipped directory holds none.
        if (owner?.npm && childManifestsOff) continue
        const childPath = join(state.currentDir, entry.name)
        const skip = classifySkip(childPath, state.rootPath, layers, state.excludeMatcher, state.hasExcludes)
        if (skip) {
            // Inside an npm project a skip can only hide a sub-manifest, never a project, and reporting every
            // ignored dist/ or coverage/ there would bury the skips that do hide one.
            if (state.onSkip && !owner?.npm) state.onSkip({ path: childPath, source: skip })
            continue
        }
        walk({ ...state, currentDir: childPath, depth: state.depth + 1, layers, owner, manifestsOff: childManifestsOff })
    }
}

// Decides what this directory is: a new project (rules 1 and 3), part of the enclosing one (rule 2), or
// neither. Returns the project that owns the directory's subtree.
function claimDirectory(state: WalkState): Owner | null {
    const dir = state.currentDir
    const owner = state.owner
    // The walk never enters a skipped directory below an npm project, so everything it reaches there is the
    // project's.
    if (owner?.npm) {
        attachManifests(owner.project, dir, state.subEcosystems)
        return owner
    }
    if (state.npmOn && existsFile(join(dir, 'package.json'))) {
        return startProject(state, dir, true, detectManifestsInSync(dir, dir, state.ecosystems))
    }
    if (state.manifestsOff) return owner
    if (owner) {
        attachManifests(owner.project, dir, state.subEcosystems)
        return owner
    }
    const found = detectManifestsInSync(dir, dir, state.subEcosystems)
    if (found.length === 0) return null
    return startProject(state, dir, false, found)
}

function startProject(state: WalkState, dir: string, npm: boolean, found: DetectedManifest[]): Owner {
    const project: DiscoveredProject = {
        absolutePath: dir,
        relPath: relative(state.rootPath, dir) || '.',
        name: basenameOf(dir),
        // An npm project's manager stays the JavaScript one; any other is its anchor manifest's.
        packageManager: npm ? detectPackageManager(dir) : packageManagerOfManifest(found[0]!.kind),
        nvmrcVersion: readNvmrcVersion(dir),
        gitBranch: readGitBranch(dir, state.rootPath),
        ecosystems: [],
        manifests: []
    }
    state.out.push(project)
    addManifests(project, found)
    return { project, npm }
}

function attachManifests(project: DiscoveredProject, dir: string, ecosystems: readonly EcosystemDefinition[]): void {
    addManifests(project, detectManifestsInSync(dir, project.absolutePath, ecosystems))
}

function addManifests(project: DiscoveredProject, found: DetectedManifest[]): void {
    for (const manifest of found) {
        project.manifests.push({
            path: relative(project.absolutePath, manifest.absolutePath).split(sep).join('/'),
            ecosystem: requireEcosystemId(manifest.ecosystem),
            kind: manifest.kind
        })
    }
}

// Orders the manifests independently of directory read order (which differs between filesystems): the
// project's own first, then by directory, keeping registry order within one directory. Then derives the
// ecosystems from them.
function finishProject(project: DiscoveredProject, ecosystems: readonly EcosystemDefinition[]): void {
    project.manifests.sort(function byDirectory(a, b) {
        return manifestDirOf(a.path).localeCompare(manifestDirOf(b.path))
    })
    project.ecosystems = ecosystems
        .filter(function present(eco) {
            return project.manifests.some(function ofEco(m) { return m.ecosystem === eco.id })
        })
        .map(function id(eco) { return eco.id })
}

function isNpm(eco: EcosystemDefinition): boolean {
    return eco.id === 'npm'
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
        if (rel && isWithin(rootPath, absolutePath) && (excludeMatcher.ignores(rel) || excludeMatcher.ignores(rel + '/'))) {
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

// A directory that cannot be read is walked as empty so the rest of the tree is still discovered, and
// reported, because its projects are then missing from the result rather than gone.
function readEntries(dir: string, onError: ((error: DiscoveryError) => void) | undefined): Dirent[] {
    try {
        return readdirSync(dir, { withFileTypes: true })
    } catch (error) {
        if (onError) onError({ path: dir, message: String(error) })
        return []
    }
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
