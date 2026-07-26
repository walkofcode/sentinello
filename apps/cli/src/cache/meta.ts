import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

// Where the CLI keeps its advisory cache, and what it remembers about it.
//
// This is the ONLY thing the CLI writes to disk. Nothing about the scanned code is ever persisted: no
// findings, no history, no project list, no telemetry. The cache holds public advisory data and the
// bookkeeping needed to refresh it incrementally, and deleting it costs nothing but a re-download.

// Bump when the on-disk layout changes in a way older files cannot satisfy. A mismatch discards and
// re-seeds, which is always safe here precisely because this is a cache and not a source of truth.
const CACHE_SCHEMA_VERSION = 1

export type SourceId = 'osv' | 'gemnasium'

export type SourceState = {
    // The normalizer version that produced these rows. A bump forces a re-seed, exactly as it does for the
    // portal's SQLite cache — both read the constant from @sentinello/core.
    normalizerVersion: number
    recordCount: number
    refreshedAt: number
    // OSV: the newest modified_id.csv timestamp consumed, and the ETag to replay as If-None-Match.
    cursorIso?: string | null
    etag?: string | null
    // gemnasium: the gemnasium-db commit the cache was built from.
    headSha?: string | null
}

export type CacheMeta = {
    schemaVersion: number
    // Keyed by source, then by ecosystem. The CLI scans JavaScript only today, so the inner key is always
    // 'npm' — but keying by ecosystem now means adding Python or Go later is a data change rather than a
    // migration.
    sources: Record<SourceId, Record<string, SourceState>>
}

function emptyMeta(): CacheMeta {
    return { schemaVersion: CACHE_SCHEMA_VERSION, sources: { osv: {}, gemnasium: {} } }
}

// Resolution order: explicit flag, then SENTINELLO_CACHE_DIR, then the XDG cache location, then
// ~/.cache/sentinello. Deliberately NOT the current working directory — the cache must be shared across
// every invocation from every folder, and an npx run has no durable directory of its own.
export function resolveCacheDir(override?: string | null): string {
    if (override && override.trim().length > 0) return resolve(override.trim())
    const fromEnv = process.env.SENTINELLO_CACHE_DIR
    if (fromEnv && fromEnv.trim().length > 0) return resolve(fromEnv.trim())
    const xdg = process.env.XDG_CACHE_HOME
    if (xdg && xdg.trim().length > 0) return join(resolve(xdg.trim()), 'sentinello')
    return join(homedir(), '.cache', 'sentinello')
}

export function advisoryFilePath(cacheDir: string, source: SourceId, ecosystem: string): string {
    // Ecosystem ids can contain characters that are awkward in filenames ('crates.io'), so flatten them.
    const slug = ecosystem.replace(/[^a-zA-Z0-9._-]+/g, '-')
    return join(cacheDir, source + '-' + slug + '.ndjson.gz')
}

function metaPath(cacheDir: string): string {
    return join(cacheDir, 'meta.json')
}

export async function ensureCacheDir(cacheDir: string): Promise<void> {
    await mkdir(cacheDir, { recursive: true })
}

// Reads the cache metadata, treating anything unreadable, unparseable, or from a different schema version
// as "no cache". Callers then re-seed, which is the correct response to a cache we cannot interpret.
export async function readCacheMeta(cacheDir: string): Promise<CacheMeta> {
    let text: string
    try {
        text = await readFile(metaPath(cacheDir), 'utf8')
    } catch {
        return emptyMeta()
    }
    let parsed: unknown
    try {
        parsed = JSON.parse(text)
    } catch {
        return emptyMeta()
    }
    if (!parsed || typeof parsed !== 'object') return emptyMeta()
    const meta = parsed as Partial<CacheMeta>
    if (meta.schemaVersion !== CACHE_SCHEMA_VERSION) return emptyMeta()
    const sources = meta.sources
    if (!sources || typeof sources !== 'object') return emptyMeta()
    return {
        schemaVersion: CACHE_SCHEMA_VERSION,
        sources: {
            osv: sources.osv ?? {},
            gemnasium: sources.gemnasium ?? {}
        }
    }
}

export async function writeCacheMeta(cacheDir: string, meta: CacheMeta): Promise<void> {
    await ensureCacheDir(cacheDir)
    const target = metaPath(cacheDir)
    const tmp = target + '.tmp'
    await writeFile(tmp, JSON.stringify(meta, null, 4) + '\n', 'utf8')
    await rename(tmp, target)
}

export function getSourceState(meta: CacheMeta, source: SourceId, ecosystem: string): SourceState | null {
    return meta.sources[source][ecosystem] ?? null
}

export function setSourceState(meta: CacheMeta, source: SourceId, ecosystem: string, state: SourceState): void {
    meta.sources[source][ecosystem] = state
}

// True when this (source, ecosystem) has usable rows produced by the current normalizer. Mirrors the
// portal's isSeeded gate: a cache written by an older normalizer is treated as absent rather than matched
// with the wrong semantics.
export function isSeeded(meta: CacheMeta, source: SourceId, ecosystem: string, normalizerVersion: number): boolean {
    const state = getSourceState(meta, source, ecosystem)
    if (!state) return false
    return state.normalizerVersion === normalizerVersion && state.recordCount > 0
}

export type CacheLock = {
    release(): Promise<void>
}

// A best-effort lock so two concurrent runs do not rebuild the same cache file at once. Uses exclusive
// file creation, which is atomic on every platform we target. Held only while syncing; a scan that finds
// the lock held simply reads the existing cache rather than waiting, since a slightly stale read is far
// better than blocking a developer's terminal behind someone else's 200 MB download.
export async function tryAcquireLock(cacheDir: string): Promise<CacheLock | null> {
    await ensureCacheDir(cacheDir)
    const path = join(cacheDir, '.lock')
    try {
        await writeFile(path, String(process.pid), { flag: 'wx' })
    } catch {
        // A lock left behind by a killed process would block syncing forever, so an old one is reclaimed.
        if (await isStaleLock(path)) {
            await rm(path, { force: true })
            return await tryAcquireLock(cacheDir)
        }
        return null
    }
    async function release(): Promise<void> {
        await rm(path, { force: true })
    }
    return { release }
}

const LOCK_STALE_MS = 30 * 60 * 1000

async function isStaleLock(path: string): Promise<boolean> {
    try {
        const info = await stat(path)
        return Date.now() - info.mtimeMs > LOCK_STALE_MS
    } catch {
        return false
    }
}
