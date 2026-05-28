import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getCurrentVersion } from '@/lib/version'
import { registerReadTools } from './tools/read'
import { registerActionTools } from './tools/actions'

// Builds a fresh McpServer per request (stateless mode). Tools all close over getDb() which is a
// process-wide singleton, so spinning up a new server per request is cheap — no shared mutable
// MCP state, no session bookkeeping.
export function createMcpServer(): McpServer {
    const server = new McpServer({
        name: 'sentinello',
        version: getCurrentVersion()
    })
    registerReadTools(server)
    registerActionTools(server)
    return server
}
