import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
    getDashboardSummary,
    getProjectById,
    getProjectEcosystemCoverage,
    getRootById,
    listCurrentFindingsForProject,
    listLibraries,
    listProjectCatalog,
    listRoots,
    listScansForProject
} from '@sentinello/db'
import { SEVERITY_RANK, severityRank } from '@sentinello/core'
import { getDb } from '@/lib/db'

const depTypeSchema = z.enum(['all', 'prod', 'dev']).optional()

// Thin wrappers around packages/db query helpers. Each tool returns structured JSON via
// `structuredContent` so MCP clients with schema-aware UIs render it nicely, plus a text fallback
// for clients that only render plain content blocks.
export function registerReadTools(server: McpServer): void {
    server.registerTool(
        'list_roots',
        {
            title: 'List roots',
            description: 'Lists all configured Sentinello scan roots (project directories).'
        },
        async function handler() {
            const rows = listRoots(getDb()).map(function toOut(r) {
                return { id: r.id, path: r.path, label: r.label, createdAt: r.createdAt }
            })
            return {
                content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }],
                structuredContent: { roots: rows }
            }
        }
    )

    server.registerTool(
        'get_root',
        {
            title: 'Get root',
            description: 'Fetches a single root by id.',
            inputSchema: { id: z.string().min(1).describe('Root id (sha256 of the path)') }
        },
        async function handler({ id }) {
            const row = getRootById(getDb(), id)
            if (!row) {
                return {
                    isError: true,
                    content: [{ type: 'text', text: 'Root not found: ' + id }]
                }
            }
            return {
                content: [{ type: 'text', text: JSON.stringify(row, null, 2) }],
                structuredContent: row
            }
        }
    )

    server.registerTool(
        'list_projects',
        {
            title: 'List projects',
            description: 'Lists projects discovered under all (or one) root, with severity counts and last-scan status.',
            inputSchema: {
                rootId: z.string().min(1).optional().describe('Limit to one root by id'),
                depType: depTypeSchema.describe('Filter findings by dependency type (default: all)')
            }
        },
        async function handler({ rootId, depType }) {
            const db = getDb()
            // Always return the rich ProjectCatalogRow shape (severity counts + last-scan status) so
            // the schema is identical whether or not rootId is passed. ProjectCatalogRow carries
            // rootPath but not rootId, so resolve the root and filter by path in-memory.
            let rows = listProjectCatalog(db, Date.now(), depType || 'all')
            if (rootId) {
                const root = getRootById(db, rootId)
                if (!root) {
                    return { isError: true, content: [{ type: 'text', text: 'Root not found: ' + rootId }] }
                }
                rows = rows.filter(function inRoot(r) { return r.rootPath === root.path })
            }
            return {
                content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }],
                structuredContent: { projects: rows }
            }
        }
    )

    server.registerTool(
        'get_project',
        {
            title: 'Get project',
            description: 'Fetches a single project by id, including its detected ecosystems and per-ecosystem resolver coverage (ok / partial / unauditable with a reason code).',
            inputSchema: { id: z.string().min(1) }
        },
        async function handler({ id }) {
            const db = getDb()
            const row = getProjectById(db, id)
            if (!row) {
                return { isError: true, content: [{ type: 'text', text: 'Project not found: ' + id }] }
            }
            // Surface per-ecosystem coverage so an agent sees that e.g. a Python scan was partial rather
            // than reading the absence of findings as a clean bill of health.
            const out = { ...row, coverage: getProjectEcosystemCoverage(db, id) }
            return {
                content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
                structuredContent: out
            }
        }
    )

    server.registerTool(
        'list_findings',
        {
            title: 'List current findings for a project',
            description: 'Returns the active (unresolved) vulnerability findings for one project, ordered by severity. Optionally filter by minimum severity, ecosystem, or source.',
            inputSchema: {
                projectId: z.string().min(1),
                minSeverity: z.enum(['critical', 'high', 'moderate', 'low', 'info']).optional(),
                depType: depTypeSchema,
                ecosystem: z.string().min(1).optional().describe("Filter to one ecosystem id ('npm', 'PyPI', 'Go', 'crates.io')"),
                source: z.string().min(1).optional().describe("Filter to one source id ('npm-audit', 'osv', 'gemnasium')"),
                includeMuted: z.boolean().optional().describe('Include muted findings (default false)')
            }
        },
        async function handler({ projectId, minSeverity, depType, ecosystem, source, includeMuted }) {
            const all = listCurrentFindingsForProject(getDb(), projectId, Date.now(), depType || 'all')
            // Lower rank = more severe. Keep findings at or above the requested floor. Note: must NOT
            // use `&&`/`||` here — `critical` ranks 0, and a falsy-zero would silently drop criticals
            // and invert `minSeverity: 'critical'`. severityRank() always returns a valid number.
            let cutoff = 4
            if (minSeverity) cutoff = SEVERITY_RANK[minSeverity]
            const filtered = all.filter(function keep(f) {
                if (!includeMuted && f.isMuted) return false
                if (ecosystem && f.ecosystem !== ecosystem) return false
                if (source && f.source !== source) return false
                return severityRank(f.severity) <= cutoff
            })
            return {
                content: [{ type: 'text', text: JSON.stringify(filtered, null, 2) }],
                structuredContent: { findings: filtered }
            }
        }
    )

    server.registerTool(
        'list_scans',
        {
            title: 'List recent scans for a project',
            description: 'Returns the most recent scan rows for a project.',
            inputSchema: {
                projectId: z.string().min(1),
                limit: z.number().int().min(1).max(200).optional()
            }
        },
        async function handler({ projectId, limit }) {
            const rows = listScansForProject(getDb(), projectId, limit || 50, 0)
            return {
                content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }],
                structuredContent: { scans: rows }
            }
        }
    )

    server.registerTool(
        'list_libraries',
        {
            title: 'List libraries (packages) with their vulnerability footprint',
            description: 'Returns a summary of every (ecosystem, package) observed across scanned projects with its severity counts. Each row carries its ecosystem so same-named packages in different ecosystems stay distinct. Optionally filter by ecosystem.',
            inputSchema: {
                depType: depTypeSchema,
                ecosystem: z.string().min(1).optional().describe("Filter to one ecosystem id ('npm', 'PyPI', 'Go', 'crates.io')")
            }
        },
        async function handler({ depType, ecosystem }) {
            const all = listLibraries(getDb(), Date.now(), depType || 'all')
            const rows = ecosystem ? all.filter(function keep(l) { return l.ecosystem === ecosystem }) : all
            return {
                content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }],
                structuredContent: { libraries: rows }
            }
        }
    )

    server.registerTool(
        'get_dashboard_summary',
        {
            title: 'Get dashboard summary',
            description: 'High-level counts (projects with findings, severity totals, last scan timestamp) that drive the home page.',
            inputSchema: { depType: depTypeSchema }
        },
        async function handler({ depType }) {
            const summary = getDashboardSummary(getDb(), Date.now(), depType || 'all')
            return {
                content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
                structuredContent: summary
            }
        }
    )
}
