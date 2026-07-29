import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import createNextIntlPlugin from 'next-intl/plugin'

// Points at ./i18n/request.ts, which resolves the active locale from the URL prefix (/en, /es, …).
const withNextIntl = createNextIntlPlugin()

// Stated rather than inferred. Next walks up looking for a lockfile to call the workspace root, and a
// git worktree checked out beneath the main clone (.claude/worktrees/*) leaves two of them on that
// path — so it picks the wrong one and warns. Deriving the root from this file keeps it correct in
// any checkout, which a hardcoded path would not.
const monorepoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// Dev-only: when the dev server is reached through a tunnel (e.g. <port>.tunnel.example.com)
// instead of localhost, Next 16 blocks cross-origin requests to /_next dev resources (HMR + client
// chunks) by default. That blocks hydration, leaving the page non-interactive. Set NEXT_DEV_ORIGINS
// (comma-separated hosts) to allow them — mirrors the portal app. No effect on production builds.
const rawDevOrigins = process.env.NEXT_DEV_ORIGINS || ''
const allowedDevOrigins = rawDevOrigins
    .split(',')
    .map(function trim(origin) { return origin.trim() })
    .filter(function nonEmpty(origin) { return origin.length > 0 })

/** @type {import('next').NextConfig} */
const nextConfig = {
    reactStrictMode: true,
    turbopack: { root: monorepoRoot },
    // @sentinello/core is consumed as raw TypeScript source (no dist/ build step), so Next must
    // compile its .ts as part of the bundle.
    transpilePackages: ['@sentinello/core'],
    allowedDevOrigins,
    typescript: {
        ignoreBuildErrors: false
    }
}

export default withNextIntl(nextConfig)
