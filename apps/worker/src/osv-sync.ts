import { statfs } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import axios from 'axios'
import unzipper from 'unzipper'
import {
    OSV_REQUIRED_FREE_BYTES,
    OSV_SEED_DOWNLOAD_BYTES,
    getEcosystem,
    type EcosystemId
} from '@sentinello/core'
import {
    OSV_META_KEYS,
    OSV_NORMALIZER_VERSION,
    countOsvAdvisories,
    deleteOsvAdvisories,
    deleteOsvAdvisoriesForEcosystem,
    getOsvMeta,
    osvMetaKeyFor,
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

function feedBase(): string {
    const fromEnv = process.env.SENTINELLO_OSV_FEED_URL
    if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim()
    return DEFAULT_FEED_BASE
}

// The canonical OSV feed directory for an ecosystem, taken from the central registry's `osvEcosystem`
// (e.g. 'npm' | 'PyPI' | 'Go' | 'crates.io') — NEVER a lowercase language slug, which would 404 the feed.
// encodeURIComponent guards the path segment (a no-op for the current ids, future-proof for any with
// reserved characters). Throws on an unknown ecosystem so a typo fails loudly instead of fetching garbage.
function osvFeedDir(ecosystem: EcosystemId): string {
    const def = getEcosystem(ecosystem)
    if (!def) throw new Error('unknown OSV ecosystem: ' + ecosystem)
    return encodeURIComponent(def.osvEcosystem)
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

// Full seed/re-seed for ONE ecosystem. Once the download stream is live it marks the ecosystem unseeded and
// DISCARDS its prior rows, then streams <ecosystem>/all.zip, normalizes each entry (keeping only that
// ecosystem's affected entries), and batch-upserts into osv.db. Discarding first means a successful seed
// cannot leave rows that vanished from the current export (deleted advisory, dropped affected package,
// old-shape rows from a previous normalizer version), and a failure mid-stream leaves the ecosystem
// unseeded — unauditable rather than matching stale/partial data. Streaming + batched flushes keep memory
// bounded — the unpacked npm export alone is ~860 MB across ~220k files. On success sets the ecosystem's
// seedComplete + its normalizer-version stamp + the lastModified cursor from the zip's Last-Modified header.
// Rows are keyed by (advisoryId, ecosystem, packageName) and the discard is ecosystem-scoped, so seeding one
// ecosystem never disturbs another's rows.
export async function seedOsv(db: OsvDrizzleDb, ecosystem: EcosystemId, abortSignal?: AbortSignal): Promise<OsvSyncResult> {
    const ecoCount = function ecoCount() {
        return countOsvAdvisories(db, ecosystem)
    }
    if (osvFeedDisabled()) {
        return { status: 'skipped', upserted: 0, recordCount: ecoCount(), message: 'feed disabled' }
    }
    const space = await checkOsvFreeSpace()
    if (!space.sufficient) {
        const message =
            'insufficient free space for OSV seed: need ~' +
            mib(OSV_REQUIRED_FREE_BYTES) +
            ' MiB, have ' +
            mib(space.freeBytes) +
            ' MiB'
        setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.lastError, ecosystem), message)
        return { status: 'error', upserted: 0, recordCount: ecoCount(), message }
    }
    const url = feedBase() + '/' + osvFeedDir(ecosystem) + '/all.zip'
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
        const message = 'OSV seed download failed (' + ecosystem + '): ' + errText(err)
        setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.lastError, ecosystem), message)
        return { status: 'error', upserted: 0, recordCount: ecoCount(), message }
    }
    const lastModified = typeof response.headers['last-modified'] === 'string' ? response.headers['last-modified'] : null
    // The download is live — invalidate the prior cache for this ecosystem before consuming it. Mark it
    // unseeded first so any concurrent scan treats the ecosystem as not-yet-downloaded for the duration of
    // the rebuild, then clear its rows so the seed below is a true rebuild (no rows survive that are absent
    // from the current export). seedComplete flips back to true only after the full stream succeeds.
    setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.seedComplete, ecosystem), false)
    deleteOsvAdvisoriesForEcosystem(db, ecosystem)
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
            const rows = parseEntry(content, ecosystem)
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
        const message = 'OSV seed parse failed (' + ecosystem + ') after ' + upserted + ' rows: ' + errText(err)
        setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.lastError, ecosystem), message)
        return { status: 'error', upserted, recordCount: ecoCount(), message }
    }
    const recordCount = ecoCount()
    setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.seedComplete, ecosystem), true)
    setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.normalizerVersion, ecosystem), OSV_NORMALIZER_VERSION)
    setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.recordCount, ecosystem), recordCount)
    setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.refreshedAt, ecosystem), Date.now())
    setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.lastError, ecosystem), null)
    if (lastModified) setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.lastModified, ecosystem), lastModified)
    console.log('[osv-sync] seed complete (' + ecosystem + '): ' + recordCount + ' advisory rows')
    return { status: 'ok', upserted, recordCount, message: null }
}

// Incremental sync for ONE ecosystem: fetch <ecosystem>/modified_id.csv (id + modified-timestamp, newest
// first), take every id modified after the stored per-ecosystem cursor, fetch each id's current JSON, and
// replace its rows FOR THIS ECOSYSTEM ONLY. Advisories that 404 (deleted upstream) or come back withdrawn
// are purged. Advances the ecosystem's cursor to the newest seen.
export async function incrementalSyncOsv(db: OsvDrizzleDb, ecosystem: EcosystemId, abortSignal?: AbortSignal): Promise<OsvSyncResult> {
    const ecoCount = function ecoCount() {
        return countOsvAdvisories(db, ecosystem)
    }
    if (osvFeedDisabled()) {
        return { status: 'skipped', upserted: 0, recordCount: ecoCount(), message: 'feed disabled' }
    }
    const cursor = getCursorMs(db, ecosystem)
    let csv: string
    try {
        const response = await axios.get(feedBase() + '/' + osvFeedDir(ecosystem) + '/modified_id.csv', {
            responseType: 'text',
            signal: abortSignal,
            timeout: 60 * 1000
        })
        csv = String(response.data)
    } catch (err) {
        const message = 'OSV modified_id.csv fetch failed (' + ecosystem + '): ' + errText(err)
        setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.lastError, ecosystem), message)
        return { status: 'error', upserted: 0, recordCount: ecoCount(), message }
    }
    const changed = selectChangedIds(csv, cursor)
    if (changed.ids.length === 0) {
        setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.refreshedAt, ecosystem), Date.now())
        setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.lastError, ecosystem), null)
        return { status: 'ok', upserted: 0, recordCount: ecoCount(), message: 'no changes' }
    }
    let upserted = 0
    for (const id of changed.ids) {
        if (abortSignal && abortSignal.aborted) break
        // Clear this ecosystem's prior rows for the advisory so a package dropped from `affected` doesn't
        // linger — scoped to the ecosystem so a sibling ecosystem's rows for the same id survive.
        deleteOsvAdvisories(db, [id], ecosystem)
        const rows = await fetchAdvisory(id, ecosystem, abortSignal)
        const live = rows.filter(function notWithdrawn(r) {
            return r.withdrawn === null
        })
        if (live.length > 0) {
            upsertOsvAdvisories(db, live)
            upserted += live.length
        }
    }
    const recordCount = ecoCount()
    setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.recordCount, ecosystem), recordCount)
    setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.refreshedAt, ecosystem), Date.now())
    setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.lastError, ecosystem), null)
    if (changed.newestIso) setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.lastModified, ecosystem), changed.newestIso)
    console.log('[osv-sync] incremental sync (' + ecosystem + '): ' + changed.ids.length + ' changed advisor(ies), ' + upserted + ' rows upserted')
    return { status: 'ok', upserted, recordCount, message: null }
}

async function fetchAdvisory(id: string, ecosystem: EcosystemId, abortSignal?: AbortSignal): Promise<OsvAdvisoryRow[]> {
    try {
        const response = await axios.get(feedBase() + '/' + osvFeedDir(ecosystem) + '/' + id + '.json', {
            responseType: 'json',
            signal: abortSignal,
            timeout: 30 * 1000,
            // 404 = advisory removed upstream; treat as "no rows" rather than throwing.
            validateStatus: function ok(status) {
                return status === 200 || status === 404
            }
        })
        if (response.status === 404) return []
        return normalizeOsvRecord(response.data, ecosystem)
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

function getCursorMs(db: OsvDrizzleDb, ecosystem: EcosystemId): number {
    const iso = getOsvMeta<string>(db, osvMetaKeyFor(OSV_META_KEYS.lastModified, ecosystem))
    if (!iso) return 0
    const ms = Date.parse(iso)
    return Number.isFinite(ms) ? ms : 0
}

function parseEntry(content: Buffer, ecosystem: EcosystemId): OsvAdvisoryRow[] {
    let parsed: unknown
    try {
        parsed = JSON.parse(content.toString('utf8'))
    } catch {
        return []
    }
    return normalizeOsvRecord(parsed, ecosystem)
}

function mib(bytes: number): string {
    return Math.round(bytes / (1024 * 1024)).toString()
}

function errText(err: unknown): string {
    return (err instanceof Error && err.message) || String(err)
}

// Exposed so the scheduler/index can decide whether a seed is needed before scheduling incremental work.
export { OSV_SEED_DOWNLOAD_BYTES }
