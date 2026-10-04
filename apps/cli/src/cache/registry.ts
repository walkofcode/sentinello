import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { createMemoryRegistryStore, type RegistryRow, type RegistryStore } from '@sentinello/fixes'
import { ensureCacheDir, tryAcquireLock } from './meta'

// The CLI's npm registry cache: the store behind the same cache-first client the worker uses, kept as one
// gzipped ndjson file in the cache directory, one RegistryRow per line (D-b).
//
//   - Loaded IN FULL at run start. The way out asks for names nobody can list up front — the dependencies
//     of candidate releases and the curated replacements it discovers as it walks — so a reader filtered
//     to the installed packages would refetch those on every run, and lose their stale fallback.
//   - Saved once, at run end, under the cache lock: the file on disk is re-read and only the rows this run
//     answered are merged into it, newest answer winning per field group. Another run that saved in the
//     meantime keeps its rows; renaming a run-start snapshot over the file would drop them.
//   - A held lock skips the save. The run still answered from what it fetched; the next run refetches.
//
// It holds public package metadata only — names, versions, publish dates, download counts — never
// anything about the scanned code.

export function registryFilePath(cacheDir: string): string {
    return join(cacheDir, 'registry-npm.ndjson.gz')
}

export type FileRegistryStore = RegistryStore & {
    // The rows this run recorded an answer or a download count for, as they are now in memory.
    dirtyRows(): RegistryRow[]
}

// Unreadable or missing means empty, like the rest of the cache: it is refetched, never trusted.
async function readRows(path: string): Promise<RegistryRow[]> {
    let text: string
    try {
        text = gunzipSync(await readFile(path)).toString('utf8')
    } catch {
        return []
    }
    const rows: RegistryRow[] = []
    for (const line of text.split('\n')) {
        if (line.length === 0) continue
        const row = parseRow(line)
        if (row) rows.push(row)
    }
    return rows
}

function isTime(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value)
}

// One line, checked field by field. A line that is not a row is dropped rather than served: the client
// would otherwise treat a malformed answer as a cached one.
export function parseRow(line: string): RegistryRow | null {
    let parsed: unknown
    try {
        parsed = JSON.parse(line)
    } catch {
        return null
    }
    if (!parsed || typeof parsed !== 'object') return null
    const r = parsed as Partial<RegistryRow>
    if (typeof r.name !== 'string' || r.name.length === 0) return null
    if (r.status !== 'ok' && r.status !== 'not_found') return null
    if (r.summaryJson !== null && typeof r.summaryJson !== 'string') return null
    if (!isTime(r.checkedAt)) return null
    const downloads = isTime(r.weeklyDownloads) && isTime(r.downloadsCheckedAt)
    return {
        name: r.name,
        status: r.status,
        summaryJson: r.summaryJson,
        checkedAt: r.checkedAt,
        weeklyDownloads: downloads ? r.weeklyDownloads as number : null,
        downloadsCheckedAt: downloads ? r.downloadsCheckedAt as number : null
    }
}

export async function loadRegistryStore(cacheDir: string): Promise<FileRegistryStore> {
    const inner = createMemoryRegistryStore(await readRows(registryFilePath(cacheDir)))
    const dirty = new Set<string>()
    return {
        get: inner.get,
        put: function put(row) {
            inner.put(row)
            dirty.add(row.name)
        },
        setDownloads: function setDownloads(name, weeklyDownloads, checkedAt) {
            inner.setDownloads(name, weeklyDownloads, checkedAt)
            dirty.add(name)
        },
        dirtyRows: function dirtyRows() {
            // A count for a name with no answer is not recorded (the store's contract), so it has no row.
            return [...inner.get([...dirty]).values()]
        }
    }
}

// Per name, the newer answer wins for the answer (status, summary, checkedAt) and the newer count for the
// count. Each half is judged on its own timestamp, so a run that only refreshed a download count never
// rolls back an answer another run fetched later, and the reverse.
export function mergeRow(onDisk: RegistryRow | undefined, mine: RegistryRow): RegistryRow {
    if (!onDisk) return mine
    const answer = mine.checkedAt > onDisk.checkedAt ? mine : onDisk
    const count = (mine.downloadsCheckedAt ?? -1) > (onDisk.downloadsCheckedAt ?? -1) ? mine : onDisk
    return {
        name: mine.name,
        status: answer.status,
        summaryJson: answer.summaryJson,
        checkedAt: answer.checkedAt,
        weeklyDownloads: count.weeklyDownloads,
        downloadsCheckedAt: count.downloadsCheckedAt
    }
}

export type RegistrySaveResult = 'saved' | 'unchanged' | 'locked'

export async function saveRegistryStore(cacheDir: string, store: FileRegistryStore): Promise<RegistrySaveResult> {
    const mine = store.dirtyRows()
    if (mine.length === 0) return 'unchanged'
    await ensureCacheDir(cacheDir)
    const lock = await tryAcquireLock(cacheDir)
    if (!lock) return 'locked'
    const path = registryFilePath(cacheDir)
    const tmp = path + '.tmp'
    try {
        const merged = new Map<string, RegistryRow>()
        for (const row of await readRows(path)) merged.set(row.name, row)
        for (const row of mine) merged.set(row.name, mergeRow(merged.get(row.name), row))
        const lines = [...merged.values()].map(function encode(row) { return JSON.stringify(row) + '\n' })
        try {
            await writeFile(tmp, gzipSync(lines.join('')))
            await rename(tmp, path)
        } catch (err) {
            await rm(tmp, { force: true })
            throw err
        }
        return 'saved'
    } finally {
        await lock.release()
    }
}

export type RegistryCacheSummary = { rows: number; oldestCheckedAt: number }

// What --doctor shows: how many packages are cached and how old the oldest answer is. Null when there is
// no usable cache.
export async function registryCacheSummary(cacheDir: string): Promise<RegistryCacheSummary | null> {
    const rows = await readRows(registryFilePath(cacheDir))
    if (rows.length === 0) return null
    let oldestCheckedAt = Infinity
    for (const row of rows) oldestCheckedAt = Math.min(oldestCheckedAt, row.checkedAt)
    return { rows: rows.length, oldestCheckedAt }
}
