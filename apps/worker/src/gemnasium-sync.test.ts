import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    GEMNASIUM_META_KEYS,
    GEMNASIUM_NORMALIZER_VERSION,
    countGemnasiumAdvisories,
    getGemnasiumMeta,
    lookupGemnasiumByPackages,
    openGemnasiumDb,
    runGemnasiumMigrations,
    setGemnasiumMeta,
    upsertGemnasiumAdvisories,
    type GemnasiumDrizzleDb,
    type SqliteDb
} from '@sentinello/db'
import type { GemnasiumAdvisoryRow } from '@sentinello/core'

// gemnasium-sync exists because the old behaviour was to re-download ~80 MB on every cycle regardless of
// whether the upstream repo had moved at all. What replaced it is a three-way decision, cheapest first,
// and each branch has a failure mode the others do not:
//
//   1. HEAD sha unchanged  → return immediately, transfer nothing.
//   2. HEAD moved, provenance known → apply just the changed advisory files.
//   3. no usable provenance → full archive rebuild.
//
// The rules that make it safe to be this cheap:
//   - the incremental path advances the sha ONLY on success. A partially applied catch-up must be retried
//     from the same starting point; advancing regardless would skip the un-applied half forever.
//   - a commit touching only unsupported ecosystems still advances the sha, or every later sync would
//     re-compare from the same stale point and never converge.
//   - the rebuild's purge runs ONLY after the full stream succeeds. Purging on a partial download would
//     empty the cache on any transient network failure.
//
// @sentinello/feeds is stubbed; the cache is a real migrated gemnasium.db.

const feeds = vi.hoisted(function makeFeedsDouble() {
    return {
        feedDisabled: false,
        fetchGemnasiumHeadSha: vi.fn(),
        fetchGemnasiumChangedPaths: vi.fn(),
        fetchGemnasiumFileRows: vi.fn(),
        streamGemnasiumArchive: vi.fn()
    }
})

vi.mock('@sentinello/feeds', function mockFeeds() {
    return {
        // Reproduces the real helper (strip directories, strip the extension) so path→id mapping in the
        // incremental path is exercised rather than stubbed away.
        advisoryIdFromPath: function advisoryIdFromPath(path: string) {
            const file = path.split('/').pop()
            if (!file) return null
            const dot = file.lastIndexOf('.')
            const id = dot > 0 ? file.slice(0, dot) : file
            return id.length > 0 ? id : null
        },
        errText: function errText(err: unknown) {
            return err instanceof Error && err.message || String(err)
        },
        gemnasiumFeedDisabled: function gemnasiumFeedDisabled() { return feeds.feedDisabled },
        fetchGemnasiumHeadSha: feeds.fetchGemnasiumHeadSha,
        fetchGemnasiumChangedPaths: feeds.fetchGemnasiumChangedPaths,
        fetchGemnasiumFileRows: feeds.fetchGemnasiumFileRows,
        streamGemnasiumArchive: feeds.streamGemnasiumArchive
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

const { checkGemnasiumFreeSpace, syncGemnasium } = await import('./gemnasium-sync')

let dir: string
let db: GemnasiumDrizzleDb
let sqlite: SqliteDb
let priorEnv: string | undefined

function row(overrides: Partial<GemnasiumAdvisoryRow> = {}): GemnasiumAdvisoryRow {
    return {
        advisoryId: 'CVE-2024-1',
        ecosystem: 'npm',
        packageName: 'lodash',
        aliases: ['GHSA-aaaa'],
        ranges: [{ introduced: '0', fixed: '4.17.21' }],
        versions: [],
        severity: 'high',
        summary: 'Prototype pollution',
        url: 'https://example.test/CVE-2024-1',
        ...overrides
    } as GemnasiumAdvisoryRow
}

function stream(batches: { rows: GemnasiumAdvisoryRow[]; lastModified: string | null }[], failAfter?: number) {
    return async function* generate() {
        let emitted = 0
        for (const batch of batches) {
            if (failAfter !== undefined && emitted === failAfter) throw new Error('archive died')
            yield batch
            emitted += 1
        }
        if (failAfter !== undefined && emitted === failAfter) throw new Error('archive died')
    }
}

function meta<T>(key: string): T | null {
    return getGemnasiumMeta<T>(db, key)
}

// Puts the cache in the state where the incremental path is eligible: seeded, current normalizer, and a
// known provenance sha.
function markSeeded(sha = 'sha-old'): void {
    setGemnasiumMeta(db, GEMNASIUM_META_KEYS.seedComplete, true)
    setGemnasiumMeta(db, GEMNASIUM_META_KEYS.normalizerVersion, GEMNASIUM_NORMALIZER_VERSION)
    setGemnasiumMeta(db, GEMNASIUM_META_KEYS.headSha, sha)
}

beforeEach(async function setup() {
    feeds.feedDisabled = false
    statfsResult.override = null
    feeds.fetchGemnasiumHeadSha.mockReset()
    feeds.fetchGemnasiumChangedPaths.mockReset()
    feeds.fetchGemnasiumFileRows.mockReset()
    feeds.streamGemnasiumArchive.mockReset()
    feeds.fetchGemnasiumHeadSha.mockResolvedValue('sha-new')
    feeds.streamGemnasiumArchive.mockImplementation(stream([{ rows: [row()], lastModified: null }]))
    dir = await mkdtemp(join(tmpdir(), 'sentinello-gemnasium-sync-'))
    priorEnv = process.env.SENTINELLO_GEMNASIUM_DB_PATH
    process.env.SENTINELLO_GEMNASIUM_DB_PATH = join(dir, 'gemnasium.db')
    const opened = openGemnasiumDb(join(dir, 'gemnasium.db'))
    db = opened.db
    sqlite = opened.sqlite
    runGemnasiumMigrations(db)
    vi.spyOn(console, 'log').mockImplementation(function silence() {})
})

afterEach(async function teardown() {
    if (priorEnv === undefined) delete process.env.SENTINELLO_GEMNASIUM_DB_PATH
    else process.env.SENTINELLO_GEMNASIUM_DB_PATH = priorEnv
    vi.restoreAllMocks()
    sqlite.close()
    await rm(dir, { recursive: true, force: true })
})

describe('checkGemnasiumFreeSpace', function () {
    it('reports the available bytes on the volume holding the cache', async function () {
        const space = await checkGemnasiumFreeSpace()
        expect(space.freeBytes).toBeGreaterThan(0)
        expect(space.sufficient).toBe(true)
    })

    it('reports unknown rather than blocking when the volume cannot be stat-ed', async function () {
        process.env.SENTINELLO_GEMNASIUM_DB_PATH = join(dir, 'no', 'such', 'place', 'gemnasium.db')
        expect(await checkGemnasiumFreeSpace()).toEqual({ freeBytes: 0, sufficient: true })
    })

    it('reports insufficient when the volume is below the required headroom', async function () {
        statfsResult.override = { bavail: 10, bsize: 4096 }
        expect(await checkGemnasiumFreeSpace()).toMatchObject({ freeBytes: 40_960, sufficient: false })
    })
})

// The rebuild pulls the full ~80 MB archive and expands it. The guard sits on the REBUILD path only,
// not on the incremental one — an incremental catch-up applies a handful of files and needs no
// headroom, so gating it on disk space would refuse cheap work for an expensive reason.
describe('syncGemnasium — the free-space guard on the rebuild path', function () {
    beforeEach(function tinyVolume() {
        statfsResult.override = { bavail: 10, bsize: 4096 }
        feeds.fetchGemnasiumHeadSha.mockResolvedValue('sha-1')
    })

    it('refuses to rebuild and never opens the archive', async function () {
        const result = await syncGemnasium(db)
        expect(result).toMatchObject({ status: 'error', upserted: 0 })
        expect(result.message).toMatch(/insufficient free space for gemnasium seed: need ~\d+ MiB, have 0 MiB/)
        expect(feeds.streamGemnasiumArchive).not.toHaveBeenCalled()
    })

    // Surfaced in Settings → Sources rather than only returned, so the source does not just look
    // permanently un-seeded with no stated reason.
    it('records the reason as the source last error', async function () {
        await syncGemnasium(db)
        expect(getGemnasiumMeta(db, GEMNASIUM_META_KEYS.lastError)).toMatch(/insufficient free space/)
    })

    // The cache is left exactly as it was: refusing to start is the whole point, and a guard that
    // purged first would turn a full disk into an empty advisory database.
    it('leaves the existing cache intact', async function () {
        upsertGemnasiumAdvisories(db, [row()])
        const before = countGemnasiumAdvisories(db)

        await syncGemnasium(db)

        expect(countGemnasiumAdvisories(db)).toBe(before)
    })
})

describe('syncGemnasium — choosing a path', function () {
    it('skips entirely when the feed is disabled', async function () {
        feeds.feedDisabled = true
        expect(await syncGemnasium(db)).toMatchObject({ status: 'skipped', message: 'feed disabled' })
        expect(feeds.fetchGemnasiumHeadSha).not.toHaveBeenCalled()
    })

    // The cheapest outcome, and the one that made per-scan syncing viable at all.
    it('transfers nothing when HEAD has not moved', async function () {
        markSeeded('sha-same')
        feeds.fetchGemnasiumHeadSha.mockResolvedValue('sha-same')

        const result = await syncGemnasium(db)

        expect(result).toMatchObject({ status: 'ok', upserted: 0, message: 'unchanged upstream' })
        expect(feeds.fetchGemnasiumChangedPaths).not.toHaveBeenCalled()
        expect(feeds.streamGemnasiumArchive).not.toHaveBeenCalled()
        expect(meta<number>(GEMNASIUM_META_KEYS.refreshedAt)).not.toBeNull()
    })

    it('rebuilds from the archive on a first seed', async function () {
        const result = await syncGemnasium(db)
        expect(feeds.streamGemnasiumArchive).toHaveBeenCalledTimes(1)
        expect(result).toMatchObject({ status: 'ok', upserted: 1 })
    })

    // A normalizer bump means the stored rows lack fields the matcher now reads; only a rebuild fixes that.
    it('rebuilds rather than catching up when the normalizer version moved', async function () {
        markSeeded()
        setGemnasiumMeta(db, GEMNASIUM_META_KEYS.normalizerVersion, GEMNASIUM_NORMALIZER_VERSION - 1)
        await syncGemnasium(db)
        expect(feeds.streamGemnasiumArchive).toHaveBeenCalledTimes(1)
        expect(feeds.fetchGemnasiumChangedPaths).not.toHaveBeenCalled()
    })

    it('rebuilds when the cache was seeded but carries no provenance sha', async function () {
        setGemnasiumMeta(db, GEMNASIUM_META_KEYS.seedComplete, true)
        setGemnasiumMeta(db, GEMNASIUM_META_KEYS.normalizerVersion, GEMNASIUM_NORMALIZER_VERSION)
        await syncGemnasium(db)
        expect(feeds.streamGemnasiumArchive).toHaveBeenCalledTimes(1)
    })

    it('rebuilds when the upstream sha could not be read', async function () {
        markSeeded()
        feeds.fetchGemnasiumHeadSha.mockResolvedValue(null)
        await syncGemnasium(db)
        expect(feeds.streamGemnasiumArchive).toHaveBeenCalledTimes(1)
    })

    it('catches up incrementally when provenance is intact and HEAD moved', async function () {
        markSeeded()
        feeds.fetchGemnasiumChangedPaths.mockResolvedValue({
            status: 'ok',
            changed: ['npm/lodash/CVE-2024-1.yml'],
            deleted: [],
            toSha: 'sha-new'
        })
        feeds.fetchGemnasiumFileRows.mockResolvedValue([row()])

        const result = await syncGemnasium(db)

        expect(feeds.streamGemnasiumArchive).not.toHaveBeenCalled()
        expect(result).toMatchObject({ status: 'ok', upserted: 1 })
        expect(meta<string>(GEMNASIUM_META_KEYS.headSha)).toBe('sha-new')
    })

    // Falling back rather than leaving the cache subtly incomplete: an unusable compare (too many files,
    // upstream timeout) means we cannot know what changed.
    it('falls back to a full rebuild when the compare is unusable', async function () {
        markSeeded()
        feeds.fetchGemnasiumChangedPaths.mockResolvedValue({ status: 'unavailable', reason: 'too many files' })

        const result = await syncGemnasium(db)

        expect(feeds.streamGemnasiumArchive).toHaveBeenCalledTimes(1)
        expect(result).toMatchObject({ status: 'ok' })
    })
})

describe('syncGemnasium — the incremental path', function () {
    beforeEach(function seeded() {
        markSeeded()
    })

    // The sha must advance even though nothing changed here, or every later sync re-compares from the
    // same stale point and the window only grows.
    it('advances the sha when the commit touched only unsupported ecosystems', async function () {
        feeds.fetchGemnasiumChangedPaths.mockResolvedValue({
            status: 'ok',
            changed: [],
            deleted: [],
            toSha: 'sha-new'
        })

        const result = await syncGemnasium(db)

        expect(result).toMatchObject({ status: 'ok', upserted: 0, message: 'no relevant changes' })
        expect(meta<string>(GEMNASIUM_META_KEYS.headSha)).toBe('sha-new')
    })

    it('removes an advisory deleted upstream', async function () {
        upsertGemnasiumAdvisories(db, [row({ advisoryId: 'CVE-2024-gone' })])
        feeds.fetchGemnasiumChangedPaths.mockResolvedValue({
            status: 'ok',
            changed: [],
            deleted: ['npm/lodash/CVE-2024-gone.yml'],
            toSha: 'sha-new'
        })

        await syncGemnasium(db)

        expect(countGemnasiumAdvisories(db)).toBe(0)
    })

    // Clearing before rewriting is what stops a package dropped from an advisory lingering as a phantom.
    it('clears a changed advisory prior rows before rewriting it', async function () {
        upsertGemnasiumAdvisories(db, [row({ packageName: 'left-pad' })])
        feeds.fetchGemnasiumChangedPaths.mockResolvedValue({
            status: 'ok',
            changed: ['npm/lodash/CVE-2024-1.yml'],
            deleted: [],
            toSha: 'sha-new'
        })
        feeds.fetchGemnasiumFileRows.mockResolvedValue([row({ packageName: 'lodash' })])

        await syncGemnasium(db)

        expect(lookupGemnasiumByPackages(db, 'npm', ['left-pad']).get('left-pad')).toBeUndefined()
        expect(countGemnasiumAdvisories(db)).toBe(1)
    })

    it('applies several changed files in one pass', async function () {
        feeds.fetchGemnasiumChangedPaths.mockResolvedValue({
            status: 'ok',
            changed: ['npm/a/CVE-1.yml', 'npm/b/CVE-2.yml'],
            deleted: [],
            toSha: 'sha-new'
        })
        feeds.fetchGemnasiumFileRows
            .mockResolvedValueOnce([row({ advisoryId: 'CVE-1', packageName: 'a' })])
            .mockResolvedValueOnce([row({ advisoryId: 'CVE-2', packageName: 'b' })])

        const result = await syncGemnasium(db)

        expect(result).toMatchObject({ upserted: 2, recordCount: 2 })
    })

    it('tolerates a changed file that produced no rows', async function () {
        feeds.fetchGemnasiumChangedPaths.mockResolvedValue({
            status: 'ok',
            changed: ['npm/a/CVE-1.yml'],
            deleted: [],
            toSha: 'sha-new'
        })
        feeds.fetchGemnasiumFileRows.mockResolvedValue([])
        expect(await syncGemnasium(db)).toMatchObject({ status: 'ok', upserted: 0 })
    })

    // The single most consequential rule in this module: a half-applied catch-up must be retried from the
    // same point, so the sha stays where it was.
    it('does not advance the sha when a file fetch fails', async function () {
        feeds.fetchGemnasiumChangedPaths.mockResolvedValue({
            status: 'ok',
            changed: ['npm/a/CVE-1.yml'],
            deleted: [],
            toSha: 'sha-new'
        })
        feeds.fetchGemnasiumFileRows.mockRejectedValue(new Error('upstream 500'))

        const result = await syncGemnasium(db)

        expect(result).toMatchObject({ status: 'error' })
        expect(meta<string>(GEMNASIUM_META_KEYS.headSha)).toBe('sha-old')
        expect(meta<string>(GEMNASIUM_META_KEYS.lastError)).toContain('upstream 500')
    })

    it('reports how far it got before failing', async function () {
        feeds.fetchGemnasiumChangedPaths.mockResolvedValue({
            status: 'ok',
            changed: ['npm/a/CVE-1.yml', 'npm/b/CVE-2.yml'],
            deleted: [],
            toSha: 'sha-new'
        })
        feeds.fetchGemnasiumFileRows
            .mockResolvedValueOnce([row({ advisoryId: 'CVE-1' })])
            .mockRejectedValueOnce(new Error('upstream 500'))

        const result = await syncGemnasium(db)

        expect(result).toMatchObject({ status: 'error', upserted: 1 })
        expect(meta<string>(GEMNASIUM_META_KEYS.lastError)).toContain('after 1 rows')
    })

    it('stops on abort and leaves the sha where it was', async function () {
        const controller = new AbortController()
        feeds.fetchGemnasiumChangedPaths.mockResolvedValue({
            status: 'ok',
            changed: ['npm/a/CVE-1.yml', 'npm/b/CVE-2.yml'],
            deleted: [],
            toSha: 'sha-new'
        })
        feeds.fetchGemnasiumFileRows.mockImplementation(async function abortAfterFirst() {
            controller.abort()
            return [row({ advisoryId: 'CVE-1' })]
        })

        const result = await syncGemnasium(db, controller.signal)

        expect(result.status).toBe('error')
        expect(feeds.fetchGemnasiumFileRows).toHaveBeenCalledTimes(1)
        expect(meta<string>(GEMNASIUM_META_KEYS.headSha)).toBe('sha-old')
    })

    it('clears a stale error once a catch-up succeeds', async function () {
        setGemnasiumMeta(db, GEMNASIUM_META_KEYS.lastError, 'previous failure')
        feeds.fetchGemnasiumChangedPaths.mockResolvedValue({
            status: 'ok',
            changed: ['npm/a/CVE-1.yml'],
            deleted: [],
            toSha: 'sha-new'
        })
        feeds.fetchGemnasiumFileRows.mockResolvedValue([row()])
        await syncGemnasium(db)
        expect(meta<string>(GEMNASIUM_META_KEYS.lastError)).toBeNull()
    })
})

describe('syncGemnasium — the full rebuild', function () {
    it('writes every streamed row and stamps the cache seeded', async function () {
        feeds.streamGemnasiumArchive.mockImplementation(stream([
            { rows: [row(), row({ advisoryId: 'CVE-2', packageName: 'minimist' })], lastModified: 'Mon, 01 Jan 2026 00:00:00 GMT' }
        ]))

        const result = await syncGemnasium(db)

        expect(result).toMatchObject({ status: 'ok', upserted: 2, recordCount: 2, message: null })
        expect(meta<boolean>(GEMNASIUM_META_KEYS.seedComplete)).toBe(true)
        expect(meta<number>(GEMNASIUM_META_KEYS.normalizerVersion)).toBe(GEMNASIUM_NORMALIZER_VERSION)
        expect(meta<string>(GEMNASIUM_META_KEYS.lastModified)).toBe('Mon, 01 Jan 2026 00:00:00 GMT')
    })

    // The archive comes from `master`, not a pinned sha, so it may be newer than the sha read a moment
    // earlier. Recording the older sha is still correct: the next compare replays that window, which is
    // idempotent, rather than skipping it.
    it('records the sha it knew about, not the one the archive might hold', async function () {
        feeds.fetchGemnasiumHeadSha.mockResolvedValue('sha-observed')
        await syncGemnasium(db)
        expect(meta<string>(GEMNASIUM_META_KEYS.headSha)).toBe('sha-observed')
    })

    // Only safe after the full stream succeeded — which is exactly why it is not in the loop.
    it('purges advisories that disappeared upstream', async function () {
        upsertGemnasiumAdvisories(db, [row({ advisoryId: 'CVE-gone', packageName: 'ghost' })])
        feeds.streamGemnasiumArchive.mockImplementation(stream([{ rows: [row()], lastModified: null }]))

        await syncGemnasium(db)

        expect(countGemnasiumAdvisories(db)).toBe(1)
        expect(lookupGemnasiumByPackages(db, 'npm', ['ghost']).get('ghost')).toBeUndefined()
    })

    it('never purges after a partial download', async function () {
        upsertGemnasiumAdvisories(db, [row({ advisoryId: 'CVE-keep', packageName: 'ghost' })])
        feeds.streamGemnasiumArchive.mockImplementation(stream([{ rows: [row()], lastModified: null }], 1))

        const result = await syncGemnasium(db)

        expect(result).toMatchObject({ status: 'error', upserted: 1 })
        expect(lookupGemnasiumByPackages(db, 'npm', ['ghost']).get('ghost')).toBeDefined()
    })

    it('records the failure reason and leaves the cache unseeded', async function () {
        feeds.streamGemnasiumArchive.mockImplementation(stream([], 0))

        const result = await syncGemnasium(db)

        expect(result.status).toBe('error')
        expect(meta<string>(GEMNASIUM_META_KEYS.lastError)).toContain('gemnasium archive sync failed')
        expect(meta<boolean>(GEMNASIUM_META_KEYS.seedComplete)).toBeNull()
    })

    it('consumes several batches into one rebuild', async function () {
        feeds.streamGemnasiumArchive.mockImplementation(stream([
            { rows: [row()], lastModified: null },
            { rows: [row({ advisoryId: 'CVE-2' })], lastModified: 'later' }
        ]))
        const result = await syncGemnasium(db)
        expect(result.upserted).toBe(2)
        expect(meta<string>(GEMNASIUM_META_KEYS.lastModified)).toBe('later')
    })

    it('threads the abort signal into the download', async function () {
        const controller = new AbortController()
        await syncGemnasium(db, controller.signal)
        expect(feeds.streamGemnasiumArchive).toHaveBeenCalledWith('sha-new', undefined, { abortSignal: controller.signal })
    })

    // The archive is fetched AT the sha we resolved, not at a moving ref. That is what makes the download
    // an immutable, CDN-cacheable object shared by every client on the same upstream commit — requesting
    // `master` instead is what had GitLab shedding the request with a 406 that no retry could clear.
    it('downloads the archive at the sha it resolved', async function () {
        feeds.fetchGemnasiumHeadSha.mockResolvedValue('sha-pinned')
        await syncGemnasium(db)
        expect(feeds.streamGemnasiumArchive.mock.calls[0]?.[0]).toBe('sha-pinned')
    })

    // A failed sha lookup degrades to the branch ref inside the feeds layer rather than skipping the seed.
    it('passes a null sha straight through when the lookup failed', async function () {
        feeds.fetchGemnasiumHeadSha.mockResolvedValue(null)
        await syncGemnasium(db)
        expect(feeds.streamGemnasiumArchive.mock.calls[0]?.[0]).toBeNull()
    })
})
