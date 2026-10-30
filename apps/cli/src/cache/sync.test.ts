import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GEMNASIUM_NORMALIZER_VERSION, GEMNASIUM_SEED_DOWNLOAD_BYTES, osvNormalizerVersion, type EcosystemId, type GemnasiumAdvisoryRow, type OsvAdvisoryRow } from '@sentinello/core'
import { advisoryFilePath, ensureCacheDir, getSourceState, readCacheMeta, setSourceState, writeCacheMeta, type SourceId, type SourceState } from './meta'
import { createRowWriter, readRowsForPackages, rowKey } from './store'

// Turns the shared feed package into a refreshed on-disk cache. @sentinello/feeds is the only thing
// stubbed, and only because it owns the network — every cache file below is real gzipped NDJSON written
// and rewritten through the production writer, and every meta read/write is the real JSON round-trip.
//
// The branch worth the most attention is seed-vs-refresh, because getting it wrong is expensive in both
// directions: a needless seed re-downloads ~100 MB, and a missed one leaves the cache silently stale. The
// escalation rules (too many changed ids, a missing sha, an unavailable compare) all collapse to "re-seed",
// and each is pinned separately here because they are reached by completely different upstream conditions.

const feeds = vi.hoisted(function makeFeedDoubles() {
    return {
        headOsvSeed: vi.fn(),
        streamOsvSeed: vi.fn(),
        fetchOsvChangedIds: vi.fn(),
        fetchOsvAdvisoryRows: vi.fn(),
        fetchGemnasiumHeadSha: vi.fn(),
        fetchGemnasiumChangedPaths: vi.fn(),
        fetchGemnasiumFileRows: vi.fn(),
        streamGemnasiumArchive: vi.fn(),
        osvFeedDisabled: vi.fn(),
        gemnasiumFeedDisabled: vi.fn()
    }
})

vi.mock('@sentinello/feeds', async function mockFeeds(importOriginal) {
    // Keep the real constants and errText — only the network-owning functions are replaced.
    const actual = await importOriginal<typeof import('@sentinello/feeds')>()
    return { ...actual, ...feeds }
})

const { cacheRowCount, gemnasiumPathRowKey, normalizerVersionOf, pathEcosystemMatches, planSync, runSync } = await import('./sync')

const T0 = Date.UTC(2026, 0, 1)

let dir: string

function options(overrides: Partial<Parameters<typeof runSync>[0]> = {}) {
    return {
        cacheDir: dir,
        sources: ['osv', 'gemnasium'] as SourceId[],
        ecosystems: ['npm'] as EcosystemId[],
        ...overrides
    }
}

function osvRow(overrides: Partial<OsvAdvisoryRow> = {}): OsvAdvisoryRow {
    return {
        advisoryId: 'GHSA-aaaa',
        ecosystem: 'npm',
        packageName: 'lodash',
        aliases: [],
        ranges: [],
        versions: [],
        severity: 'high',
        summary: null,
        url: null,
        malicious: false,
        withdrawn: null,
        ...overrides
    } as OsvAdvisoryRow
}

function gemRow(overrides: Partial<GemnasiumAdvisoryRow> = {}): GemnasiumAdvisoryRow {
    return {
        advisoryId: 'GMS-2024-1',
        ecosystem: 'npm',
        packageName: 'lodash',
        aliases: [],
        ranges: [],
        versions: [],
        severity: 'high',
        summary: null,
        url: null,
        ...overrides
    } as GemnasiumAdvisoryRow
}

// Turns an array of batches into the async generator the seed streamers return.
function streamOf<T>(batches: readonly T[]) {
    return async function* stream() {
        for (const batch of batches) yield batch
    }
}

async function seedFile(source: SourceId, rows: readonly object[]): Promise<void> {
    await ensureCacheDir(dir)
    const writer = createRowWriter(advisoryFilePath(dir, source, 'npm'))
    await writer.write(rows as never)
    await writer.commit()
}

async function seedState(source: SourceId, overrides: Partial<SourceState> = {}): Promise<void> {
    const meta = await readCacheMeta(dir)
    setSourceState(meta, source, 'npm', {
        normalizerVersion: source === 'osv' ? osvNormalizerVersion('npm') : GEMNASIUM_NORMALIZER_VERSION,
        recordCount: 1,
        refreshedAt: T0,
        ...overrides
    })
    await writeCacheMeta(dir, meta)
}

async function stateOf(source: SourceId): Promise<SourceState | null> {
    return getSourceState(await readCacheMeta(dir), source, 'npm')
}

beforeEach(async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-sync-'))
    feeds.osvFeedDisabled.mockReturnValue(false)
    feeds.gemnasiumFeedDisabled.mockReturnValue(false)
    feeds.headOsvSeed.mockResolvedValue({ contentLength: 96 * 1024 * 1024 })
    feeds.streamOsvSeed.mockImplementation(streamOf([{ rows: [osvRow()], lastModified: '2026-07-01T00:00:00Z' }]))
    feeds.streamGemnasiumArchive.mockImplementation(streamOf([{ rows: [gemRow()] }]))
    feeds.fetchGemnasiumHeadSha.mockResolvedValue('a'.repeat(40))
    feeds.fetchOsvChangedIds.mockResolvedValue({ status: 'ok', ids: [], etag: 'etag-1', newestIso: null })
    feeds.fetchOsvAdvisoryRows.mockResolvedValue([])
    feeds.fetchGemnasiumChangedPaths.mockResolvedValue({ status: 'ok', changed: [], deleted: [] })
    feeds.fetchGemnasiumFileRows.mockResolvedValue([])
})

afterEach(async function teardown() {
    vi.clearAllMocks()
    vi.useRealTimers()
    await rm(dir, { recursive: true, force: true })
})

describe('retry notices', function () {
    // The feeds layer reports a slow-transient wait so the terminal can say why it is sitting there.
    // sync relays it with the plan item attached, because the UI names the source in that line and the
    // feeds layer has no idea which source it is downloading for.
    it('relays a feed retry notice with the item that caused it', async function () {
        const notices: { source: string; waitMs: number }[] = []
        feeds.streamGemnasiumArchive.mockImplementation(function stream(_ref: unknown, _progress: unknown, opts: { onRetry?: (n: unknown) => void }) {
            if (opts && opts.onRetry) opts.onRetry({ status: 406, attempt: 1, waitMs: 2_000, elapsedMs: 0, budgetMs: 15_000 })
            return streamOf([{ rows: [gemRow()] }])()
        })
        const opts = options({
            sources: ['gemnasium'],
            onRetry: function record(item, notice) {
                notices.push({ source: item.source, waitMs: notice.waitMs })
            }
        })
        await runSync(opts, await planSync(opts))
        expect(notices).toEqual([{ source: 'gemnasium', waitMs: 2_000 }])
    })

    // Without a listener the relay must stay undefined rather than becoming a no-op closure, so the
    // feeds layer can tell "nobody is watching" from "someone is watching and ignoring it".
    it('passes no notifier through when the caller supplied none', async function () {
        let sawOnRetry: unknown = 'unset'
        feeds.streamGemnasiumArchive.mockImplementation(function stream(_ref: unknown, _progress: unknown, opts: { onRetry?: unknown }) {
            sawOnRetry = opts.onRetry
            return streamOf([{ rows: [gemRow()] }])()
        })
        const opts = options({ sources: ['gemnasium'] })
        await runSync(opts, await planSync(opts))
        expect(sawOnRetry).toBeUndefined()
    })

    // The budget is threaded from the CLI flag down to every feed call, not just the archive download:
    // while a block holds, the HEAD-sha and compare calls fail exactly as the download does.
    it('threads the retry budget to the feed calls', async function () {
        let seen: number | undefined
        feeds.streamGemnasiumArchive.mockImplementation(function stream(_ref: unknown, _progress: unknown, opts: { retryWaitMs?: number }) {
            seen = opts.retryWaitMs
            return streamOf([{ rows: [gemRow()] }])()
        })
        const opts = options({ sources: ['gemnasium'], retryWaitMs: 5_000 })
        await runSync(opts, await planSync(opts))
        expect(seen).toBe(5_000)
    })
})

describe('planSync', function () {
    it('plans a seed for each source on a cold cache and asks for consent', async function () {
        const plan = await planSync(options())
        expect(plan.items.map(function kind(i) { return i.source + ':' + i.kind })).toEqual(['osv:seed', 'gemnasium:seed'])
        expect(plan.needsConsent).toBe(true)
    })

    it('plans a refresh, needing no consent, once a source is seeded at the current normalizer', async function () {
        await seedState('osv')
        const plan = await planSync(options({ sources: ['osv'] }))
        expect(plan.items[0]).toMatchObject({ kind: 'refresh', downloadBytes: null })
        expect(plan.needsConsent).toBe(false)
    })

    // A cache written by an older normalizer is treated as absent rather than matched with wrong semantics.
    it('plans a re-seed when the cached rows came from an older normalizer', async function () {
        await seedState('osv', { normalizerVersion: osvNormalizerVersion('npm') - 1 })
        const plan = await planSync(options({ sources: ['osv'] }))
        expect(plan.items[0]?.kind).toBe('seed')
    })

    it('plans a seed when the metadata claims zero rows', async function () {
        await seedState('osv', { recordCount: 0 })
        expect((await planSync(options({ sources: ['osv'] }))).items[0]?.kind).toBe('seed')
    })

    it('quotes the real transfer size for an OSV seed, unflagged because the server advertised it', async function () {
        const plan = await planSync(options({ sources: ['osv'] }))
        expect(plan.items[0]).toMatchObject({ downloadBytes: 96 * 1024 * 1024, downloadBytesEstimated: false })
        expect(plan.seedBytes).toBe(96 * 1024 * 1024)
    })

    // GitLab generates repo archives on demand and advertises no length up front, so there is nothing to
    // HEAD. Quoting the measured constant the portal already shows beats asking to approve an unknown
    // quantity; the estimated flag is what keeps it rendering as "~80 MB" rather than an exact figure.
    it('quotes the measured constant for a gemnasium seed and flags it as an estimate', async function () {
        // OSV's feed is off so gemnasium is the only item: no withdrawal evidence can be planned.
        feeds.osvFeedDisabled.mockReturnValue(true)
        const plan = await planSync(options({ sources: ['gemnasium'] }))
        expect(plan.items[0]).toMatchObject({
            downloadBytes: GEMNASIUM_SEED_DOWNLOAD_BYTES,
            downloadBytesEstimated: true
        })
        expect(plan.seedBytes).toBe(GEMNASIUM_SEED_DOWNLOAD_BYTES)
    })

    it('counts an estimated seed towards the plan total alongside a measured one', async function () {
        const plan = await planSync(options())
        expect(plan.seedBytes).toBe(96 * 1024 * 1024 + GEMNASIUM_SEED_DOWNLOAD_BYTES)
    })

    it('falls back to an unknown size when the HEAD request fails', async function () {
        feeds.headOsvSeed.mockRejectedValue(new Error('network down'))
        const plan = await planSync(options({ sources: ['osv'] }))
        expect(plan.items[0]).toMatchObject({ downloadBytes: null, downloadBytesEstimated: false })
    })

    it('omits a source whose feed is switched off', async function () {
        feeds.osvFeedDisabled.mockReturnValue(true)
        const plan = await planSync(options())
        expect(plan.items.map(function s(i) { return i.source })).toEqual(['gemnasium'])
    })

    it('plans nothing when every feed is switched off', async function () {
        feeds.osvFeedDisabled.mockReturnValue(true)
        feeds.gemnasiumFeedDisabled.mockReturnValue(true)
        const plan = await planSync(options())
        expect(plan.items).toEqual([])
        expect(plan.needsConsent).toBe(false)
    })

    it('marks every selected source as planned for findings', async function () {
        const plan = await planSync(options())
        expect(plan.items.map(function p(i) { return i.source + ':' + i.purpose })).toEqual(['osv:findings', 'gemnasium:findings'])
    })
})

// gemnasium-db records no withdrawal, so a gemnasium run needs OSV as its withdrawal evidence even when
// OSV is not a selected source (SENTINEL-45). It rides the same plan: a first download goes through the
// same consent prompt and --yes, and every later run refreshes it, so the evidence is as fresh as the run.
describe('planSync — withdrawal evidence for gemnasium', function () {
    it('adds an OSV evidence seed, listed for consent, when OSV is not seeded', async function () {
        await seedState('gemnasium')
        const plan = await planSync(options({ sources: ['gemnasium'] }))
        expect(plan.items.map(function p(i) { return i.source + ':' + i.kind + ':' + i.purpose })).toEqual(['gemnasium:refresh:findings', 'osv:seed:withdrawal-evidence'])
        expect(plan.items[1]).toMatchObject({ downloadBytes: 96 * 1024 * 1024 })
        expect(plan.seedBytes).toBe(96 * 1024 * 1024)
        expect(plan.needsConsent).toBe(true)
    })

    it('adds an OSV evidence refresh, needing no consent, once OSV is seeded', async function () {
        await seedState('gemnasium')
        await seedState('osv')
        const plan = await planSync(options({ sources: ['gemnasium'] }))
        expect(plan.items.map(function p(i) { return i.source + ':' + i.kind + ':' + i.purpose })).toEqual(['gemnasium:refresh:findings', 'osv:refresh:withdrawal-evidence'])
        expect(plan.needsConsent).toBe(false)
    })

    it('re-seeds the evidence when it came from an older normalizer', async function () {
        await seedState('gemnasium')
        await seedState('osv', { normalizerVersion: osvNormalizerVersion('npm') - 1 })
        const plan = await planSync(options({ sources: ['gemnasium'] }))
        expect(plan.items[1]).toMatchObject({ source: 'osv', kind: 'seed', purpose: 'withdrawal-evidence' })
    })

    it('plans no evidence when the OSV feed is switched off', async function () {
        feeds.osvFeedDisabled.mockReturnValue(true)
        const plan = await planSync(options({ sources: ['gemnasium'] }))
        expect(plan.items.map(function s(i) { return i.source })).toEqual(['gemnasium'])
    })

    it('plans no evidence when OSV is selected anyway, since it is already synced for findings', async function () {
        const plan = await planSync(options())
        expect(plan.items.filter(function e(i) { return i.purpose === 'withdrawal-evidence' })).toEqual([])
    })

    it('plans no evidence for a run without gemnasium', async function () {
        const plan = await planSync(options({ sources: ['osv'] }))
        expect(plan.items.map(function p(i) { return i.source + ':' + i.purpose })).toEqual(['osv:findings'])
    })

    it('syncs the evidence item through the OSV refresh like any other', async function () {
        await seedState('gemnasium', { headSha: 'a'.repeat(40) })
        await seedFile('osv', [osvRow()])
        await seedState('osv')
        feeds.fetchOsvChangedIds.mockResolvedValue({ status: 'unchanged' })
        const outcomes = await runSync(options({ sources: ['gemnasium'] }), await planSync(options({ sources: ['gemnasium'] })))
        expect(outcomes.map(function o(x) { return x.source + ':' + x.status })).toEqual(['gemnasium:unchanged', 'osv:unchanged'])
    })
})

describe('runSync — lock and lifecycle', function () {
    it('does nothing at all for an empty plan', async function () {
        expect(await runSync(options(), { items: [], seedBytes: 0, needsConsent: false })).toEqual([])
    })

    // A slightly stale read beats blocking a developer's terminal behind someone else's 200 MB download.
    it('skips every item rather than waiting when another process holds the lock', async function () {
        await ensureCacheDir(dir)
        await writeFile(join(dir, '.lock'), '99999', 'utf8')
        const outcomes = await runSync(options(), await planSync(options()))
        expect(outcomes.map(function s(o) { return o.status })).toEqual(['skipped', 'skipped'])
        expect(outcomes[0]?.message).toBe('another sentinello process is syncing the cache')
        expect(feeds.streamOsvSeed).not.toHaveBeenCalled()
    })

    it('releases the lock when the run completes', async function () {
        await runSync(options({ sources: ['osv'] }), await planSync(options({ sources: ['osv'] })))
        expect(await cacheRowCount(dir, 'osv', 'npm')).toBe(1)
        // A second run must be able to acquire the lock again. 'unchanged' rather than 'skipped' is what
        // proves it: the first run seeded, so this one takes the refresh path and finds nothing new.
        // Asserted positively — `not.toBe('skipped')` would pass on an empty outcome list.
        const again = await runSync(options({ sources: ['osv'] }), await planSync(options({ sources: ['osv'] })))
        expect(again.map(function status(o) { return o.status })).toEqual(['unchanged'])
    })

    it('reports progress and status callbacks per item', async function () {
        const statuses: string[] = []
        const opts = options({
            sources: ['osv'],
            onStatus: function onStatus(item, phase) { statuses.push(item.source + ':' + phase) }
        })
        await runSync(opts, await planSync(opts))
        expect(statuses).toEqual(['osv:start', 'osv:done'])
    })

    it('forwards download progress with the item it belongs to', async function () {
        const seen: Array<{ source: string; read: number; total: number | null }> = []
        feeds.streamOsvSeed.mockImplementation(function stream(_eco: unknown, onProgress: (r: number, t: number | null) => void) {
            if (onProgress) onProgress(2048, 4096)
            return streamOf([{ rows: [osvRow()], lastModified: null }])()
        })
        const opts = options({
            sources: ['osv'],
            onProgress: function onProgress(item, read, total) { seen.push({ source: item.source, read, total }) }
        })
        await runSync(opts, await planSync(opts))
        expect(seen).toEqual([{ source: 'osv', read: 2048, total: 4096 }])
    })

    it('stops before the next item once aborted', async function () {
        const controller = new AbortController()
        controller.abort()
        const opts = options({ abortSignal: controller.signal })
        const outcomes = await runSync(opts, await planSync(options()))
        expect(outcomes).toEqual([])
    })

    // One source failing must leave the others intact.
    it('records an error for the failing source and still syncs the other', async function () {
        feeds.streamOsvSeed.mockImplementation(function throws() { throw new Error('connection reset') })
        const outcomes = await runSync(options(), await planSync(options()))
        expect(outcomes[0]).toMatchObject({ source: 'osv', status: 'error', message: 'connection reset', rowCount: 0 })
        expect(outcomes[1]).toMatchObject({ source: 'gemnasium', status: 'seeded' })
    })

    // Writes land on a temp file and are renamed only on success, so a failure never destroys a good cache.
    it('leaves a previously good cache intact when a re-seed fails midway', async function () {
        await seedFile('osv', [osvRow({ advisoryId: 'GHSA-old' })])
        feeds.streamOsvSeed.mockImplementation(async function* partial() {
            yield { rows: [osvRow()], lastModified: null }
            throw new Error('connection reset')
        })
        await runSync(options({ sources: ['osv'] }), await planSync(options({ sources: ['osv'] })))
        expect(await cacheRowCount(dir, 'osv', 'npm')).toBe(1)
    })
})

describe('runSync — OSV', function () {
    it('writes the streamed rows and records the cursor from the seed', async function () {
        const outcomes = await runSync(options({ sources: ['osv'] }), await planSync(options({ sources: ['osv'] })))
        expect(outcomes[0]).toMatchObject({ status: 'seeded', rowCount: 1 })
        expect(await stateOf('osv')).toMatchObject({ cursorIso: '2026-07-01T00:00:00Z', recordCount: 1 })
    })

    // A fresh seed supersedes any prior cursor, so the next refresh must re-read modified_id.csv rather
    // than trust a 304 against a copy from before the seed.
    it('clears the etag on a seed', async function () {
        await seedState('osv', { etag: 'stale-etag', normalizerVersion: osvNormalizerVersion('npm') - 1 })
        await runSync(options({ sources: ['osv'] }), await planSync(options({ sources: ['osv'] })))
        expect((await stateOf('osv'))?.etag).toBeNull()
    })

    it('reports unchanged and advances nothing when upstream answers 304', async function () {
        await seedFile('osv', [osvRow()])
        await seedState('osv', { recordCount: 5, etag: 'etag-0' })
        feeds.fetchOsvChangedIds.mockResolvedValue({ status: 'unchanged' })
        const outcomes = await runSync(options({ sources: ['osv'] }), await planSync(options({ sources: ['osv'] })))
        expect(outcomes[0]).toMatchObject({ status: 'unchanged', rowCount: 5 })
        expect((await stateOf('osv'))?.etag).toBe('etag-0')
    })

    it('records the new etag when nothing changed but the cursor moved', async function () {
        await seedFile('osv', [osvRow()])
        await seedState('osv', { recordCount: 5, etag: 'etag-0' })
        feeds.fetchOsvChangedIds.mockResolvedValue({ status: 'ok', ids: [], etag: 'etag-1', newestIso: null })
        const outcomes = await runSync(options({ sources: ['osv'] }), await planSync(options({ sources: ['osv'] })))
        expect(outcomes[0]?.status).toBe('unchanged')
        expect((await stateOf('osv'))?.etag).toBe('etag-1')
    })

    it('applies an incremental update by dropping and re-appending the changed advisories', async function () {
        await seedFile('osv', [osvRow({ advisoryId: 'GHSA-keep' }), osvRow({ advisoryId: 'GHSA-change' })])
        await seedState('osv', { recordCount: 2 })
        feeds.fetchOsvChangedIds.mockResolvedValue({ status: 'ok', ids: ['GHSA-change'], etag: 'etag-2', newestIso: '2026-07-02T00:00:00Z' })
        feeds.fetchOsvAdvisoryRows.mockResolvedValue([
            osvRow({ advisoryId: 'GHSA-change', packageName: 'express' }),
            osvRow({ advisoryId: 'GHSA-change', packageName: 'lodash' })
        ])
        const outcomes = await runSync(options({ sources: ['osv'] }), await planSync(options({ sources: ['osv'] })))
        expect(outcomes[0]).toMatchObject({ status: 'refreshed', rowCount: 3, message: '1 advisor(ies) updated' })
        expect(await stateOf('osv')).toMatchObject({ cursorIso: '2026-07-02T00:00:00Z', etag: 'etag-2' })
    })

    // A withdrawn advisory is not a deletion: its rows come back flagged and replace the active ones, so
    // nothing matches on them while gemnasium can still see the withdrawal (SENTINEL-42). The old refresh
    // dropped the advisory, which is how a withdrawal published after the seed vanished from the cache.
    it('keeps the rows of an advisory that came back withdrawn, flagged', async function () {
        const withdrawnAt = Date.UTC(2026, 9, 23)
        await seedFile('osv', [osvRow({ advisoryId: 'GHSA-keep' }), osvRow({ advisoryId: 'GHSA-gone', packageName: 'braces' })])
        await seedState('osv', { recordCount: 2 })
        feeds.fetchOsvChangedIds.mockResolvedValue({ status: 'ok', ids: ['GHSA-gone'], etag: 'etag-2', newestIso: '2026-10-23T12:53:02Z' })
        // Range-less too (SENTINEL-47): the row is evidence only, so it needs no ranges or versions.
        feeds.fetchOsvAdvisoryRows.mockResolvedValue([osvRow({ advisoryId: 'GHSA-gone', packageName: 'braces', withdrawn: withdrawnAt })])
        const outcomes = await runSync(options({ sources: ['osv'] }), await planSync(options({ sources: ['osv'] })))
        expect(outcomes[0]).toMatchObject({ status: 'refreshed', rowCount: 2 })
        const rows = await readRowsForPackages<OsvAdvisoryRow>(advisoryFilePath(dir, 'osv', 'npm'), new Set(['braces']))
        expect(rows.get('braces')).toEqual([expect.objectContaining({ advisoryId: 'GHSA-gone', withdrawn: withdrawnAt, ranges: [], versions: [] })])
    })

    // Past the threshold, one request per advisory costs more than re-downloading the whole export.
    it('escalates to a full re-seed when too many advisories changed', async function () {
        await seedFile('osv', [osvRow()])
        await seedState('osv')
        const { OSV_INCREMENTAL_MAX_IDS } = await import('@sentinello/feeds')
        feeds.fetchOsvChangedIds.mockResolvedValue({
            status: 'changed',
            ids: Array.from({ length: OSV_INCREMENTAL_MAX_IDS + 1 }, function id(_u, i) { return 'GHSA-' + i }),
            etag: 'etag-2',
            newestIso: null
        })
        const outcomes = await runSync(options({ sources: ['osv'] }), await planSync(options({ sources: ['osv'] })))
        expect(outcomes[0]?.status).toBe('seeded')
        expect(feeds.streamOsvSeed).toHaveBeenCalled()
        expect(feeds.fetchOsvAdvisoryRows).not.toHaveBeenCalled()
    })

    // The rows of an advisory we could not re-read must survive. Dropping the whole changed set while
    // appending only the successful subset deleted every id that timed out, and the cursor then moved past
    // them — so each flaky run monotonically shrank the user's cache while reporting success.
    it('keeps the rows of an advisory that failed to fetch', async function () {
        await seedFile('osv', [osvRow({ advisoryId: 'GHSA-bad', packageName: 'lodash' })])
        await seedState('osv', { cursorIso: '2026-06-01T00:00:00Z', etag: 'etag-0' })
        feeds.fetchOsvChangedIds.mockResolvedValue({ status: 'ok', ids: ['GHSA-bad'], etag: 'etag-2', newestIso: '2026-07-02T00:00:00Z' })
        feeds.fetchOsvAdvisoryRows.mockRejectedValue(new Error('connection reset'))

        const outcomes = await runSync(options({ sources: ['osv'] }), await planSync(options({ sources: ['osv'] })))

        expect(outcomes[0]).toMatchObject({ status: 'error', rowCount: 1 })
        expect(outcomes[0]?.message).toContain('GHSA-bad could not be re-read (connection reset)')
        expect(await cacheRowCount(dir, 'osv', 'npm')).toBe(1)
        // Cursor held so the id is retried, and the ETag cleared so the retry is not answered by a 304.
        expect(await stateOf('osv')).toMatchObject({ cursorIso: '2026-06-01T00:00:00Z', etag: null, refreshedAt: T0 })
    })

    // A pass is all or nothing: one advisory failing writes nothing of it, so fetching the rest would be
    // wasted. The error outcome is what offers the run's retry.
    it('writes nothing of a pass in which one advisory failed, and stops fetching', async function () {
        await seedFile('osv', [osvRow({ advisoryId: 'GHSA-keep' })])
        await seedState('osv')
        feeds.fetchOsvChangedIds.mockResolvedValue({ status: 'ok', ids: ['GHSA-good', 'GHSA-bad', 'GHSA-later'], etag: null, newestIso: null })
        feeds.fetchOsvAdvisoryRows.mockImplementation(async function fetchRows(id: string) {
            if (id === 'GHSA-bad') throw new Error('503')
            return [osvRow({ advisoryId: id })]
        })
        const outcomes = await runSync(options({ sources: ['osv'] }), await planSync(options({ sources: ['osv'] })))
        expect(outcomes[0]?.status).toBe('error')
        expect(feeds.fetchOsvAdvisoryRows).toHaveBeenCalledTimes(2)
        expect(await cacheRowCount(dir, 'osv', 'npm')).toBe(1)
    })

    // SENTINEL-48. GitHub withdraws GHSA-A as a duplicate of a newly published GHSA-B, both aliasing CVE-X.
    // Writing A's withdrawal while B's fetch failed left every record linked to CVE-X withdrawn, and the
    // run stamped a live gemnasium advisory from it. The file keeps the last complete snapshot until a
    // refresh that re-read both lands.
    it('keeps a withdrawn duplicate out of the file until its replacement is re-read too', async function () {
        const withdrawnAt = Date.UTC(2026, 9, 23)
        await seedFile('osv', [osvRow({ advisoryId: 'GHSA-a', packageName: 'braces', aliases: ['CVE-X'] })])
        await seedState('osv', { cursorIso: '2026-10-22T00:00:00Z', etag: 'etag-1' })
        feeds.fetchOsvChangedIds.mockResolvedValue({ status: 'ok', ids: ['GHSA-a', 'GHSA-b'], etag: 'etag-2', newestIso: '2026-10-23T12:53:02Z' })
        feeds.fetchOsvAdvisoryRows.mockImplementation(async function partial(id: string) {
            if (id === 'GHSA-b') throw new Error('503')
            return [osvRow({ advisoryId: 'GHSA-a', packageName: 'braces', aliases: ['CVE-X'], withdrawn: withdrawnAt })]
        })
        const plan = await planSync(options({ sources: ['osv'] }))

        const failed = await runSync(options({ sources: ['osv'] }), plan)

        expect(failed[0]?.status).toBe('error')
        const before = await readRowsForPackages<OsvAdvisoryRow>(advisoryFilePath(dir, 'osv', 'npm'), new Set(['braces']))
        expect(before.get('braces')).toEqual([expect.objectContaining({ advisoryId: 'GHSA-a', withdrawn: null })])

        // The retry the run offers: same plan item, now every advisory reads.
        feeds.fetchOsvAdvisoryRows.mockImplementation(async function complete(id: string) {
            return [osvRow({ advisoryId: id, packageName: 'braces', aliases: ['CVE-X'], withdrawn: id === 'GHSA-a' ? withdrawnAt : null })]
        })
        const retried = await runSync(options({ sources: ['osv'] }), plan)

        expect(feeds.fetchOsvChangedIds.mock.calls.at(-1)?.slice(1, 3)).toEqual([Date.parse('2026-10-22T00:00:00Z'), null])
        expect(retried[0]).toMatchObject({ status: 'refreshed', rowCount: 2 })
        const after = await readRowsForPackages<OsvAdvisoryRow>(advisoryFilePath(dir, 'osv', 'npm'), new Set(['braces']))
        expect(after.get('braces')).toEqual(expect.arrayContaining([
            expect.objectContaining({ advisoryId: 'GHSA-a', withdrawn: withdrawnAt }),
            expect.objectContaining({ advisoryId: 'GHSA-b', withdrawn: null })
        ]))
        expect(await stateOf('osv')).toMatchObject({ cursorIso: '2026-10-23T12:53:02Z', etag: 'etag-2' })
    })

    // A run reading the cache while another one refreshes it (the lock makes it read rather than wait)
    // sees the previous file whole until the pass is complete.
    it('leaves the previous file in place for a concurrent reader while the pass is fetching', async function () {
        await seedFile('osv', [osvRow({ advisoryId: 'GHSA-a', packageName: 'braces', aliases: ['CVE-X'] })])
        await seedState('osv')
        let releaseB: (rows: OsvAdvisoryRow[]) => void = function unset() {}
        feeds.fetchOsvChangedIds.mockResolvedValue({ status: 'ok', ids: ['GHSA-a', 'GHSA-b'], etag: 'etag-2', newestIso: null })
        feeds.fetchOsvAdvisoryRows
            .mockResolvedValueOnce([osvRow({ advisoryId: 'GHSA-a', packageName: 'braces', aliases: ['CVE-X'], withdrawn: 1 })])
            .mockReturnValueOnce(new Promise<OsvAdvisoryRow[]>(function hold(resolve) {
                releaseB = resolve
            }))

        const pass = runSync(options({ sources: ['osv'] }), await planSync(options({ sources: ['osv'] })))
        await vi.waitFor(function bothRequested() {
            expect(feeds.fetchOsvAdvisoryRows).toHaveBeenCalledTimes(2)
        })

        const during = await readRowsForPackages<OsvAdvisoryRow>(advisoryFilePath(dir, 'osv', 'npm'), new Set(['braces']))
        expect(during.get('braces')).toEqual([expect.objectContaining({ advisoryId: 'GHSA-a', withdrawn: null })])

        releaseB([osvRow({ advisoryId: 'GHSA-b', packageName: 'braces', aliases: ['CVE-X'] })])
        expect((await pass)[0]?.status).toBe('refreshed')
        expect(await cacheRowCount(dir, 'osv', 'npm')).toBe(2)
    })

    it('keeps the previous cursor when the refresh reports no newer one', async function () {
        await seedFile('osv', [osvRow()])
        await seedState('osv', { cursorIso: '2026-06-01T00:00:00Z' })
        feeds.fetchOsvChangedIds.mockResolvedValue({ status: 'ok', ids: ['GHSA-x'], etag: null, newestIso: null })
        feeds.fetchOsvAdvisoryRows.mockResolvedValue([osvRow({ advisoryId: 'GHSA-x' })])
        await runSync(options({ sources: ['osv'] }), await planSync(options({ sources: ['osv'] })))
        expect((await stateOf('osv'))?.cursorIso).toBe('2026-06-01T00:00:00Z')
    })

    it('stops fetching advisories partway through once aborted, writing nothing', async function () {
        await seedFile('osv', [osvRow()])
        await seedState('osv')
        const controller = new AbortController()
        feeds.fetchOsvChangedIds.mockResolvedValue({ status: 'ok', ids: ['a', 'b', 'c'], etag: null, newestIso: null })
        feeds.fetchOsvAdvisoryRows.mockImplementation(async function fetchRows() {
            controller.abort()
            return [osvRow({ advisoryId: 'a' })]
        })
        const plan = await planSync(options({ sources: ['osv'] }))
        // The abort is raised mid-pass, so the item is reached; runSync's own between-items check is not.
        const outcomes = await runSync(options({ sources: ['osv'], abortSignal: controller.signal }), plan)
        expect(feeds.fetchOsvAdvisoryRows).toHaveBeenCalledTimes(1)
        expect(outcomes[0]).toMatchObject({ status: 'error', message: expect.stringContaining('cancelled') })
        expect(await cacheRowCount(dir, 'osv', 'npm')).toBe(1)
    })
})

describe('runSync — gemnasium', function () {
    // The archive is fetched from master, so it may be marginally newer than the recorded sha; recording
    // the older one makes the next compare replay that window, which is idempotent.
    it('reads the HEAD sha before downloading and records it', async function () {
        const outcomes = await runSync(options({ sources: ['gemnasium'] }), await planSync(options({ sources: ['gemnasium'] })))
        expect(outcomes[0]).toMatchObject({ status: 'seeded', rowCount: 1 })
        expect((await stateOf('gemnasium'))?.headSha).toBe('a'.repeat(40))
    })

    // The CLI scans JavaScript only, so the polyglot archive is filtered down on the way in.
    it('keeps only the requested ecosystem out of the polyglot archive', async function () {
        feeds.streamGemnasiumArchive.mockImplementation(streamOf([{
            rows: [gemRow({ ecosystem: 'npm' }), gemRow({ ecosystem: 'PyPI', advisoryId: 'GMS-py' })]
        }]))
        const outcomes = await runSync(options({ sources: ['gemnasium'] }), await planSync(options({ sources: ['gemnasium'] })))
        expect(outcomes[0]?.rowCount).toBe(1)
    })

    it('reports unchanged when the stored sha still matches HEAD', async function () {
        await seedFile('gemnasium', [gemRow()])
        await seedState('gemnasium', { headSha: 'a'.repeat(40), recordCount: 7 })
        const outcomes = await runSync(options({ sources: ['gemnasium'] }), await planSync(options({ sources: ['gemnasium'] })))
        expect(outcomes[0]).toMatchObject({ status: 'unchanged', rowCount: 7 })
        expect(feeds.streamGemnasiumArchive).not.toHaveBeenCalled()
    })

    it('re-seeds when the cache has no stored sha to compare against', async function () {
        await seedFile('gemnasium', [gemRow()])
        await seedState('gemnasium', { headSha: null })
        const outcomes = await runSync(options({ sources: ['gemnasium'] }), await planSync(options({ sources: ['gemnasium'] })))
        expect(outcomes[0]?.status).toBe('seeded')
    })

    it('re-seeds when upstream cannot report its HEAD sha', async function () {
        await seedFile('gemnasium', [gemRow()])
        await seedState('gemnasium', { headSha: 'b'.repeat(40) })
        feeds.fetchGemnasiumHeadSha.mockResolvedValue(null)
        const outcomes = await runSync(options({ sources: ['gemnasium'] }), await planSync(options({ sources: ['gemnasium'] })))
        expect(outcomes[0]?.status).toBe('seeded')
    })

    it('re-seeds when the compare is unavailable', async function () {
        await seedFile('gemnasium', [gemRow()])
        await seedState('gemnasium', { headSha: 'b'.repeat(40) })
        feeds.fetchGemnasiumChangedPaths.mockResolvedValue({ status: 'unavailable', changed: [], deleted: [] })
        const outcomes = await runSync(options({ sources: ['gemnasium'] }), await planSync(options({ sources: ['gemnasium'] })))
        expect(outcomes[0]?.status).toBe('seeded')
    })

    // The sha must advance even when nothing relevant changed, or every later refresh re-compares from
    // the same stale point and the window grows without bound.
    it('advances the sha without rewriting when the commit touched only other ecosystems', async function () {
        await seedFile('gemnasium', [gemRow()])
        await seedState('gemnasium', { headSha: 'b'.repeat(40), recordCount: 3 })
        feeds.fetchGemnasiumChangedPaths.mockResolvedValue({ status: 'ok', changed: ['pypi/flask/GMS-py.yml'], deleted: [] })
        const outcomes = await runSync(options({ sources: ['gemnasium'] }), await planSync(options({ sources: ['gemnasium'] })))
        expect(outcomes[0]).toMatchObject({ status: 'unchanged', rowCount: 3 })
        expect((await stateOf('gemnasium'))?.headSha).toBe('a'.repeat(40))
        expect(feeds.fetchGemnasiumFileRows).not.toHaveBeenCalled()
    })

    it('applies a changed advisory file incrementally', async function () {
        await seedFile('gemnasium', [gemRow({ advisoryId: 'GMS-keep' }), gemRow({ advisoryId: 'GMS-change' })])
        await seedState('gemnasium', { headSha: 'b'.repeat(40) })
        feeds.fetchGemnasiumChangedPaths.mockResolvedValue({ status: 'ok', changed: ['npm/lodash/GMS-change.yml'], deleted: [] })
        feeds.fetchGemnasiumFileRows.mockResolvedValue([gemRow({ advisoryId: 'GMS-change', packageName: 'lodash' })])
        const outcomes = await runSync(options({ sources: ['gemnasium'] }), await planSync(options({ sources: ['gemnasium'] })))
        expect(outcomes[0]).toMatchObject({ status: 'refreshed', rowCount: 2, message: '1 advisory file(s) updated' })
    })

    // A deleted advisory must disappear from the cache, not linger.
    it('drops the rows of a deleted advisory file', async function () {
        await seedFile('gemnasium', [gemRow({ advisoryId: 'GMS-keep' }), gemRow({ advisoryId: 'GMS-gone' })])
        await seedState('gemnasium', { headSha: 'b'.repeat(40) })
        feeds.fetchGemnasiumChangedPaths.mockResolvedValue({ status: 'ok', changed: [], deleted: ['npm/lodash/GMS-gone.yml'] })
        const outcomes = await runSync(options({ sources: ['gemnasium'] }), await planSync(options({ sources: ['gemnasium'] })))
        expect(outcomes[0]?.rowCount).toBe(1)
    })

    it('discards rows of another ecosystem returned by a changed file', async function () {
        await seedFile('gemnasium', [gemRow({ advisoryId: 'GMS-keep' })])
        await seedState('gemnasium', { headSha: 'b'.repeat(40) })
        feeds.fetchGemnasiumChangedPaths.mockResolvedValue({ status: 'ok', changed: ['npm/lodash/GMS-x.yml'], deleted: [] })
        feeds.fetchGemnasiumFileRows.mockResolvedValue([
            gemRow({ advisoryId: 'GMS-x', ecosystem: 'PyPI' }),
            gemRow({ advisoryId: 'GMS-x', ecosystem: 'npm' })
        ])
        const outcomes = await runSync(options({ sources: ['gemnasium'] }), await planSync(options({ sources: ['gemnasium'] })))
        expect(outcomes[0]?.rowCount).toBe(2)
    })

    // The rows a failed pass would have replaced are the ones still in force upstream: dropping them before
    // every changed file was re-read would leave a seeded cache that answers "no advisory" for them.
    it('keeps every row a pass would touch when a later file fetch fails', async function () {
        await seedFile('gemnasium', [
            gemRow({ advisoryId: 'GMS-a', packageName: 'a', summary: 'old text' }),
            gemRow({ advisoryId: 'GMS-b', packageName: 'b' }),
            gemRow({ advisoryId: 'GMS-c', packageName: 'c' })
        ])
        await seedState('gemnasium', { headSha: 'b'.repeat(40) })
        feeds.fetchGemnasiumChangedPaths.mockResolvedValue({
            status: 'ok',
            changed: ['npm/a/GMS-a.yml', 'npm/b/GMS-b.yml'],
            deleted: ['npm/c/GMS-c.yml']
        })
        feeds.fetchGemnasiumFileRows
            .mockResolvedValueOnce([gemRow({ advisoryId: 'GMS-a', packageName: 'a', summary: 'new text' })])
            .mockRejectedValueOnce(new Error('upstream 500'))
        const outcomes = await runSync(options({ sources: ['gemnasium'] }), await planSync(options({ sources: ['gemnasium'] })))
        expect(outcomes[0]).toMatchObject({ status: 'error', message: expect.stringContaining('upstream 500') })
        expect((await stateOf('gemnasium'))?.headSha).toBe('b'.repeat(40))
        const rows = await readRowsForPackages<GemnasiumAdvisoryRow>(advisoryFilePath(dir, 'gemnasium', 'npm'), new Set(['a', 'b', 'c']))
        expect(rows.get('a')).toEqual([expect.objectContaining({ advisoryId: 'GMS-a', summary: 'old text' })])
        expect(rows.get('b')).toHaveLength(1)
        expect(rows.get('c')).toHaveLength(1)
    })

    it('stops fetching advisory files partway through once aborted', async function () {
        await seedFile('gemnasium', [gemRow()])
        await seedState('gemnasium', { headSha: 'b'.repeat(40) })
        const controller = new AbortController()
        feeds.fetchGemnasiumChangedPaths.mockResolvedValue({
            status: 'ok',
            changed: ['npm/a/GMS-a.yml', 'npm/b/GMS-b.yml', 'npm/c/GMS-c.yml'],
            deleted: []
        })
        feeds.fetchGemnasiumFileRows.mockImplementation(async function fetchRows() {
            controller.abort()
            return [gemRow({ advisoryId: 'GMS-a' })]
        })
        const outcomes = await runSync(options({ sources: ['gemnasium'], abortSignal: controller.signal }), await planSync(options({ sources: ['gemnasium'] })))
        expect(feeds.fetchGemnasiumFileRows).toHaveBeenCalledTimes(1)
        // A pass cut short writes nothing and keeps the sha, so the next refresh repeats the window.
        expect(outcomes[0]).toMatchObject({ status: 'error', message: expect.stringContaining('cancelled') })
        expect((await stateOf('gemnasium'))?.headSha).toBe('b'.repeat(40))
        expect(await cacheRowCount(dir, 'gemnasium', 'npm')).toBe(1)
    })
})

describe('cacheRowCount', function () {
    it('counts the rows actually on disk', async function () {
        await seedFile('osv', [osvRow(), osvRow({ advisoryId: 'GHSA-b' }), osvRow({ advisoryId: 'GHSA-c' })])
        expect(await cacheRowCount(dir, 'osv', 'npm')).toBe(3)
    })

    it('reports zero for a cache file that does not exist', async function () {
        expect(await cacheRowCount(dir, 'gemnasium', 'npm')).toBe(0)
    })
})

describe('runSync — the cursor and record-count fallbacks', function () {
    // A state row that exists but carries no cursor (written by an older CLI, or by a seed that never
    // saw a modified date) has to refresh from zero rather than NaN. Date.parse of an unparseable
    // string returns NaN, and passing that upstream as a cursor asks for everything-since-NaN.
    it.each([
        ['no cursor at all', undefined],
        ['an unparseable cursor', 'not-a-date']
    ])('refreshes from zero with %s', async function (_label, cursorIso) {
        await seedFile('osv', [osvRow()])
        await seedState('osv', { cursorIso: cursorIso as string | undefined, recordCount: 1 })
        feeds.fetchOsvChangedIds.mockResolvedValue({ status: 'ok', ids: [], etag: null, newestIso: null })

        await runSync(options({ sources: ['osv'] }), await planSync(options({ sources: ['osv'] })))

        expect(feeds.fetchOsvChangedIds.mock.calls[0]?.[1]).toBe(0)
    })

    it('passes the parsed cursor when the state has one', async function () {
        await seedFile('osv', [osvRow()])
        await seedState('osv', { cursorIso: '2026-07-01T00:00:00Z', recordCount: 1 })
        feeds.fetchOsvChangedIds.mockResolvedValue({ status: 'ok', ids: [], etag: null, newestIso: null })

        await runSync(options({ sources: ['osv'] }), await planSync(options({ sources: ['osv'] })))

        expect(feeds.fetchOsvChangedIds.mock.calls[0]?.[1]).toBe(Date.parse('2026-07-01T00:00:00Z'))
    })

    it('sends no etag when the state has none', async function () {
        await seedFile('osv', [osvRow()])
        await seedState('osv', { etag: undefined, recordCount: 1 })
        feeds.fetchOsvChangedIds.mockResolvedValue({ status: 'ok', ids: [], etag: null, newestIso: null })

        await runSync(options({ sources: ['osv'] }), await planSync(options({ sources: ['osv'] })))

        expect(feeds.fetchOsvChangedIds.mock.calls[0]?.[2]).toBeNull()
    })

    // planSync reads the meta, and runSync reads it AGAIN — so a refresh can arrive at a state row that
    // has since vanished. That is not hypothetical: planSync runs before ui.confirmSeed's interactive
    // prompt and runSync after it, so anything that clears the cache while the user is deciding lands
    // here. The refresh must then report zero rather than crash on a missing state, and touch() must be
    // a no-op instead of writing a refreshedAt onto nothing.
    //
    // Driven through runSync with a hand-built refresh plan because that is exactly the shape planSync
    // would have produced a moment earlier, against a cache that no longer exists.
    it.each([
        ['upstream reports not-modified', { status: 'unchanged' }],
        ['upstream reports zero changed ids', { status: 'ok', ids: [], etag: 'etag-9', newestIso: null }]
    ])('reports zero rows when the state disappeared between plan and run — %s', async function (_label, changed) {
        feeds.fetchOsvChangedIds.mockResolvedValue(changed)

        const outcomes = await runSync(options({ sources: ['osv'] }), {
            items: [{ source: 'osv', ecosystems: ['npm'], purpose: 'findings', kind: 'refresh', downloadBytes: null, downloadBytesEstimated: false }],
            seedBytes: 0,
            needsConsent: false
        })

        expect(outcomes[0]).toMatchObject({ status: 'unchanged', rowCount: 0 })
        // touch() found nothing to touch, so no state row was invented for a cache that is not there.
        expect(await stateOf('osv')).toBeNull()
    })

    // The same vanished state on a pass that fails: there is no ETag to clear and no count to report, and
    // the failure must not invent a state row either.
    it('reports zero rows and invents no state when a pass fails after the state disappeared', async function () {
        feeds.fetchOsvChangedIds.mockResolvedValue({ status: 'ok', ids: ['GHSA-bad'], etag: 'etag-9', newestIso: null })
        feeds.fetchOsvAdvisoryRows.mockRejectedValue(new Error('connection reset'))

        const outcomes = await runSync(options({ sources: ['osv'] }), {
            items: [{ source: 'osv', ecosystems: ['npm'], purpose: 'findings', kind: 'refresh', downloadBytes: null, downloadBytesEstimated: false }],
            seedBytes: 0,
            needsConsent: false
        })

        expect(outcomes[0]).toMatchObject({ status: 'error', rowCount: 0 })
        expect(await stateOf('osv')).toBeNull()
    })
})

// SENTINEL-50. A refresh writes only when every changed advisory was re-read, so one advisory that keeps
// failing held the cache at its last snapshot until the window crossed OSV_INCREMENTAL_MAX_IDS — days, for
// npm. Refreshes that have failed for OSV_INCREMENTAL_STUCK_MS re-seed instead.
describe('runSync — an OSV advisory that keeps failing to re-read (SENTINEL-50)', function () {
    const STUCK_MS = 48 * 60 * 60 * 1000

    function failing() {
        feeds.fetchOsvChangedIds.mockResolvedValue({ status: 'ok', ids: ['GHSA-stuck'], etag: 'etag-2', newestIso: '2026-10-24T00:00:00Z' })
        feeds.fetchOsvAdvisoryRows.mockRejectedValue(new Error('HTTP 503'))
    }

    async function run() {
        return await runSync(options({ sources: ['osv'] }), await planSync(options({ sources: ['osv'] })))
    }

    beforeEach(async function seeded() {
        await seedFile('osv', [osvRow({ advisoryId: 'GHSA-keep' })])
    })

    it('starts the clock on the first failure and names the advisory and the fallback', async function () {
        await seedState('osv', { cursorIso: '2026-10-20T00:00:00Z' })
        failing()
        const before = Date.now()

        const outcomes = await run()

        const since = (await stateOf('osv'))?.incrementalFailingSince as number
        expect(since).toBeGreaterThanOrEqual(before)
        expect(outcomes[0]?.status).toBe('error')
        expect(outcomes[0]?.message).toContain('GHSA-stuck could not be re-read (HTTP 503)')
        expect(outcomes[0]?.message).toContain('failed since ' + new Date(since).toISOString())
        expect(outcomes[0]?.message).toContain('if GHSA-stuck still cannot be re-read at ' + new Date(since + STUCK_MS).toISOString())
        expect(feeds.streamOsvSeed).not.toHaveBeenCalled()
    })

    it('keeps the clock of the first failure across later ones', async function () {
        const since = Date.now() - STUCK_MS + 60_000
        await seedState('osv', { incrementalFailingSince: since })
        failing()

        await run()

        expect((await stateOf('osv'))?.incrementalFailingSince).toBe(since)
        expect(feeds.streamOsvSeed).not.toHaveBeenCalled()
    })

    it('re-seeds once the failures have lasted the stuck threshold', async function () {
        await seedState('osv', { incrementalFailingSince: Date.now() - STUCK_MS, etag: 'etag-1' })
        failing()

        const outcomes = await run()

        expect(outcomes[0]).toMatchObject({ status: 'seeded', rowCount: 1 })
        expect(feeds.streamOsvSeed).toHaveBeenCalledTimes(1)
        const state = await stateOf('osv')
        expect(state?.incrementalFailingSince).toBeUndefined()
        expect(state?.cursorIso).toBe('2026-07-01T00:00:00Z')
    })

    it('ends the run of failures on a refresh that writes', async function () {
        await seedState('osv', { incrementalFailingSince: Date.now() - 1000 })
        feeds.fetchOsvChangedIds.mockResolvedValue({ status: 'ok', ids: ['GHSA-stuck'], etag: 'etag-2', newestIso: null })
        feeds.fetchOsvAdvisoryRows.mockResolvedValue([osvRow({ advisoryId: 'GHSA-stuck' })])

        await run()

        expect((await stateOf('osv'))?.incrementalFailingSince).toBeUndefined()
    })

    it('ends the run of failures on a feed that has not been republished', async function () {
        await seedState('osv', { incrementalFailingSince: Date.now() - 1000 })
        feeds.fetchOsvChangedIds.mockResolvedValue({ status: 'unchanged' })

        await run()

        expect((await stateOf('osv'))?.incrementalFailingSince).toBeUndefined()
    })

    // Ctrl-C tears down the in-flight fetch, which rejects like a failed advisory would. That says nothing
    // about the feed: it neither starts the clock nor, past it, triggers a re-seed.
    it('does not count a fetch torn down by a cancellation', async function () {
        await seedState('osv', { incrementalFailingSince: Date.now() - STUCK_MS })
        const controller = new AbortController()
        feeds.fetchOsvChangedIds.mockResolvedValue({ status: 'ok', ids: ['GHSA-stuck'], etag: null, newestIso: null })
        feeds.fetchOsvAdvisoryRows.mockImplementation(async function cancelMidFetch() {
            controller.abort()
            throw new Error('aborted')
        })
        const plan = await planSync(options({ sources: ['osv'] }))

        const outcomes = await runSync(options({ sources: ['osv'], abortSignal: controller.signal }), plan)

        expect(outcomes[0]?.status).toBe('error')
        expect(outcomes[0]?.message).not.toContain('re-downloads')
        expect(feeds.streamOsvSeed).not.toHaveBeenCalled()
    })
})

describe('runSync — gemnasium paths that are not advisories', function () {
    // advisoryIdFromPath returns null only when the last path segment is empty — a directory entry,
    // which is how a rename or a subtree delete appears in a git compare. The loop building the drop
    // set has to skip it rather than adding null and then matching rows against it.
    it('ignores a deleted directory entry that carries no advisory id', async function () {
        await seedFile('gemnasium', [gemRow({ advisoryId: 'GMS-keep' }), gemRow({ advisoryId: 'GMS-change' })])
        await seedState('gemnasium', { headSha: 'b'.repeat(40), recordCount: 2 })
        feeds.fetchGemnasiumChangedPaths.mockResolvedValue({
            status: 'ok',
            changed: ['npm/lodash/GMS-change.yml'],
            deleted: ['npm/lodash/']
        })
        feeds.fetchGemnasiumFileRows.mockResolvedValue([gemRow({ advisoryId: 'GMS-change', packageName: 'lodash' })])

        const outcomes = await runSync(options({ sources: ['gemnasium'] }), await planSync(options({ sources: ['gemnasium'] })))

        // The directory entry dropped nothing, so the untouched advisory survives alongside the
        // rewritten one.
        expect(outcomes[0]).toMatchObject({ status: 'refreshed', rowCount: 2 })
    })

})

// Several ecosystems in one cache (SENTINEL-67). OSV has one export per ecosystem and is planned per
// ecosystem; gemnasium is one archive for all of them, planned and downloaded once. Each ecosystem keeps its
// own file, and a change to one ecosystem must never touch another's rows.
describe('several ecosystems', function () {
    const HEAD = 'a'.repeat(40)
    const OLD = 'b'.repeat(40)

    async function seedEcosystemFile(source: SourceId, ecosystem: EcosystemId, rows: readonly object[]): Promise<void> {
        await ensureCacheDir(dir)
        const writer = createRowWriter(advisoryFilePath(dir, source, ecosystem))
        await writer.write(rows as never)
        await writer.commit()
    }

    async function seedEcosystemState(source: SourceId, ecosystem: EcosystemId, overrides: Partial<SourceState> = {}): Promise<void> {
        const meta = await readCacheMeta(dir)
        setSourceState(meta, source, ecosystem, {
            normalizerVersion: normalizerVersionOf(source, ecosystem),
            recordCount: 1,
            refreshedAt: T0,
            ...overrides
        })
        await writeCacheMeta(dir, meta)
    }

    async function rowsOf(source: SourceId, ecosystem: EcosystemId, names: string[]) {
        return await readRowsForPackages<GemnasiumAdvisoryRow>(advisoryFilePath(dir, source, ecosystem), new Set(names))
    }

    function polyglot(overrides: Partial<Parameters<typeof runSync>[0]> = {}) {
        return options({ ecosystems: ['npm', 'PyPI'], ...overrides })
    }

    describe('planSync', function () {
        it('plans one OSV export per ecosystem and one gemnasium archive for all of them', async function () {
            const plan = await planSync(polyglot())
            expect(plan.items.map(function shape(i) { return [i.source, i.ecosystems, i.kind] })).toEqual([
                ['osv', ['npm'], 'seed'],
                ['osv', ['PyPI'], 'seed'],
                ['gemnasium', ['npm', 'PyPI'], 'seed']
            ])
            expect(feeds.headOsvSeed.mock.calls.map(function eco(call) { return call[0] })).toEqual(['npm', 'PyPI'])
            // Two OSV exports at 96 MB each, and the archive once.
            expect(plan.seedBytes).toBe(2 * 96 * 1024 * 1024 + GEMNASIUM_SEED_DOWNLOAD_BYTES)
        })

        it('downloads nothing for a tree with no ecosystem', async function () {
            const plan = await planSync(options({ ecosystems: [] }))
            expect(plan.items).toEqual([])
            expect(plan.needsConsent).toBe(false)
        })

        it('re-seeds the gemnasium archive when one of its ecosystems is new, but refreshes a seeded OSV export', async function () {
            await seedEcosystemState('osv', 'npm')
            await seedEcosystemState('gemnasium', 'npm', { headSha: HEAD })
            const plan = await planSync(polyglot())
            expect(plan.items.map(function shape(i) { return [i.source, i.ecosystems, i.kind] })).toEqual([
                ['osv', ['npm'], 'refresh'],
                ['osv', ['PyPI'], 'seed'],
                ['gemnasium', ['npm', 'PyPI'], 'seed']
            ])
        })

        it('plans OSV withdrawal evidence for each ecosystem gemnasium audits', async function () {
            const plan = await planSync(polyglot({ sources: ['gemnasium'] }))
            expect(plan.items.map(function shape(i) { return [i.source, i.ecosystems, i.purpose] })).toEqual([
                ['gemnasium', ['npm', 'PyPI'], 'findings'],
                ['osv', ['npm'], 'withdrawal-evidence'],
                ['osv', ['PyPI'], 'withdrawal-evidence']
            ])
        })
    })

    describe('a gemnasium seed', function () {
        it('downloads the archive once and writes each ecosystem its own file', async function () {
            feeds.streamGemnasiumArchive.mockImplementation(streamOf([{
                rows: [
                    gemRow({ ecosystem: 'npm', packageName: 'lodash' }),
                    gemRow({ ecosystem: 'npm', packageName: 'lodash', advisoryId: 'GMS-2024-2' }),
                    gemRow({ ecosystem: 'PyPI', packageName: 'requests', advisoryId: 'GMS-py' }),
                    gemRow({ ecosystem: 'Go', packageName: 'example.invalid/mod', advisoryId: 'GMS-go' })
                ]
            }]))
            const outcomes = await runSync(polyglot({ sources: ['gemnasium'] }), {
                items: [{ source: 'gemnasium', ecosystems: ['npm', 'PyPI'], purpose: 'findings', kind: 'seed', downloadBytes: null, downloadBytesEstimated: true }],
                seedBytes: 0,
                needsConsent: false
            })
            expect(feeds.streamGemnasiumArchive).toHaveBeenCalledTimes(1)
            expect(outcomes[0]).toMatchObject({ source: 'gemnasium', ecosystems: ['npm', 'PyPI'], status: 'seeded', rowCount: 3 })
            expect((await rowsOf('gemnasium', 'npm', ['lodash'])).get('lodash')).toHaveLength(2)
            expect([...(await rowsOf('gemnasium', 'PyPI', ['requests'])).keys()]).toEqual(['requests'])
            // An ecosystem the tree does not hold is not written at all.
            expect(await cacheRowCount(dir, 'gemnasium', 'Go')).toBe(0)
            const meta = await readCacheMeta(dir)
            expect(getSourceState(meta, 'gemnasium', 'npm')).toMatchObject({ headSha: HEAD, recordCount: 2 })
            expect(getSourceState(meta, 'gemnasium', 'PyPI')).toMatchObject({ headSha: HEAD, recordCount: 1 })
        })

        it('keeps every ecosystem\'s previous file when the download fails midway', async function () {
            await seedEcosystemFile('gemnasium', 'npm', [gemRow({ advisoryId: 'GMS-old-npm' })])
            await seedEcosystemFile('gemnasium', 'PyPI', [gemRow({ ecosystem: 'PyPI', packageName: 'requests', advisoryId: 'GMS-old-py' })])
            feeds.streamGemnasiumArchive.mockImplementation(async function* failing() {
                yield { rows: [gemRow({ ecosystem: 'PyPI', packageName: 'requests', advisoryId: 'GMS-new-py' })] }
                throw new Error('connection reset')
            })
            const outcomes = await runSync(polyglot({ sources: ['gemnasium'] }), await planSync(polyglot({ sources: ['gemnasium'] })))
            expect(outcomes[0]).toMatchObject({ status: 'error', message: 'connection reset' })
            expect((await rowsOf('gemnasium', 'npm', ['lodash'])).get('lodash')?.map(function id(r) { return r.advisoryId })).toEqual(['GMS-old-npm'])
            expect((await rowsOf('gemnasium', 'PyPI', ['requests'])).get('requests')?.map(function id(r) { return r.advisoryId })).toEqual(['GMS-old-py'])
        })
    })

    describe('a gemnasium refresh', function () {
        async function seedBoth(npmSha: string, pypiSha: string): Promise<void> {
            await seedEcosystemFile('gemnasium', 'npm', [gemRow({ advisoryId: 'CVE-FAKE-SHARED', packageName: 'lodash' })])
            await seedEcosystemFile('gemnasium', 'PyPI', [gemRow({ ecosystem: 'PyPI', advisoryId: 'CVE-FAKE-SHARED', packageName: 'requests' })])
            await seedEcosystemState('gemnasium', 'npm', { headSha: npmSha })
            await seedEcosystemState('gemnasium', 'PyPI', { headSha: pypiSha })
        }

        async function refreshBoth() {
            return await runSync(polyglot({ sources: ['gemnasium'] }), await planSync(polyglot({ sources: ['gemnasium'] })))
        }

        // The bug this replaced: every non-npm path matched every ecosystem, and the drop went by advisory id,
        // so an npm file changing CVE-X deleted PyPI's CVE-X rows and re-appended none.
        it('leaves the PyPI rows intact when an npm advisory sharing their id changes', async function () {
            await seedBoth(OLD, OLD)
            feeds.fetchGemnasiumChangedPaths.mockResolvedValue({ status: 'ok', changed: ['npm/lodash/CVE-FAKE-SHARED.yml'], deleted: [] })
            feeds.fetchGemnasiumFileRows.mockResolvedValue([gemRow({ advisoryId: 'CVE-FAKE-SHARED', packageName: 'lodash', severity: 'low' })])
            const outcomes = await refreshBoth()
            expect(outcomes[0]).toMatchObject({ status: 'refreshed', rowCount: 2, message: '1 advisory file(s) updated' })
            expect(feeds.fetchGemnasiumChangedPaths).toHaveBeenCalledTimes(1)
            expect(feeds.fetchGemnasiumFileRows).toHaveBeenCalledTimes(1)
            expect((await rowsOf('gemnasium', 'PyPI', ['requests'])).get('requests')).toHaveLength(1)
            expect((await rowsOf('gemnasium', 'npm', ['lodash'])).get('lodash')?.[0]?.severity).toBe('low')
            // Both ecosystems move to the compared commit.
            const meta = await readCacheMeta(dir)
            expect(getSourceState(meta, 'gemnasium', 'npm')?.headSha).toBe(HEAD)
            expect(getSourceState(meta, 'gemnasium', 'PyPI')?.headSha).toBe(HEAD)
        })

        it('leaves the npm rows intact when a PyPI advisory file sharing their id is deleted', async function () {
            await seedBoth(OLD, OLD)
            feeds.fetchGemnasiumChangedPaths.mockResolvedValue({ status: 'ok', changed: [], deleted: ['pypi/requests/CVE-FAKE-SHARED.yml'] })
            await refreshBoth()
            expect(await cacheRowCount(dir, 'gemnasium', 'PyPI')).toBe(0)
            expect((await rowsOf('gemnasium', 'npm', ['lodash'])).get('lodash')).toHaveLength(1)
        })

        it('keeps another package\'s rows for the same advisory in the same ecosystem', async function () {
            await seedEcosystemFile('gemnasium', 'npm', [gemRow({ advisoryId: 'CVE-FAKE-TWO', packageName: 'left-pkg' }), gemRow({ advisoryId: 'CVE-FAKE-TWO', packageName: 'right-pkg' })])
            await seedEcosystemState('gemnasium', 'npm', { headSha: OLD })
            feeds.fetchGemnasiumChangedPaths.mockResolvedValue({ status: 'ok', changed: ['npm/left-pkg/CVE-FAKE-TWO.yml'], deleted: [] })
            feeds.fetchGemnasiumFileRows.mockResolvedValue([gemRow({ advisoryId: 'CVE-FAKE-TWO', packageName: 'left-pkg', severity: 'low' })])
            await runSync(options({ sources: ['gemnasium'] }), await planSync(options({ sources: ['gemnasium'] })))
            const rows = await rowsOf('gemnasium', 'npm', ['left-pkg', 'right-pkg'])
            expect(rows.get('right-pkg')).toHaveLength(1)
            expect(rows.get('left-pkg')?.map(function severity(r) { return r.severity })).toEqual(['low'])
        })

        it('compares each stored commit once, and none already at HEAD', async function () {
            const OTHER = 'c'.repeat(40)
            await seedBoth(OLD, OTHER)
            await seedEcosystemFile('gemnasium', 'Go', [gemRow({ ecosystem: 'Go', packageName: 'example.invalid/mod' })])
            await seedEcosystemState('gemnasium', 'Go', { headSha: HEAD, recordCount: 5 })
            const options3 = options({ sources: ['gemnasium'], ecosystems: ['npm', 'PyPI', 'Go'] })
            const outcomes = await runSync(options3, await planSync(options3))
            expect(feeds.fetchGemnasiumChangedPaths.mock.calls.map(function from(call) { return call[0] })).toEqual([OLD, OTHER])
            // Nothing relevant changed anywhere: unchanged, the counts summed across the three files.
            expect(outcomes[0]).toMatchObject({ status: 'unchanged', rowCount: 7 })
            expect(getSourceState(await readCacheMeta(dir), 'gemnasium', 'PyPI')?.headSha).toBe(HEAD)
        })

        it('re-seeds every ecosystem from one archive when a compare is unavailable', async function () {
            await seedBoth(OLD, OLD)
            feeds.fetchGemnasiumChangedPaths.mockResolvedValue({ status: 'unavailable', reason: 'compare timed out upstream' })
            feeds.streamGemnasiumArchive.mockImplementation(streamOf([{ rows: [gemRow(), gemRow({ ecosystem: 'PyPI', packageName: 'requests' })] }]))
            const outcomes = await refreshBoth()
            expect(outcomes[0]).toMatchObject({ status: 'seeded', rowCount: 2 })
            expect(feeds.streamGemnasiumArchive).toHaveBeenCalledTimes(1)
        })

        it('re-seeds every ecosystem when one has no stored commit', async function () {
            await seedBoth(OLD, OLD)
            await seedEcosystemState('gemnasium', 'PyPI', { headSha: null })
            const outcomes = await refreshBoth()
            expect(outcomes[0]?.status).toBe('seeded')
            expect(feeds.fetchGemnasiumHeadSha).toHaveBeenCalledTimes(1)
        })

        it.each([
            ['crates.io', 'cargo/serde/RUSTSEC-FAKE-1.yml', 'serde'],
            ['RubyGems', 'gem/rack/CVE-FAKE-RB.yml', 'rack'],
            ['Go', 'go/example.invalid/mod/CVE-FAKE-GO.yml', 'example.invalid/mod']
        ] as const)('applies a %s change found under its own package-type directory', async function (ecosystem, path, name) {
            await seedEcosystemFile('gemnasium', ecosystem, [gemRow({ ecosystem, packageName: name, advisoryId: 'OLD-ID' })])
            await seedEcosystemState('gemnasium', ecosystem, { headSha: OLD })
            feeds.fetchGemnasiumChangedPaths.mockResolvedValue({ status: 'ok', changed: [path], deleted: [] })
            feeds.fetchGemnasiumFileRows.mockResolvedValue([gemRow({ ecosystem, packageName: name, advisoryId: path.split('/').pop()!.replace('.yml', '') })])
            const scoped = options({ sources: ['gemnasium'], ecosystems: [ecosystem] })
            const outcomes = await runSync(scoped, await planSync(scoped))
            expect(outcomes[0]).toMatchObject({ status: 'refreshed', rowCount: 2 })
        })
    })
})

describe('pathEcosystemMatches', function () {
    it.each([
        ['npm/lodash/CVE-1.yml', 'npm', true],
        ['pypi/requests/CVE-1.yml', 'PyPI', true],
        ['pypi/requests/CVE-1.yml', 'npm', false],
        ['npm/lodash/CVE-1.yml', 'PyPI', false],
        ['cargo/serde/CVE-1.yml', 'crates.io', true],
        ['gem/rack/CVE-1.yml', 'RubyGems', true],
        ['go/example.invalid/mod/CVE-1.yml', 'Go', true],
        // A directory whose name merely starts with a package type is another package type.
        ['npmx/pkg/CVE-1.yml', 'npm', false],
        ['maven/org/x/CVE-1.yml', 'npm', false],
        ['npm/lodash/CVE-1.yml', 'nuget', false]
    ])('%s belongs to %s: %s', function (path, ecosystem, expected) {
        expect(pathEcosystemMatches(path, ecosystem)).toBe(expected)
    })
})

describe('gemnasiumPathRowKey', function () {
    it('keys the package between the type directory and the file, scoped names included', function () {
        expect(gemnasiumPathRowKey('npm/@scope/pkg/CVE-1.yml')).toBe(rowKey('@scope/pkg', 'CVE-1'))
        expect(gemnasiumPathRowKey('go/example.invalid/org/mod/GHSA-x.yml')).toBe(rowKey('example.invalid/org/mod', 'GHSA-x'))
    })

    // The normalizer keys PyPI names by PEP 503, so the drop has to as well or the old row survives.
    it('canonicalizes a PyPI name the way the normalizer does', function () {
        expect(gemnasiumPathRowKey('pypi/Some_Package/CVE-1.yml')).toBe(rowKey('some-package', 'CVE-1'))
    })

    it.each([
        ['npm/CVE-1.yml'],
        ['npm/lodash/'],
        ['npm//CVE-1.yml']
    ])('is null for %s, which names no package and file', function (path) {
        expect(gemnasiumPathRowKey(path)).toBeNull()
    })
})

describe('normalizerVersionOf', function () {
    it('reads OSV\'s per ecosystem and gemnasium\'s single number', function () {
        expect(normalizerVersionOf('osv', 'PyPI')).toBe(osvNormalizerVersion('PyPI'))
        expect(normalizerVersionOf('osv', 'npm')).toBe(osvNormalizerVersion('npm'))
        expect(normalizerVersionOf('gemnasium', 'PyPI')).toBe(GEMNASIUM_NORMALIZER_VERSION)
    })
})
