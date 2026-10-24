import { statfs } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
    OSV_REQUIRED_FREE_BYTES,
    OSV_SEED_DOWNLOAD_BYTES,
    type EcosystemId,
    type OsvAdvisoryRow
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
export async function seedOsv(
    db: OsvDrizzleDb,
    ecosystem: EcosystemId,
    abortSignal?: AbortSignal,
    onCacheDiscarded?: () => void
): Promise<OsvSyncResult> {
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
                // The point of no return, announced. The ecosystem's rows are gone and the scanner already
                // refuses it, so anything mirroring this cache's state has to learn that NOW rather than
                // when the seed finishes minutes later. Sampling only at the ends is what let Settings →
                // Sources report a pre-rebuild snapshot for the whole rebuild while every scan returned
                // osv_db_not_seeded. A throw here would be caught below and recorded as a seed error;
                // that is the right outcome — the only caller writes to the worker's own main DB, and a
                // write failure on that handle is already fatal to everything else the worker does.
                if (onCacheDiscarded) onCacheDiscarded()
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
// ONLY. Advisories that 404 (deleted upstream) are purged; one that comes back withdrawn keeps its rows
// with `withdrawn` set, as the seed does, because gemnasium reads them as withdrawal evidence. The whole
// pass is published atomically, and only once every changed id was re-read, advancing the ecosystem's
// cursor to the newest seen. When the feed has not been republished since the stored ETag, this costs a
// single round trip and transfers nothing.
export async function incrementalSyncOsv(
    db: OsvDrizzleDb,
    ecosystem: EcosystemId,
    abortSignal?: AbortSignal,
    onCacheDiscarded?: () => void
): Promise<OsvSyncResult> {
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
        // Forwarded: this is a destructive re-seed reached from a USABLE cache, so it is the one rebuild
        // whose invalidation nobody would otherwise be told about.
        return await seedOsv(db, ecosystem, abortSignal, onCacheDiscarded)
    }
    if (changed.ids.length === 0) {
        setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.refreshedAt, ecosystem), Date.now())
        setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.lastError, ecosystem), null)
        if (changed.etag) setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.modifiedIdsEtag, ecosystem), changed.etag)
        return { status: 'ok', upserted: 0, recordCount: ecoCount(), message: 'no changes' }
    }
    // The pass is staged, then published as ONE transaction, and only when every changed id was re-read.
    //
    // An advisory we could not re-read is an advisory we must not drop: an early version of this loop
    // deleted the old rows first and fetched second, so any timeout erased that advisory and the cursor
    // moved past it regardless. Replacing each advisory as its fetch landed fixed that, but still exposed
    // every partial pass to the scans running meanwhile and left it in place after a failure. That is
    // harmless to OSV matching, which reads each advisory on its own, and not to gemnasium, which reads
    // this cache as withdrawal EVIDENCE across advisories: GitHub withdraws GHSA-A as a duplicate of a newly
    // published GHSA-B, both aliasing CVE-X; with A's withdrawal applied and B's fetch failed (or not yet
    // reached), every record linked to CVE-X looks withdrawn and gemnasium suppresses a live advisory. So
    // the cache only ever moves from one complete snapshot to the next: scans during the pass read the
    // previous one, a failed or aborted pass leaves it untouched for the next sync to retry, and a worker
    // killed mid-publish rolls the transaction back.
    //
    // A 404 is not a failure here: fetchOsvAdvisoryRows returns [] for an advisory removed upstream, which
    // is exactly the deletion signal, and the replace below applies it. A withdrawn advisory is not a
    // deletion: its rows come back with `withdrawn` set and replace the active ones, so nothing matches on
    // them any more while gemnasium can still see the withdrawal.
    const staged: OsvAdvisoryRow[] = []
    let failure: string | null = null
    for (const id of changed.ids) {
        if (abortSignal && abortSignal.aborted) {
            failure = 'the sync was aborted before every changed advisory was re-read'
            break
        }
        try {
            const rows = await fetchOsvAdvisoryRows(id, ecosystem, { abortSignal })
            for (const row of rows) staged.push(row)
        } catch (err) {
            // Nothing of this pass will be published, so the remaining fetches would be wasted.
            failure = id + ' could not be re-read (' + errText(err) + ')'
            break
        }
    }
    if (failure !== null) {
        // The cursor is held, so the next sync repeats this window — idempotent, and self-limiting because a
        // window that keeps growing eventually crosses OSV_INCREMENTAL_MAX_IDS and re-seeds outright. The
        // stored ETag is cleared too, and both halves are needed: holding the cursor alone would not retry
        // anything, because the next sync would send the old ETag, OSV would answer 304, and the pass would
        // return "not modified" without ever revisiting the window. refreshedAt stays where it is: the
        // cache is still the snapshot that sync produced.
        setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.modifiedIdsEtag, ecosystem), null)
        const message = failure + '; none of the ' + changed.ids.length + ' changed advisories were applied and the pass is retried from the previous cursor'
        setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.lastError, ecosystem), message)
        console.warn('[osv-sync] ' + ecosystem + ': ' + message)
        return { status: 'error', upserted: 0, recordCount: ecoCount(), message }
    }
    const recordCount = db.transaction(function publish(): number {
        // Scoped to the ecosystem so a sibling ecosystem's rows for the same id survive, and so a package
        // dropped from `affected` does not linger.
        deleteOsvAdvisories(db, changed.ids, ecosystem)
        upsertOsvAdvisories(db, staged)
        const count = ecoCount()
        setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.recordCount, ecosystem), count)
        setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.refreshedAt, ecosystem), Date.now())
        setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.lastError, ecosystem), null)
        if (changed.newestIso) setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.lastModified, ecosystem), changed.newestIso)
        if (changed.etag) setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.modifiedIdsEtag, ecosystem), changed.etag)
        return count
    })
    console.log('[osv-sync] incremental sync (' + ecosystem + '): ' + changed.ids.length + ' changed advisor(ies), ' + staged.length + ' rows upserted')
    return { status: 'ok', upserted: staged.length, recordCount, message: null }
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
