import { NextResponse } from 'next/server'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { isMcpEnabled, verifyMcpAuth } from '@/lib/mcp/auth'
import { noStandaloneStream } from '@/lib/mcp/no-stream'
import { createMcpServer } from '@/lib/mcp/server'

// Sentinello's MCP endpoint. Stateless: each POST spins up a fresh McpServer + transport pair,
// handles the JSON-RPC payload, and tears down. No session id, no cross-request state — the SQLite
// singleton is already shared via lib/db. GET and DELETE answer 405 (lib/mcp/no-stream.ts).
//
// Why this lives in the Next.js app and not a separate process: the existing query helpers and
// server actions all assume `lib/db.ts`'s singleton DB handle. Reusing them keeps the worker
// pipeline (scan-request mailbox, mutes lifecycle, revalidation semantics) in one place.

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

async function handle(req: Request): Promise<Response> {
    if (!isMcpEnabled()) {
        return NextResponse.json({ error: 'MCP disabled' }, { status: 404 })
    }
    const auth = verifyMcpAuth(req)
    if (!auth.ok) {
        return NextResponse.json(auth.body, {
            status: auth.status,
            headers: { 'WWW-Authenticate': 'Bearer realm="sentinello-mcp"' }
        })
    }
    const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true
    })
    const server = createMcpServer()
    await server.connect(transport)
    try {
        return await transport.handleRequest(req)
    } finally {
        await server.close()
    }
}

export async function POST(req: Request): Promise<Response> {
    return handle(req)
}

// No standalone stream and no session: 405 before any auth or server construction, since an MCP client
// that is told "200, stream" here reconnects as fast as the stream closes.
export async function GET(): Promise<Response> {
    return noStandaloneStream()
}

export async function DELETE(): Promise<Response> {
    return noStandaloneStream()
}
