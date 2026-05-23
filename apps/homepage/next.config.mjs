import createNextIntlPlugin from 'next-intl/plugin'

// Points at ./i18n/request.ts, which resolves the active locale from the URL prefix (/en, /es, …).
const withNextIntl = createNextIntlPlugin()

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
    // @sentinello/core is consumed as raw TypeScript source (no dist/ build step), so Next must
    // compile its .ts as part of the bundle.
    transpilePackages: ['@sentinello/core'],
    allowedDevOrigins,
    typescript: {
        ignoreBuildErrors: false
    }
}

export default withNextIntl(nextConfig)
