import {
    GEMNASIUM_NORMALIZER_VERSION,
    GEMNASIUM_SEED_DOWNLOAD_BYTES,
    osvNormalizerVersion,
    type EcosystemId,
    type GemnasiumAdvisoryRow,
    type OsvAdvisoryRow
} from '@sentinello/core'
import {
    OSV_INCREMENTAL_MAX_IDS,
    OSV_INCREMENTAL_STUCK_MS,
    advisoryIdFromPath,
    errText,
    fetchGemnasiumChangedPaths,
    fetchGemnasiumFileRows,
    fetchGemnasiumHeadSha,
    fetchOsvAdvisoryRows,
    fetchOsvChangedIds,
    gemnasiumFeedDisabled,
    headOsvSeed,
    osvFeedDisabled,
    streamGemnasiumArchive,
    streamOsvSeed,
    type FetchOptions,
    type ProgressReporter,
    type RetryNotice
} from '@sentinello/feeds'
import {
    advisoryFilePath,
    ensureCacheDir,
    getSourceState,
    isSeeded,
    readCacheMeta,
    setSourceState,
    tryAcquireLock,
    writeCacheMeta,
    type CacheMeta,
    type SourceId,
    type SourceState
} from './meta'
import { countRows, createRowWriter, rewriteRows } from './store'

// Turns the shared feed package into a refreshed on-disk cache.
//
// There is no separate `sync` command: every scan refreshes first. That is only reasonable because the
// freshness checks are nearly free — OSV answers 304 when nothing was republished, and gemnasium reports
// its HEAD commit in about a kilobyte. The expensive path (a full seed) happens once, and only after the
// user has agreed to it.

export type SyncPlanItem = {
    source: SourceId
    ecosystem: EcosystemId
    // 'findings' is a source the run matches against. 'withdrawal-evidence' is the OSV cache fetched only
    // so gemnasium can drop advisories GitHub has withdrawn, when OSV itself is not a selected source:
    // gemnasium-db records no withdrawal, and OSV mirrors GitHub's.
    purpose: 'findings' | 'withdrawal-evidence'
    // 'seed' is the big first download; 'refresh' is the cheap incremental catch-up.
    kind: 'seed' | 'refresh'
    // Bytes the seed will transfer, when known. Populated for 'seed' so the consent prompt can state a
    // real number instead of asking the user to approve an unknown quantity.
    downloadBytes: number | null
    // True when downloadBytes is a measured constant rather than a length the server advertised, so the
    // prompt can render it as an approximation. OSV answers a HEAD with Content-Length; gemnasium cannot.
    downloadBytesEstimated: boolean
}

export type SyncPlan = {
    items: SyncPlanItem[]
    // Total bytes across every seed in the plan.
    seedBytes: number
    needsConsent: boolean
}

export type SyncOutcome = {
    source: SourceId
    ecosystem: EcosystemId
    status: 'seeded' | 'refreshed' | 'unchanged' | 'skipped' | 'error'
    rowCount: number
    message: string | null
}

export type SyncOptions = {
    cacheDir: string
    sources: SourceId[]
    ecosystem: EcosystemId
    abortSignal?: AbortSignal
    // Reports download progress for the seed, so the UI layer can render a real progress bar.
    onProgress?: (item: SyncPlanItem, bytesRead: number, totalBytes: number | null) => void
    // Wall-clock budget for waiting out a slow-transient rejection; 0 fails fast. Defaults in the feeds layer.
    retryWaitMs?: number
    onRetry?: (item: SyncPlanItem, notice: RetryNotice) => void
    onStatus?: (item: SyncPlanItem, phase: 'start' | 'done') => void
}

// What the run must sync: every selected source, plus OSV as gemnasium's withdrawal evidence when gemnasium
// is selected and OSV is not. The evidence rides the same plan, so a first download goes through the same
// consent prompt and --yes, and every later run refreshes it just like a selected source.
export type SyncTarget = { source: SourceId; purpose: SyncPlanItem['purpose'] }

export function syncTargets(sources: readonly SourceId[]): SyncTarget[] {
    const targets = sources.map(function forFindings(source): SyncTarget {
        return { source, purpose: 'findings' }
    })
    if (sources.includes('gemnasium') && !sources.includes('osv')) {
        targets.push({ source: 'osv', purpose: 'withdrawal-evidence' })
    }
    return targets
}

// Works out what each enabled source needs before anything is downloaded, so the caller can show the cost
// and ask for consent. A source already seeded at the current normalizer version needs only a refresh.
export async function planSync(options: SyncOptions): Promise<SyncPlan> {
    const meta = await readCacheMeta(options.cacheDir)
    const items: SyncPlanItem[] = []
    let seedBytes = 0
    for (const { source, purpose } of syncTargets(options.sources)) {
        if (source === 'osv' && osvFeedDisabled()) continue
        if (source === 'gemnasium' && gemnasiumFeedDisabled()) continue
        const normalizerVersion = source === 'osv' ? osvNormalizerVersion(options.ecosystem) : GEMNASIUM_NORMALIZER_VERSION
        const seeded = isSeeded(meta, source, options.ecosystem, normalizerVersion)
        if (seeded) {
            items.push({ source, ecosystem: options.ecosystem, purpose, kind: 'refresh', downloadBytes: null, downloadBytesEstimated: false })
            continue
        }
        const estimate = await estimateSeedBytes(source, options.ecosystem, options.abortSignal)
        if (estimate.bytes !== null) seedBytes += estimate.bytes
        items.push({
            source,
            ecosystem: options.ecosystem,
            purpose,
            kind: 'seed',
            downloadBytes: estimate.bytes,
            downloadBytesEstimated: estimate.estimated
        })
    }
    return {
        items,
        seedBytes,
        needsConsent: items.some(function isSeed(i): boolean {
            return i.kind === 'seed'
        })
    }
}

type SeedEstimate = { bytes: number | null; estimated: boolean }

async function estimateSeedBytes(source: SourceId, ecosystem: EcosystemId, abortSignal?: AbortSignal): Promise<SeedEstimate> {
    if (source !== 'osv') {
        // GitLab generates repo archives on demand and does not advertise a length up front, so there is
        // nothing to HEAD. The constant in core is the observed size and is what the portal already quotes
        // for this same download; quoting it here too beats asking for consent to an unknown quantity.
        return { bytes: GEMNASIUM_SEED_DOWNLOAD_BYTES, estimated: true }
    }
    try {
        const info = await headOsvSeed(ecosystem, { abortSignal })
        return { bytes: info.contentLength, estimated: false }
    } catch {
        return { bytes: null, estimated: false }
    }
}

// Executes a plan. Each (source, ecosystem) is independent: one failing leaves the others intact, and a
// failure never destroys a previously good cache, because writes land on a temp file and are renamed into
// place only on success.
export async function runSync(options: SyncOptions, plan: SyncPlan): Promise<SyncOutcome[]> {
    await ensureCacheDir(options.cacheDir)
    const outcomes: SyncOutcome[] = []
    if (plan.items.length === 0) return outcomes
    const lock = await tryAcquireLock(options.cacheDir)
    if (!lock) {
        // Another Sentinello process is already syncing. Reading its previous cache is strictly better than
        // blocking the terminal behind someone else's download.
        for (const item of plan.items) {
            outcomes.push({
                source: item.source,
                ecosystem: item.ecosystem,
                status: 'skipped',
                rowCount: 0,
                message: 'another sentinello process is syncing the cache'
            })
        }
        return outcomes
    }
    try {
        const meta = await readCacheMeta(options.cacheDir)
        for (const item of plan.items) {
            if (options.abortSignal && options.abortSignal.aborted) break
            if (options.onStatus) options.onStatus(item, 'start')
            const outcome = await runOne(options, meta, item)
            outcomes.push(outcome)
            if (options.onStatus) options.onStatus(item, 'done')
        }
        await writeCacheMeta(options.cacheDir, meta)
    } finally {
        await lock.release()
    }
    return outcomes
}

async function runOne(options: SyncOptions, meta: CacheMeta, item: SyncPlanItem): Promise<SyncOutcome> {
    try {
        if (item.source === 'osv') {
            if (item.kind === 'seed') return await seedOsv(options, meta, item)
            return await refreshOsv(options, meta, item)
        }
        if (item.kind === 'seed') return await seedGemnasium(options, meta, item)
        return await refreshGemnasium(options, meta, item)
    } catch (err) {
        return {
            source: item.source,
            ecosystem: item.ecosystem,
            status: 'error',
            rowCount: 0,
            message: errText(err)
        }
    }
}

function progressFor(options: SyncOptions, item: SyncPlanItem): ProgressReporter | undefined {
    const report = options.onProgress
    if (!report) return undefined
    return function onProgress(bytesRead: number, totalBytes: number | null): void {
        report(item, bytesRead, totalBytes)
    }
}

function retryNotifierFor(options: SyncOptions, item: SyncPlanItem): ((notice: RetryNotice) => void) | undefined {
    const report = options.onRetry
    // Left undefined rather than wrapped in a no-op, so the feeds layer can tell "nobody is watching"
    // from "someone is watching and ignoring it".
    if (!report) return undefined
    return function onRetry(notice: RetryNotice): void {
        report(item, notice)
    }
}

// Every feed call carries the same cancellation and retry policy. A slow-transient rejection is a property
// of the host, not of one route, so scoping the budget to the archive download alone would leave the other
// GitLab calls on a policy that cannot clear what they will hit.
function fetchOptionsFor(options: SyncOptions, item: SyncPlanItem): FetchOptions {
    return {
        abortSignal: options.abortSignal,
        retryWaitMs: options.retryWaitMs,
        onRetry: retryNotifierFor(options, item)
    }
}

async function seedOsv(options: SyncOptions, meta: CacheMeta, item: SyncPlanItem): Promise<SyncOutcome> {
    const path = advisoryFilePath(options.cacheDir, 'osv', item.ecosystem)
    const writer = createRowWriter(path)
    let lastModified: string | null = null
    let rowCount: number
    try {
        for await (const batch of streamOsvSeed(item.ecosystem, progressFor(options, item), fetchOptionsFor(options, item))) {
            lastModified = batch.lastModified
            await writer.write(batch.rows as OsvAdvisoryRow[])
        }
        rowCount = await writer.commit()
    } catch (err) {
        await writer.abort()
        throw err
    }
    setSourceState(meta, 'osv', item.ecosystem, {
        normalizerVersion: osvNormalizerVersion(item.ecosystem),
        recordCount: rowCount,
        refreshedAt: Date.now(),
        cursorIso: lastModified,
        // A fresh seed supersedes any prior cursor, so the next refresh must re-read modified_id.csv rather
        // than trust a 304 against a copy from before the seed.
        etag: null
    })
    return { source: 'osv', ecosystem: item.ecosystem, status: 'seeded', rowCount, message: null }
}

async function refreshOsv(options: SyncOptions, meta: CacheMeta, item: SyncPlanItem): Promise<SyncOutcome> {
    const state = getSourceState(meta, 'osv', item.ecosystem)
    const cursorMs = state && state.cursorIso ? Date.parse(state.cursorIso) || 0 : 0
    const etag = state && state.etag ? state.etag : null
    const changed = await fetchOsvChangedIds(item.ecosystem, cursorMs, etag, fetchOptionsFor(options, item))
    if (changed.status === 'unchanged') {
        touch(meta, 'osv', item.ecosystem)
        return { source: 'osv', ecosystem: item.ecosystem, status: 'unchanged', rowCount: state?.recordCount ?? 0, message: null }
    }
    // Past the threshold, one request per advisory costs more than re-downloading the whole export.
    if (changed.ids.length > OSV_INCREMENTAL_MAX_IDS) {
        return await seedOsv(options, meta, { ...item, kind: 'seed' })
    }
    if (changed.ids.length === 0) {
        touch(meta, 'osv', item.ecosystem, changed.etag)
        return { source: 'osv', ecosystem: item.ecosystem, status: 'unchanged', rowCount: state?.recordCount ?? 0, message: null }
    }
    // The pass is staged and the cache file rewritten only when every changed id was re-read.
    //
    // Rewriting the file with just the advisories that were re-read kept a failed id's old rows, but
    // still published a partial pass. That is harmless to OSV matching, which reads each advisory on its
    // own, and not to gemnasium, which reads this file as withdrawal EVIDENCE across advisories: GitHub
    // withdraws GHSA-A as a duplicate of a newly published GHSA-B, both aliasing CVE-X; with A's withdrawal
    // written and B's fetch failed, every record linked to CVE-X looks withdrawn and gemnasium drops a live
    // advisory. So the file only ever moves from one complete snapshot to the next. The rewrite lands on a
    // temp file renamed into place, so a concurrent run reading the cache sees either snapshot whole.
    const append: OsvAdvisoryRow[] = []
    let failure: string | null = null
    // The id that could not be re-read; null with a failure set means the refresh was cancelled, which says
    // nothing about the feed and never counts towards the stuck-refresh fallback.
    let failedId: string | null = null
    for (const id of changed.ids) {
        if (options.abortSignal && options.abortSignal.aborted) {
            failure = 'the refresh was cancelled before every changed advisory was re-read'
            break
        }
        try {
            const rows = await fetchOsvAdvisoryRows(id, item.ecosystem, fetchOptionsFor(options, item))
            for (const row of rows) append.push(row)
        } catch (err) {
            // Nothing of this pass will be written, so the remaining fetches would be wasted.
            failure = id + ' could not be re-read (' + errText(err) + ')'
            // A fetch torn down by Ctrl-C rejects too; that is the cancellation, not the advisory.
            if (!(options.abortSignal && options.abortSignal.aborted)) failedId = id
            break
        }
    }
    if (failure !== null) {
        let message = failure + '; the previous OSV data is kept until a refresh re-reads all ' + changed.ids.length + ' changed advisories'
        // The cursor is held so the next refresh repeats this window, and the ETag is cleared — holding
        // the cursor alone would let the next refresh answer "unchanged" from the ETag and never retry.
        // The failure is an error outcome, so the run offers its usual retry.
        if (state) {
            state.etag = null
            if (failedId !== null) {
                // One advisory that keeps failing would otherwise hold the cache at its last snapshot until the
                // window crossed OSV_INCREMENTAL_MAX_IDS. Past OSV_INCREMENTAL_STUCK_MS of failures, re-seed,
                // without asking, exactly as the threshold path above does: the user consented to this cache.
                const now = Date.now()
                const failingSince = state.incrementalFailingSince ?? now
                if (now - failingSince >= OSV_INCREMENTAL_STUCK_MS) {
                    return await seedOsv(options, meta, { ...item, kind: 'seed' })
                }
                state.incrementalFailingSince = failingSince
                message += '. Refreshes have failed since ' + new Date(failingSince).toISOString() + '; if ' + failedId + ' still cannot be re-read at ' + new Date(failingSince + OSV_INCREMENTAL_STUCK_MS).toISOString() + ', the next run re-downloads the full OSV export'
            }
        }
        return {
            source: 'osv',
            ecosystem: item.ecosystem,
            status: 'error',
            rowCount: state?.recordCount ?? 0,
            message
        }
    }
    const path = advisoryFilePath(options.cacheDir, 'osv', item.ecosystem)
    const rowCount = await rewriteRows(path, { dropAdvisoryIds: new Set(changed.ids), append })
    setSourceState(meta, 'osv', item.ecosystem, {
        normalizerVersion: osvNormalizerVersion(item.ecosystem),
        recordCount: rowCount,
        refreshedAt: Date.now(),
        cursorIso: changed.newestIso ?? state?.cursorIso ?? null,
        etag: changed.etag
    })
    return {
        source: 'osv',
        ecosystem: item.ecosystem,
        status: 'refreshed',
        rowCount,
        message: changed.ids.length + ' advisor(ies) updated'
    }
}

async function seedGemnasium(options: SyncOptions, meta: CacheMeta, item: SyncPlanItem): Promise<SyncOutcome> {
    // Read the HEAD sha BEFORE downloading, and then download THAT sha rather than a branch ref. Two
    // things follow. The archive is immutable per sha, so every client on the same upstream commit shares
    // one CDN-cached object instead of each forcing GitLab to generate one (see archiveUrl). And the bytes
    // we ingest are exactly the commit we record, so there is no window between the two to replay.
    //
    // A null sha means the lookup failed; streamGemnasiumArchive falls back to the branch ref, which is
    // the behaviour this used to have unconditionally.
    const headSha = await fetchGemnasiumHeadSha(fetchOptionsFor(options, item))
    const path = advisoryFilePath(options.cacheDir, 'gemnasium', item.ecosystem)
    const writer = createRowWriter(path)
    let rowCount: number
    try {
        for await (const batch of streamGemnasiumArchive(headSha, progressFor(options, item), fetchOptionsFor(options, item))) {
            // The CLI scans JavaScript only, so keep just this ecosystem's rows out of the polyglot archive.
            const rows = batch.rows.filter(function forEcosystem(row): boolean {
                return row.ecosystem === item.ecosystem
            })
            await writer.write(rows as GemnasiumAdvisoryRow[])
        }
        rowCount = await writer.commit()
    } catch (err) {
        await writer.abort()
        throw err
    }
    setSourceState(meta, 'gemnasium', item.ecosystem, {
        normalizerVersion: GEMNASIUM_NORMALIZER_VERSION,
        recordCount: rowCount,
        refreshedAt: Date.now(),
        headSha
    })
    return { source: 'gemnasium', ecosystem: item.ecosystem, status: 'seeded', rowCount, message: null }
}

async function refreshGemnasium(options: SyncOptions, meta: CacheMeta, item: SyncPlanItem): Promise<SyncOutcome> {
    const state = getSourceState(meta, 'gemnasium', item.ecosystem)
    // Hoisted above the fetch, which narrows `state` for the whole rest of the function: an incremental
    // refresh is only possible from a stored sha, and a stored sha implies a stored state. Every
    // `state?.recordCount ?? 0` below used to re-ask a question this answers once. It also skips a
    // pointless HEAD request on the re-seed path, which the old order issued and then discarded.
    if (!state || !state.headSha) {
        return await seedGemnasium(options, meta, { ...item, kind: 'seed' })
    }
    const storedSha = state.headSha
    const headSha = await fetchGemnasiumHeadSha(fetchOptionsFor(options, item))
    if (!headSha) {
        return await seedGemnasium(options, meta, { ...item, kind: 'seed' })
    }
    if (storedSha === headSha) {
        touch(meta, 'gemnasium', item.ecosystem)
        return { source: 'gemnasium', ecosystem: item.ecosystem, status: 'unchanged', rowCount: state.recordCount, message: null }
    }
    const changed = await fetchGemnasiumChangedPaths(storedSha, headSha, fetchOptionsFor(options, item))
    if (changed.status === 'unavailable') {
        return await seedGemnasium(options, meta, { ...item, kind: 'seed' })
    }
    const relevant = changed.changed.filter(function forEcosystem(path): boolean {
        return pathEcosystemMatches(path, item.ecosystem)
    })
    const removed = changed.deleted.filter(function forEcosystem(path): boolean {
        return pathEcosystemMatches(path, item.ecosystem)
    })
    if (relevant.length === 0 && removed.length === 0) {
        // The commit touched only other ecosystems, but the sha must still advance or every later refresh
        // would re-compare from the same stale point.
        touchGemnasiumSha(state, headSha)
        return { source: 'gemnasium', ecosystem: item.ecosystem, status: 'unchanged', rowCount: state.recordCount, message: null }
    }
    const dropAdvisoryIds = new Set<string>()
    for (const path of removed.concat(relevant)) {
        const id = advisoryIdFromPath(path)
        if (id) dropAdvisoryIds.add(id)
    }
    const append: GemnasiumAdvisoryRow[] = []
    for (const path of relevant) {
        if (options.abortSignal && options.abortSignal.aborted) break
        const rows = await fetchGemnasiumFileRows(path, headSha, fetchOptionsFor(options, item))
        for (const row of rows) {
            if (row.ecosystem === item.ecosystem) append.push(row)
        }
    }
    const cachePath = advisoryFilePath(options.cacheDir, 'gemnasium', item.ecosystem)
    const rowCount = await rewriteRows(cachePath, { dropAdvisoryIds, append })
    setSourceState(meta, 'gemnasium', item.ecosystem, {
        normalizerVersion: GEMNASIUM_NORMALIZER_VERSION,
        recordCount: rowCount,
        refreshedAt: Date.now(),
        headSha
    })
    return {
        source: 'gemnasium',
        ecosystem: item.ecosystem,
        status: 'refreshed',
        rowCount,
        message: relevant.length + ' advisory file(s) updated'
    }
}

// gemnasium paths are "<packageType>/<package>/<id>.yml"; npm's package-type directory happens to share
// its name with the registry ecosystem id, which is why this can compare directly.
function pathEcosystemMatches(path: string, ecosystem: EcosystemId): boolean {
    if (ecosystem !== 'npm') return true
    return path.startsWith('npm/')
}

function touch(meta: CacheMeta, source: SourceId, ecosystem: string, etag?: string | null): void {
    const state = getSourceState(meta, source, ecosystem)
    if (!state) return
    state.refreshedAt = Date.now()
    if (etag !== undefined) state.etag = etag
    // A refresh that found nothing to re-read ends any run of failed ones.
    delete state.incrementalFailingSince
}

// Takes the state its one caller has already narrowed, rather than re-looking it up and re-guarding.
function touchGemnasiumSha(state: SourceState, headSha: string): void {
    state.refreshedAt = Date.now()
    state.headSha = headSha
}

// Row counts straight off disk, for the diagnostics output.
export async function cacheRowCount(cacheDir: string, source: SourceId, ecosystem: string): Promise<number> {
    return await countRows(advisoryFilePath(cacheDir, source, ecosystem))
}
