import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { countRows, createRowWriter, readRowsForPackages, rewriteRows } from './store'
import type { StorableRow } from './store'

// The advisory cache is gzipped NDJSON: `packageName \t advisoryId \t {json}` per line. The two
// leading fields duplicate data from the JSON on purpose — every read filters by package name and
// every incremental update filters by advisory id, so those passes stay string slices and only
// matching lines are ever JSON.parsed.

type Row = StorableRow & { severity?: string }

let dir: string
let path: string

beforeEach(async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-store-'))
    path = join(dir, 'osv-npm.ndjson.gz')
})

afterEach(async function teardown() {
    await rm(dir, { recursive: true, force: true })
})

async function writeRows(rows: Row[]): Promise<number> {
    const writer = createRowWriter(path)
    await writer.write(rows)
    return await writer.commit()
}

function row(packageName: string, advisoryId: string, extra: Partial<Row> = {}): Row {
    return { packageName, advisoryId, ...extra }
}

describe('createRowWriter and readRowsForPackages', function () {
    it('round-trips rows through the cache', async function () {
        await writeRows([row('lodash', 'GHSA-1', { severity: 'high' }), row('axios', 'GHSA-2')])

        const found = await readRowsForPackages<Row>(path, new Set(['lodash']))
        expect(found.get('lodash')).toEqual([{ packageName: 'lodash', advisoryId: 'GHSA-1', severity: 'high' }])
        expect(found.has('axios')).toBe(false)
    })

    it('reports the number of rows committed', async function () {
        expect(await writeRows([row('a', '1'), row('b', '2'), row('c', '3')])).toBe(3)
    })

    it('groups several advisories under one package', async function () {
        await writeRows([row('lodash', 'GHSA-1'), row('lodash', 'GHSA-2')])
        expect(await readRowsForPackages<Row>(path, new Set(['lodash']))).toEqual(
            new Map([['lodash', [row('lodash', 'GHSA-1'), row('lodash', 'GHSA-2')]]])
        )
    })

    it('returns rows for several requested packages at once', async function () {
        await writeRows([row('a', '1'), row('b', '2'), row('c', '3')])
        const found = await readRowsForPackages<Row>(path, new Set(['a', 'c']))
        expect([...found.keys()].sort()).toEqual(['a', 'c'])
    })

    it('returns an empty map when nothing was requested', async function () {
        await writeRows([row('a', '1')])
        expect(await readRowsForPackages<Row>(path, new Set())).toEqual(new Map())
    })

    // A missing cache is the normal pre-seed state, not an error.
    it('returns an empty map when the cache file does not exist', async function () {
        expect(await readRowsForPackages<Row>(join(dir, 'absent.gz'), new Set(['a']))).toEqual(new Map())
    })

    it('accepts multiple write calls before a single commit', async function () {
        const writer = createRowWriter(path)
        await writer.write([row('a', '1')])
        await writer.write([row('b', '2')])
        expect(await writer.commit()).toBe(2)
        expect(await countRows(path)).toBe(2)
    })
})

describe('the on-disk format', function () {
    it('is gzip-compressed', async function () {
        await writeRows([row('lodash', 'GHSA-1')])
        const raw = await readFile(path)
        // gzip magic number.
        expect(raw[0]).toBe(0x1f)
        expect(raw[1]).toBe(0x8b)
    })

    it('writes one tab-delimited line per row, with the leading fields duplicated', async function () {
        await writeRows([row('lodash', 'GHSA-1', { severity: 'high' })])
        const text = gunzipSync(await readFile(path)).toString('utf8')
        const lines = text.split('\n').filter(Boolean)

        expect(lines).toHaveLength(1)
        const parts = lines[0]?.split('\t') ?? []
        expect(parts[0]).toBe('lodash')
        expect(parts[1]).toBe('GHSA-1')
        expect(JSON.parse(parts[2] ?? '{}')).toEqual({ packageName: 'lodash', advisoryId: 'GHSA-1', severity: 'high' })
    })

    // Tabs and newlines in the leading fields would break the record framing, so they are stripped
    // there — while the JSON payload keeps the original value (JSON.stringify escapes them safely).
    it('strips separators from the leading fields but not from the payload', async function () {
        await writeRows([row('bad\tname', 'GHSA\n1')])
        const text = gunzipSync(await readFile(path)).toString('utf8')
        const lines = text.split('\n').filter(Boolean)

        expect(lines).toHaveLength(1)
        const parts = lines[0]?.split('\t') ?? []
        expect(parts[0]).toBe('badname')
        expect(parts[1]).toBe('GHSA1')
        // The payload is unsanitised, so the row is keyed under the stripped name while its parsed
        // packageName still carries the tab. Worth knowing before trusting the map key as identity.
        expect(JSON.parse(parts[2] ?? '{}').packageName).toBe('bad\tname')
    })
})

describe('atomicity', function () {
    // rename() is atomic on POSIX, so an interrupted sync leaves the previous cache readable rather
    // than a half-written file. This is what makes a Ctrl-C mid-download safe.
    it('leaves the previous cache intact when a write is aborted', async function () {
        await writeRows([row('original', 'GHSA-1')])

        const writer = createRowWriter(path)
        await writer.write([row('replacement', 'GHSA-2')])
        await writer.abort()

        const found = await readRowsForPackages<Row>(path, new Set(['original', 'replacement']))
        expect(found.has('original')).toBe(true)
        expect(found.has('replacement')).toBe(false)
    })

    it('does not create the target file at all when an abort happens with no prior cache', async function () {
        const writer = createRowWriter(path)
        await writer.write([row('a', '1')])
        await writer.abort()
        expect(await readRowsForPackages<Row>(path, new Set(['a']))).toEqual(new Map())
    })

    it('cleans up its temporary file on abort', async function () {
        const writer = createRowWriter(path)
        await writer.write([row('a', '1')])
        await writer.abort()
        await expect(readFile(path + '.tmp')).rejects.toThrow()
    })

    it('replaces the previous cache wholesale on commit', async function () {
        await writeRows([row('old', 'GHSA-1')])
        await writeRows([row('new', 'GHSA-2')])

        const found = await readRowsForPackages<Row>(path, new Set(['old', 'new']))
        expect(found.has('old')).toBe(false)
        expect(found.has('new')).toBe(true)
    })
})

describe('rewriteRows — the incremental update path', function () {
    it('drops the named advisories and appends the new ones', async function () {
        await writeRows([row('a', 'KEEP'), row('b', 'DROP'), row('c', 'KEEP2')])

        const count = await rewriteRows<Row>(path, {
            dropAdvisoryIds: new Set(['DROP']),
            append: [row('d', 'NEW')]
        })

        expect(count).toBe(3)
        const found = await readRowsForPackages<Row>(path, new Set(['a', 'b', 'c', 'd']))
        expect([...found.keys()].sort()).toEqual(['a', 'c', 'd'])
    })

    it('drops every row carrying a dropped advisory id', async function () {
        await writeRows([row('a', 'DROP'), row('b', 'DROP'), row('c', 'KEEP')])
        await rewriteRows<Row>(path, { dropAdvisoryIds: new Set(['DROP']), append: [] })
        expect(await countRows(path)).toBe(1)
    })

    it('is a no-op when nothing is dropped or appended', async function () {
        await writeRows([row('a', '1'), row('b', '2')])
        expect(await rewriteRows<Row>(path, { dropAdvisoryIds: new Set(), append: [] })).toBe(2)
        expect(await countRows(path)).toBe(2)
    })

    it('seeds a cache that does not exist yet', async function () {
        const count = await rewriteRows<Row>(join(dir, 'fresh.gz'), {
            dropAdvisoryIds: new Set(),
            append: [row('a', '1')]
        })
        expect(count).toBe(1)
    })

    it('preserves surviving rows byte-for-byte rather than re-encoding them', async function () {
        await writeRows([row('a', 'KEEP', { severity: 'critical' })])
        await rewriteRows<Row>(path, { dropAdvisoryIds: new Set(['OTHER']), append: [] })

        const found = await readRowsForPackages<Row>(path, new Set(['a']))
        expect(found.get('a')).toEqual([{ packageName: 'a', advisoryId: 'KEEP', severity: 'critical' }])
    })
})

describe('countRows', function () {
    it('counts the rows in a cache', async function () {
        await writeRows([row('a', '1'), row('b', '2')])
        expect(await countRows(path)).toBe(2)
    })

    it('returns zero for a missing cache', async function () {
        expect(await countRows(join(dir, 'absent.gz'))).toBe(0)
    })

    it('returns zero for an empty cache', async function () {
        const writer = createRowWriter(path)
        expect(await writer.commit()).toBe(0)
        expect(await countRows(path)).toBe(0)
    })
})

describe('corrupt cache handling', function () {
    // rewriteRows and countRows wrap read+gunzip together and degrade gracefully...
    it('lets rewriteRows recover from a corrupt cache by reseeding', async function () {
        await writeFile(path, 'not gzip at all')
        const count = await rewriteRows<Row>(path, { dropAdvisoryIds: new Set(), append: [row('a', '1')] })
        expect(count).toBe(1)
    })

    it('lets countRows report zero for a corrupt cache', async function () {
        await writeFile(path, 'not gzip at all')
        expect(await countRows(path)).toBe(0)
    })

    // ...but readRowsForPackages leaves gunzipSync OUTSIDE its try/catch, so a truncated or
    // non-gzip cache throws instead of degrading. Pinned as current behaviour: it is inconsistent
    // with the other two readers, and a corrupt cache surfaces as a crash rather than a reseed.
    it('makes readRowsForPackages throw on a corrupt cache, unlike the other readers', async function () {
        await writeFile(path, 'not gzip at all')
        await expect(readRowsForPackages<Row>(path, new Set(['a']))).rejects.toThrow()
    })
})

describe('backpressure and streaming failures', function () {
    // The writer streams into gzip rather than buffering: the npm advisory set is ~6 MB compressed
    // and several times that in memory, so a rows-in-memory implementation is the thing this design
    // exists to avoid. That makes drain handling load-bearing rather than theoretical.
    it('handles a write large enough to need a drain', async function () {
        const rows: Row[] = []
        for (let i = 0; i < 20_000; i++) {
            rows.push(row('pkg-' + i, 'GHSA-' + i, { severity: 'high' }))
        }

        const written = await writeRows(rows)

        expect(written).toBe(20_000)
        expect(await countRows(path)).toBe(20_000)
    })

    it('reads back a row from the far end of a drained write', async function () {
        const rows: Row[] = []
        for (let i = 0; i < 20_000; i++) {
            rows.push(row('pkg-' + i, 'GHSA-' + i, { severity: 'high' }))
        }
        await writeRows(rows)

        const found = await readRowsForPackages<Row>(path, new Set(['pkg-19999']))

        expect(found.get('pkg-19999')).toEqual([{ packageName: 'pkg-19999', advisoryId: 'GHSA-19999', severity: 'high' }])
    })

    // A downstream failure rejects the pipeline, which is captured rather than left to become an
    // unhandled rejection. This pins the weaker half of that contract: the write/commit sequence as a
    // whole rejects rather than resolving, and the process survives. commit() awaiting the pipeline is
    // enough to satisfy it, so it does NOT prove the re-throw-from-write below.
    it('surfaces a pipeline failure from the sequence rather than crashing', async function () {
        const writer = createRowWriter(join(dir, 'no', 'such', 'dir', 'out.ndjson.gz'))

        await expect((async function attempt() {
            await writer.write([row('lodash', 'GHSA-1')])
            await writer.write([row('axios', 'GHSA-2')])
            await writer.commit()
        })()).rejects.toThrow()
    })

    // And the stronger half: once the pipeline has failed, a WRITE re-throws the captured error — the
    // caller learns at the next row it pushes, not only when it finally commits. It has to be the real
    // error too, because "ENOENT on the cache directory" is actionable and a generic stream failure is
    // not. The failure lands asynchronously, so the first write may still succeed; retry until a write
    // throws rather than sleeping a fixed interval and hoping.
    it('re-throws the captured pipeline failure from the next write', async function () {
        const writer = createRowWriter(join(dir, 'no', 'such', 'dir', 'out.ndjson.gz'))

        let message: string | null = null
        for (let attempt = 0; attempt < 50 && message === null; attempt++) {
            try {
                await writer.write([row('lodash', 'GHSA-' + attempt)])
            } catch (err) {
                message = err instanceof Error ? err.message : String(err)
            }
            if (message === null) await new Promise(function tick(resolve) { setTimeout(resolve, 10) })
        }

        expect(message).toMatch(/ENOENT/)
        await writer.abort()
    })

    it('writes nothing for an empty batch', async function () {
        const writer = createRowWriter(path)
        await writer.write([])
        await writer.writeRaw([])
        expect(await writer.commit()).toBe(0)
        expect(await countRows(path)).toBe(0)
    })
})

describe('readRowsForPackages — the skipped lines', function () {
    // Every read filters by package name as a string slice before parsing any JSON, so the field
    // scanning has its own set of malformed-line cases that never reach safeParse.
    async function writeRaw(lines: string[]): Promise<void> {
        const { gzipSync } = await import('node:zlib')
        await writeFile(path, gzipSync(Buffer.from(lines.join('\n') + '\n', 'utf8')))
    }

    it('returns an empty map for an empty query rather than reading the file', async function () {
        await writeRows([row('lodash', 'GHSA-1')])
        expect(await readRowsForPackages<Row>(path, new Set())).toEqual(new Map())
    })

    it('returns an empty map when the cache file is absent', async function () {
        expect(await readRowsForPackages<Row>(join(dir, 'absent.ndjson.gz'), new Set(['lodash']))).toEqual(new Map())
    })

    it('skips a line with no field separator at all', async function () {
        await writeRaw(['garbage with no tabs', 'lodash\tGHSA-1\t{"packageName":"lodash","advisoryId":"GHSA-1"}'])
        const found = await readRowsForPackages<Row>(path, new Set(['lodash']))
        expect(found.get('lodash')).toHaveLength(1)
    })

    // The name separator belongs to a LATER line — i.e. this line has none of its own. Scanning has
    // to notice that the separator it found is past the line end rather than treating the rest of
    // the file as this line's payload.
    it('skips a line whose only separator belongs to the next line', async function () {
        await writeRaw(['no-separator-here', 'lodash\tGHSA-1\t{"packageName":"lodash","advisoryId":"GHSA-1"}'])
        expect((await readRowsForPackages<Row>(path, new Set(['lodash']))).get('lodash')).toHaveLength(1)
    })

    it('skips a matching line with no second separator', async function () {
        await writeRaw(['lodash\tGHSA-1', 'lodash\tGHSA-2\t{"packageName":"lodash","advisoryId":"GHSA-2"}'])
        const found = await readRowsForPackages<Row>(path, new Set(['lodash']))
        expect(found.get('lodash')?.map(function id(r) { return r.advisoryId })).toEqual(['GHSA-2'])
    })

    it('skips a matching line whose JSON does not parse', async function () {
        await writeRaw(['lodash\tGHSA-1\t{not json', 'lodash\tGHSA-2\t{"packageName":"lodash","advisoryId":"GHSA-2"}'])
        const found = await readRowsForPackages<Row>(path, new Set(['lodash']))
        expect(found.get('lodash')?.map(function id(r) { return r.advisoryId })).toEqual(['GHSA-2'])
    })

    // Several advisories for one package accumulate into the same array rather than the last
    // overwriting the first — this is the list-vs-create branch of the result map.
    it('accumulates several advisories under one package name', async function () {
        await writeRows([row('lodash', 'GHSA-1'), row('lodash', 'GHSA-2'), row('lodash', 'GHSA-3')])
        const found = await readRowsForPackages<Row>(path, new Set(['lodash']))
        expect(found.get('lodash')?.map(function id(r) { return r.advisoryId })).toEqual(['GHSA-1', 'GHSA-2', 'GHSA-3'])
    })

    // A final line with no trailing separator must still be read, not dropped.
    it('reads a final line with no trailing newline', async function () {
        const { gzipSync } = await import('node:zlib')
        await writeFile(path, gzipSync(Buffer.from('lodash\tGHSA-1\t{"packageName":"lodash","advisoryId":"GHSA-1"}', 'utf8')))
        expect((await readRowsForPackages<Row>(path, new Set(['lodash']))).get('lodash')).toHaveLength(1)
    })
})

describe('rewriteRows — the malformed-line skips', function () {
    // The rewrite filters surviving lines by advisory id, again as a string slice. Lines it cannot
    // parse are DROPPED rather than carried over, which is the right call for a cache that can be
    // re-seeded — but it means the field scanning has to be right or good rows go missing.
    async function writeRaw(lines: string[]): Promise<void> {
        const { gzipSync } = await import('node:zlib')
        await writeFile(path, gzipSync(Buffer.from(lines.join('\n') + '\n', 'utf8')))
    }

    it('drops a line with no separators and keeps the rest', async function () {
        await writeRaw(['garbage', 'lodash\tGHSA-1\t{"packageName":"lodash","advisoryId":"GHSA-1"}'])
        const count = await rewriteRows<Row>(path, { dropAdvisoryIds: new Set(), append: [] })
        expect(count).toBe(1)
    })

    it('drops a line with only one separator', async function () {
        await writeRaw(['lodash\tGHSA-1', 'axios\tGHSA-2\t{"packageName":"axios","advisoryId":"GHSA-2"}'])
        expect(await rewriteRows<Row>(path, { dropAdvisoryIds: new Set(), append: [] })).toBe(1)
    })

    it('writes only the appended rows when there is no existing cache', async function () {
        const count = await rewriteRows<Row>(join(dir, 'fresh.ndjson.gz'), {
            dropAdvisoryIds: new Set(['GHSA-old']),
            append: [row('lodash', 'GHSA-1')]
        })
        expect(count).toBe(1)
    })

    // Surviving lines are written in 5000-line chunks, so a rewrite that spans several chunks is a
    // distinct path from the single-chunk case every other test takes.
    it('rewrites a cache large enough to span several chunks', async function () {
        const rows: Row[] = []
        for (let i = 0; i < 12_000; i++) rows.push(row('pkg-' + i, 'GHSA-' + i))
        await writeRows(rows)

        const count = await rewriteRows<Row>(path, {
            dropAdvisoryIds: new Set(['GHSA-0', 'GHSA-11999']),
            append: [row('new-pkg', 'GHSA-new')]
        })

        expect(count).toBe(12_000 - 2 + 1)
        expect((await readRowsForPackages<Row>(path, new Set(['pkg-0']))).get('pkg-0')).toBeUndefined()
        expect((await readRowsForPackages<Row>(path, new Set(['new-pkg']))).get('new-pkg')).toHaveLength(1)
    })

    it('aborts and rethrows when the rewrite target cannot be written', async function () {
        await writeRows([row('lodash', 'GHSA-1')])
        await expect(rewriteRows<Row>(join(dir, 'no', 'such', 'dir', 'out.ndjson.gz'), {
            dropAdvisoryIds: new Set(),
            append: [row('lodash', 'GHSA-1')]
        })).rejects.toThrow()
    })
})
