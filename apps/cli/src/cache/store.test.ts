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
