import { statfs } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
    GEMNASIUM_REQUIRED_FREE_BYTES,
    GEMNASIUM_SEED_DOWNLOAD_BYTES
} from '@sentinello/core'
import {
    advisoryIdFromPath,
    errText,
    fetchGemnasiumChangedPaths,
    fetchGemnasiumFileRows,
    fetchGemnasiumHeadSha,
    gemnasiumFeedDisabled,
    streamGemnasiumArchive
} from '@sentinello/feeds'
import {
    GEMNASIUM_META_KEYS,
    GEMNASIUM_NORMALIZER_VERSION,
    countGemnasiumAdvisories,
    deleteGemnasiumAdvisories,
    deleteGemnasiumAdvisoriesExcept,
    gemnasiumRowKeyFor,
    getGemnasiumMeta,
    resolveGemnasiumDbPath,
    setGemnasiumMeta,
    upsertGemnasiumAdvisories,
    type GemnasiumDrizzleDb
} from '@sentinello/db'

// The worker's gemnasium persistence layer. Feed I/O lives in @sentinello/feeds; this module owns
// gemnasium.db state and the choice between a full archive rebuild and an incremental catch-up.

export { gemnasiumFeedDisabled }

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

// Entry point for a gemnasium refresh. Three outcomes, cheapest first:
//   1. HEAD sha matches what the cache was built from → nothing changed upstream, return immediately.
//   2. HEAD moved and we know our sha → ask which advisory files differ and apply just those.
//   3. No usable provenance (first seed, normalizer bump, or an unusable compare) → full archive rebuild.
// This is what stopped the old behavior of re-downloading 80 MB on every sync cycle regardless of whether
// the upstream repo had moved at all.
export async function syncGemnasium(db: GemnasiumDrizzleDb, abortSignal?: AbortSignal): Promise<GemnasiumSyncResult> {
    if (gemnasiumFeedDisabled()) {
        return { status: 'skipped', upserted: 0, recordCount: countGemnasiumAdvisories(db), message: 'feed disabled' }
    }
    const seeded = getGemnasiumMeta<boolean>(db, GEMNASIUM_META_KEYS.seedComplete) === true
    const normalizerCurrent = getGemnasiumMeta<number>(db, GEMNASIUM_META_KEYS.normalizerVersion) === GEMNASIUM_NORMALIZER_VERSION
    const storedSha = getGemnasiumMeta<string>(db, GEMNASIUM_META_KEYS.headSha) ?? null
    const headSha = await fetchGemnasiumHeadSha({ abortSignal })

    if (seeded && normalizerCurrent && headSha && storedSha === headSha) {
        setGemnasiumMeta(db, GEMNASIUM_META_KEYS.refreshedAt, Date.now())
        setGemnasiumMeta(db, GEMNASIUM_META_KEYS.lastError, null)
        return { status: 'ok', upserted: 0, recordCount: countGemnasiumAdvisories(db), message: 'unchanged upstream' }
    }

    if (seeded && normalizerCurrent && headSha && storedSha) {
        const incremental = await incrementalSyncGemnasium(db, storedSha, headSha, abortSignal)
        if (incremental) return incremental
        // Fall through to the full rebuild when the incremental path was unusable.
    }

    return await rebuildGemnasium(db, headSha, abortSignal)
}

// Applies only the advisory files that changed between two commits. Returns null when the compare is
// unusable (too many changes, upstream timeout, request failure), which tells the caller to fall back to
// the full archive rather than leave the cache subtly incomplete.
async function incrementalSyncGemnasium(
    db: GemnasiumDrizzleDb,
    fromSha: string,
    toSha: string,
    abortSignal?: AbortSignal
): Promise<GemnasiumSyncResult | null> {
    const changed = await fetchGemnasiumChangedPaths(fromSha, toSha, { abortSignal })
    if (changed.status === 'unavailable') {
        console.log('[gemnasium-sync] incremental unavailable (' + changed.reason + '); falling back to full archive')
        return null
    }
    // A commit that touched only unsupported ecosystems (maven, gem, …) legitimately changes nothing here,
    // but the sha must still advance or every later sync would re-compare from the same stale point.
    if (changed.changed.length === 0 && changed.deleted.length === 0) {
        setGemnasiumMeta(db, GEMNASIUM_META_KEYS.headSha, toSha)
        setGemnasiumMeta(db, GEMNASIUM_META_KEYS.refreshedAt, Date.now())
        setGemnasiumMeta(db, GEMNASIUM_META_KEYS.lastError, null)
        return { status: 'ok', upserted: 0, recordCount: countGemnasiumAdvisories(db), message: 'no relevant changes' }
    }
    let upserted = 0
    try {
        const deletedIds: string[] = []
        for (const path of changed.deleted) {
            const id = advisoryIdFromPath(path)
            if (id) deletedIds.push(id)
        }
        // Clear the rows of every touched advisory before rewriting them, so a package dropped from an
        // advisory's affected set disappears instead of lingering as a phantom finding.
        for (const path of changed.changed) {
            const id = advisoryIdFromPath(path)
            if (id) deletedIds.push(id)
        }
        deleteGemnasiumAdvisories(db, deletedIds)
        for (const path of changed.changed) {
            if (abortSignal && abortSignal.aborted) throw new Error('aborted')
            const rows = await fetchGemnasiumFileRows(path, toSha, { abortSignal })
            if (rows.length > 0) {
                upsertGemnasiumAdvisories(db, rows)
                upserted += rows.length
            }
        }
    } catch (err) {
        // The sha is deliberately NOT advanced here: a partially applied catch-up must be retried from the
        // same starting point, not skipped past.
        const message = 'gemnasium incremental sync failed after ' + upserted + ' rows: ' + errText(err)
        setGemnasiumMeta(db, GEMNASIUM_META_KEYS.lastError, message)
        return { status: 'error', upserted, recordCount: countGemnasiumAdvisories(db), message }
    }
    const recordCount = countGemnasiumAdvisories(db)
    setGemnasiumMeta(db, GEMNASIUM_META_KEYS.headSha, toSha)
    setGemnasiumMeta(db, GEMNASIUM_META_KEYS.recordCount, recordCount)
    setGemnasiumMeta(db, GEMNASIUM_META_KEYS.refreshedAt, Date.now())
    setGemnasiumMeta(db, GEMNASIUM_META_KEYS.lastError, null)
    console.log(
        '[gemnasium-sync] incremental sync: ' +
        changed.changed.length + ' changed, ' + changed.deleted.length + ' deleted, ' +
        upserted + ' rows upserted'
    )
    return { status: 'ok', upserted, recordCount, message: null }
}

// Full rebuild from the repo archive. Streams the zip, normalizes each *.yml, batch-upserts, then purges
// any advisory not seen this pass (so upstream deletions don't linger). The purge runs ONLY after the full
// stream succeeds, so a failed/partial download never empties the cache.
async function rebuildGemnasium(
    db: GemnasiumDrizzleDb,
    headSha: string | null,
    abortSignal?: AbortSignal
): Promise<GemnasiumSyncResult> {
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
    let upserted = 0
    let lastModified: string | null = null
    const seenRowKeys = new Set<string>()
    try {
        for await (const batch of streamGemnasiumArchive(undefined, { abortSignal })) {
            lastModified = batch.lastModified
            for (const row of batch.rows) {
                seenRowKeys.add(gemnasiumRowKeyFor(row.advisoryId, row.ecosystem, row.packageName))
            }
            upsertGemnasiumAdvisories(db, batch.rows)
            upserted += batch.rows.length
        }
    } catch (err) {
        const message = 'gemnasium archive sync failed after ' + upserted + ' rows: ' + errText(err)
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
    // The archive is fetched from the `master` ref rather than a pinned sha, so it may in principle be
    // newer than the sha we read a moment earlier. Recording the sha we know about is still correct: the
    // next compare then replays that window, which is idempotent, rather than skipping it.
    setGemnasiumMeta(db, GEMNASIUM_META_KEYS.headSha, headSha)
    if (lastModified) setGemnasiumMeta(db, GEMNASIUM_META_KEYS.lastModified, lastModified)
    console.log('[gemnasium-sync] full sync complete: ' + recordCount + ' advisory rows (' + purged + ' stale purged)')
    return { status: 'ok', upserted, recordCount, message: null }
}

function mib(bytes: number): string {
    return Math.round(bytes / (1024 * 1024)).toString()
}

// Exposed so the runtime can show the expected download footprint before a seed.
export { GEMNASIUM_SEED_DOWNLOAD_BYTES }
