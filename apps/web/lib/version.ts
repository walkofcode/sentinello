import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { getConfigValue } from '@sentinello/db'
import { getDb } from '@/lib/db'

// Source of truth for the version shown in the UI footer and /api/health, plus the
// update-check that powers the "v0.2.0 available" footer badge.
//
// Version resolution order:
//   1. process.env.SENTINELLO_VERSION   ← baked in by the Docker image at build time
//   2. root package.json#version         ← dev fallback (pnpm dev); walks up from cwd
//   3. literal 'dev'                     ← last resort (e.g. standalone bundle without env)
//
// Update-check: caches the GitHub Releases lookup for UPDATE_TTL_OK (6h) on success and
// UPDATE_TTL_ERR (15min) on failure so a transient GH outage doesn't lock us out for 6 hours.

const DEFAULT_FEED_URL = 'https://api.github.com/repos/walkofcode/sentinello/releases/latest'
const UPDATE_TTL_OK = 6 * 60 * 60 * 1000
const UPDATE_TTL_ERR = 15 * 60 * 1000
const REQUEST_TIMEOUT_MS = 5000

export type VersionSource = 'github' | 'cache' | 'disabled' | 'error' | 'dev-fallback'

export type VersionInfo = {
    current: string
    latest: string | null
    updateAvailable: boolean
    releaseUrl: string | null
    checkedAt: string
    source: VersionSource
    error?: string
}

let cachedVersion: string | null = null
let cachedInfo: { data: VersionInfo; expiresAt: number } | null = null

function parseSegment(s: string): number {
    const n = parseInt(s, 10)
    return Number.isFinite(n) && n || 0
}

function stripVPrefix(s: string): string {
    return s.startsWith('v') && s.slice(1) || s
}

function compareSemVer(a: string, b: string): number {
    const pa = stripVPrefix(a).split('-')[0].split('.').map(parseSegment)
    const pb = stripVPrefix(b).split('-')[0].split('.').map(parseSegment)
    const len = Math.max(pa.length, pb.length)
    for (let i = 0; i < len; i++) {
        const da = pa[i] || 0
        const db = pb[i] || 0
        if (da > db) return 1
        if (da < db) return -1
    }
    return 0
}

function findRootPackageVersion(): string | null {
    let dir = process.cwd()
    while (true) {
        const pj = resolve(dir, 'package.json')
        if (existsSync(pj)) {
            try {
                const pkg = JSON.parse(readFileSync(pj, 'utf8')) as { name?: string; version?: string }
                if (pkg.name === 'sentinello' && pkg.version) return pkg.version
            } catch {
                // fall through and keep walking
            }
        }
        const parent = dirname(dir)
        if (parent === dir) return null
        dir = parent
    }
}

export function getCurrentVersion(): string {
    if (cachedVersion) return cachedVersion
    const fromEnv = process.env.SENTINELLO_VERSION
    if (fromEnv && fromEnv.trim()) {
        cachedVersion = fromEnv.trim()
        return cachedVersion
    }
    const fromPkg = findRootPackageVersion()
    cachedVersion = fromPkg || 'dev'
    return cachedVersion
}

function readUpdateChecksEnabled(): boolean {
    try {
        const db = getDb()
        const flag = getConfigValue<boolean>(db, 'update_checks_enabled')
        // Default ON when the key has never been set.
        return flag !== false
    } catch {
        return true
    }
}

function buildDisabled(): VersionInfo {
    return {
        current: getCurrentVersion(),
        latest: null,
        updateAvailable: false,
        releaseUrl: null,
        checkedAt: new Date().toISOString(),
        source: 'disabled'
    }
}

type GhRelease = {
    tag_name?: string
    html_url?: string
    name?: string
    draft?: boolean
    prerelease?: boolean
}

async function fetchLatestRelease(feedUrl: string): Promise<GhRelease> {
    const res = await fetch(feedUrl, {
        headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'sentinello-update-check'
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    if (!res.ok) {
        throw new Error('github ' + res.status + ' ' + res.statusText)
    }
    return await res.json() as GhRelease
}

export async function getVersionInfo(): Promise<VersionInfo> {
    const current = getCurrentVersion()
    const envFeed = process.env.SENTINELLO_UPDATE_FEED_URL
    if (envFeed === 'off') return buildDisabled()
    if (!readUpdateChecksEnabled()) return buildDisabled()

    const now = Date.now()
    if (cachedInfo && cachedInfo.expiresAt > now) {
        return { ...cachedInfo.data, source: 'cache' }
    }

    const feedUrl = envFeed && envFeed.trim() || DEFAULT_FEED_URL
    try {
        const release = await fetchLatestRelease(feedUrl)
        const latestRaw = release.tag_name || ''
        const latest = stripVPrefix(latestRaw) || null
        const updateAvailable = latest !== null && compareSemVer(current, latest) < 0
        const info: VersionInfo = {
            current,
            latest,
            updateAvailable,
            releaseUrl: release.html_url || null,
            checkedAt: new Date().toISOString(),
            source: 'github'
        }
        cachedInfo = { data: info, expiresAt: now + UPDATE_TTL_OK }
        return info
    } catch (err) {
        const info: VersionInfo = {
            current,
            latest: null,
            updateAvailable: false,
            releaseUrl: null,
            checkedAt: new Date().toISOString(),
            source: 'error',
            error: err instanceof Error && err.message || 'unknown update-check error'
        }
        cachedInfo = { data: info, expiresAt: now + UPDATE_TTL_ERR }
        return info
    }
}
