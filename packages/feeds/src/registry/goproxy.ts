import type { PublishedResult, PublishedSummary } from './published'
import { getRegistryBody, registryBaseUrl, textBody, type RegistryFetchOptions } from './request'

// The Go module proxy (proxy.golang.org by default), read through the GOPROXY protocol and nothing else:
//   - `GET {proxy}/{module}/@v/list` — the module's tagged versions, one per line. It omits pseudo-versions
//     by protocol, so a module fixed only in a commit lists nothing for its fix;
//   - `GET {proxy}/{module}/@v/{version}.info` — whether one exact version (a pseudo-version included)
//     exists, asked only for a fix version an advisory states and the list does not have (SENTINEL-126).
// Both answer 404 or 410 for "not there", which the protocol defines as not found. No Go toolchain is
// involved.

export const DEFAULT_GOPROXY_URL = 'https://proxy.golang.org'

export function goproxyUrl(): string {
    return registryBaseUrl('SENTINELLO_GOPROXY_URL', DEFAULT_GOPROXY_URL)
}

// The protocol's case-escaping, applied to module paths and versions alike: every uppercase letter becomes
// `!` and its lowercase, so `github.com/BurntSushi/toml` travels as `github.com/!burnt!sushi/toml` (the
// proxy serves case-insensitive file systems). Each path element is then URL-encoded on its own, keeping
// the slashes.
export function escapeGoPath(path: string): string {
    return path.replace(/[A-Z]/g, function escape(letter) { return '!' + letter.toLowerCase() })
        .split('/').map(encodeURIComponent).join('/')
}

const NOT_FOUND = [404, 410]

// Every listed version is a live one: the list has no notion of a yank (a retraction lives in the module's
// own go.mod, which settlement does not read).
export async function fetchGoModuleList(module: string, options?: RegistryFetchOptions): Promise<PublishedResult> {
    const result = await getRegistryBody((options?.registryUrl ?? goproxyUrl()) + '/' + escapeGoPath(module) + '/@v/list', options, textBody('version list', NOT_FOUND))
    if (result.status !== 'ok') return result
    return { status: 'ok', summary: summarizeGoList(module, result.body), etag: result.etag }
}

// An empty list is an answer: the module exists and has no tagged version (it may still have pseudo-versions).
export function summarizeGoList(module: string, text: string): PublishedSummary {
    const versions: PublishedSummary['versions'] = {}
    for (const line of text.split('\n')) {
        const version = line.trim()
        if (version.length > 0) versions[version] = { yanked: false }
    }
    return { v: 1, name: module, versions }
}

// `published` and `absent` are the proxy's answer; `error` is no answer (a timeout, a 5xx, a refused
// connection) and must never be read as absence.
export type GoVersionInfoResult = { status: 'published' } | { status: 'absent' } | { status: 'error'; reason: string }

// `version` is spelled the way the proxy names it, with its `v`. A 200 is the proxy saying the version
// exists; its body (the version's canonical name and commit time) is read to the end, so a 200 that stalls
// is an error, but its content is not needed for that answer.
export async function fetchGoVersionInfo(module: string, version: string, options?: Omit<RegistryFetchOptions, 'ifNoneMatch'>): Promise<GoVersionInfoResult> {
    const url = (options?.registryUrl ?? goproxyUrl()) + '/' + escapeGoPath(module) + '/@v/' + escapeGoPath(version) + '.info'
    const result = await getRegistryBody(url, { ...options, ifNoneMatch: null }, { accept: 'application/json', what: 'version info', notFound: NOT_FOUND, parse: function ignore() { return null } })
    if (result.status === 'ok') return { status: 'published' }
    if (result.status === 'not_found') return { status: 'absent' }
    // No validator is sent, so the proxy cannot have answered "not modified".
    return result as { status: 'error'; reason: string }
}
