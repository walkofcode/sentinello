import { existsSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'

// A deterministic npm registry: a loopback HTTP server over recorded packuments
// (apps/worker/test/fixtures/registry/, plus the synthetic layers under tests/fixtures/registry/). Shared
// by the worker's --fixture smokes, the CLI e2e and the worker/CLI parity test, so none of them ever
// reaches the live registry, and each can count the requests it caused. Layers are directories searched
// last-first, so a variant directory overrides only the packages it contains. It also answers npm's
// download-count API (`/downloads/point/last-week/<name>`) from each layer's `_downloads.json`. Point both
// SENTINELLO_NPM_REGISTRY_URL and SENTINELLO_NPM_DOWNLOADS_URL at `url`.
//
// Given `published` (tests/fixtures/registry/polyglot/published.json), the same server also stands in for
// the registries the other ecosystems' fixes settle against, each under its own prefix of `url` and in its
// own wire format: PyPI's project JSON, the crates.io sparse index, the Go module proxy (`@v/list` and
// `@v/<version>.info`) and rubygems.org's versions JSON, which, like the real one, leaves a yanked version
// out. Point SENTINELLO_PYPI_URL, SENTINELLO_CRATES_INDEX_URL, SENTINELLO_GOPROXY_URL and
// SENTINELLO_RUBYGEMS_URL at `urls`.

// Per ecosystem, per package, the versions its registry has published; `yanked` marks a withdrawn one.
export type PublishedRegistries = Partial<Record<'PyPI' | 'Go' | 'crates.io' | 'RubyGems', Record<string, Record<string, { yanked?: boolean }>>>>

export type StubRegistryUrls = { pypi: string; crates: string; goproxy: string; rubygems: string }

export type StubRegistry = {
    url: string
    // The base URL of each non-npm registry, each a prefix of `url`.
    urls: StubRegistryUrls
    // Every packument path requested, in order.
    requests: string[]
    // Every download-count path requested, in order.
    downloadRequests: string[]
    // Every request to the non-npm registries, in order, prefix included.
    publishedRequests: string[]
    // While failing, every request is answered 503 — a registry outage.
    setFailing(failing: boolean): void
    close(): Promise<void>
}

// `@scope/name` is stored as `@scope__name.json`.
function fileFor(layers: readonly string[], name: string): string | null {
    const file = name.replace('/', '__') + '.json'
    for (let i = layers.length - 1; i >= 0; i--) {
        const path = join(layers[i] as string, file)
        if (existsSync(path)) return path
    }
    return null
}

const DOWNLOADS_PREFIX = '/downloads/point/last-week/'

function downloadsFor(layers: readonly string[], name: string): number | null {
    for (let i = layers.length - 1; i >= 0; i--) {
        const path = join(layers[i] as string, '_downloads.json')
        if (!existsSync(path)) continue
        const counts = JSON.parse(readFileSync(path, 'utf8')) as Record<string, number>
        if (name in counts) return counts[name] as number
    }
    return null
}

const PREFIXES = { pypi: '/_pypi', crates: '/_crates', goproxy: '/_goproxy', rubygems: '/_rubygems' }

type Answer = { status: number; type: string; body: string }

const NOT_FOUND: Answer = { status: 404, type: 'text/plain', body: 'not found' }

function json(body: unknown): Answer {
    return { status: 200, type: 'application/json', body: JSON.stringify(body) }
}

function versionsOf(published: PublishedRegistries, ecosystem: keyof PublishedRegistries, name: string): [string, { yanked?: boolean }][] | null {
    const packages = published[ecosystem]
    if (!packages || !(name in packages)) return null
    return Object.entries(packages[name] as Record<string, { yanked?: boolean }>)
}

// The Go proxy's case-escaping undone: `!x` is `X`.
function unescapeGo(path: string): string {
    return path.split('/').map(decodeURIComponent).join('/').replace(/!([a-z])/g, function upper(_bang, letter: string) { return letter.toUpperCase() })
}

// One non-npm registry request, answered from `published` in that registry's format; null when the path is
// not under any of their prefixes.
function answerPublished(published: PublishedRegistries, path: string): Answer | null {
    if (path.startsWith(PREFIXES.pypi + '/pypi/')) {
        // /pypi/<name>/json: a release with files, each file carrying the release's yanked flag.
        const name = decodeURIComponent(path.slice((PREFIXES.pypi + '/pypi/').length).replace(/\/json$/, ''))
        const versions = versionsOf(published, 'PyPI', name)
        if (versions === null) return NOT_FOUND
        const releases: Record<string, { filename: string; yanked: boolean }[]> = {}
        for (const [version, release] of versions) releases[version] = [{ filename: name + '-' + version + '.tar.gz', yanked: release.yanked === true }]
        return json({ info: { name }, releases })
    }
    if (path.startsWith(PREFIXES.crates + '/')) {
        // The sparse index path ends in the lowercased crate name; one JSON object per version per line.
        const name = path.slice(path.lastIndexOf('/') + 1)
        const versions = versionsOf(published, 'crates.io', name)
        if (versions === null) return NOT_FOUND
        const lines = versions.map(function line([vers, release]) { return JSON.stringify({ name, vers, deps: [], cksum: '0'.repeat(64), features: {}, yanked: release.yanked === true }) })
        return { status: 200, type: 'text/plain', body: lines.join('\n') + '\n' }
    }
    if (path.startsWith(PREFIXES.goproxy + '/')) {
        const rest = path.slice(PREFIXES.goproxy.length + 1)
        const at = rest.indexOf('/@v/')
        if (at === -1) return NOT_FOUND
        const versions = versionsOf(published, 'Go', unescapeGo(rest.slice(0, at)))
        if (versions === null) return NOT_FOUND
        const file = rest.slice(at + '/@v/'.length)
        if (file === 'list') return { status: 200, type: 'text/plain', body: versions.map(function v([version]) { return version + '\n' }).join('') }
        const version = unescapeGo(file.replace(/\.info$/, ''))
        if (!file.endsWith('.info') || !versions.some(function listed([v]) { return v === version })) return NOT_FOUND
        return json({ Version: version, Time: '2026-01-01T00:00:00Z' })
    }
    if (path.startsWith(PREFIXES.rubygems + '/api/v1/versions/')) {
        const name = decodeURIComponent(path.slice((PREFIXES.rubygems + '/api/v1/versions/').length).replace(/\.json$/, ''))
        const versions = versionsOf(published, 'RubyGems', name)
        if (versions === null) return NOT_FOUND
        return json(versions.filter(function live([, release]) { return release.yanked !== true }).map(function entry([number]) { return { number, platform: 'ruby' } }))
    }
    return null
}

export async function startStubRegistry(layers: readonly string[], published: PublishedRegistries = {}): Promise<StubRegistry> {
    const requests: string[] = []
    const downloadRequests: string[] = []
    const publishedRequests: string[] = []
    let failing = false
    const server = createServer(function handle(request: IncomingMessage, response: ServerResponse): void {
        const path = request.url ?? '/'
        const isDownloads = path.startsWith(DOWNLOADS_PREFIX)
        const isPublished = Object.values(PREFIXES).some(function under(prefix) { return path.startsWith(prefix + '/') })
        if (isDownloads) downloadRequests.push(path)
        else if (isPublished) publishedRequests.push(path)
        else requests.push(path)
        if (failing) {
            response.writeHead(503, { 'Content-Type': 'text/plain' })
            response.end('stub registry: failing on purpose')
            return
        }
        if (isPublished) {
            const answer = answerPublished(published, path) ?? NOT_FOUND
            response.writeHead(answer.status, { 'Content-Type': answer.type })
            response.end(answer.body)
            return
        }
        if (isDownloads) {
            const count = downloadsFor(layers, decodeURIComponent(path.slice(DOWNLOADS_PREFIX.length)))
            response.writeHead(count === null ? 404 : 200, { 'Content-Type': 'application/json' })
            response.end(count === null ? '{"error":"not found"}' : JSON.stringify({ downloads: count }))
            return
        }
        const name = decodeURIComponent(path.replace(/^\//, ''))
        const file = fileFor(layers, name)
        if (file === null) {
            response.writeHead(404, { 'Content-Type': 'application/json' })
            response.end('{"error":"Not found"}')
            return
        }
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(readFileSync(file))
    })
    await new Promise<void>(function listen(resolve) {
        server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address() as AddressInfo
    const url = 'http://127.0.0.1:' + address.port
    return {
        url,
        urls: { pypi: url + PREFIXES.pypi, crates: url + PREFIXES.crates, goproxy: url + PREFIXES.goproxy, rubygems: url + PREFIXES.rubygems },
        requests,
        downloadRequests,
        publishedRequests,
        setFailing: function setFailing(next: boolean) {
            failing = next
        },
        close: function close(): Promise<void> {
            return new Promise(function shut(resolve) {
                server.closeAllConnections()
                server.close(function done() {
                    resolve()
                })
            })
        }
    }
}
