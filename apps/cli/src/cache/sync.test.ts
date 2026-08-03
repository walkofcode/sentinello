import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GEMNASIUM_NORMALIZER_VERSION, GEMNASIUM_SEED_DOWNLOAD_BYTES, OSV_NORMALIZER_VERSION, type GemnasiumAdvisoryRow, type OsvAdvisoryRow } from '@sentinello/core'
import { advisoryFilePath, ensureCacheDir, getSourceState, readCacheMeta, setSourceState, writeCacheMeta, type SourceId, type SourceState } from './meta'
import { createRowWriter } from './store'

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

const { cacheRowCount, planSync, runSync } = await import('./sync')

const T0 = Date.UTC(2026, 0, 1)

let dir: string

function options(overrides: Partial<Parameters<typeof runSync>[0]> = {}) {
    return {
        cacheDir: dir,
        sources: ['osv', 'gemnasium'] as SourceId[],
        ecosystem: 'npm' as const,
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
        normalizerVersion: source === 'osv' ? OSV_NORMALIZER_VERSION : GEMNASIUM_NORMALIZER_VERSION,
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
        await seedState('osv', { normalizerVersion: OSV_NORMALIZER_VERSION - 1 })
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
        await seedState('osv', { etag: 'stale-etag', normalizerVersion: OSV_NORMALIZER_VERSION - 1 })
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

    // One advisory failing must not abort the pass; the cursor only advances on a completed pass, so it
    // is simply re-read next time.
    it('drops an advisory that fails to fetch and keeps the rest of the pass', async function () {
        await seedFile('osv', [osvRow({ advisoryId: 'GHSA-keep' })])
        await seedState('osv')
        feeds.fetchOsvChangedIds.mockResolvedValue({ status: 'ok', ids: ['GHSA-bad', 'GHSA-good'], etag: null, newestIso: null })
        feeds.fetchOsvAdvisoryRows.mockImplementation(async function fetchRows(id: string) {
            if (id === 'GHSA-bad') throw new Error('404')
            return [osvRow({ advisoryId: 'GHSA-good' })]
        })
        const outcomes = await runSync(options({ sources: ['osv'] }), await planSync(options({ sources: ['osv'] })))
        expect(outcomes[0]?.status).toBe('refreshed')
        expect(outcomes[0]?.rowCount).toBe(2)
    })

    it('keeps the previous cursor when the refresh reports no newer one', async function () {
        await seedFile('osv', [osvRow()])
        await seedState('osv', { cursorIso: '2026-06-01T00:00:00Z' })
        feeds.fetchOsvChangedIds.mockResolvedValue({ status: 'ok', ids: ['GHSA-x'], etag: null, newestIso: null })
        feeds.fetchOsvAdvisoryRows.mockResolvedValue([osvRow({ advisoryId: 'GHSA-x' })])
        await runSync(options({ sources: ['osv'] }), await planSync(options({ sources: ['osv'] })))
        expect((await stateOf('osv'))?.cursorIso).toBe('2026-06-01T00:00:00Z')
    })

    it('stops fetching advisories partway through once aborted', async function () {
        await seedFile('osv', [osvRow()])
        await seedState('osv')
        const controller = new AbortController()
        feeds.fetchOsvChangedIds.mockResolvedValue({ status: 'ok', ids: ['a', 'b', 'c'], etag: null, newestIso: null })
        feeds.fetchOsvAdvisoryRows.mockImplementation(async function fetchRows() {
            controller.abort()
            return [osvRow({ advisoryId: 'a' })]
        })
        await runSync(options({ sources: ['osv'], abortSignal: controller.signal }), await planSync(options({ sources: ['osv'] })))
        expect(feeds.fetchOsvAdvisoryRows).toHaveBeenCalledTimes(1)
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
        await runSync(options({ sources: ['gemnasium'], abortSignal: controller.signal }), await planSync(options({ sources: ['gemnasium'] })))
        expect(feeds.fetchGemnasiumFileRows).toHaveBeenCalledTimes(1)
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
