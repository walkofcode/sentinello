import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

// Fails loudly when apps/web/.next is older than the sources it was built from.
//
// This exists because `pnpm test:e2e` does not build, and `next start` will happily serve whatever is
// in .next from the last build. A MISSING build fails obviously ("Could not find a production
// build"); a STALE one passes silently, and you spend the afternoon wondering why your change has no
// effect. CI builds as its own step so this is quiet there — it is a local footgun, and this turns it
// into one line naming the file.
//
// Same class of problem as the seeded-database guard in global-setup.ts, which was itself written
// after a green run on stale state.

const SKIP = new Set(['node_modules', '.next', '.turbo', '.git', 'dist', 'coverage'])

// apps/web sources, plus the workspace packages next.config.mjs lists in transpilePackages — those
// are consumed as raw TypeScript, so a change in them is compiled into .next too.
function watchedPaths(repoRoot: string): string[] {
    const web = join(repoRoot, 'apps', 'web')
    return [
        join(web, 'app'),
        join(web, 'components'),
        join(web, 'lib'),
        join(web, 'i18n'),
        join(web, 'messages'),
        join(web, 'proxy.ts'),
        join(web, 'next.config.mjs'),
        join(web, 'package.json'),
        join(repoRoot, 'packages', 'core', 'src'),
        join(repoRoot, 'packages', 'db', 'src'),
        join(repoRoot, 'packages', 'notifications', 'src')
    ]
}

function newestUnder(path: string): { path: string; mtimeMs: number } | null {
    if (!existsSync(path)) return null
    const stat = statSync(path)
    if (!stat.isDirectory()) return { path, mtimeMs: stat.mtimeMs }
    let newest: { path: string; mtimeMs: number } | null = null
    for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (SKIP.has(entry.name)) continue
        const child = newestUnder(join(path, entry.name))
        if (child && (!newest || child.mtimeMs > newest.mtimeMs)) newest = child
    }
    return newest
}

export function assertFreshBuild(repoRoot: string): void {
    const buildId = resolve(repoRoot, 'apps', 'web', '.next', 'BUILD_ID')
    if (!existsSync(buildId)) {
        throw new Error(
            '[e2e] no production build at apps/web/.next. The suite runs `next start`, not the dev ' +
            'server, so what is exercised is what ships. Run: pnpm --filter @sentinello/web build'
        )
    }
    const builtAt = statSync(buildId).mtimeMs
    for (const path of watchedPaths(repoRoot)) {
        const newest = newestUnder(path)
        if (newest && newest.mtimeMs > builtAt) {
            throw new Error(
                '[e2e] apps/web/.next is STALE — ' + newest.path.replace(repoRoot + '/', '') +
                ' was modified ' + Math.round((newest.mtimeMs - builtAt) / 1000) + 's after the build. ' +
                'next start would serve the previous build and your change would appear to do nothing. ' +
                'Run: pnpm test:e2e:fresh (or pnpm --filter @sentinello/web build first)'
            )
        }
    }
}
