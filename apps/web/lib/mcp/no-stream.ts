// The /api/mcp answer to GET and DELETE. The endpoint is stateless (one McpServer per POST, no session
// id), so it offers no standalone SSE stream and has no session to terminate. The MCP Streamable HTTP
// spec has a server in that position answer GET with 405; a 200 stream that closes at once instead makes
// a client reconnect in a tight loop (no-stream.test.ts says what that cost).
export function noStandaloneStream(): Response {
    return new Response(null, { status: 405, headers: { Allow: 'POST' } })
}
