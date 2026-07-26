import { statfs } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
    OSV_REQUIRED_FREE_BYTES,
    OSV_SEED_DOWNLOAD_BYTES,
    type EcosystemId
} from '@sentinello/core'
import {
    OSV_INCREMENTAL_MAX_IDS,
    errText,
    fetchOsvAdvisoryRows,
    fetchOsvChangedIds,
    osvFeedDisabled,
    streamOsvSeed
} from '@sentinello/feeds'
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
    type OsvDrizzleDb
} from '@sentinello/db'

// The worker's OSV persistence layer. Downloading, unzipping, normalizing, and deciding what changed all
// live in @sentinello/feeds now — this module is what turns those rows into osv.db state: free-space
// pre-flight, destructive-rebuild ordering, batched upserts, and the per-ecosystem meta bookkeeping the
// Settings panel reads. The CLI consumes the same feeds package with a completely different sink.

export { osvFeedDisabled }

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
// DISCARDS its prior rows, then consumes the normalized batches from the feed and upserts them. Discarding
// first means a successful seed cannot leave rows that vanished from the current export (deleted advisory,
// dropped affected package, old-shape rows from a previous normalizer version), and a failure mid-stream
// leaves the ecosystem unseeded — unauditable rather than matching stale/partial data. On success sets the
// ecosystem's seedComplete + its normalizer-version stamp + the lastModified cursor from the zip header.
// Rows are keyed by (advisoryId, ecosystem, packageName) and the discard is ecosystem-scoped, so seeding
// one ecosystem never disturbs another's rows.
export async function seedOsv(db: OsvDrizzleDb, ecosystem: EcosystemId, abortSignal?: AbortSignal): Promise<OsvSyncResult> {
    function ecoCount(): number {
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
    let upserted = 0
    let lastModified: string | null = null
    let invalidated = false
    try {
        for await (const batch of streamOsvSeed(ecosystem, undefined, { abortSignal })) {
            // The download is live — invalidate the prior cache for this ecosystem before consuming it.
            // Mark it unseeded first so any concurrent scan treats the ecosystem as not-yet-downloaded for
            // the duration of the rebuild, then clear its rows so the seed is a true rebuild (no row
            // survives that is absent from the current export). seedComplete flips back to true only after
            // the full stream succeeds. Deferred to the first batch so a download that fails before
            // producing anything leaves the existing cache intact.
            if (!invalidated) {
                setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.seedComplete, ecosystem), false)
                deleteOsvAdvisoriesForEcosystem(db, ecosystem)
                invalidated = true
            }
            lastModified = batch.lastModified
            upsertOsvAdvisories(db, batch.rows)
            upserted += batch.rows.length
        }
    } catch (err) {
        const message = 'OSV seed failed (' + ecosystem + ') after ' + upserted + ' rows: ' + errText(err)
        setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.lastError, ecosystem), message)
        return { status: 'error', upserted, recordCount: ecoCount(), message }
    }
    const recordCount = ecoCount()
    setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.seedComplete, ecosystem), true)
    setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.normalizerVersion, ecosystem), OSV_NORMALIZER_VERSION)
    setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.recordCount, ecosystem), recordCount)
    setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.refreshedAt, ecosystem), Date.now())
    setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.lastError, ecosystem), null)
    // A fresh seed supersedes whatever incremental cursor was stored, so drop the etag: the next
    // incremental sync must re-read modified_id.csv rather than trust a 304 against a pre-seed copy.
    setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.modifiedIdsEtag, ecosystem), null)
    if (lastModified) setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.lastModified, ecosystem), lastModified)
    console.log('[osv-sync] seed complete (' + ecosystem + '): ' + recordCount + ' advisory rows')
    return { status: 'ok', upserted, recordCount, message: null }
}

// Incremental sync for ONE ecosystem: conditionally fetch <ecosystem>/modified_id.csv, take every id
// modified after the stored cursor, fetch each id's current JSON, and replace its rows FOR THIS ECOSYSTEM
// ONLY. Advisories that 404 (deleted upstream) or come back withdrawn are purged. Advances the ecosystem's
// cursor to the newest seen. When the feed has not been republished since the stored ETag, this costs a
// single round trip and transfers nothing.
export async function incrementalSyncOsv(db: OsvDrizzleDb, ecosystem: EcosystemId, abortSignal?: AbortSignal): Promise<OsvSyncResult> {
    function ecoCount(): number {
        return countOsvAdvisories(db, ecosystem)
    }
    if (osvFeedDisabled()) {
        return { status: 'skipped', upserted: 0, recordCount: ecoCount(), message: 'feed disabled' }
    }
    const cursor = getCursorMs(db, ecosystem)
    const etag = getOsvMeta<string>(db, osvMetaKeyFor(OSV_META_KEYS.modifiedIdsEtag, ecosystem)) ?? null
    let changed
    try {
        changed = await fetchOsvChangedIds(ecosystem, cursor, etag, { abortSignal })
    } catch (err) {
        const message = 'OSV modified_id.csv fetch failed (' + ecosystem + '): ' + errText(err)
        setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.lastError, ecosystem), message)
        return { status: 'error', upserted: 0, recordCount: ecoCount(), message }
    }
    if (changed.status === 'unchanged') {
        setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.refreshedAt, ecosystem), Date.now())
        setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.lastError, ecosystem), null)
        return { status: 'ok', upserted: 0, recordCount: ecoCount(), message: 'not modified' }
    }
    // Past a certain volume, fetching advisories one at a time costs far more than re-downloading the
    // whole export — OSV can land tens of thousands of malware records in a single day.
    if (changed.ids.length > OSV_INCREMENTAL_MAX_IDS) {
        console.log('[osv-sync] ' + changed.ids.length + ' changed advisories for ' + ecosystem + ' exceeds the incremental threshold; re-seeding')
        return await seedOsv(db, ecosystem, abortSignal)
    }
    if (changed.ids.length === 0) {
        setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.refreshedAt, ecosystem), Date.now())
        setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.lastError, ecosystem), null)
        if (changed.etag) setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.modifiedIdsEtag, ecosystem), changed.etag)
        return { status: 'ok', upserted: 0, recordCount: ecoCount(), message: 'no changes' }
    }
    let upserted = 0
    for (const id of changed.ids) {
        if (abortSignal && abortSignal.aborted) break
        // Clear this ecosystem's prior rows for the advisory so a package dropped from `affected` doesn't
        // linger — scoped to the ecosystem so a sibling ecosystem's rows for the same id survive.
        deleteOsvAdvisories(db, [id], ecosystem)
        let rows
        try {
            rows = await fetchOsvAdvisoryRows(id, ecosystem, { abortSignal })
        } catch {
            // A single advisory failing to fetch must not abort the pass; its rows are already cleared, so
            // it is simply absent until the next sync re-reads it (the cursor only advances on success).
            continue
        }
        if (rows.length > 0) {
            upsertOsvAdvisories(db, rows)
            upserted += rows.length
        }
    }
    const recordCount = ecoCount()
    setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.recordCount, ecosystem), recordCount)
    setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.refreshedAt, ecosystem), Date.now())
    setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.lastError, ecosystem), null)
    if (changed.newestIso) setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.lastModified, ecosystem), changed.newestIso)
    if (changed.etag) setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.modifiedIdsEtag, ecosystem), changed.etag)
    console.log('[osv-sync] incremental sync (' + ecosystem + '): ' + changed.ids.length + ' changed advisor(ies), ' + upserted + ' rows upserted')
    return { status: 'ok', upserted, recordCount, message: null }
}

function getCursorMs(db: OsvDrizzleDb, ecosystem: EcosystemId): number {
    const iso = getOsvMeta<string>(db, osvMetaKeyFor(OSV_META_KEYS.lastModified, ecosystem))
    if (!iso) return 0
    const ms = Date.parse(iso)
    return Number.isFinite(ms) ? ms : 0
}

function mib(bytes: number): string {
    return Math.round(bytes / (1024 * 1024)).toString()
}

// Exposed so the scheduler/index can decide whether a seed is needed before scheduling incremental work.
export { OSV_SEED_DOWNLOAD_BYTES }
