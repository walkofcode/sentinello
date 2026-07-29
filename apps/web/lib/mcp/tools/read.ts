import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
    getDashboardSummary,
    getProjectById,
    getProjectEcosystemCoverage,
    getRootById,
    listActiveMutes,
    listCurrentFindingsForProject,
    listLibraries,
    listProjectCatalog,
    listRoots,
    listScansForProject
} from '@sentinello/db'
import { buildPaginatedAdvisoryMarkdown, meetsSeverityFloor } from '@sentinello/core'
import { getDb } from '@/lib/db'
import { buildProjectAdvisoryParts } from '@/lib/project-advisory-export'
import { buildAdvisoryToolResult } from '@/lib/mcp/advisory-result'

const depTypeSchema = z
    .enum(['all', 'prod', 'dev'])
    .optional()
    .describe(
        "Which dependencies to count: 'all' (default) covers production and dev dependencies, 'prod' only production, 'dev' only dev."
    )

// Advisory documents are prose and can run to hundreds of KB on a large monorepo, while a tool result
// has to fit in the client's context. ~90 KB sits under a 25k-token cap with room for the header, the
// prompt and the continuation notice. Paging past this is honest and explicit; silently overflowing
// the client's limit is not — a truncated security document reads as a clean one.
const ADVISORY_BYTE_BUDGET = 90_000

// Thin wrappers around packages/db query helpers. Each tool returns structured JSON via
// `structuredContent` so MCP clients with schema-aware UIs render it nicely, plus a text fallback
// for clients that only render plain content blocks.
export function registerReadTools(server: McpServer): void {
    server.registerTool(
        'list_roots',
        {
            title: 'List roots',
            description:
                'Lists all configured Sentinello scan roots — the directories mounted into the container that Sentinello discovers projects under. Start here when you do not yet know what this instance is watching; use list_projects for the projects found inside them.'
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
            description: 'Fetches a single scan root by id, as listed by list_roots.',
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
            description:
                'Lists projects discovered under all (or one) root, each with severity counts and last-scan status. Severity counts are DISTINCT ADVISORIES, deduplicated across reporting sources — so they are lower than the row count list_findings returns for the same project, and they match get_project_advisory. This is the usual starting point for finding a projectId.',
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
            description:
                "Fetches a single project by id, including its detected ecosystems and per-ecosystem resolver coverage (ok / partial / unauditable, each with a reason code). Check coverage before concluding a project is clean: 'unauditable' means that ecosystem was never successfully scanned, so zero findings there means unknown, not safe.",
            inputSchema: { id: z.string().min(1).describe('Project id, as returned by list_projects (a 26-char hex string)') }
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
            description:
                'Returns the active (unresolved) vulnerability findings for one project, ordered by severity, as RAW PER-SOURCE ROWS: one row per reporting source, so a vulnerability that npm-audit and OSV both report appears twice under their different advisory ids. This count is therefore expected to EXCEED the distinct-advisory counts from list_projects, get_dashboard_summary and get_project_advisory — that is the intended difference in grain, not a bug. Use this when you want the underlying rows or need to mute a specific (source, advisory, package) identity; use get_project_advisory when you want the deduplicated work document.',
            inputSchema: {
                projectId: z.string().min(1).describe('Project id, as returned by list_projects (a 26-char hex string)'),
                minSeverity: z
                    .enum(['critical', 'high', 'moderate', 'low', 'info'])
                    .optional()
                    .describe(
                        "Only return findings at or above this severity (default: no floor, everything is returned). 'high' yields critical + high."
                    ),
                depType: depTypeSchema,
                ecosystem: z.string().min(1).optional().describe("Filter to one ecosystem id ('npm', 'PyPI', 'Go', 'crates.io')"),
                source: z.string().min(1).optional().describe("Filter to one source id ('npm-audit', 'osv', 'gemnasium')"),
                includeMuted: z.boolean().optional().describe('Include muted findings (default false)')
            }
        },
        async function handler({ projectId, minSeverity, depType, ecosystem, source, includeMuted }) {
            const all = listCurrentFindingsForProject(getDb(), projectId, Date.now(), depType || 'all')
            const filtered = all.filter(function keep(f) {
                if (!includeMuted && f.isMuted) return false
                if (ecosystem && f.ecosystem !== ecosystem) return false
                if (source && f.source !== source) return false
                if (minSeverity) return meetsSeverityFloor(f.severity, minSeverity)
                return true
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
            description:
                "Returns the most recent scan rows for a project, newest first — each with its status, timing and any error. Use this to confirm a scan requested via request_scan has actually finished, and to tell 'no findings' apart from 'never successfully scanned'.",
            inputSchema: {
                projectId: z.string().min(1).describe('Project id, as returned by list_projects (a 26-char hex string)'),
                limit: z
                    .number()
                    .int()
                    .min(1)
                    .max(200)
                    .optional()
                    .describe('How many scan rows to return, newest first (default: 50, maximum: 200).')
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
            description:
                "Returns a summary of every (ecosystem, package) observed across scanned projects with its severity counts and how many projects use it. Each row carries its ecosystem, so an npm 'requests' and a PyPI 'requests' never collapse into one row. Use this for fleet-wide questions — 'which vulnerable package is most widespread' — rather than per-project triage.",
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
        'list_mutes',
        {
            title: 'List active mutes',
            description:
                'Lists the mutes currently in force — the accepted-risk decisions a human recorded to keep a finding off the dashboard. Expired mutes are not returned. Each row carries the mute id needed by the unmute tool, which is otherwise unobtainable. A project-scope mute silences every finding on that project; a finding-scope mute silences one (source, ecosystem, advisory, package) identity.',
            inputSchema: {
                projectId: z
                    .string()
                    .min(1)
                    .optional()
                    .describe(
                        'Limit to mutes affecting one project (default: every active mute). Includes global finding-scope mutes, which have no projectId and apply everywhere.'
                    )
            }
        },
        async function handler({ projectId }) {
            const all = listActiveMutes(getDb(), Date.now())
            let rows = all
            if (projectId) {
                // A finding-scope mute with a null projectId is global — it silences that identity in
                // every project, so it belongs in a per-project view too.
                rows = all.filter(function affects(m) {
                    return m.projectId === projectId || m.projectId === null
                })
            }
            return {
                content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }],
                structuredContent: { mutes: rows }
            }
        }
    )

    server.registerTool(
        'get_dashboard_summary',
        {
            title: 'Get dashboard summary',
            description:
                "High-level counts across every project — projects with findings, severity totals, and the last scan timestamp — the same numbers the portal home page shows. Severity totals count distinct advisories (deduped across reporting sources), matching list_projects. Use this for 'how bad is it overall', and list_projects when you need the per-project breakdown.",
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

    server.registerTool(
        'get_project_advisory',
        {
            title: 'Get the advisory export document for a project',
            description:
                "Returns the Markdown advisory work document for one project — the same document the portal's Download .md button produces: a remediation prompt followed by the active vulnerabilities. This is a work document to act on, not a data query; use list_findings when you only need finding rows.\n\n" +
                'GRAIN: one entry per distinct advisory, with every reporting source merged into it. A vulnerability that npm-audit and OSV both report is ONE entry here but TWO rows in list_findings, so this count is deliberately lower — that is not a discrepancy. It matches the severity totals from list_projects and the dashboard.\n\n' +
                'SIZE: the response is paginated by byte size, not by a fixed count. If the document does not fit, the last line tells you it is incomplete and gives you the exact follow-up call to make; keep calling until it stops doing so. Never treat a page that ends early as the full list.\n\n' +
                "Muted findings are excluded, and a note states how many. Default depType is 'all' here, while the portal page defaults to 'prod' — pass 'prod' to match a download taken from the default view.",
            inputSchema: {
                projectId: z.string().min(1).describe('Project id, as returned by list_projects (a 26-char hex string)'),
                depType: depTypeSchema.describe(
                    "Dependency-type filter baked into the document. 'all' (default) covers prod + dev; 'prod' matches the portal page's own default view."
                ),
                offset: z
                    .number()
                    .int()
                    .min(0)
                    .optional()
                    .describe(
                        'Index of the first advisory to render, for continuing a paginated document (default: 0). Pass the value the previous response told you to use — do not guess or increment it yourself.'
                    ),
                minSeverity: z
                    .enum(['critical', 'high', 'moderate', 'low', 'info'])
                    .optional()
                    .describe(
                        "Only include advisories at or above this severity (default: no floor, everything is included). 'high' yields critical + high."
                    ),
                includePrompt: z
                    .boolean()
                    .optional()
                    .describe(
                        'Include the ~10 KB remediation prompt that explains how to approach the fixes. Defaults to true on the first page and false when offset > 0, since a continuation page would only repeat it. Set false to save space when you already have the ground rules.'
                    )
            }
        },
        async function handler({ projectId, depType, offset, minSeverity, includePrompt }) {
            const resolvedDepType = depType || 'all'
            const resolvedOffset = offset || 0
            const parts = buildProjectAdvisoryParts(getDb(), projectId, resolvedDepType, Date.now())
            if (!parts) {
                return { isError: true, content: [{ type: 'text', text: 'Project not found: ' + projectId }] }
            }
            let findings = parts.findings
            if (minSeverity) {
                findings = findings.filter(function keep(f) {
                    return meetsSeverityFloor(f.severity, minSeverity)
                })
            }
            // A continuation page repeats none of the 10 KB remediation prompt by default — the agent
            // asking for offset > 0 already read it on page 1.
            let withPrompt = resolvedOffset === 0
            if (includePrompt !== undefined) withPrompt = includePrompt
            const page = buildPaginatedAdvisoryMarkdown({
                scope: parts.scope,
                prompt: withPrompt ? parts.prompt : '',
                findings,
                generatedAt: parts.generatedAt,
                offset: resolvedOffset,
                byteBudget: ADVISORY_BYTE_BUDGET
            })
            return buildAdvisoryToolResult({
                page,
                mutedExcludedCount: parts.mutedExcludedCount,
                projectId: parts.projectId,
                depType: resolvedDepType
            })
        }
    )
}
