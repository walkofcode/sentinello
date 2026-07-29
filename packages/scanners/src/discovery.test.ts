import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, describe, expect, it } from 'vitest'
import { discoverProjectsInTree, detectEcosystems, detectPackageManager, readGitBranch } from './discovery'
import type { DiscoverySkip } from './discovery'

// Fixture trees are built at runtime from the specs below rather than committed as files, for two
// reasons that leave no choice:
//   - a committed .gitignore inside a fixture applies to THIS repository, so git would refuse to
//     track the very files the test needs to prove are discoverable;
//   - a committed .git directory is impossible — git treats a nested one as a submodule.
// The fixtures are still hand-written, frozen and offline; they just live as data rather than files.

const PKG = JSON.stringify({ name: 'fixture', version: '1.0.0' })

const created: string[] = []

async function makeTree(spec: Record<string, string>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'sentinello-discovery-'))
    created.push(root)
    for (const [relPath, content] of Object.entries(spec)) {
        const full = join(root, relPath)
        await mkdir(dirname(full), { recursive: true })
        await writeFile(full, content)
    }
    return root
}

afterAll(async function cleanup() {
    for (const dir of created) {
        await rm(dir, { recursive: true, force: true })
    }
})

function relPaths(root: string, options: Record<string, unknown> = {}): string[] {
    return discoverProjectsInTree({ rootPath: root, ...options })
        .map(function toRel(p) {
            return p.relPath
        })
        .sort()
}

describe('discoverProjectsInTree — what counts as a project', function () {
    it('reports the root itself as "." when the root carries a manifest', async function () {
        const root = await makeTree({ 'package.json': PKG })
        expect(relPaths(root)).toEqual(['.'])
    })

    it('finds projects nested at several depths', async function () {
        const root = await makeTree({
            'apps/web/package.json': PKG,
            'apps/api/package.json': PKG,
            'packages/deep/nested/lib/package.json': PKG
        })
        expect(relPaths(root)).toEqual(['apps/api', 'apps/web', 'packages/deep/nested/lib'])
    })

    it('returns nothing for a tree with no manifests', async function () {
        const root = await makeTree({ 'docs/readme.md': '# hi' })
        expect(relPaths(root)).toEqual([])
    })

    it('returns nothing for a root that does not exist', function () {
        expect(discoverProjectsInTree({ rootPath: '/definitely/not/here' })).toEqual([])
    })

    // Projects do not nest: a monorepo root is ONE project, which is also how pnpm audit sees it.
    it('stops descending once a directory is itself a project', async function () {
        const root = await makeTree({
            'package.json': PKG,
            'packages/inner/package.json': PKG
        })
        expect(relPaths(root)).toEqual(['.'])
    })

    it('never descends into node_modules or .git', async function () {
        const root = await makeTree({
            'app/package.json': PKG,
            'node_modules/evil/package.json': PKG,
            '.git/hooks/package.json': PKG
        })
        expect(relPaths(root)).toEqual(['app'])
    })
})

describe('discoverProjectsInTree — ignore files', function () {
    it('honours a .gitignore', async function () {
        const root = await makeTree({
            '.gitignore': 'vendor/\n',
            'app/package.json': PKG,
            'vendor/thing/package.json': PKG
        })
        expect(relPaths(root)).toEqual(['app'])
    })

    it('honours a .sentinelloignore', async function () {
        const root = await makeTree({
            '.sentinelloignore': 'scratch/\n',
            'app/package.json': PKG,
            'scratch/thing/package.json': PKG
        })
        expect(relPaths(root)).toEqual(['app'])
    })

    // The load-bearing case. The two files are composed into ONE matcher precisely so a negation in
    // .sentinelloignore can re-include something .gitignore excluded. Keeping them as separate
    // layers (where "ignored by any layer" wins) would make this escape hatch silently not exist.
    it('lets a .sentinelloignore negation re-include a .gitignore exclusion', async function () {
        const root = await makeTree({
            '.gitignore': 'vendor/\n',
            '.sentinelloignore': '!vendor/\n',
            'vendor/thing/package.json': PKG
        })
        expect(relPaths(root)).toEqual(['vendor/thing'])
    })

    // The negation escape hatch is DIRECTORY-LOCAL. Composition happens per directory, and
    // classifySkip walks outward past any layer that does not match — so a bare negation in a
    // nested .sentinelloignore matches nothing in its own layer, and the outer .gitignore still
    // wins. Worth knowing: re-including a subtree requires the negation to sit beside the
    // .gitignore that excluded it, not beside the thing being re-included.
    it('does not let a nested negation override an outer .gitignore', async function () {
        const root = await makeTree({
            '.gitignore': 'build/\n',
            'app/.sentinelloignore': '!build/\n',
            'app/build/package.json': PKG
        })
        expect(relPaths(root)).toEqual([])
    })

    it('re-includes when the negation sits beside the .gitignore that excluded it', async function () {
        const root = await makeTree({
            'app/.gitignore': 'build/\n',
            'app/.sentinelloignore': '!build/\n',
            'app/build/package.json': PKG
        })
        expect(relPaths(root)).toEqual(['app/build'])
    })

    it('applies an ignore file only to its own subtree', async function () {
        const root = await makeTree({
            'a/.gitignore': 'skipme/\n',
            'a/skipme/package.json': PKG,
            'b/skipme/package.json': PKG
        })
        expect(relPaths(root)).toEqual(['b/skipme'])
    })
})

describe('discoverProjectsInTree — explicit excludes', function () {
    it('skips a directory matched by an exclude pattern', async function () {
        const root = await makeTree({
            'app/package.json': PKG,
            'tmp/thing/package.json': PKG
        })
        expect(relPaths(root, { excludes: ['tmp/'] })).toEqual(['app'])
    })

    // Excludes are rooted at the WALK ROOT, not at whichever directory happens to be in scope.
    it('roots exclude patterns at the walk root', async function () {
        const root = await makeTree({
            'deep/one/package.json': PKG,
            'other/one/package.json': PKG
        })
        expect(relPaths(root, { excludes: ['deep/one'] })).toEqual(['other/one'])
    })

    // The operator is speaking directly, so unlike ignore FILES an exclude cannot be negated.
    it('cannot be negated by a deeper .sentinelloignore', async function () {
        const root = await makeTree({
            '.sentinelloignore': '!tmp/\n',
            'tmp/thing/package.json': PKG
        })
        expect(relPaths(root, { excludes: ['tmp/'] })).toEqual([])
    })
})

describe('discoverProjectsInTree — maxDepth', function () {
    it('examines only the root at depth 0', async function () {
        const root = await makeTree({ 'app/package.json': PKG })
        expect(relPaths(root, { maxDepth: 0 })).toEqual([])
    })

    it('finds a root project even at depth 0', async function () {
        const root = await makeTree({ 'package.json': PKG })
        expect(relPaths(root, { maxDepth: 0 })).toEqual(['.'])
    })

    it('descends exactly the requested number of levels', async function () {
        const root = await makeTree({
            'a/package.json': PKG,
            'b/c/package.json': PKG,
            'd/e/f/package.json': PKG
        })
        expect(relPaths(root, { maxDepth: 1 })).toEqual(['a'])
        expect(relPaths(root, { maxDepth: 2 })).toEqual(['a', 'b/c'])
        expect(relPaths(root, { maxDepth: 3 })).toEqual(['a', 'b/c', 'd/e/f'])
    })

    it('treats null as unlimited', async function () {
        const root = await makeTree({ 'd/e/f/package.json': PKG })
        expect(relPaths(root, { maxDepth: null })).toEqual(['d/e/f'])
    })
})

describe('discoverProjectsInTree — skip reporting', function () {
    // "Sentinello found nothing" must never be indistinguishable from "Sentinello skipped it".
    async function skipsFor(spec: Record<string, string>, options: Record<string, unknown> = {}) {
        const root = await makeTree(spec)
        const skips: DiscoverySkip[] = []
        discoverProjectsInTree({
            rootPath: root,
            ...options,
            onSkip: function record(skip) {
                skips.push(skip)
            }
        })
        return skips
    }

    it('attributes a skip to gitignore', async function () {
        const skips = await skipsFor({ '.gitignore': 'vendor/\n', 'vendor/x/package.json': PKG })
        expect(skips).toHaveLength(1)
        expect(skips[0]?.source).toBe('gitignore')
        expect(skips[0]?.path.endsWith('/vendor')).toBe(true)
    })

    it('attributes a skip to sentinelloignore when only that file contributed', async function () {
        const skips = await skipsFor({ '.sentinelloignore': 'vendor/\n', 'vendor/x/package.json': PKG })
        expect(skips[0]?.source).toBe('sentinelloignore')
    })

    it('attributes a skip to excludes', async function () {
        const skips = await skipsFor({ 'tmp/x/package.json': PKG }, { excludes: ['tmp/'] })
        expect(skips[0]?.source).toBe('excludes')
    })

    // Composed rules cannot say which file matched, so the more surprising source is reported.
    it('attributes to gitignore when both files contributed', async function () {
        const skips = await skipsFor({
            '.gitignore': 'vendor/\n',
            '.sentinelloignore': 'other/\n',
            'vendor/x/package.json': PKG
        })
        expect(skips[0]?.source).toBe('gitignore')
    })

    it('reports no skips for a clean tree', async function () {
        expect(await skipsFor({ 'app/package.json': PKG })).toEqual([])
    })
})

describe('discoverProjectsInTree — project metadata', function () {
    it('reads the package manager from the lockfile', async function () {
        const root = await makeTree({ 'package.json': PKG, 'pnpm-lock.yaml': 'lockfileVersion: 9\n' })
        expect(discoverProjectsInTree({ rootPath: root })[0]?.packageManager).toBe('pnpm')
    })

    it('reports an unknown package manager for a manifest with no lockfile', async function () {
        const root = await makeTree({ 'package.json': PKG })
        expect(discoverProjectsInTree({ rootPath: root })[0]?.packageManager).toBe('unknown')
    })

    it('reads the nvmrc version, trimmed', async function () {
        const root = await makeTree({ 'package.json': PKG, '.nvmrc': '  24.14.0  \n' })
        expect(discoverProjectsInTree({ rootPath: root })[0]?.nvmrcVersion).toBe('24.14.0')
    })

    it('reports a null nvmrc version when absent or blank', async function () {
        const absent = await makeTree({ 'package.json': PKG })
        expect(discoverProjectsInTree({ rootPath: absent })[0]?.nvmrcVersion).toBeNull()
        const blank = await makeTree({ 'package.json': PKG, '.nvmrc': '   \n' })
        expect(discoverProjectsInTree({ rootPath: blank })[0]?.nvmrcVersion).toBeNull()
    })

    it('names the project after its directory basename', async function () {
        const root = await makeTree({ 'apps/web/package.json': PKG })
        expect(discoverProjectsInTree({ rootPath: root })[0]?.name).toBe('web')
    })
})

describe('detectEcosystems and detectPackageManager', function () {
    it('detects npm from package.json alone', async function () {
        const root = await makeTree({ 'package.json': PKG })
        expect(detectEcosystems(root)).toContain('npm')
    })

    it('detects a non-npm ecosystem from its resolver manifest', async function () {
        const root = await makeTree({ 'Cargo.lock': '[[package]]\n' })
        expect(detectEcosystems(root)).toContain('crates.io')
    })

    it('detects several ecosystems in one directory', async function () {
        const root = await makeTree({ 'package.json': PKG, 'go.mod': 'module x\n' })
        const ecosystems = detectEcosystems(root)
        expect(ecosystems).toContain('npm')
        expect(ecosystems).toContain('Go')
    })

    it('reports no ecosystems for a plain directory', async function () {
        const root = await makeTree({ 'readme.md': '# hi' })
        expect(detectEcosystems(root)).toEqual([])
    })

    // npm wins because LOCKFILE_TO_PM is checked in declaration order.
    it('prefers pnpm over npm when both lockfiles exist', async function () {
        const root = await makeTree({ 'package.json': PKG, 'pnpm-lock.yaml': '', 'package-lock.json': '{}' })
        expect(detectPackageManager(root)).toBe('pnpm')
    })
})

describe('readGitBranch', function () {
    // Read straight off the filesystem — the runtime image carries no git binary and roots are
    // mounted read-only, so shelling out is not an option.
    it('reads an attached HEAD', async function () {
        const root = await makeTree({ 'package.json': PKG, '.git/HEAD': 'ref: refs/heads/main\n' })
        expect(readGitBranch(root, root)).toBe('main')
    })

    it('keeps slashes in a branch name', async function () {
        const root = await makeTree({ '.git/HEAD': 'ref: refs/heads/feat/some/thing\n' })
        expect(readGitBranch(root, root)).toBe('feat/some/thing')
    })

    it('shortens a detached HEAD to seven characters', async function () {
        const root = await makeTree({ '.git/HEAD': '0123456789abcdef0123456789abcdef01234567\n' })
        expect(readGitBranch(root, root)).toBe('0123456')
    })

    it('follows a gitdir pointer file, as used by worktrees and submodules', async function () {
        const root = await makeTree({
            'real/HEAD': 'ref: refs/heads/worktree-branch\n',
            'checkout/.git': 'gitdir: ../real\n'
        })
        expect(readGitBranch(join(root, 'checkout'), root)).toBe('worktree-branch')
    })

    // A project can be a package inside a repository rather than the repository root.
    it('walks up to find the repository root', async function () {
        const root = await makeTree({ '.git/HEAD': 'ref: refs/heads/main\n', 'apps/web/package.json': PKG })
        expect(readGitBranch(join(root, 'apps/web'), root)).toBe('main')
    })

    it('does not walk above the scan root', async function () {
        const root = await makeTree({ '.git/HEAD': 'ref: refs/heads/main\n', 'apps/web/package.json': PKG })
        expect(readGitBranch(join(root, 'apps/web'), join(root, 'apps'))).toBeNull()
    })

    // Not a git checkout is a normal state, not an error.
    it('returns null for a directory that is not a checkout', async function () {
        const root = await makeTree({ 'package.json': PKG })
        expect(readGitBranch(root, root)).toBeNull()
    })

    it('returns null for an unreadable or unrecognised HEAD', async function () {
        const root = await makeTree({ '.git/HEAD': 'garbage\n' })
        expect(readGitBranch(root, root)).toBeNull()
    })
})

describe('readGitBranch — the remaining git layouts', function () {
    // A .git FILE rather than a directory is how worktrees and submodules store their pointer, and
    // every one of these malformed spellings has to degrade to null rather than throw out of a
    // discovery sweep that is otherwise fine.
    it('returns null when the gitdir pointer has no target', async function () {
        const root = await makeTree({ 'checkout/.git': 'gitdir:\n' })
        expect(readGitBranch(join(root, 'checkout'), root)).toBeNull()
    })

    it('returns null when the .git file is not a gitdir pointer at all', async function () {
        const root = await makeTree({ 'checkout/.git': 'this is not a pointer\n' })
        expect(readGitBranch(join(root, 'checkout'), root)).toBeNull()
    })

    // The pointer resolved, but the directory it names has no HEAD — a half-removed worktree.
    it('returns null when the pointer target has no HEAD', async function () {
        const root = await makeTree({ 'real/config': '[core]\n', 'checkout/.git': 'gitdir: ../real\n' })
        expect(readGitBranch(join(root, 'checkout'), root)).toBeNull()
    })

    // A .git file whose pointer is unusable must not stop the walk: an outer repository above it is
    // still the right answer.
    it('keeps walking up past an unusable .git pointer', async function () {
        const root = await makeTree({
            '.git/HEAD': 'ref: refs/heads/outer\n',
            'nested/.git': 'not a pointer\n',
            'nested/package.json': PKG
        })
        expect(readGitBranch(join(root, 'nested'), root)).toBe('outer')
    })

    it('trims whitespace around a branch name', async function () {
        const root = await makeTree({ '.git/HEAD': 'ref: refs/heads/  main  \n' })
        expect(readGitBranch(root, root)).toBe('main')
    })

    // "ref: refs/heads/" with nothing after it: the capture group matches an empty-ish string, and
    // the result has to be null rather than an empty branch name rendered as a blank chip.
    it('returns null for a ref with no branch name', async function () {
        const root = await makeTree({ '.git/HEAD': 'ref: refs/heads/   \n' })
        expect(readGitBranch(root, root)).toBeNull()
    })

    it('returns null for a sha of the wrong length', async function () {
        const root = await makeTree({ '.git/HEAD': '0123456\n' })
        expect(readGitBranch(root, root)).toBeNull()
    })

    // The scan root is not an ancestor of the project at all — the walk must terminate rather than
    // climbing to the filesystem root looking for a stop that never comes.
    it('terminates when the scan root is not an ancestor', async function () {
        const root = await makeTree({ 'a/package.json': PKG, 'b/x': 'x' })
        expect(readGitBranch(join(root, 'a'), join(root, 'b'))).toBeNull()
    })
})

describe('discoverProjectsInTree — unreadable paths', function () {
    // Discovery walks read-only mounts it does not control. A directory it cannot enumerate has to
    // yield nothing and let the sweep continue, because the alternative is one bad permission
    // aborting the scan of every other project under the same root.
    it('treats an unreadable directory as empty rather than failing the sweep', async function () {
        const { chmod } = await import('node:fs/promises')
        const root = await makeTree({ 'good/package.json': PKG, 'locked/keep': 'x' })
        await chmod(join(root, 'locked'), 0o000)
        try {
            expect(discoverProjectsInTree({ rootPath: root }).map(function rel(p) { return p.relPath })).toEqual(['good'])
        } finally {
            await chmod(join(root, 'locked'), 0o755)
        }
    })

    // An unreadable ignore file is the same story: fall back to "no rules from this layer" instead of
    // throwing, so a permissions problem cannot silently un-discover a whole subtree either.
    it('ignores an unreadable ignore file', async function () {
        const { chmod } = await import('node:fs/promises')
        const root = await makeTree({ '.gitignore': 'good\n', 'good/package.json': PKG })
        await chmod(join(root, '.gitignore'), 0o000)
        try {
            expect(discoverProjectsInTree({ rootPath: root }).map(function rel(p) { return p.relPath })).toEqual(['good'])
        } finally {
            await chmod(join(root, '.gitignore'), 0o644)
        }
    })

    it('reads no nvmrc version from an unreadable .nvmrc', async function () {
        const { chmod, mkdir, writeFile } = await import('node:fs/promises')
        const root = await makeTree({ 'app/package.json': PKG })
        await mkdir(join(root, 'app'), { recursive: true })
        await writeFile(join(root, 'app', '.nvmrc'), '20.0.0\n', 'utf8')
        await chmod(join(root, 'app', '.nvmrc'), 0o000)
        try {
            expect(discoverProjectsInTree({ rootPath: root })[0]?.nvmrcVersion).toBeNull()
        } finally {
            await chmod(join(root, 'app', '.nvmrc'), 0o644)
        }
    })

    it('reads no nvmrc version from a blank .nvmrc', async function () {
        const root = await makeTree({ 'app/package.json': PKG, 'app/.nvmrc': '   \n' })
        expect(discoverProjectsInTree({ rootPath: root })[0]?.nvmrcVersion).toBeNull()
    })
})
