import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer } from '@/lib/mcp/server'

// Drives the tools through a real McpServer and a real Client over a linked in-memory transport
// pair, rather than by calling the registered handlers directly. That costs a few lines of setup and
// buys the thing that matters: every call goes through the declared zod inputSchema exactly as a
// request from an MCP client would, so a schema that does not match its handler fails here instead
// of in front of an agent.

export type ToolResult = {
    content: { type: string; text?: string }[]
    structuredContent?: Record<string, unknown>
    isError?: boolean
}

export type McpHarness = {
    call: (name: string, args?: Record<string, unknown>) => Promise<ToolResult>
    listToolNames: () => Promise<string[]>
    close: () => Promise<void>
}

export async function connectMcp(): Promise<McpHarness> {
    const server = createMcpServer()
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'sentinello-test-client', version: '0.0.0' })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    return {
        async call(name, args = {}) {
            return (await client.callTool({ name, arguments: args })) as ToolResult
        },
        async listToolNames() {
            const { tools } = await client.listTools()
            return tools.map(function name(t) { return t.name }).sort()
        },
        async close() {
            await client.close()
            await server.close()
        }
    }
}

// Every tool returns its payload as JSON in the first text content block (get_project_advisory is the
// documented exception — it returns raw Markdown).
export function jsonOf<T>(result: ToolResult): T {
    return JSON.parse(textOf(result)) as T
}

// A result carrying no content block is a bug in the tool under test, so say that. Letting the
// undefined through would surface as `JSON.parse(undefined)` or an assertion against "undefined"
// several frames from the tool that actually returned nothing.
export function textOf(result: ToolResult): string {
    const first = result.content[0]
    if (!first) throw new Error('tool result carried no content block')
    return first.text as string
}
