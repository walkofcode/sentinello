import type { PublishedResult, PublishedSummary } from './published'
import { getRegistryBody, isRecord, registryBaseUrl, textBody, type RegistryFetchOptions } from './request'

// crates.io, read through its sparse index — the same files cargo itself reads: one per crate, one JSON
// object per published version per line (`{"name","vers","deps","cksum","features","yanked",…}`). Far
// smaller than the API's crate document, and served from a CDN with no rate limit.

export const DEFAULT_CRATES_INDEX_URL = 'https://index.crates.io'

export function cratesIndexUrl(): string {
    return registryBaseUrl('SENTINELLO_CRATES_INDEX_URL', DEFAULT_CRATES_INDEX_URL)
}

// The index path of a crate, lowercased: `1/{name}` and `2/{name}` for one- and two-character names,
// `3/{first character}/{name}` for three, and `{first two}/{next two}/{name}` for everything longer. A
// path in any other case is a 404, whatever the crate is called.
export function cratesIndexPath(name: string): string {
    const lower = name.toLowerCase()
    if (lower.length <= 2) return lower.length + '/' + lower
    if (lower.length === 3) return '3/' + lower.slice(0, 1) + '/' + lower
    return lower.slice(0, 2) + '/' + lower.slice(2, 4) + '/' + lower
}

// 404 is cargo's "no such crate", and so is 410.
export async function fetchCratesPackage(name: string, options?: RegistryFetchOptions): Promise<PublishedResult> {
    const result = await getRegistryBody((options?.registryUrl ?? cratesIndexUrl()) + '/' + cratesIndexPath(name), options, textBody('index file', [404, 410]))
    if (result.status !== 'ok') return result
    const summary = summarizeCratesIndex(name, result.body)
    if (typeof summary === 'string') return { status: 'error', reason: summary }
    return { status: 'ok', summary, etag: result.etag }
}

// The summary, or why the file cannot be one. Unlike a JSON document, an index file has no outer shape to
// check, so every line is held to it instead: one unreadable line, or a file with no lines at all (the
// index never holds a crate with no versions), reads as an error — never as "nothing was published".
export function summarizeCratesIndex(name: string, text: string): PublishedSummary | string {
    const versions: PublishedSummary['versions'] = {}
    const lines = text.split('\n').filter(function nonBlank(line) { return line.trim().length > 0 })
    if (lines.length === 0) return 'index file has no versions'
    for (const line of lines) {
        let entry: unknown
        try {
            entry = JSON.parse(line)
        } catch {
            return 'unreadable index entry'
        }
        if (!isRecord(entry) || typeof entry.vers !== 'string') return 'unreadable index entry'
        versions[entry.vers] = { yanked: entry.yanked === true }
    }
    return { v: 1, name, versions }
}
