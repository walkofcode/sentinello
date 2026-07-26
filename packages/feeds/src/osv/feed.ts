import unzipper from 'unzipper'
import { getEcosystem, type EcosystemId, type OsvAdvisoryRow } from '@sentinello/core'
import {
    getJsonOrNull,
    getTextConditional,
    headFile,
    openDownloadStream,
    type FetchOptions,
    type ProgressReporter,
    type RemoteFileInfo
} from '../http'
import { normalizeOsvRecord } from './normalize'

// The OSV feed as pure I/O + parsing: it turns the remote export into normalized rows and knows nothing
// about where those rows are stored. The worker persists them into osv.db via drizzle; the CLI writes
// them as gzipped ndjson. Keeping storage out of here is what lets the CLI ship without better-sqlite3.

// Base URL of the OSV GCS export bucket. Overridable for tests / mirrors; set to 'off' to hard-disable
// any network access (the seed/sync becomes a no-op and the scanner just never gets seeded).
const DEFAULT_FEED_BASE = 'https://osv-vulnerabilities.storage.googleapis.com'

// Rows are yielded in batches so the consumer can flush at a size that suits its store — 2000 matches the
// worker's historical transaction batch.
const BATCH_SIZE = 2000

// Above this many changed advisories, fetching each one individually costs more than re-downloading the
// whole export. OSV occasionally lands tens of thousands of malware records in a single day, which is
// exactly the case that would otherwise turn an incremental sync into an overnight job.
export const OSV_INCREMENTAL_MAX_IDS = 20_000

function feedBase(): string {
    const fromEnv = process.env.SENTINELLO_OSV_FEED_URL
    if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim()
    return DEFAULT_FEED_BASE
}

export function osvFeedDisabled(): boolean {
    return feedBase().toLowerCase() === 'off'
}

// The canonical OSV feed directory for an ecosystem, taken from the central registry's `osvEcosystem`
// (e.g. 'npm' | 'PyPI' | 'Go' | 'crates.io') — NEVER a lowercase language slug, which would 404 the feed.
// encodeURIComponent guards the path segment (a no-op for the current ids, future-proof for any with
// reserved characters). Throws on an unknown ecosystem so a typo fails loudly instead of fetching garbage.
function osvFeedDir(ecosystem: EcosystemId): string {
    const def = getEcosystem(ecosystem)
    if (!def) throw new Error('unknown OSV ecosystem: ' + ecosystem)
    return encodeURIComponent(def.osvEcosystem)
}

export function osvSeedUrl(ecosystem: EcosystemId): string {
    return feedBase() + '/' + osvFeedDir(ecosystem) + '/all.zip'
}

export function osvModifiedIdsUrl(ecosystem: EcosystemId): string {
    return feedBase() + '/' + osvFeedDir(ecosystem) + '/modified_id.csv'
}

export function osvAdvisoryUrl(id: string, ecosystem: EcosystemId): string {
    return feedBase() + '/' + osvFeedDir(ecosystem) + '/' + id + '.json'
}

// Size + freshness of the full export without downloading it, so a caller can show the real byte count in
// a consent prompt and pre-flight free space before committing to hundreds of megabytes.
export function headOsvSeed(ecosystem: EcosystemId, options?: FetchOptions): Promise<RemoteFileInfo> {
    return headFile(osvSeedUrl(ecosystem), options)
}

export type OsvSeedBatch = {
    rows: OsvAdvisoryRow[]
    lastModified: string | null
}

// Streams <ecosystem>/all.zip, normalizing each entry and yielding rows in batches. Streaming plus batched
// yields keeps memory bounded — the unpacked npm export alone is ~860 MB across ~220k files, so nothing
// here may accumulate the full corpus. The consumer decides what invalidation and commit mean for its
// store; this generator only produces rows.
export async function* streamOsvSeed(
    ecosystem: EcosystemId,
    onProgress?: ProgressReporter,
    options?: FetchOptions
): AsyncGenerator<OsvSeedBatch> {
    const download = await openDownloadStream(osvSeedUrl(ecosystem), onProgress, options)
    const abortSignal = options && options.abortSignal
    let batch: OsvAdvisoryRow[] = []
    const zip = download.stream.pipe(unzipper.Parse({ forceStream: true }))
    for await (const entry of zip) {
        if (abortSignal && abortSignal.aborted) {
            entry.autodrain()
            throw new Error('aborted')
        }
        if (entry.type !== 'File' || !String(entry.path).endsWith('.json')) {
            entry.autodrain()
            continue
        }
        const content = await entry.buffer()
        for (const row of parseSeedEntry(content, ecosystem)) batch.push(row)
        if (batch.length >= BATCH_SIZE) {
            yield { rows: batch, lastModified: download.lastModified }
            batch = []
        }
    }
    if (batch.length > 0) {
        yield { rows: batch, lastModified: download.lastModified }
    }
}

export type OsvChangedIds =
    // The feed has not been republished since our cached etag — nothing to do, and nothing transferred.
    | { status: 'unchanged' }
    | { status: 'ok'; ids: string[]; newestIso: string | null; etag: string | null }

// Fetches modified_id.csv conditionally and returns the advisory ids modified after the cursor. The
// conditional request is what makes syncing on every scan viable: OSV republishes roughly daily, so most
// runs get a 304 and transfer nothing at all, and a run that does see changes pays 8.4 MB once.
export async function fetchOsvChangedIds(
    ecosystem: EcosystemId,
    cursorMs: number,
    etag: string | null,
    options?: FetchOptions
): Promise<OsvChangedIds> {
    const result = await getTextConditional(osvModifiedIdsUrl(ecosystem), etag, options)
    if (result.status === 'unchanged') return { status: 'unchanged' }
    const changed = selectChangedIds(result.body, cursorMs)
    return { status: 'ok', ids: changed.ids, newestIso: changed.newestIso, etag: result.etag }
}

// Current rows for one advisory. Returns [] when the advisory 404s (removed upstream) or comes back
// withdrawn — both mean "this advisory should no longer match", which the caller applies as a deletion.
export async function fetchOsvAdvisoryRows(
    id: string,
    ecosystem: EcosystemId,
    options?: FetchOptions
): Promise<OsvAdvisoryRow[]> {
    const record = await getJsonOrNull<unknown>(osvAdvisoryUrl(id, ecosystem), options)
    if (record === null) return []
    const rows = normalizeOsvRecord(record, ecosystem)
    return rows.filter(function notWithdrawn(row): boolean {
        return row.withdrawn === null
    })
}

export type ChangedIdSelection = {
    ids: string[]
    newestIso: string | null
}

// Parses modified_id.csv ("<iso>,<id>" per line, newest first) and returns ids modified strictly after
// the cursor. The newest timestamp seen becomes the next cursor.
export function selectChangedIds(csv: string, cursorMs: number): ChangedIdSelection {
    const ids: string[] = []
    let newestIso: string | null = null
    let newestMs = cursorMs
    const lines = csv.split('\n')
    for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const comma = trimmed.indexOf(',')
        if (comma <= 0) continue
        const iso = trimmed.slice(0, comma)
        const id = trimmed.slice(comma + 1).trim()
        if (!id) continue
        const ms = Date.parse(iso)
        if (!Number.isFinite(ms)) continue
        if (ms > cursorMs) {
            ids.push(id)
        }
        if (ms > newestMs) {
            newestMs = ms
            newestIso = iso
        }
    }
    return { ids, newestIso }
}

function parseSeedEntry(content: Buffer, ecosystem: EcosystemId): OsvAdvisoryRow[] {
    let parsed: unknown
    try {
        parsed = JSON.parse(content.toString('utf8'))
    } catch {
        return []
    }
    return normalizeOsvRecord(parsed, ecosystem)
}
