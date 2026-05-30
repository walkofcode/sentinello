import { statfs } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import axios from 'axios'
import unzipper from 'unzipper'
import {
    OSV_REQUIRED_FREE_BYTES,
    OSV_SEED_DOWNLOAD_BYTES
} from '@sentinello/core'
import {
    OSV_META_KEYS,
    countOsvAdvisories,
    deleteOsvAdvisories,
    getOsvMeta,
    resolveOsvDbPath,
    setOsvMeta,
    upsertOsvAdvisories,
    type OsvAdvisoryRow,
    type OsvDrizzleDb
} from '@sentinello/db'
import { normalizeOsvRecord } from './osv-normalize'

// Base URL of the OSV GCS export bucket. Overridable for tests / mirrors; set to 'off' to hard-disable
// any network access (the seed/sync becomes a no-op and the scanner just never gets seeded).
const DEFAULT_FEED_BASE = 'https://osv-vulnerabilities.storage.googleapis.com'
const NPM_ALL_ZIP = '/npm/all.zip'

function feedBase(): string {
    const fromEnv = process.env.SENTINELLO_OSV_FEED_URL
    if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim()
    return DEFAULT_FEED_BASE
}

export function osvFeedDisabled(): boolean {
    return feedBase().toLowerCase() === 'off'
}

export type OsvSyncResult = {
    status: 'ok' | 'skipped' | 'error'
    upserted: number
    recordCount: number
    message: string | null
}

// Free-space pre-flight against the directory that will hold osv.db. Returns the available bytes so the
// caller can both gate the download and surface the number to the operator.
export async function checkOsvFreeSpace(): Promise<{ freeBytes: number; sufficient: boolean }> {
    const dir = dirname(resolveOsvDbPath())
    try {
        const stats = await statfs(dir)
        const freeBytes = Number(stats.bavail) * Number(stats.bsize)
        return { freeBytes, sufficient: freeBytes >= OSV_REQUIRED_FREE_BYTES }
    } catch {
        // If we can't stat the volume, don't block — but report 0 so the UI shows "unknown".
        return { freeBytes: 0, sufficient: true }
    }
}

// Full seed: stream npm/all.zip, normalize each entry, and batch-upsert into osv.db. Streaming + batched
// flushes keep memory bounded — the unpacked export is ~860 MB across ~220k files, far too large to hold
// at once. On success sets seedComplete + the lastModified cursor from the zip's Last-Modified header.
export async function seedOsv(db: OsvDrizzleDb, abortSignal?: AbortSignal): Promise<OsvSyncResult> {
    if (osvFeedDisabled()) {
        return { status: 'skipped', upserted: 0, recordCount: countOsvAdvisories(db), message: 'feed disabled' }
    }
    const space = await checkOsvFreeSpace()
    if (!space.sufficient) {
        const message =
            'insufficient free space for OSV seed: need ~' +
            mib(OSV_REQUIRED_FREE_BYTES) +
            ' MiB, have ' +
            mib(space.freeBytes) +
            ' MiB'
        setOsvMeta(db, OSV_META_KEYS.lastError, message)
        return { status: 'error', upserted: 0, recordCount: countOsvAdvisories(db), message }
    }
    const url = feedBase() + NPM_ALL_ZIP
    let response
    try {
        response = await axios.get(url, {
            responseType: 'stream',
            signal: abortSignal,
            // The seed is large; allow plenty of time but cap so a hung connection can't wedge the worker.
            timeout: 10 * 60 * 1000,
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        })
    } catch (err) {
        const message = 'OSV seed download failed: ' + errText(err)
        setOsvMeta(db, OSV_META_KEYS.lastError, message)
        return { status: 'error', upserted: 0, recordCount: countOsvAdvisories(db), message }
    }
    const lastModified = typeof response.headers['last-modified'] === 'string' ? response.headers['last-modified'] : null
    let upserted = 0
    const batch: OsvAdvisoryRow[] = []
    const BATCH_SIZE = 2000
    try {
        const zip = (response.data as Readable).pipe(unzipper.Parse({ forceStream: true }))
        for await (const entry of zip) {
            if (abortSignal && abortSignal.aborted) {
                entry.autodrain()
                throw new Error('aborted')
            }
            if (entry.type !== 'File' || !String(entry.path).endsWith('.json')) {
                entry.autodrain()
                continue
            }
            const content = await entry.buffer()
            const rows = parseEntry(content)
            for (const row of rows) batch.push(row)
            if (batch.length >= BATCH_SIZE) {
                upsertOsvAdvisories(db, batch)
                upserted += batch.length
                batch.length = 0
            }
        }
        if (batch.length > 0) {
            upsertOsvAdvisories(db, batch)
            upserted += batch.length
            batch.length = 0
        }
    } catch (err) {
        const message = 'OSV seed parse failed after ' + upserted + ' rows: ' + errText(err)
        setOsvMeta(db, OSV_META_KEYS.lastError, message)
        return { status: 'error', upserted, recordCount: countOsvAdvisories(db), message }
    }
    const recordCount = countOsvAdvisories(db)
    setOsvMeta(db, OSV_META_KEYS.seedComplete, true)
    setOsvMeta(db, OSV_META_KEYS.recordCount, recordCount)
    setOsvMeta(db, OSV_META_KEYS.refreshedAt, Date.now())
    setOsvMeta(db, OSV_META_KEYS.lastError, null)
    if (lastModified) setOsvMeta(db, OSV_META_KEYS.lastModified, lastModified)
    console.log('[osv-sync] seed complete: ' + recordCount + ' advisory rows')
    return { status: 'ok', upserted, recordCount, message: null }
}

const NPM_MODIFIED_CSV = '/npm/modified_id.csv'

// Incremental sync: fetch npm/modified_id.csv (id + modified-timestamp, newest first), take every id
// modified after the stored cursor, fetch each id's current JSON, and replace its rows. Advisories that
// 404 (deleted upstream) or come back withdrawn are purged. Advances the cursor to the newest seen.
export async function incrementalSyncOsv(db: OsvDrizzleDb, abortSignal?: AbortSignal): Promise<OsvSyncResult> {
    if (osvFeedDisabled()) {
        return { status: 'skipped', upserted: 0, recordCount: countOsvAdvisories(db), message: 'feed disabled' }
    }
    const cursor = getCursorMs(db)
    let csv: string
    try {
        const response = await axios.get(feedBase() + NPM_MODIFIED_CSV, {
            responseType: 'text',
            signal: abortSignal,
            timeout: 60 * 1000
        })
        csv = String(response.data)
    } catch (err) {
        const message = 'OSV modified_id.csv fetch failed: ' + errText(err)
        setOsvMeta(db, OSV_META_KEYS.lastError, message)
        return { status: 'error', upserted: 0, recordCount: countOsvAdvisories(db), message }
    }
    const changed = selectChangedIds(csv, cursor)
    if (changed.ids.length === 0) {
        setOsvMeta(db, OSV_META_KEYS.refreshedAt, Date.now())
        setOsvMeta(db, OSV_META_KEYS.lastError, null)
        return { status: 'ok', upserted: 0, recordCount: countOsvAdvisories(db), message: 'no changes' }
    }
    let upserted = 0
    for (const id of changed.ids) {
        if (abortSignal && abortSignal.aborted) break
        // Clear any prior rows for this advisory so a package dropped from `affected` doesn't linger.
        deleteOsvAdvisories(db, [id])
        const rows = await fetchAdvisory(id, abortSignal)
        const live = rows.filter(function notWithdrawn(r) {
            return r.withdrawn === null
        })
        if (live.length > 0) {
            upsertOsvAdvisories(db, live)
            upserted += live.length
        }
    }
    const recordCount = countOsvAdvisories(db)
    setOsvMeta(db, OSV_META_KEYS.recordCount, recordCount)
    setOsvMeta(db, OSV_META_KEYS.refreshedAt, Date.now())
    setOsvMeta(db, OSV_META_KEYS.lastError, null)
    if (changed.newestIso) setOsvMeta(db, OSV_META_KEYS.lastModified, changed.newestIso)
    console.log('[osv-sync] incremental sync: ' + changed.ids.length + ' changed advisor(ies), ' + upserted + ' rows upserted')
    return { status: 'ok', upserted, recordCount, message: null }
}

async function fetchAdvisory(id: string, abortSignal?: AbortSignal): Promise<OsvAdvisoryRow[]> {
    try {
        const response = await axios.get(feedBase() + '/npm/' + id + '.json', {
            responseType: 'json',
            signal: abortSignal,
            timeout: 30 * 1000,
            // 404 = advisory removed upstream; treat as "no rows" rather than throwing.
            validateStatus: function ok(status) {
                return status === 200 || status === 404
            }
        })
        if (response.status === 404) return []
        return normalizeOsvRecord(response.data)
    } catch {
        return []
    }
}

type ChangedIds = {
    ids: string[]
    newestIso: string | null
}

// Parses modified_id.csv ("<iso>,<id>" per line, newest first) and returns ids modified strictly after
// the cursor. The newest timestamp seen becomes the next cursor.
function selectChangedIds(csv: string, cursorMs: number): ChangedIds {
    const ids: string[] = []
    let newestIso: string | null = null
    let newestMs = cursorMs
    const lines = csv.split('\n')
    for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const comma = trimmed.indexOf(',')
        if (comma <= 0) continue
        const iso = trimmed.slice(0, comma)
        const id = trimmed.slice(comma + 1).trim()
        if (!id) continue
        const ms = Date.parse(iso)
        if (!Number.isFinite(ms)) continue
        if (ms > cursorMs) {
            ids.push(id)
        }
        if (ms > newestMs) {
            newestMs = ms
            newestIso = iso
        }
    }
    return { ids, newestIso }
}

function getCursorMs(db: OsvDrizzleDb): number {
    const iso = getOsvMeta<string>(db, OSV_META_KEYS.lastModified)
    if (!iso) return 0
    const ms = Date.parse(iso)
    return Number.isFinite(ms) ? ms : 0
}

function parseEntry(content: Buffer): OsvAdvisoryRow[] {
    let parsed: unknown
    try {
        parsed = JSON.parse(content.toString('utf8'))
    } catch {
        return []
    }
    return normalizeOsvRecord(parsed)
}

function mib(bytes: number): string {
    return Math.round(bytes / (1024 * 1024)).toString()
}

function errText(err: unknown): string {
    return (err instanceof Error && err.message) || String(err)
}

// Exposed so the scheduler/index can decide whether a seed is needed before scheduling incremental work.
export { OSV_SEED_DOWNLOAD_BYTES }
