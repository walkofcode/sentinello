import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    OSV_META_KEYS,
    OSV_NORMALIZER_VERSION,
    countOsvAdvisories,
    getOsvMeta,
    lookupOsvByPackages,
    openOsvDb,
    osvMetaKeyFor,
    runOsvMigrations,
    setOsvMeta,
    upsertOsvAdvisories,
    type OsvDrizzleDb,
    type SqliteDb
} from '@sentinello/db'
import type { OsvAdvisoryRow } from '@sentinello/core'

// osv-sync is the persistence half of the OSV feed: the downloading, unzipping and normalizing all live
// in @sentinello/feeds, and what remains here is the part that can corrupt an operator's cache.
//
// Three orderings carry the whole weight, and each one is a data-loss bug if reversed:
//
//   - a seed invalidates the prior rows only ONCE THE DOWNLOAD IS LIVE, deferred to the first batch. A
//     download that dies before producing anything must leave the existing cache intact; clearing first
//     would trade a working cache for an empty one on every transient network failure.
//   - the ecosystem is marked UNSEEDED before its rows are cleared, and seedComplete flips back only
//     after the full stream succeeds. In between, a concurrent scan must treat the ecosystem as
//     not-downloaded — a half-rebuilt cache that still reports seeded reads as "no vulnerabilities".
//   - an advisory is REPLACED, not cleared-then-refetched. The rows go only once the replacement is in
//     hand, and the cursor advances only when every changed id was processed. Deleting first meant any
//     timeout erased that advisory, and the cursor moved past it regardless — losing it until the next
//     full re-seed, silently, on a sync that reported success.
//
// @sentinello/feeds is stubbed — the real thing downloads ~100 MB per ecosystem — but the cache is a real
// migrated osv.db, so every meta write, upsert, delete and count below is the production query.

const feeds = vi.hoisted(function makeFeedsDouble() {
    return {
        feedDisabled: false,
        // The incremental-vs-reseed threshold, as a field rather than a literal so a test can lower it.
        // The number itself is not what the boundary tests are about — `=== MAX` stays incremental and
        // `> MAX` re-seeds is the same branch at 2 as at 20,000 — but the COST is entirely about the
        // number: incrementalSyncOsv calls deleteOsvAdvisories once per id, and each of those opens its
        // own transaction against a real on-disk SQLite file. At 20,000 that is 20,000 BEGIN/DELETE/COMMIT
        // cycles, which took ~2s alone and 6-7s under the full suite's parallel load, so the test failed
        // the 5s default timeout intermittently for reasons that had nothing to do with what it asserts.
        // The production value stays pinned where it belongs, by packages/feeds/src/osv/feed.test.ts.
        incrementalMaxIds: 20_000,
        streamOsvSeed: vi.fn(),
        fetchOsvChangedIds: vi.fn(),
        fetchOsvAdvisoryRows: vi.fn()
    }
})

vi.mock('@sentinello/feeds', function mockFeeds() {
    return {
        // A getter, not a value: the factory runs once, so a literal here would freeze the threshold before
        // any test could change it.
        get OSV_INCREMENTAL_MAX_IDS() { return feeds.incrementalMaxIds },
        errText: function errText(err: unknown) {
            return err instanceof Error && err.message || String(err)
        },
        osvFeedDisabled: function osvFeedDisabled() { return feeds.feedDisabled },
        streamOsvSeed: feeds.streamOsvSeed,
        fetchOsvChangedIds: feeds.fetchOsvChangedIds,
        fetchOsvAdvisoryRows: feeds.fetchOsvAdvisoryRows
    }
})

// statfs is the only way to drive the free-space guard: it reports the real volume, which on any
// machine that can run this suite has room. Partial so mkdtemp/rm keep working.
const statfsResult = vi.hoisted(function makeStatfs() {
    return { override: null as { bavail: number; bsize: number } | null }
})

vi.mock('node:fs/promises', async function mockFsPromises(importOriginal) {
    const actual = await importOriginal<typeof import('node:fs/promises')>()
    return {
        ...actual,
        statfs: async function statfs(path: string) {
            if (statfsResult.override) return statfsResult.override as unknown as Awaited<ReturnType<typeof actual.statfs>>
            return actual.statfs(path)
        }
    }
})

const { checkOsvFreeSpace, incrementalSyncOsv, seedOsv } = await import('./osv-sync')

const ECO = 'npm'

let dir: string
let db: OsvDrizzleDb
let sqlite: SqliteDb
let priorEnv: string | undefined

function row(overrides: Partial<OsvAdvisoryRow> = {}): OsvAdvisoryRow {
    return {
        advisoryId: 'GHSA-aaaa',
        ecosystem: ECO,
        packageName: 'lodash',
        aliases: ['CVE-2024-1'],
        ranges: [{ type: 'SEMVER', introduced: '0', fixed: '4.17.21', lastAffected: null }],
        versions: [],
        severity: 'high',
        summary: 'Prototype pollution',
        url: 'https://example.test/GHSA-aaaa',
        malicious: false,
        // Epoch ms of the advisory's `withdrawn` timestamp, not a flag — null means "not withdrawn".
        withdrawn: null,
        ...overrides
    } as OsvAdvisoryRow
}

// Turns a list of batches into the async generator streamOsvSeed returns.
function stream(batches: { rows: OsvAdvisoryRow[]; lastModified: string | null }[], failAfter?: number) {
    return async function* generate() {
        let emitted = 0
        for (const batch of batches) {
            if (failAfter !== undefined && emitted === failAfter) throw new Error('stream died')
            yield batch
            emitted += 1
        }
        if (failAfter !== undefined && emitted === failAfter) throw new Error('stream died')
    }
}

function meta<T>(key: string): T | null {
    return getOsvMeta<T>(db, osvMetaKeyFor(key, ECO))
}

beforeEach(async function setup() {
    feeds.feedDisabled = false
    feeds.incrementalMaxIds = 20_000
    statfsResult.override = null
    feeds.streamOsvSeed.mockReset()
    feeds.fetchOsvChangedIds.mockReset()
    feeds.fetchOsvAdvisoryRows.mockReset()
    dir = await mkdtemp(join(tmpdir(), 'sentinello-osv-sync-'))
    priorEnv = process.env.SENTINELLO_OSV_DB_PATH
    process.env.SENTINELLO_OSV_DB_PATH = join(dir, 'osv.db')
    const opened = openOsvDb(join(dir, 'osv.db'))
    db = opened.db
    sqlite = opened.sqlite
    runOsvMigrations(db)
    vi.spyOn(console, 'log').mockImplementation(function silence() {})
})

afterEach(async function teardown() {
    if (priorEnv === undefined) delete process.env.SENTINELLO_OSV_DB_PATH
    else process.env.SENTINELLO_OSV_DB_PATH = priorEnv
    vi.restoreAllMocks()
    sqlite.close()
    await rm(dir, { recursive: true, force: true })
})

describe('checkOsvFreeSpace', function () {
    it('reports the available bytes on the volume holding the cache', async function () {
        const space = await checkOsvFreeSpace()
        expect(space.freeBytes).toBeGreaterThan(0)
        expect(space.sufficient).toBe(true)
    })

    // Reporting 0-but-sufficient is deliberate: an unstattable volume shows "unknown" in the UI without
    // blocking a sync that would probably have worked.
    it('reports unknown rather than blocking when the volume cannot be stat-ed', async function () {
        process.env.SENTINELLO_OSV_DB_PATH = join(dir, 'no', 'such', 'place', 'osv.db')
        expect(await checkOsvFreeSpace()).toEqual({ freeBytes: 0, sufficient: true })
    })

    it('reports insufficient when the volume is below the required headroom', async function () {
        statfsResult.override = { bavail: 10, bsize: 4096 }
        expect(await checkOsvFreeSpace()).toMatchObject({ freeBytes: 40_960, sufficient: false })
    })
})

// The seed pulls roughly 100 MB per ecosystem and expands it into the cache. Refusing up front is the
// difference between "OSV did not update" and filling the volume the operator's SQLite database and
// its WAL also live on — at which point the worker cannot write a scan either. The message carries
// both numbers because "need more space" without an amount is not actionable.
describe('seedOsv — the free-space guard', function () {
    beforeEach(function tinyVolume() {
        statfsResult.override = { bavail: 10, bsize: 4096 }
    })

    it('refuses to seed and never starts the download', async function () {
        const result = await seedOsv(db, ECO)
        expect(result).toMatchObject({ status: 'error', upserted: 0 })
        expect(result.message).toMatch(/insufficient free space for OSV seed: need ~\d+ MiB, have 0 MiB/)
        expect(feeds.streamOsvSeed).not.toHaveBeenCalled()
    })

    // Recorded on the meta row, not just returned, so Settings → Sources shows why the seed did not
    // happen rather than leaving the source looking merely un-seeded.
    it('records the reason as the source last error', async function () {
        await seedOsv(db, ECO)
        expect(getOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.lastError, ECO))).toMatch(/insufficient free space/)
    })

    // Checked after the feed-disabled short-circuit: an operator who turned the source off should not
    // be told about disk space for a download that was never going to run.
    it('yields to the feed-disabled check', async function () {
        feeds.feedDisabled = true
        expect(await seedOsv(db, ECO)).toMatchObject({ status: 'skipped', message: 'feed disabled' })
    })
})

describe('seedOsv', function () {
    it('skips without touching the cache when the feed is disabled', async function () {
        feeds.feedDisabled = true
        const result = await seedOsv(db, ECO)
        expect(result).toMatchObject({ status: 'skipped', message: 'feed disabled' })
        expect(feeds.streamOsvSeed).not.toHaveBeenCalled()
    })

    it('writes every streamed row and stamps the ecosystem seeded', async function () {
        feeds.streamOsvSeed.mockImplementation(stream([
            { rows: [row(), row({ advisoryId: 'GHSA-bbbb', packageName: 'minimist' })], lastModified: 'Mon, 01 Jan 2026 00:00:00 GMT' }
        ]))

        const result = await seedOsv(db, ECO)

        expect(result).toMatchObject({ status: 'ok', upserted: 2, recordCount: 2, message: null })
        expect(meta<boolean>(OSV_META_KEYS.seedComplete)).toBe(true)
        expect(meta<number>(OSV_META_KEYS.normalizerVersion)).toBe(OSV_NORMALIZER_VERSION)
        expect(meta<number>(OSV_META_KEYS.recordCount)).toBe(2)
        expect(meta<string>(OSV_META_KEYS.lastModified)).toBe('Mon, 01 Jan 2026 00:00:00 GMT')
        expect(meta<string>(OSV_META_KEYS.lastError)).toBeNull()
    })

    it('consumes several batches into one seed', async function () {
        feeds.streamOsvSeed.mockImplementation(stream([
            { rows: [row()], lastModified: null },
            { rows: [row({ advisoryId: 'GHSA-bbbb' })], lastModified: 'later' }
        ]))
        const result = await seedOsv(db, ECO)
        expect(result.upserted).toBe(2)
        expect(meta<string>(OSV_META_KEYS.lastModified)).toBe('later')
    })

    // A re-seed is a true rebuild: a row that vanished from the current export (advisory deleted, package
    // dropped from `affected`) must not survive it.
    it('discards rows absent from the new export', async function () {
        upsertOsvAdvisories(db, [row({ advisoryId: 'GHSA-gone' })])
        feeds.streamOsvSeed.mockImplementation(stream([{ rows: [row()], lastModified: null }]))

        await seedOsv(db, ECO)

        expect(lookupOsvByPackages(db, ECO, ['lodash']).get('lodash')?.map(function id(a) {
            return a.advisoryId
        })).toEqual(['GHSA-aaaa'])
    })

    it('leaves a sibling ecosystem untouched', async function () {
        upsertOsvAdvisories(db, [row({ ecosystem: 'PyPI', packageName: 'django' })])
        feeds.streamOsvSeed.mockImplementation(stream([{ rows: [row()], lastModified: null }]))
        await seedOsv(db, ECO)
        expect(countOsvAdvisories(db, 'PyPI')).toBe(1)
    })

    // The deferral is the whole point: nothing is destroyed until the download has proven it can produce
    // rows, so a network failure costs a retry rather than the operator's cache.
    it('leaves the prior cache intact when the download dies before the first batch', async function () {
        upsertOsvAdvisories(db, [row({ advisoryId: 'GHSA-old' })])
        setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.seedComplete, ECO), true)
        feeds.streamOsvSeed.mockImplementation(stream([], 0))

        const result = await seedOsv(db, ECO)

        expect(result.status).toBe('error')
        expect(countOsvAdvisories(db, ECO)).toBe(1)
        expect(meta<boolean>(OSV_META_KEYS.seedComplete)).toBe(true)
    })

    // Once the rebuild HAS started, the opposite rule applies: better unauditable than matching a
    // half-rebuilt cache.
    it('leaves the ecosystem unseeded when the stream dies mid-rebuild', async function () {
        setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.seedComplete, ECO), true)
        feeds.streamOsvSeed.mockImplementation(stream([{ rows: [row()], lastModified: null }], 1))

        const result = await seedOsv(db, ECO)

        expect(result).toMatchObject({ status: 'error', upserted: 1 })
        expect(meta<boolean>(OSV_META_KEYS.seedComplete)).toBe(false)
        expect(meta<string>(OSV_META_KEYS.lastError)).toContain('OSV seed failed (npm) after 1 rows')
    })

    it('records the failure reason for the Settings panel', async function () {
        feeds.streamOsvSeed.mockImplementation(stream([], 0))
        await seedOsv(db, ECO)
        expect(meta<string>(OSV_META_KEYS.lastError)).toContain('stream died')
    })

    // A fresh seed supersedes any incremental cursor; keeping the etag would let the next incremental
    // sync take a 304 against a copy that predates the rebuild and skip real changes.
    it('drops the incremental etag so the next catch-up re-reads the feed', async function () {
        setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.modifiedIdsEtag, ECO), 'etag-from-before')
        feeds.streamOsvSeed.mockImplementation(stream([{ rows: [row()], lastModified: null }]))
        await seedOsv(db, ECO)
        expect(meta<string>(OSV_META_KEYS.modifiedIdsEtag)).toBeNull()
    })

    it('leaves lastModified alone when the export carried no header', async function () {
        setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.lastModified, ECO), 'previous')
        feeds.streamOsvSeed.mockImplementation(stream([{ rows: [row()], lastModified: null }]))
        await seedOsv(db, ECO)
        expect(meta<string>(OSV_META_KEYS.lastModified)).toBe('previous')
    })

    it('threads the abort signal into the download', async function () {
        const controller = new AbortController()
        feeds.streamOsvSeed.mockImplementation(stream([{ rows: [row()], lastModified: null }]))
        await seedOsv(db, ECO, controller.signal)
        expect(feeds.streamOsvSeed).toHaveBeenCalledWith(ECO, undefined, { abortSignal: controller.signal })
    })
})

describe('incrementalSyncOsv', function () {
    beforeEach(function markSeeded() {
        setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.seedComplete, ECO), true)
        setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.normalizerVersion, ECO), OSV_NORMALIZER_VERSION)
    })

    it('skips when the feed is disabled', async function () {
        feeds.feedDisabled = true
        expect(await incrementalSyncOsv(db, ECO)).toMatchObject({ status: 'skipped', message: 'feed disabled' })
    })

    // The common case by a wide margin: OSV republishes roughly daily, so most runs cost one round trip
    // and transfer nothing.
    it('costs nothing when the feed has not been republished', async function () {
        feeds.fetchOsvChangedIds.mockResolvedValue({ status: 'unchanged' })
        const result = await incrementalSyncOsv(db, ECO)
        expect(result).toMatchObject({ status: 'ok', upserted: 0, message: 'not modified' })
        expect(meta<number>(OSV_META_KEYS.refreshedAt)).not.toBeNull()
        expect(feeds.fetchOsvAdvisoryRows).not.toHaveBeenCalled()
    })

    it('records a failed manifest fetch without disturbing the cache', async function () {
        upsertOsvAdvisories(db, [row()])
        feeds.fetchOsvChangedIds.mockRejectedValue(new Error('connection reset'))
        const result = await incrementalSyncOsv(db, ECO)
        expect(result).toMatchObject({ status: 'error', upserted: 0, recordCount: 1 })
        expect(meta<string>(OSV_META_KEYS.lastError)).toContain('connection reset')
    })

    it('reports no changes and stores the new etag when the manifest is empty', async function () {
        feeds.fetchOsvChangedIds.mockResolvedValue({ status: 'ok', ids: [], newestIso: null, etag: 'etag-1' })
        const result = await incrementalSyncOsv(db, ECO)
        expect(result).toMatchObject({ status: 'ok', message: 'no changes' })
        expect(meta<string>(OSV_META_KEYS.modifiedIdsEtag)).toBe('etag-1')
    })

    // The other half of that write, and the reason it is guarded at all: fetchOsvChangedIds types etag
    // as `string | null` because a server is not obliged to send one. Writing it unconditionally would
    // replace a good cached etag with null, and every later sync would fall back from a conditional
    // request to a full manifest download — the exact cost this etag exists to avoid. Nothing would
    // error, the sync would just quietly get more expensive forever, which is why it needs a test
    // rather than a reviewer noticing.
    it('keeps the stored etag when the manifest carries none', async function () {
        setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.modifiedIdsEtag, ECO), 'etag-stored')
        feeds.fetchOsvChangedIds.mockResolvedValue({ status: 'ok', ids: [], newestIso: null, etag: null })
        const result = await incrementalSyncOsv(db, ECO)
        expect(result).toMatchObject({ status: 'ok', message: 'no changes' })
        expect(meta<string>(OSV_META_KEYS.modifiedIdsEtag)).toBe('etag-stored')
    })

    it('applies each changed advisory and advances the cursor', async function () {
        feeds.fetchOsvChangedIds.mockResolvedValue({
            status: 'ok',
            ids: ['GHSA-aaaa'],
            newestIso: '2026-01-02T00:00:00Z',
            etag: 'etag-2'
        })
        feeds.fetchOsvAdvisoryRows.mockResolvedValue([row()])

        const result = await incrementalSyncOsv(db, ECO)

        expect(result).toMatchObject({ status: 'ok', upserted: 1, recordCount: 1 })
        expect(meta<string>(OSV_META_KEYS.lastModified)).toBe('2026-01-02T00:00:00Z')
        expect(meta<string>(OSV_META_KEYS.modifiedIdsEtag)).toBe('etag-2')
    })

    // A package dropped from an advisory's `affected` set has to disappear, so the advisory's rows are
    // cleared before the new ones land rather than merged over.
    it('clears an advisory prior rows so a dropped package does not linger', async function () {
        upsertOsvAdvisories(db, [row({ packageName: 'left-pad' })])
        feeds.fetchOsvChangedIds.mockResolvedValue({ status: 'ok', ids: ['GHSA-aaaa'], newestIso: null, etag: null })
        feeds.fetchOsvAdvisoryRows.mockResolvedValue([row({ packageName: 'lodash' })])

        await incrementalSyncOsv(db, ECO)

        expect(lookupOsvByPackages(db, ECO, ['left-pad']).get('left-pad')).toBeUndefined()
        expect(lookupOsvByPackages(db, ECO, ['lodash'])).toBeDefined()
    })

    // An advisory that 404s upstream (deleted) comes back with no rows — clearing plus writing nothing
    // is what purges it.
    it('purges an advisory that returns no rows', async function () {
        upsertOsvAdvisories(db, [row()])
        feeds.fetchOsvChangedIds.mockResolvedValue({ status: 'ok', ids: ['GHSA-aaaa'], newestIso: null, etag: null })
        feeds.fetchOsvAdvisoryRows.mockResolvedValue([])

        const result = await incrementalSyncOsv(db, ECO)

        expect(result.recordCount).toBe(0)
        expect(countOsvAdvisories(db, ECO)).toBe(0)
    })

    // One advisory failing must not abort the pass, and must not cost the operator that advisory.
    it('skips an advisory whose fetch failed and keeps going', async function () {
        feeds.fetchOsvChangedIds.mockResolvedValue({
            status: 'ok',
            ids: ['GHSA-bad', 'GHSA-aaaa'],
            newestIso: null,
            etag: null
        })
        feeds.fetchOsvAdvisoryRows
            .mockRejectedValueOnce(new Error('connection reset'))
            .mockResolvedValueOnce([row()])

        const result = await incrementalSyncOsv(db, ECO)

        expect(result).toMatchObject({ status: 'ok', upserted: 1 })
        expect(countOsvAdvisories(db, ECO)).toBe(1)
    })

    // The rows go only once their replacement is in hand. Clearing first traded a stale advisory for no
    // advisory on every transient network failure — and a missing advisory is a finding that silently
    // stops being reported.
    it('keeps the existing rows when the replacement cannot be fetched', async function () {
        upsertOsvAdvisories(db, [row({ advisoryId: 'GHSA-bad', packageName: 'lodash' })])
        feeds.fetchOsvChangedIds.mockResolvedValue({ status: 'ok', ids: ['GHSA-bad'], newestIso: null, etag: null })
        feeds.fetchOsvAdvisoryRows.mockRejectedValue(new Error('connection reset'))

        await incrementalSyncOsv(db, ECO)

        expect(lookupOsvByPackages(db, ECO, ['lodash']).get('lodash')).toHaveLength(1)
    })

    // …and the cursor stays put, so the id is retried rather than left behind it forever. Repeating the
    // window is idempotent; skipping an id is not recoverable.
    it('holds the cursor when an advisory could not be re-read', async function () {
        setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.lastModified, ECO), '2026-01-01T00:00:00Z')
        feeds.fetchOsvChangedIds.mockResolvedValue({
            status: 'ok',
            ids: ['GHSA-bad'],
            newestIso: '2026-01-02T00:00:00Z',
            etag: 'etag-new'
        })
        feeds.fetchOsvAdvisoryRows.mockRejectedValue(new Error('connection reset'))

        await incrementalSyncOsv(db, ECO)

        expect(meta<string>(OSV_META_KEYS.lastModified)).toBe('2026-01-01T00:00:00Z')
        expect(meta<string>(OSV_META_KEYS.modifiedIdsEtag)).toBeNull()
        expect(meta<string>(OSV_META_KEYS.lastError)).toContain('could not be re-read')
    })

    // Past a certain volume, fetching one advisory at a time costs far more than re-downloading the whole
    // export — OSV can land tens of thousands of malware records in a single day.
    //
    // Both boundary tests drive the threshold down to 2. What they pin is the comparison at the boundary,
    // and one id either side of it proves that as completely as 20,000 did — while the id count is what
    // decided how long the test took, because the incremental path opens one SQLite transaction per id.
    it('re-seeds instead of fetching when the change set is enormous', async function () {
        feeds.incrementalMaxIds = 2
        const ids = ['GHSA-1', 'GHSA-2', 'GHSA-3']
        feeds.fetchOsvChangedIds.mockResolvedValue({ status: 'ok', ids, newestIso: null, etag: null })
        feeds.streamOsvSeed.mockImplementation(stream([{ rows: [row()], lastModified: null }]))

        const result = await incrementalSyncOsv(db, ECO)

        expect(feeds.streamOsvSeed).toHaveBeenCalledTimes(1)
        expect(feeds.fetchOsvAdvisoryRows).not.toHaveBeenCalled()
        expect(result).toMatchObject({ status: 'ok' })
    })

    it('stays incremental exactly at the threshold', async function () {
        feeds.incrementalMaxIds = 2
        const ids = ['GHSA-1', 'GHSA-2']
        feeds.fetchOsvChangedIds.mockResolvedValue({ status: 'ok', ids, newestIso: null, etag: null })
        feeds.fetchOsvAdvisoryRows.mockResolvedValue([])
        await incrementalSyncOsv(db, ECO)
        expect(feeds.streamOsvSeed).not.toHaveBeenCalled()
        // The assertion the id count used to obscure: at the boundary every changed id is still fetched.
        expect(feeds.fetchOsvAdvisoryRows).toHaveBeenCalledTimes(2)
    })

    it('stops fetching once the abort signal fires', async function () {
        const controller = new AbortController()
        feeds.fetchOsvChangedIds.mockResolvedValue({
            status: 'ok',
            ids: ['GHSA-1', 'GHSA-2', 'GHSA-3'],
            newestIso: null,
            etag: null
        })
        feeds.fetchOsvAdvisoryRows.mockImplementation(async function abortAfterFirst() {
            controller.abort()
            return []
        })

        await incrementalSyncOsv(db, ECO, controller.signal)

        expect(feeds.fetchOsvAdvisoryRows).toHaveBeenCalledTimes(1)
    })

    it('reads the stored cursor as milliseconds for the manifest request', async function () {
        setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.lastModified, ECO), '2026-01-01T00:00:00.000Z')
        feeds.fetchOsvChangedIds.mockResolvedValue({ status: 'unchanged' })
        await incrementalSyncOsv(db, ECO)
        expect(feeds.fetchOsvChangedIds.mock.calls[0]?.[1]).toBe(Date.parse('2026-01-01T00:00:00.000Z'))
    })

    it('treats an unparseable stored cursor as no cursor at all', async function () {
        setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.lastModified, ECO), 'not a date')
        feeds.fetchOsvChangedIds.mockResolvedValue({ status: 'unchanged' })
        await incrementalSyncOsv(db, ECO)
        expect(feeds.fetchOsvChangedIds.mock.calls[0]?.[1]).toBe(0)
    })

    it('starts from zero when nothing has ever been synced', async function () {
        feeds.fetchOsvChangedIds.mockResolvedValue({ status: 'unchanged' })
        await incrementalSyncOsv(db, ECO)
        expect(feeds.fetchOsvChangedIds.mock.calls[0]?.[1]).toBe(0)
    })

    it('passes the stored etag so the request can be answered with a 304', async function () {
        setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.modifiedIdsEtag, ECO), 'etag-stored')
        feeds.fetchOsvChangedIds.mockResolvedValue({ status: 'unchanged' })
        await incrementalSyncOsv(db, ECO)
        expect(feeds.fetchOsvChangedIds.mock.calls[0]?.[2]).toBe('etag-stored')
    })

    it('clears a stale error once a sync succeeds', async function () {
        setOsvMeta(db, osvMetaKeyFor(OSV_META_KEYS.lastError, ECO), 'previous failure')
        feeds.fetchOsvChangedIds.mockResolvedValue({ status: 'ok', ids: ['GHSA-aaaa'], newestIso: null, etag: null })
        feeds.fetchOsvAdvisoryRows.mockResolvedValue([row()])
        await incrementalSyncOsv(db, ECO)
        expect(meta<string>(OSV_META_KEYS.lastError)).toBeNull()
    })
})
