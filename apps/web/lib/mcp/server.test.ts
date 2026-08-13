import { describe, expect, it, beforeAll } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer } from './server'

// The tool list is the entire contract an LLM sees before it calls anything: names, prose, and the
// JSON Schema for each input. Anything true but unstated here does not exist as far as the model is
// concerned, which is how a caller ended up reporting a deliberate difference in counting grain as a
// bug. These tests assert against the real wire output rather than the registry internals, because the
// wire output is what clients actually receive.

type ToolSchema = {
    name: string
    description?: string
    inputSchema: { properties?: Record<string, { description?: string }>; required?: string[] }
}

let tools: ToolSchema[]

beforeAll(async function listTools() {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test', version: '0' })
    await Promise.all([createMcpServer().connect(serverTransport), client.connect(clientTransport)])
    const result = await client.listTools()
    tools = result.tools as ToolSchema[]
})

function tool(name: string): ToolSchema {
    const found = tools.find(function byName(t) {
        return t.name === name
    })
    if (!found) throw new Error('tool not registered: ' + name)
    return found
}

describe('MCP tool surface', function () {
    it('registers every documented tool', function () {
        const names = tools.map(function nameOf(t) {
            return t.name
        })
        expect(names.sort()).toEqual(
            [
                'get_dashboard_summary',
                'get_project',
                'get_project_advisory',
                'get_root',
                'list_findings',
                'list_libraries',
                'list_mutes',
                'list_projects',
                'list_roots',
                'list_scans',
                'mute_finding',
                'request_scan',
                'set_project_alias',
                'set_project_tags',
                'unmute'
            ].sort()
        )
    })

    // Walks whatever is registered rather than a hand-maintained list, so a tool added later without
    // descriptions fails here instead of quietly shipping inputs the model cannot interpret.
    it('describes every tool and every input of every tool', function () {
        const undescribed: string[] = []
        for (const t of tools) {
            if (!t.description) undescribed.push(t.name)
            const properties = t.inputSchema.properties || {}
            for (const [input, schema] of Object.entries(properties)) {
                if (!schema.description) undescribed.push(t.name + '.' + input)
            }
        }
        expect(undescribed).toEqual([])
    })

    // The two tools count different things on purpose. Each has to say so, or the difference reads as
    // a defect to whoever compares them.
    it('warns on list_findings that its rows are per-source and outnumber distinct advisories', function () {
        const description = tool('list_findings').description || ''
        expect(description).toContain('RAW PER-SOURCE ROWS')
        expect(description).toContain('get_project_advisory')
    })

    it('states on get_project_advisory that entries are deduplicated advisories', function () {
        const description = tool('get_project_advisory').description || ''
        expect(description).toContain('one entry per distinct advisory')
        expect(description).toContain('list_findings')
    })

    it('tells the caller that get_project_advisory paginates and how to detect a partial document', function () {
        const description = tool('get_project_advisory').description || ''
        expect(description).toContain('paginated')
        expect(description.toLowerCase()).toContain('incomplete')
    })

    // get_dashboard_summary counts a DIFFERENT POPULATION than list_projects: a project-muted
    // project is dropped from totalActiveProjects but still listed by list_projects. Unstated, that
    // reads as an off-by-N between two tools an agent naturally calls together — the same class of
    // false bug report the grain tests above exist to prevent.
    it('states on get_dashboard_summary that project-muted projects are excluded from the totals', function () {
        const description = tool('get_dashboard_summary').description || ''
        expect(description).toContain('EXCLUDED from totalActiveProjects')
        expect(description).toContain('list_projects')
    })

    // The description used to enumerate the fields it returns and omit two of them, which is how
    // totalActiveProjects changed meaning without anyone noticing it was undocumented.
    it('names every field get_dashboard_summary returns', function () {
        const description = tool('get_dashboard_summary').description || ''
        for (const field of ['totalActiveProjects', 'projectsWithFindings', 'findingsLast24h']) {
            expect(description).toContain(field)
        }
    })

    it('warns on list_projects that a muted project is listed with zeroed counts', function () {
        const description = tool('list_projects').description || ''
        expect(description).toContain('muted: true')
        expect(description).toContain('silenced, not clean')
    })

    // unmute took an id that no read tool could produce until list_mutes existed.
    it('offers a way to discover the mute ids that unmute requires', function () {
        expect(tool('list_mutes')).toBeDefined()
        expect(tool('unmute').description || '').toContain('list_mutes')
    })

    it('warns that set_project_tags replaces rather than appends', function () {
        const description = tool('set_project_tags').description || ''
        expect(description).toContain('REPLACES')
    })

    it('warns that request_scan only queues work', function () {
        const description = tool('request_scan').description || ''
        expect(description).toContain('QUEUES')
    })
})
