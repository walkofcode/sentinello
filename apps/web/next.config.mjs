import createNextIntlPlugin from 'next-intl/plugin'

// Points at the default ./i18n/request.ts, which resolves the active locale from the NEXT_LOCALE cookie.
const withNextIntl = createNextIntlPlugin()

/** @type {import('next').NextConfig} */
const rawDevOrigins = process.env.NEXT_DEV_ORIGINS || ''
const allowedDevOrigins = rawDevOrigins
    .split(',')
    .map(function trim(origin) { return origin.trim() })
    .filter(function nonEmpty(origin) { return origin.length > 0 })

const nextConfig = {
    reactStrictMode: true,
    // Internal workspace packages are consumed as raw TypeScript source (no dist/ build step).
    // transpilePackages tells Next to compile their .ts as part of the server bundle.
    transpilePackages: ['@sentinello/core', '@sentinello/db', '@sentinello/notifications'],
    // The portal opens better-sqlite3 directly in server components; mark it external so Next
    // doesn't try to bundle the native binding. axios stays external too — no upside to bundling.
    serverExternalPackages: ['better-sqlite3', 'axios'],
    allowedDevOrigins,
    experimental: {
        // No experimental flags in v1.
    },
    typescript: {
        ignoreBuildErrors: false
    }
}

export default withNextIntl(nextConfig)
