import { existsSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'

// A deterministic npm registry for the --fixture smoke: a loopback HTTP server over recorded packuments
// (apps/worker/test/fixtures/registry/). Layers are directories searched last-first, so a variant
// directory overrides only the packages it contains. Point SENTINELLO_NPM_REGISTRY_URL at `url`.

export type StubRegistry = {
    url: string
    // Every packument path requested, in order.
    requests: string[]
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

export async function startStubRegistry(layers: readonly string[]): Promise<StubRegistry> {
    const requests: string[] = []
    let failing = false
    const server = createServer(function handle(request: IncomingMessage, response: ServerResponse): void {
        const path = request.url ?? '/'
        requests.push(path)
        if (failing) {
            response.writeHead(503, { 'Content-Type': 'text/plain' })
            response.end('stub registry: failing on purpose')
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
