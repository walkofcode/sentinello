import { createWriteStream } from 'node:fs'
import { readFile, rename, rm } from 'node:fs/promises'
import { createGzip, gunzipSync } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { PassThrough } from 'node:stream'
import { asError } from '@sentinello/core'

// The CLI's advisory cache: one gzipped ndjson file per (source, ecosystem).
//
// The portal keeps this data in SQLite, which is the right call for a long-lived server but the wrong one
// for something distributed by npx — better-sqlite3 is a native module with an install script. Measured
// against a live portal cache, the npm OSV corpus is 96 MB as SQLite and 5.6 MB as gzipped ndjson, and a
// lookup across 918 installed packages costs 77 ms (42 ms gunzip + 35 ms scan). That is immaterial next to
// `npm audit`'s own 2-10 s, so the CLI trades an index for zero native dependencies.
//
// Line format: `packageName \t advisoryId \t {json}`.
//
// Both leading fields are duplicated from the JSON on purpose. Every read filters by package name and
// every incremental update filters by advisory id, so keeping them as leading tab-delimited fields means
// those passes are string slices — only the handful of lines that actually match are ever JSON.parsed.
// Parsing all 220k rows to answer either question would cost seconds instead of milliseconds.

const FIELD_SEPARATOR = '\t'
const LINE_SEPARATOR = '\n'

export type StorableRow = {
    packageName: string
    advisoryId: string
}

function encodeRow(row: StorableRow): string {
    // A tab or newline inside a package name or advisory id would corrupt the record boundaries. Neither is
    // legal in either identifier, but the cache is derived from third-party feeds, so strip rather than
    // trust: a malformed upstream record must not be able to smuggle in extra rows.
    const name = row.packageName.replace(/[\t\n\r]/g, '')
    const id = row.advisoryId.replace(/[\t\n\r]/g, '')
    return name + FIELD_SEPARATOR + id + FIELD_SEPARATOR + JSON.stringify(row)
}

export type RowWriter = {
    write(rows: readonly StorableRow[]): Promise<void>
    // Appends lines that are already in wire format. The rewrite path carries surviving lines through
    // untouched this way; decoding and re-encoding them would mean parsing every row in the cache, which is
    // precisely the cost the line format exists to avoid.
    writeRaw(lines: readonly string[]): Promise<void>
    // Renames the temp file over the target and returns the number of rows written.
    commit(): Promise<number>
    abort(): Promise<void>
}

// Streams rows into `<path>.tmp` and only renames over `path` on commit. rename() is atomic on POSIX, so
// an interrupted sync — Ctrl-C, a dropped connection, a full disk — leaves the previous cache intact and
// readable rather than a truncated file that would silently under-report findings.
export function createRowWriter(path: string): RowWriter {
    const tmpPath = path + '.tmp'
    const source = new PassThrough()
    const gzip = createGzip()
    const done = pipeline(source, gzip, createWriteStream(tmpPath))
    let rowCount = 0
    let failed: Error | null = null
    // The pipeline rejects on any downstream failure. Capture it so write()/commit() can surface it
    // instead of the process dying on an unhandled rejection.
    done.catch(function capture(err: unknown): void {
        failed = asError(err)
    })

    async function push(chunk: string, added: number): Promise<void> {
        if (failed) throw failed
        rowCount += added
        if (!source.write(chunk)) {
            await new Promise(function waitForDrain(resolve) {
                source.once('drain', resolve)
            })
        }
    }

    async function write(rows: readonly StorableRow[]): Promise<void> {
        if (rows.length === 0) return
        await push(rows.map(encodeRow).join(LINE_SEPARATOR) + LINE_SEPARATOR, rows.length)
    }

    async function writeRaw(lines: readonly string[]): Promise<void> {
        if (lines.length === 0) return
        await push(lines.join(LINE_SEPARATOR) + LINE_SEPARATOR, lines.length)
    }

    async function commit(): Promise<number> {
        source.end()
        await done
        await rename(tmpPath, path)
        return rowCount
    }

    async function abort(): Promise<void> {
        source.destroy()
        try {
            await done
        } catch {
            // The pipeline rejecting is the expected outcome of destroying it.
        }
        await rm(tmpPath, { force: true })
    }

    return { write, writeRaw, commit, abort }
}

// Reads the rows for a set of package names. Returns a map keyed by package name so it drops straight into
// the scanners' OsvLookup / gemnasium lookup contract. A missing cache file yields an empty map rather than
// throwing — the caller decides whether "not seeded" is an error or simply a source that stays quiet.
export async function readRowsForPackages<T extends StorableRow>(
    path: string,
    packageNames: Set<string>
): Promise<Map<string, T[]>> {
    const out = new Map<string, T[]>()
    if (packageNames.size === 0) return out
    let raw: Buffer
    try {
        raw = await readFile(path)
    } catch {
        return out
    }
    const text = gunzipSync(raw).toString('utf8')
    let offset = 0
    while (offset < text.length) {
        let end = text.indexOf(LINE_SEPARATOR, offset)
        if (end === -1) end = text.length
        const nameEnd = text.indexOf(FIELD_SEPARATOR, offset)
        if (nameEnd === -1 || nameEnd > end) {
            offset = end + 1
            continue
        }
        const name = text.slice(offset, nameEnd)
        if (packageNames.has(name)) {
            const idEnd = text.indexOf(FIELD_SEPARATOR, nameEnd + 1)
            if (idEnd !== -1 && idEnd < end) {
                const parsed = safeParse<T>(text.slice(idEnd + 1, end))
                if (parsed) {
                    const list = out.get(name)
                    if (list) {
                        list.push(parsed)
                    } else {
                        out.set(name, [parsed])
                    }
                }
            }
        }
        offset = end + 1
    }
    return out
}

export type RewriteInput<T extends StorableRow> = {
    // Advisory ids whose existing rows should be dropped. An advisory that changed upstream is cleared and
    // rewritten wholesale, so a package removed from its affected set disappears instead of lingering.
    dropAdvisoryIds: Set<string>
    // Rows to append after the surviving ones.
    append: readonly T[]
}

// Applies an incremental update by rewriting the file. There is no in-place edit for a gzip stream, but a
// full rewrite is ~600 ms for the npm corpus, which is cheap enough that an index would be complexity
// without payoff. Returns the resulting row count.
export async function rewriteRows<T extends StorableRow>(path: string, input: RewriteInput<T>): Promise<number> {
    let surviving: string[] = []
    try {
        const raw = await readFile(path)
        const text = gunzipSync(raw).toString('utf8')
        for (const line of text.split(LINE_SEPARATOR)) {
            if (line.length === 0) continue
            const nameEnd = line.indexOf(FIELD_SEPARATOR)
            if (nameEnd === -1) continue
            const idEnd = line.indexOf(FIELD_SEPARATOR, nameEnd + 1)
            if (idEnd === -1) continue
            const advisoryId = line.slice(nameEnd + 1, idEnd)
            if (input.dropAdvisoryIds.has(advisoryId)) continue
            surviving.push(line)
        }
    } catch {
        // No existing cache — the rewrite degenerates to writing just the appended rows.
        surviving = []
    }
    const writer = createRowWriter(path)
    try {
        // Surviving lines are already encoded; write them straight through rather than decode/re-encode.
        const CHUNK = 5000
        for (let i = 0; i < surviving.length; i += CHUNK) {
            await writer.writeRaw(surviving.slice(i, i + CHUNK))
        }
        await writer.write(input.append)
        return await writer.commit()
    } catch (err) {
        await writer.abort()
        throw err
    }
}

// Row counts are only needed for the cache summary, so this counts line separators on the compressed file
// rather than parsing anything.
export async function countRows(path: string): Promise<number> {
    try {
        const raw = await readFile(path)
        const text = gunzipSync(raw).toString('utf8')
        let count = 0
        let offset = 0
        for (;;) {
            const next = text.indexOf(LINE_SEPARATOR, offset)
            if (next === -1) break
            count++
            offset = next + 1
        }
        return count
    } catch {
        return 0
    }
}

function safeParse<T>(json: string): T | null {
    try {
        return JSON.parse(json) as T
    } catch {
        return null
    }
}
