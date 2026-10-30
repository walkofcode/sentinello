import {
    GEMNASIUM_NORMALIZER_VERSION,
    GEMNASIUM_SEED_DOWNLOAD_BYTES,
    getEcosystem,
    osvNormalizerVersion,
    type EcosystemId,
    type GemnasiumAdvisoryRow,
    type OsvAdvisoryRow
} from '@sentinello/core'
import {
    OSV_INCREMENTAL_MAX_IDS,
    OSV_INCREMENTAL_STUCK_MS,
    gemnasiumPathIdentity,
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
import { countRows, createRowWriter, rewriteRows, rowKey, type RowWriter } from './store'

// Turns the shared feed package into a refreshed on-disk cache.
//
// There is no separate `sync` command: every scan refreshes first. That is only reasonable because the
// freshness checks are nearly free — OSV answers 304 when nothing was republished, and gemnasium reports
// its HEAD commit in about a kilobyte. The expensive path (a full seed) happens once, and only after the
// user has agreed to it.

export type SyncPlanItem = {
    source: SourceId
    // The ecosystems the item syncs. OSV publishes one export per ecosystem, so an OSV item carries exactly
    // one. gemnasium is one archive for every ecosystem, so its one item carries all the run needs: a seed
    // downloads that archive once and writes each ecosystem's file from it.
    ecosystems: EcosystemId[]
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
    // The plan item's ecosystems: one outcome per item.
    ecosystems: EcosystemId[]
    status: 'seeded' | 'refreshed' | 'unchanged' | 'skipped' | 'error'
    rowCount: number
    message: string | null
}

export type SyncOptions = {
    cacheDir: string
    sources: SourceId[]
    // The ecosystems the scanned tree holds. Only their advisories are synced: a tree of npm projects never
    // downloads the PyPI export.
    ecosystems: EcosystemId[]
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
//
// OSV is planned per ecosystem, each export on its own. gemnasium is one item for every ecosystem: one
// archive holds them all, so an ecosystem not yet seeded (or seeded by an older normalizer) re-seeds the whole
// item from one download rather than downloading the archive once per ecosystem.
export async function planSync(options: SyncOptions): Promise<SyncPlan> {
    const meta = await readCacheMeta(options.cacheDir)
    const items: SyncPlanItem[] = []
    let seedBytes = 0
    for (const { source, purpose } of syncTargets(options.sources)) {
        if (source === 'osv' && osvFeedDisabled()) continue
        if (source === 'gemnasium' && gemnasiumFeedDisabled()) continue
        const groups = source === 'osv'
            ? options.ecosystems.map(function alone(ecosystem): EcosystemId[] { return [ecosystem] })
            : [options.ecosystems.slice()]
        for (const ecosystems of groups) {
            if (ecosystems.length === 0) continue
            const seeded = ecosystems.every(function isCurrent(ecosystem): boolean {
                return isSeeded(meta, source, ecosystem, normalizerVersionOf(source, ecosystem))
            })
            if (seeded) {
                items.push({ source, ecosystems, purpose, kind: 'refresh', downloadBytes: null, downloadBytesEstimated: false })
                continue
            }
            const estimate = await estimateSeedBytes(source, ecosystems, options.abortSignal)
            if (estimate.bytes !== null) seedBytes += estimate.bytes
            items.push({
                source,
                ecosystems,
                purpose,
                kind: 'seed',
                downloadBytes: estimate.bytes,
                downloadBytesEstimated: estimate.estimated
            })
        }
    }
    return {
        items,
        seedBytes,
        needsConsent: items.some(function isSeed(i): boolean {
            return i.kind === 'seed'
        })
    }
}

// The normalizer version a (source, ecosystem) cache must have been written by: OSV's is per ecosystem, so
// a change to one ecosystem's normalizer re-downloads that export alone; gemnasium's is one number.
export function normalizerVersionOf(source: SourceId, ecosystem: string): number {
    return source === 'osv' ? osvNormalizerVersion(ecosystem) : GEMNASIUM_NORMALIZER_VERSION
}

type SeedEstimate = { bytes: number | null; estimated: boolean }

async function estimateSeedBytes(source: SourceId, ecosystems: readonly EcosystemId[], abortSignal?: AbortSignal): Promise<SeedEstimate> {
    if (source !== 'osv') {
        // GitLab generates repo archives on demand and does not advertise a length up front, so there is
        // nothing to HEAD. The constant in core is the observed size and is what the portal already quotes
        // for this same download; quoting it here too beats asking for consent to an unknown quantity.
        return { bytes: GEMNASIUM_SEED_DOWNLOAD_BYTES, estimated: true }
    }
    try {
        const info = await headOsvSeed(osvEcosystemOf(ecosystems), { abortSignal })
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
                ecosystems: item.ecosystems,
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
            ecosystems: item.ecosystems,
            status: 'error',
            rowCount: 0,
            message: errText(err)
        }
    }
}

// The one ecosystem of an OSV item. planSync builds every OSV item with exactly one, so the first is it.
function osvEcosystemOf(ecosystems: readonly EcosystemId[]): EcosystemId {
    return ecosystems[0] as EcosystemId
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
    const ecosystem = osvEcosystemOf(item.ecosystems)
    const path = advisoryFilePath(options.cacheDir, 'osv', ecosystem)
    const writer = createRowWriter(path)
    let lastModified: string | null = null
    let rowCount: number
    try {
        for await (const batch of streamOsvSeed(ecosystem, progressFor(options, item), fetchOptionsFor(options, item))) {
            lastModified = batch.lastModified
            await writer.write(batch.rows as OsvAdvisoryRow[])
        }
        rowCount = await writer.commit()
    } catch (err) {
        await writer.abort()
        throw err
    }
    setSourceState(meta, 'osv', ecosystem, {
        normalizerVersion: osvNormalizerVersion(ecosystem),
        recordCount: rowCount,
        refreshedAt: Date.now(),
        cursorIso: lastModified,
        // A fresh seed supersedes any prior cursor, so the next refresh must re-read modified_id.csv rather
        // than trust a 304 against a copy from before the seed.
        etag: null
    })
    return { source: 'osv', ecosystems: item.ecosystems, status: 'seeded', rowCount, message: null }
}

async function refreshOsv(options: SyncOptions, meta: CacheMeta, item: SyncPlanItem): Promise<SyncOutcome> {
    const ecosystem = osvEcosystemOf(item.ecosystems)
    const state = getSourceState(meta, 'osv', ecosystem)
    const cursorMs = state && state.cursorIso ? Date.parse(state.cursorIso) || 0 : 0
    const etag = state && state.etag ? state.etag : null
    const changed = await fetchOsvChangedIds(ecosystem, cursorMs, etag, fetchOptionsFor(options, item))
    if (changed.status === 'unchanged') {
        touch(meta, 'osv', ecosystem)
        return { source: 'osv', ecosystems: item.ecosystems, status: 'unchanged', rowCount: state?.recordCount ?? 0, message: null }
    }
    // Past the threshold, one request per advisory costs more than re-downloading the whole export.
    if (changed.ids.length > OSV_INCREMENTAL_MAX_IDS) {
        return await seedOsv(options, meta, { ...item, kind: 'seed' })
    }
    if (changed.ids.length === 0) {
        touch(meta, 'osv', ecosystem, changed.etag)
        return { source: 'osv', ecosystems: item.ecosystems, status: 'unchanged', rowCount: state?.recordCount ?? 0, message: null }
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
            const rows = await fetchOsvAdvisoryRows(id, ecosystem, fetchOptionsFor(options, item))
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
            ecosystems: item.ecosystems,
            status: 'error',
            rowCount: state?.recordCount ?? 0,
            message
        }
    }
    const path = advisoryFilePath(options.cacheDir, 'osv', ecosystem)
    const rowCount = await rewriteRows(path, { dropAdvisoryIds: new Set(changed.ids), append })
    setSourceState(meta, 'osv', ecosystem, {
        normalizerVersion: osvNormalizerVersion(ecosystem),
        recordCount: rowCount,
        refreshedAt: Date.now(),
        cursorIso: changed.newestIso ?? state?.cursorIso ?? null,
        etag: changed.etag
    })
    return {
        source: 'osv',
        ecosystems: item.ecosystems,
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
    // One writer per ecosystem, all fed from the one archive: it holds every ecosystem, so seeding the five
    // costs the same single download as seeding one. Rows of an ecosystem the run does not need are dropped.
    const writers = new Map<string, RowWriter>()
    for (const ecosystem of item.ecosystems) {
        writers.set(ecosystem, createRowWriter(advisoryFilePath(options.cacheDir, 'gemnasium', ecosystem)))
    }
    const counts = new Map<string, number>()
    try {
        for await (const batch of streamGemnasiumArchive(headSha, progressFor(options, item), fetchOptionsFor(options, item))) {
            const byEcosystem = new Map<string, GemnasiumAdvisoryRow[]>()
            for (const row of batch.rows) {
                if (!writers.has(row.ecosystem)) continue
                const list = byEcosystem.get(row.ecosystem)
                if (list) list.push(row)
                else byEcosystem.set(row.ecosystem, [row])
            }
            for (const [ecosystem, rows] of byEcosystem) await (writers.get(ecosystem) as RowWriter).write(rows)
        }
        for (const [ecosystem, writer] of writers) counts.set(ecosystem, await writer.commit())
    } catch (err) {
        // Every file not yet renamed into place is discarded, so each ecosystem keeps its previous cache.
        for (const writer of writers.values()) await writer.abort()
        throw err
    }
    let rowCount = 0
    for (const [ecosystem, count] of counts) {
        setSourceState(meta, 'gemnasium', ecosystem, {
            normalizerVersion: GEMNASIUM_NORMALIZER_VERSION,
            recordCount: count,
            refreshedAt: Date.now(),
            headSha
        })
        rowCount += count
    }
    return { source: 'gemnasium', ecosystems: item.ecosystems, status: 'seeded', rowCount, message: null }
}

type GemnasiumCell = { ecosystem: EcosystemId; state: SourceState }

async function refreshGemnasium(options: SyncOptions, meta: CacheMeta, item: SyncPlanItem): Promise<SyncOutcome> {
    // An incremental refresh is only possible from a stored sha, so any ecosystem without one re-seeds the
    // item. It also skips a pointless HEAD request on that path.
    const bySha = new Map<string, GemnasiumCell[]>()
    for (const ecosystem of item.ecosystems) {
        const state = getSourceState(meta, 'gemnasium', ecosystem)
        if (!state || !state.headSha) return await seedGemnasium(options, meta, { ...item, kind: 'seed' })
        // Ecosystems first seeded by different runs sit at different commits: each commit is compared once,
        // for every ecosystem it holds.
        const cells = bySha.get(state.headSha)
        if (cells) cells.push({ ecosystem, state })
        else bySha.set(state.headSha, [{ ecosystem, state }])
    }
    const headSha = await fetchGemnasiumHeadSha(fetchOptionsFor(options, item))
    if (!headSha) {
        return await seedGemnasium(options, meta, { ...item, kind: 'seed' })
    }
    let updatedFiles = 0
    for (const [storedSha, cells] of bySha) {
        if (storedSha === headSha) {
            for (const cell of cells) touch(meta, 'gemnasium', cell.ecosystem)
            continue
        }
        const changed = await fetchGemnasiumChangedPaths(storedSha, headSha, fetchOptionsFor(options, item))
        if (changed.status === 'unavailable') {
            return await seedGemnasium(options, meta, { ...item, kind: 'seed' })
        }
        for (const cell of cells) {
            updatedFiles += await applyGemnasiumChanges(options, meta, item, cell, changed, headSha)
        }
    }
    // Every ecosystem had a state on entry (or the item re-seeded), and a refresh only ever replaces one.
    let rowCount = 0
    for (const ecosystem of item.ecosystems) rowCount += (getSourceState(meta, 'gemnasium', ecosystem) as SourceState).recordCount
    if (updatedFiles === 0) {
        return { source: 'gemnasium', ecosystems: item.ecosystems, status: 'unchanged', rowCount, message: null }
    }
    return {
        source: 'gemnasium',
        ecosystems: item.ecosystems,
        status: 'refreshed',
        rowCount,
        message: updatedFiles + ' advisory file(s) updated'
    }
}

// Applies one compare to one ecosystem's file and returns how many of its advisory files changed.
//
// Only this ecosystem's paths touch this file, and only the (package, advisory) each changed or deleted file
// held is dropped from it. Dropping by advisory id alone, as this once did with every non-npm path passing
// the filter, deleted another ecosystem's rows (or another package's) sharing the id and re-appended none.
// The pass is staged: nothing is written until every changed file was re-read, so a cancelled or failed one
// keeps the previous file and its sha, and the next refresh repeats the window.
async function applyGemnasiumChanges(
    options: SyncOptions,
    meta: CacheMeta,
    item: SyncPlanItem,
    cell: GemnasiumCell,
    changed: { changed: string[]; deleted: string[] },
    headSha: string
): Promise<number> {
    const relevant = changed.changed.filter(function forEcosystem(path): boolean {
        return pathEcosystemMatches(path, cell.ecosystem)
    })
    const removed = changed.deleted.filter(function forEcosystem(path): boolean {
        return pathEcosystemMatches(path, cell.ecosystem)
    })
    if (relevant.length === 0 && removed.length === 0) {
        // The commit touched only other ecosystems, but the sha must still advance or every later refresh
        // would re-compare from the same stale point.
        touchGemnasiumSha(cell.state, headSha)
        return 0
    }
    const dropRowKeys = new Set<string>()
    for (const path of removed.concat(relevant)) {
        const key = gemnasiumPathRowKey(path)
        if (key !== null) dropRowKeys.add(key)
    }
    const append: GemnasiumAdvisoryRow[] = []
    for (const path of relevant) {
        if (options.abortSignal && options.abortSignal.aborted) {
            throw new Error('the refresh was cancelled before every changed advisory file was re-read; the previous gemnasium data is kept')
        }
        for (const row of await fetchGemnasiumFileRows(path, headSha, fetchOptionsFor(options, item))) {
            if (row.ecosystem !== cell.ecosystem) continue
            append.push(row)
            // The file's rows replace what it held, whatever name its package_slug spells.
            dropRowKeys.add(rowKey(row.packageName, row.advisoryId))
        }
    }
    const rowCount = await rewriteRows(advisoryFilePath(options.cacheDir, 'gemnasium', cell.ecosystem), { dropRowKeys, append })
    setSourceState(meta, 'gemnasium', cell.ecosystem, {
        normalizerVersion: GEMNASIUM_NORMALIZER_VERSION,
        recordCount: rowCount,
        refreshedAt: Date.now(),
        headSha
    })
    return relevant.length + removed.length
}

// gemnasium paths are "<packageType>/<package>/<id>.yml". The package-type directory is not the ecosystem id
// ('pypi' holds PyPI, 'cargo' crates.io, 'gem' RubyGems), so it comes from the registry, the same mapping the
// feed parses the archive with. This used to compare npm's directory directly and pass every other path
// through, which is harmless while one ecosystem shares the cache and deletes rows once several do.
export function pathEcosystemMatches(path: string, ecosystem: string): boolean {
    const definition = getEcosystem(ecosystem)
    if (definition === null) return false
    return path.startsWith(definition.gemnasiumPackageType + '/')
}

// The rowKey of the one (package, advisory) a gemnasium file holds, read from its path by the feed's own
// gemnasiumPathIdentity (the worker's incremental sync reads it the same way). Null for a path with no package
// or no file, such as a deleted directory entry.
export function gemnasiumPathRowKey(path: string): string | null {
    const identity = gemnasiumPathIdentity(path)
    return identity === null ? null : rowKey(identity.packageName, identity.advisoryId)
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
