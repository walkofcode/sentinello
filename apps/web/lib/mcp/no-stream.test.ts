import { describe, expect, it } from 'vitest'
import { noStandaloneStream } from './no-stream'

// The endpoint is stateless: every POST is one JSON-RPC exchange and there is no session to stream to
// or terminate. A GET used to be handed to the transport, which opened an SSE stream that the
// per-request server.close() ended within milliseconds — and an MCP client reconnects a closed stream
// at once. One idle Claude Code session kept the web process busy with ~4 GETs a second, each building
// a whole McpServer. The spec's answer for a server with no standalone stream is 405, which clients
// accept as "no stream here" and stop asking.
describe('MCP endpoint — no standalone stream', function () {
    it('answers 405 naming POST as the one allowed method', function () {
        const res = noStandaloneStream()
        expect(res.status).toBe(405)
        expect(res.headers.get('Allow')).toBe('POST')
    })
})
