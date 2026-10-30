import type { PublishedResult, PublishedSummary } from './published'
import { getRegistryBody, isRecord, jsonBody, registryBaseUrl, type RegistryFetchOptions } from './request'

// RubyGems, read through `GET {rubygems}/api/v1/versions/{name}.json`: one entry per published version per
// platform (nokogiri lists 1.15.0 once for ruby and again for each native platform), reduced to the
// published summary.
//
// The endpoint omits yanked versions altogether and carries no yanked flag: probed 2026-10-29 against
// rest-client, whose yanked 1.6.10–1.6.13 are absent from the list (and 404 on their own version URL). So
// every version it lists is a live one, and a gem whose every version was yanked lists none.

export const DEFAULT_RUBYGEMS_URL = 'https://rubygems.org'

export function rubygemsUrl(): string {
    return registryBaseUrl('SENTINELLO_RUBYGEMS_URL', DEFAULT_RUBYGEMS_URL)
}

export function rubygemsVersionsUrl(baseUrl: string, name: string): string {
    return baseUrl + '/api/v1/versions/' + encodeURIComponent(name) + '.json'
}

export async function fetchRubyGemsPackage(name: string, options?: RegistryFetchOptions): Promise<PublishedResult> {
    const result = await getRegistryBody(rubygemsVersionsUrl(options?.registryUrl ?? rubygemsUrl(), name), options, jsonBody('version list', [404]))
    if (result.status !== 'ok') return result
    const summary = summarizeRubyGemsVersions(name, result.body)
    if (summary === null) return { status: 'error', reason: 'version list is not a list' }
    return { status: 'ok', summary, etag: result.etag }
}

// Null when the body is not a list at all; an entry with no version number is dropped rather than failing
// the gem.
export function summarizeRubyGemsVersions(name: string, body: unknown): PublishedSummary | null {
    if (!Array.isArray(body)) return null
    const versions: PublishedSummary['versions'] = {}
    for (const entry of body) {
        if (isRecord(entry) && typeof entry.number === 'string') versions[entry.number] = { yanked: false }
    }
    return { v: 1, name, versions }
}
