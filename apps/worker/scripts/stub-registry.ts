import { existsSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'

// A deterministic npm registry for the --fixture smokes: a loopback HTTP server over recorded packuments
// (apps/worker/test/fixtures/registry/). Layers are directories searched last-first, so a variant
// directory overrides only the packages it contains. It also answers npm's download-count API
// (`/downloads/point/last-week/<name>`) from each layer's `_downloads.json`. Point both
// SENTINELLO_NPM_REGISTRY_URL and SENTINELLO_NPM_DOWNLOADS_URL at `url`.

export type StubRegistry = {
    url: string
    // Every packument path requested, in order.
    requests: string[]
    // Every download-count path requested, in order.
    downloadRequests: string[]
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

export async function startStubRegistry(layers: readonly string[]): Promise<StubRegistry> {
    const requests: string[] = []
    const downloadRequests: string[] = []
    let failing = false
    const server = createServer(function handle(request: IncomingMessage, response: ServerResponse): void {
        const path = request.url ?? '/'
        const isDownloads = path.startsWith(DOWNLOADS_PREFIX)
        if (isDownloads) downloadRequests.push(path)
        else requests.push(path)
        if (failing) {
            response.writeHead(503, { 'Content-Type': 'text/plain' })
            response.end('stub registry: failing on purpose')
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
    return {
        url: 'http://127.0.0.1:' + address.port,
        requests,
        downloadRequests,
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
