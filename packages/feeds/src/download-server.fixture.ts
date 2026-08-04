import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

// A real loopback HTTP server for exercising the download path.
//
// openDownloadStream deliberately uses node:https rather than fetch (see http.ts — undici stamps an
// unremovable `Sec-Fetch-Mode: cors` that GitLab answers with 406), so a stubbed global fetch no longer
// reaches it. Stubbing node:https instead would fake the exact layer that bug lived in, which is how it
// survived two rounds of fixes with a green suite.
//
// Serving real bytes over 127.0.0.1 keeps these hermetic — no external network, nothing resolved through
// DNS — while running the genuine transport: status codes, headers, redirects, chunked encoding and
// streaming all behave the way they do in production.

export type ServedResponse = {
    status?: number
    headers?: Record<string, string>
    body?: Buffer | string
}

export type RecordedRequest = { url: string; headers: IncomingMessage['headers'] }

export type DownloadServer = {
    // Origin only, e.g. http://127.0.0.1:54321 — callers append whatever path they are testing.
    origin: string
    requests: RecordedRequest[]
    close: () => Promise<void>
}

export async function startDownloadServer(
    respond: ServedResponse | ((request: RecordedRequest) => ServedResponse)
): Promise<DownloadServer> {
    const requests: RecordedRequest[] = []
    const server = createServer(function handle(request: IncomingMessage, response: ServerResponse): void {
        const recorded: RecordedRequest = { url: request.url ?? '', headers: request.headers }
        requests.push(recorded)
        const served = typeof respond === 'function' ? respond(recorded) : respond
        const raw = served.body ?? Buffer.alloc(0)
        const body = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
        response.writeHead(served.status ?? 200, served.headers ?? {})
        response.end(body)
    })
    await new Promise<void>(function listen(resolve) {
        server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address() as AddressInfo
    return {
        origin: 'http://127.0.0.1:' + address.port,
        requests,
        close: function close(): Promise<void> {
            return new Promise(function shut(resolve) {
                // closeAllConnections so a keep-alive socket from a cancelled download cannot hold the
                // close open and hang the suite.
                server.closeAllConnections()
                server.close(function done() {
                    resolve()
                })
            })
        }
    }
}
