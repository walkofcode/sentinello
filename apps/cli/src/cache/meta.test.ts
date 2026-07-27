import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    advisoryFilePath,
    ensureCacheDir,
    getSourceState,
    isSeeded,
    readCacheMeta,
    resolveCacheDir,
    setSourceState,
    tryAcquireLock,
    writeCacheMeta,
    type CacheMeta,
    type SourceState
} from './meta'

// The cache directory is the only thing the CLI writes to disk, so its resolution order and its
// "treat anything I cannot interpret as absent" posture are the contract. Every failure mode here is
// meant to degrade to a re-download, never to a wrong answer.

let dir: string

beforeEach(async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-cache-'))
})

afterEach(async function cleanup() {
    vi.unstubAllEnvs()
    await rm(dir, { recursive: true, force: true })
})

function state(overrides: Partial<SourceState> = {}): SourceState {
    return { normalizerVersion: 1, recordCount: 10, refreshedAt: 0, ...overrides }
}

function meta(): CacheMeta {
    return { schemaVersion: 1, sources: { osv: {}, gemnasium: {} } }
}

describe('resolveCacheDir', function () {
    // Deliberately never the working directory: the cache has to be shared across every invocation
    // from every folder, and an npx run has no durable directory of its own.
    it('prefers an explicit override', function () {
        vi.stubEnv('SENTINELLO_CACHE_DIR', '/from/env')
        vi.stubEnv('XDG_CACHE_HOME', '/from/xdg')
        expect(resolveCacheDir('/explicit')).toBe(resolve('/explicit'))
    })

    it('falls back to SENTINELLO_CACHE_DIR', function () {
        vi.stubEnv('SENTINELLO_CACHE_DIR', '/from/env')
        vi.stubEnv('XDG_CACHE_HOME', '/from/xdg')
        expect(resolveCacheDir()).toBe(resolve('/from/env'))
    })

    it('falls back to a sentinello subdirectory of XDG_CACHE_HOME', function () {
        vi.stubEnv('SENTINELLO_CACHE_DIR', '')
        vi.stubEnv('XDG_CACHE_HOME', '/from/xdg')
        expect(resolveCacheDir()).toBe(join(resolve('/from/xdg'), 'sentinello'))
    })

    it('falls back to ~/.cache/sentinello', function () {
        vi.stubEnv('SENTINELLO_CACHE_DIR', undefined)
        vi.stubEnv('XDG_CACHE_HOME', undefined)
        expect(resolveCacheDir()).toBe(join(homedir(), '.cache', 'sentinello'))
    })

    it.each([null, undefined, '', '   '])('treats the override %j as unset', function (override) {
        vi.stubEnv('SENTINELLO_CACHE_DIR', '/from/env')
        expect(resolveCacheDir(override)).toBe(resolve('/from/env'))
    })

    it('trims and absolutizes a relative override', function () {
        expect(resolveCacheDir('  ./rel  ')).toBe(resolve('./rel'))
    })
})

describe('advisoryFilePath', function () {
    it('names the file after the source and ecosystem', function () {
        expect(advisoryFilePath('/cache', 'osv', 'npm')).toBe(join('/cache', 'osv-npm.ndjson.gz'))
    })

    // 'crates.io' is a legal ecosystem id and an awkward filename, so the dot run is flattened.
    it('flattens characters that are awkward in a filename', function () {
        expect(advisoryFilePath('/cache', 'gemnasium', 'crates io/x')).toBe(
            join('/cache', 'gemnasium-crates-io-x.ndjson.gz')
        )
    })

    it('keeps dots, dashes and underscores', function () {
        expect(advisoryFilePath('/cache', 'osv', 'a.b-c_d')).toBe(join('/cache', 'osv-a.b-c_d.ndjson.gz'))
    })
})

describe('ensureCacheDir', function () {
    it('creates the directory', async function () {
        const target = join(dir, 'nested', 'deep')
        await ensureCacheDir(target)
        expect((await stat(target)).isDirectory()).toBe(true)
    })

    it('is idempotent', async function () {
        await ensureCacheDir(dir)
        await expect(ensureCacheDir(dir)).resolves.toBeUndefined()
    })
})

describe('readCacheMeta', function () {
    // Every one of these degrades to "no cache", which costs a re-download and never a wrong answer.
    it('returns empty metadata when there is no file', async function () {
        expect(await readCacheMeta(dir)).toEqual(meta())
    })

    it('returns empty metadata on unparseable JSON', async function () {
        await writeFile(join(dir, 'meta.json'), '{ broken', 'utf8')
        expect(await readCacheMeta(dir)).toEqual(meta())
    })

    it.each(['null', '42', '"a string"'])('returns empty metadata for the non-object %s', async function (raw) {
        await writeFile(join(dir, 'meta.json'), raw, 'utf8')
        expect(await readCacheMeta(dir)).toEqual(meta())
    })

    // A cache written by a different on-disk layout cannot be interpreted, so it is discarded.
    it('discards metadata from a different schema version', async function () {
        await writeFile(join(dir, 'meta.json'), JSON.stringify({ schemaVersion: 99, sources: { osv: { npm: state() } } }), 'utf8')
        expect(await readCacheMeta(dir)).toEqual(meta())
    })

    it('returns empty metadata when sources is missing', async function () {
        await writeFile(join(dir, 'meta.json'), JSON.stringify({ schemaVersion: 1 }), 'utf8')
        expect(await readCacheMeta(dir)).toEqual(meta())
    })

    it('defaults a missing source key to empty rather than failing', async function () {
        await writeFile(join(dir, 'meta.json'), JSON.stringify({ schemaVersion: 1, sources: { osv: { npm: state() } } }), 'utf8')
        const read = await readCacheMeta(dir)
        expect(read.sources.gemnasium).toEqual({})
        expect(read.sources.osv.npm).toEqual(state())
    })
})

describe('writeCacheMeta', function () {
    it('round-trips through readCacheMeta', async function () {
        const m = meta()
        setSourceState(m, 'osv', 'npm', state({ cursorIso: '2026-07-01T00:00:00Z', etag: 'abc' }))
        await writeCacheMeta(dir, m)
        expect(await readCacheMeta(dir)).toEqual(m)
    })

    it('creates the cache directory if it does not exist', async function () {
        const target = join(dir, 'fresh')
        await writeCacheMeta(target, meta())
        expect((await readCacheMeta(target)).schemaVersion).toBe(1)
    })

    // Written to a temp file and renamed, so a crash mid-write cannot leave a half-parsed meta.json.
    it('leaves no temporary file behind', async function () {
        await writeCacheMeta(dir, meta())
        await expect(stat(join(dir, 'meta.json.tmp'))).rejects.toThrow()
    })

    it('writes trailing-newline JSON', async function () {
        await writeCacheMeta(dir, meta())
        expect((await readFile(join(dir, 'meta.json'), 'utf8')).endsWith('\n')).toBe(true)
    })
})

describe('getSourceState and setSourceState', function () {
    it('returns null for an ecosystem that has no state', function () {
        expect(getSourceState(meta(), 'osv', 'npm')).toBeNull()
    })

    it('stores and reads back per source and ecosystem', function () {
        const m = meta()
        setSourceState(m, 'osv', 'npm', state({ recordCount: 5 }))
        setSourceState(m, 'gemnasium', 'npm', state({ recordCount: 7 }))
        expect(getSourceState(m, 'osv', 'npm')?.recordCount).toBe(5)
        expect(getSourceState(m, 'gemnasium', 'npm')?.recordCount).toBe(7)
    })

    it('keeps ecosystems separate within one source', function () {
        const m = meta()
        setSourceState(m, 'osv', 'npm', state({ recordCount: 5 }))
        expect(getSourceState(m, 'osv', 'PyPI')).toBeNull()
    })

    it('overwrites existing state for the same key', function () {
        const m = meta()
        setSourceState(m, 'osv', 'npm', state({ recordCount: 5 }))
        setSourceState(m, 'osv', 'npm', state({ recordCount: 9 }))
        expect(getSourceState(m, 'osv', 'npm')?.recordCount).toBe(9)
    })
})

describe('isSeeded', function () {
    it('is false when there is no state', function () {
        expect(isSeeded(meta(), 'osv', 'npm', 1)).toBe(false)
    })

    it('is true for current rows', function () {
        const m = meta()
        setSourceState(m, 'osv', 'npm', state({ normalizerVersion: 2, recordCount: 10 }))
        expect(isSeeded(m, 'osv', 'npm', 2)).toBe(true)
    })

    // A cache built by an older normalizer would be matched with the wrong semantics, so it counts as
    // absent rather than being trusted.
    it('is false when the normalizer version differs', function () {
        const m = meta()
        setSourceState(m, 'osv', 'npm', state({ normalizerVersion: 1, recordCount: 10 }))
        expect(isSeeded(m, 'osv', 'npm', 2)).toBe(false)
    })

    it('is false when there are no rows', function () {
        const m = meta()
        setSourceState(m, 'osv', 'npm', state({ recordCount: 0 }))
        expect(isSeeded(m, 'osv', 'npm', 1)).toBe(false)
    })
})

describe('tryAcquireLock', function () {
    it('acquires a lock when none is held', async function () {
        const lock = await tryAcquireLock(dir)
        expect(lock).not.toBeNull()
        await lock?.release()
    })

    // A scan that finds the lock held reads the existing cache rather than waiting, so returning null
    // rather than blocking is the point.
    it('returns null when a fresh lock is already held', async function () {
        const first = await tryAcquireLock(dir)
        expect(await tryAcquireLock(dir)).toBeNull()
        await first?.release()
    })

    it('allows a new lock after release', async function () {
        const first = await tryAcquireLock(dir)
        await first?.release()
        const second = await tryAcquireLock(dir)
        expect(second).not.toBeNull()
        await second?.release()
    })

    // A lock left behind by a killed process would otherwise block syncing forever.
    it('reclaims a stale lock', async function () {
        const lockPath = join(dir, '.lock')
        await writeFile(lockPath, '99999', 'utf8')
        const old = new Date(Date.now() - 60 * 60 * 1000)
        await utimes(lockPath, old, old)
        const lock = await tryAcquireLock(dir)
        expect(lock).not.toBeNull()
        await lock?.release()
    })

    it('creates the cache directory while locking', async function () {
        const target = join(dir, 'fresh')
        const lock = await tryAcquireLock(target)
        expect((await stat(target)).isDirectory()).toBe(true)
        await lock?.release()
    })

    it('tolerates a double release', async function () {
        const lock = await tryAcquireLock(dir)
        await lock?.release()
        await expect(lock?.release()).resolves.toBeUndefined()
    })
})
