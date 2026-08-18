import yaml from 'js-yaml'
import unzipper from 'unzipper'
import { ECOSYSTEMS, type GemnasiumAdvisoryRow } from '@sentinello/core'
import {
    getJson,
    getTextOrNull,
    openDownloadStream,
    type FetchOptions,
    type ProgressReporter
} from '../http'
import { normalizeGemnasiumRecord } from './normalize'

// The gemnasium-db feed as pure I/O + parsing. Storage lives with the caller, exactly as in ../osv/feed.
//
// gemnasium-db has no per-advisory delta feed, which historically meant re-downloading the whole 80 MB
// archive on every sync. It IS a git repository though, so the GitLab API gives us two much cheaper
// signals: the HEAD commit sha (is there anything new at all?) and a compare between two shas (which
// files changed?). A daily upstream sync typically touches a handful of files, so the common refresh
// becomes a few KB instead of 80 MB, with the full archive kept as the fallback.

// URL-encoded project path rather than a numeric id: the path is stable and self-documenting, and a
// numeric id would silently point at the wrong project if it were ever mistyped.
const DEFAULT_API_BASE = 'https://gitlab.com/api/v4/projects/gitlab-org%2Fsecurity-products%2Fgemnasium-db'

const DEFAULT_REF = 'master'

const BATCH_SIZE = 2000

// GitLab caps compare responses (1000 diffs by default) and flags truncation via `compare_timeout`. Past
// this many changed files the incremental path stops being a saving anyway, so fall back to the archive.
export const GEMNASIUM_COMPARE_MAX_FILES = 1000

// An operator override, or null to use the derived URL. Kept separate from archiveUrl() because the
// disabled check has to read the override WITHOUT building a URL — there is no ref to build one from.
function archiveOverride(): string | null {
    const fromEnv = process.env.SENTINELLO_GEMNASIUM_FEED_URL
    if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim()
    return null
}

function apiBase(): string {
    const fromEnv = process.env.SENTINELLO_GEMNASIUM_API_URL
    if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim()
    return DEFAULT_API_BASE
}

// The archive is addressed by commit sha, not by ref, and that is the whole point rather than a detail.
//
// The web route at ref `master` — what this used to request — names a moving target, so every client gets
// a cache MISS and punches through to GitLab's origin, which sheds the expensive archive work with an
// empty-bodied HTTP 406. That is what made a release spike look like an IP block: the failure scaled with
// the number of people running a first seed, not with anything about any one of them.
//
// A sha names immutable bytes, so Cloudflare can serve it as a shared object and every client on the same
// upstream commit collides on one cached entry. Measured: first request MISS, second HIT. The first client
// on each new sha still pays the origin fetch, which is one origin request per sha instead of one per user.
//
// This does NOT pin the data — the caller re-resolves HEAD on every run (see fetchGemnasiumHeadSha), so a
// seed is exactly as current as the ref was. `master` remains the fallback for when that lookup fails,
// which degrades to the old behaviour rather than to no seed at all.
function archiveUrl(ref: string | null): string {
    const override = archiveOverride()
    if (override) return override
    return apiBase() + '/repository/archive.zip?sha=' + encodeURIComponent(ref ?? DEFAULT_REF)
}

export function gemnasiumFeedDisabled(): boolean {
    const override = archiveOverride()
    return override !== null && override.toLowerCase() === 'off'
}

// Map of gemnasium package-type directory name (e.g. 'npm', 'pypi', 'go', 'cargo') → registry ecosystem id
// ('npm', 'PyPI', 'Go', 'crates.io'), derived from the central registry so adding a language is a registry
// edit, never a change here. The sync parses ONLY the directories we have a resolver + comparator for;
// other gemnasium ecosystems (maven, gem, packagist, …) are skipped until their language ships.
const PACKAGE_TYPE_TO_ECOSYSTEM: Record<string, string> = (function buildMap() {
    const map: Record<string, string> = {}
    for (const eco of ECOSYSTEMS) map[eco.gemnasiumPackageType] = eco.id
    return map
})()

type AdvisoryPath = { ecosystem: string; slugPrefix: string }

// Resolves an advisory file path to its registry ecosystem, or null for non-advisory paths and ecosystems
// we do not yet scan. `rootOffset` accounts for the two path shapes this feed produces: archive entries
// are nested under a top folder ("gemnasium-db-master/npm/lodash/CVE-x.yml", offset 1) while API paths are
// repo-relative ("npm/lodash/CVE-x.yml", offset 0). Passing the wrong offset silently matches nothing.
function advisoryPathEcosystem(path: string, rootOffset: number): AdvisoryPath | null {
    if (!path.endsWith('.yml') && !path.endsWith('.yaml')) return null
    const segments = path.split('/')
    // [<root>?, packageType, ...packageName, id.yml] — need the type segment plus a package and a file.
    if (segments.length < rootOffset + 3) return null
    const packageType = segments[rootOffset]
    if (!packageType) return null
    const ecosystem = PACKAGE_TYPE_TO_ECOSYSTEM[packageType]
    if (!ecosystem) return null
    return { ecosystem, slugPrefix: packageType + '/' }
}

type CommitEntry = { id?: string }

// The HEAD commit sha of the advisory repo. This is the freshness gate: when it matches the sha recorded
// at the last sync, the cache is current and nothing else needs fetching. Returns null when the API is
// unreachable or answers unexpectedly, which the caller treats as "unknown" and handles conservatively.
export async function fetchGemnasiumHeadSha(options?: FetchOptions): Promise<string | null> {
    const url = apiBase() + '/repository/commits?ref_name=' + DEFAULT_REF + '&per_page=1'
    try {
        const commits = await getJson<CommitEntry[]>(url, options)
        if (!Array.isArray(commits) || commits.length === 0) return null
        const head = commits[0]
        if (!head || typeof head.id !== 'string' || head.id.length === 0) return null
        return head.id
    } catch {
        return null
    }
}

type CompareDiff = { new_path?: string; old_path?: string; deleted_file?: boolean }
type CompareResponse = { diffs?: CompareDiff[]; compare_timeout?: boolean }

export type GemnasiumChangedPaths =
    // The incremental path is not usable — caller must rebuild from the full archive.
    | { status: 'unavailable'; reason: string }
    | { status: 'ok'; changed: string[]; deleted: string[]; toSha: string }

// Advisory files that changed between two commits. Only paths under a supported package type are returned,
// so an upstream commit touching only maven/gem advisories correctly yields an empty changed set.
export async function fetchGemnasiumChangedPaths(
    fromSha: string,
    toSha: string,
    options?: FetchOptions
): Promise<GemnasiumChangedPaths> {
    const url = apiBase() + '/repository/compare?from=' + encodeURIComponent(fromSha) + '&to=' + encodeURIComponent(toSha)
    let response: CompareResponse
    try {
        response = await getJson<CompareResponse>(url, options)
    } catch (err) {
        return { status: 'unavailable', reason: 'compare request failed: ' + ((err instanceof Error && err.message) || String(err)) }
    }
    // A truncated diff would silently under-report changes, leaving the cache subtly stale — rebuild instead.
    if (response.compare_timeout === true) {
        return { status: 'unavailable', reason: 'compare timed out upstream' }
    }
    const diffs = Array.isArray(response.diffs) ? response.diffs : []
    if (diffs.length >= GEMNASIUM_COMPARE_MAX_FILES) {
        return { status: 'unavailable', reason: 'too many changed files (' + diffs.length + ')' }
    }
    const changed: string[] = []
    const deleted: string[] = []
    for (const diff of diffs) {
        const path = typeof diff.new_path === 'string' ? diff.new_path : null
        if (!path) continue
        if (!advisoryPathEcosystem(path, 0)) continue
        if (diff.deleted_file === true) {
            deleted.push(path)
            continue
        }
        changed.push(path)
    }
    return { status: 'ok', changed, deleted, toSha }
}

// Current rows for one advisory file. Returns [] when the file 404s (deleted between the compare and the
// fetch) or parses to nothing, which the caller applies as "this advisory no longer matches".
export async function fetchGemnasiumFileRows(
    path: string,
    ref: string,
    options?: FetchOptions
): Promise<GemnasiumAdvisoryRow[]> {
    const cell = advisoryPathEcosystem(path, 0)
    if (!cell) return []
    const url = apiBase() + '/repository/files/' + encodeURIComponent(path) + '/raw?ref=' + encodeURIComponent(ref)
    const text = await getTextOrNull(url, options)
    if (text === null) return []
    return parseAdvisoryYaml(Buffer.from(text, 'utf8'), cell)
}

// The advisory id a repo-relative path refers to, so a deleted file can be dropped from the cache without
// re-fetching it. gemnasium names each file "<identifier>.yml", which IS the row's advisoryId.
export function advisoryIdFromPath(path: string): string | null {
    const segments = path.split('/')
    const file = segments[segments.length - 1]
    if (!file) return null
    const dot = file.lastIndexOf('.')
    // Always non-empty: `file` passed the guard above, and `dot > 0` means the slice keeps at least one
    // character, so the length check it used to carry was a tautology.
    return dot > 0 ? file.slice(0, dot) : file
}

export type GemnasiumArchiveBatch = {
    rows: GemnasiumAdvisoryRow[]
    lastModified: string | null
}

// Streams the full repo archive, yielding normalized rows in batches. Used for the first seed and as the
// fallback whenever the incremental path is unavailable.
//
// `ref` is the commit sha to fetch, and callers should pass the one they resolved for the cache cursor so
// the bytes and the recorded sha describe the same commit. Passing null falls back to the branch ref.
export async function* streamGemnasiumArchive(
    ref: string | null,
    onProgress?: ProgressReporter,
    options?: FetchOptions
): AsyncGenerator<GemnasiumArchiveBatch> {
    const download = await openDownloadStream(archiveUrl(ref), onProgress, options)
    const abortSignal = options && options.abortSignal
    let batch: GemnasiumAdvisoryRow[] = []
    const zip = download.stream.pipe(unzipper.Parse({ forceStream: true }))
    try {
        for await (const entry of zip) {
            if (abortSignal && abortSignal.aborted) {
                entry.autodrain()
                throw new Error('aborted')
            }
            const cell = advisoryPathEcosystem(String(entry.path), 1)
            if (entry.type !== 'File' || !cell) {
                entry.autodrain()
                continue
            }
            const content = await entry.buffer()
            for (const row of parseAdvisoryYaml(content, cell)) batch.push(row)
            if (batch.length >= BATCH_SIZE) {
                yield { rows: batch, lastModified: download.lastModified }
                batch = []
            }
        }
        if (batch.length > 0) {
            yield { rows: batch, lastModified: download.lastModified }
        }
    } finally {
        // Release the socket explicitly, or the CLI finishes its work and then never exits.
        //
        // GitLab generates the archive on the fly and sends it chunked with no content-length, and the zip
        // parser stops as soon as it has read the end-of-central-directory record. The response is
        // therefore never fully consumed, so it never emits 'end', so node keeps the socket — and the
        // process — alive indefinitely. The finally also covers an abort or a caller that stops iterating
        // early, both of which strand the stream in exactly the same way.
        download.stream.destroy()
    }
}

function parseAdvisoryYaml(content: Buffer, cell: AdvisoryPath): GemnasiumAdvisoryRow[] {
    let parsed: unknown
    try {
        parsed = yaml.load(content.toString('utf8'))
    } catch {
        return []
    }
    return normalizeGemnasiumRecord(parsed, cell.ecosystem, cell.slugPrefix)
}
