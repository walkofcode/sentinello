import { statfs } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import axios from 'axios'
import yaml from 'js-yaml'
import unzipper from 'unzipper'
import {
    ECOSYSTEMS,
    GEMNASIUM_REQUIRED_FREE_BYTES,
    GEMNASIUM_SEED_DOWNLOAD_BYTES
} from '@sentinello/core'
import {
    GEMNASIUM_META_KEYS,
    GEMNASIUM_NORMALIZER_VERSION,
    countGemnasiumAdvisories,
    deleteGemnasiumAdvisoriesExcept,
    gemnasiumRowKeyFor,
    resolveGemnasiumDbPath,
    setGemnasiumMeta,
    upsertGemnasiumAdvisories,
    type GemnasiumAdvisoryRow,
    type GemnasiumDrizzleDb
} from '@sentinello/db'
import { normalizeGemnasiumRecord } from './gemnasium-normalize'

// Full URL of the GitLab gemnasium-db archive (a zip of the repo at HEAD). Overridable for tests/mirrors;
// set to 'off' to hard-disable network access (the sync becomes a no-op and the scanner stays unseeded).
const DEFAULT_ARCHIVE_URL =
    'https://gitlab.com/gitlab-org/security-products/gemnasium-db/-/archive/master/gemnasium-db-master.zip'

function feedUrl(): string {
    const fromEnv = process.env.SENTINELLO_GEMNASIUM_FEED_URL
    if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim()
    return DEFAULT_ARCHIVE_URL
}

export function gemnasiumFeedDisabled(): boolean {
    return feedUrl().toLowerCase() === 'off'
}

export type GemnasiumSyncResult = {
    status: 'ok' | 'skipped' | 'error'
    upserted: number
    recordCount: number
    message: string | null
}

// Free-space pre-flight against the directory that will hold gemnasium.db. Mirrors checkOsvFreeSpace.
export async function checkGemnasiumFreeSpace(): Promise<{ freeBytes: number; sufficient: boolean }> {
    const dir = dirname(resolveGemnasiumDbPath())
    try {
        const stats = await statfs(dir)
        const freeBytes = Number(stats.bavail) * Number(stats.bsize)
        return { freeBytes, sufficient: freeBytes >= GEMNASIUM_REQUIRED_FREE_BYTES }
    } catch {
        // If we can't stat the volume, don't block — but report 0 so the UI shows "unknown".
        return { freeBytes: 0, sufficient: true }
    }
}

// Map of gemnasium package-type directory name (e.g. 'npm', 'pypi', 'go', 'cargo') → registry ecosystem id
// ('npm', 'PyPI', 'Go', 'crates.io'), derived from the central registry so adding a language is a registry
// edit, never a change here. The sync parses ONLY the directories we have a resolver + comparator for;
// other gemnasium ecosystems (maven, gem, packagist, …) are skipped until their language ships.
const PACKAGE_TYPE_TO_ECOSYSTEM: Record<string, string> = (function buildMap() {
    const map: Record<string, string> = {}
    for (const eco of ECOSYSTEMS) map[eco.gemnasiumPackageType] = eco.id
    return map
})()

// gemnasium-db has no per-advisory delta feed, so every sync re-downloads the whole archive and rebuilds
// the cache. We stream the zip, resolve each entry's package-type directory to a registry ecosystem,
// normalize the *.yml, batch-upsert, then purge any advisory not seen this pass (so upstream deletions
// don't linger). The purge runs ONLY after the full stream succeeds, so a failed/partial download never
// empties the cache. On success sets seedComplete + the archive's Last-Modified cursor.
export async function syncGemnasium(db: GemnasiumDrizzleDb, abortSignal?: AbortSignal): Promise<GemnasiumSyncResult> {
    if (gemnasiumFeedDisabled()) {
        return { status: 'skipped', upserted: 0, recordCount: countGemnasiumAdvisories(db), message: 'feed disabled' }
    }
    const space = await checkGemnasiumFreeSpace()
    if (!space.sufficient) {
        const message =
            'insufficient free space for gemnasium seed: need ~' +
            mib(GEMNASIUM_REQUIRED_FREE_BYTES) +
            ' MiB, have ' +
            mib(space.freeBytes) +
            ' MiB'
        setGemnasiumMeta(db, GEMNASIUM_META_KEYS.lastError, message)
        return { status: 'error', upserted: 0, recordCount: countGemnasiumAdvisories(db), message }
    }
    let response
    try {
        response = await axios.get(feedUrl(), {
            responseType: 'stream',
            signal: abortSignal,
            timeout: 10 * 60 * 1000,
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        })
    } catch (err) {
        const message = 'gemnasium archive download failed: ' + errText(err)
        setGemnasiumMeta(db, GEMNASIUM_META_KEYS.lastError, message)
        return { status: 'error', upserted: 0, recordCount: countGemnasiumAdvisories(db), message }
    }
    const lastModified = typeof response.headers['last-modified'] === 'string' ? response.headers['last-modified'] : null
    let upserted = 0
    const seenRowKeys = new Set<string>()
    const batch: GemnasiumAdvisoryRow[] = []
    const BATCH_SIZE = 2000
    try {
        const zip = (response.data as Readable).pipe(unzipper.Parse({ forceStream: true }))
        for await (const entry of zip) {
            if (abortSignal && abortSignal.aborted) {
                entry.autodrain()
                throw new Error('aborted')
            }
            const cell = advisoryPathEcosystem(String(entry.path))
            if (entry.type !== 'File' || !cell) {
                entry.autodrain()
                continue
            }
            const content = await entry.buffer()
            const rows = parseEntry(content, cell.ecosystem, cell.slugPrefix)
            for (const row of rows) {
                seenRowKeys.add(gemnasiumRowKeyFor(row.advisoryId, row.ecosystem, row.packageName))
                batch.push(row)
            }
            if (batch.length >= BATCH_SIZE) {
                upsertGemnasiumAdvisories(db, batch)
                upserted += batch.length
                batch.length = 0
            }
        }
        if (batch.length > 0) {
            upsertGemnasiumAdvisories(db, batch)
            upserted += batch.length
            batch.length = 0
        }
    } catch (err) {
        const message = 'gemnasium archive parse failed after ' + upserted + ' rows: ' + errText(err)
        setGemnasiumMeta(db, GEMNASIUM_META_KEYS.lastError, message)
        return { status: 'error', upserted, recordCount: countGemnasiumAdvisories(db), message }
    }
    // Full pass succeeded — safe to purge advisories that disappeared upstream.
    const purged = deleteGemnasiumAdvisoriesExcept(db, seenRowKeys)
    const recordCount = countGemnasiumAdvisories(db)
    setGemnasiumMeta(db, GEMNASIUM_META_KEYS.seedComplete, true)
    setGemnasiumMeta(db, GEMNASIUM_META_KEYS.normalizerVersion, GEMNASIUM_NORMALIZER_VERSION)
    setGemnasiumMeta(db, GEMNASIUM_META_KEYS.recordCount, recordCount)
    setGemnasiumMeta(db, GEMNASIUM_META_KEYS.refreshedAt, Date.now())
    setGemnasiumMeta(db, GEMNASIUM_META_KEYS.lastError, null)
    if (lastModified) setGemnasiumMeta(db, GEMNASIUM_META_KEYS.lastModified, lastModified)
    console.log('[gemnasium-sync] sync complete: ' + recordCount + ' advisory rows (' + purged + ' stale purged)')
    return { status: 'ok', upserted, recordCount, message: null }
}

// The archive nests everything under a top folder (e.g. "gemnasium-db-master/"); a real advisory path is
// "<root>/<packageType>/<package>/<id>.yml". Resolve the package-type segment to a supported registry
// ecosystem; return null (skip) for non-advisory paths or ecosystems we don't yet scan. The `slugPrefix`
// (e.g. "pypi/") is what the normalizer strips off `package_slug` to recover the package name.
function advisoryPathEcosystem(path: string): { ecosystem: string; slugPrefix: string } | null {
    if (!path.endsWith('.yml') && !path.endsWith('.yaml')) return null
    const segments = path.split('/')
    // [root, packageType, ...packageName, id.yml] — need the type segment and at least a package + file.
    if (segments.length < 4) return null
    const packageType = segments[1]
    if (!packageType) return null
    const ecosystem = PACKAGE_TYPE_TO_ECOSYSTEM[packageType]
    if (!ecosystem) return null
    return { ecosystem, slugPrefix: packageType + '/' }
}

function parseEntry(content: Buffer, ecosystem: string, slugPrefix: string): GemnasiumAdvisoryRow[] {
    let parsed: unknown
    try {
        parsed = yaml.load(content.toString('utf8'))
    } catch {
        return []
    }
    return normalizeGemnasiumRecord(parsed, ecosystem, slugPrefix)
}

function mib(bytes: number): string {
    return Math.round(bytes / (1024 * 1024)).toString()
}

function errText(err: unknown): string {
    return (err instanceof Error && err.message) || String(err)
}

// Exposed so the runtime can show the expected download footprint before a seed.
export { GEMNASIUM_SEED_DOWNLOAD_BYTES }
