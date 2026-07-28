import {
    getConfigValue,
    getProjectById,
    getRootById,
    listCurrentFindingsForProject,
    type DrizzleDb
} from '@sentinello/db'
import type { DepTypeFilter, Severity } from '@sentinello/core'
import { parseJsonArray } from '@/lib/format'
import {
    buildAdvisoryMarkdown,
    buildExportFilename,
    resolveExportPrompt,
    type ExportFinding,
    type ExportScope
} from '@/lib/export-markdown'

// Assembles the project advisory export document. Deliberately NOT a 'use server' file: this module
// is shared by the portal's export action and the MCP `get_project_advisory` tool, and marking it
// would break both callers for different reasons — every export of a 'use server' file becomes a
// client-callable HTTP endpoint, and the MCP path would inherit the revalidatePath constraint
// documented in lib/mcp/tools/actions.ts. The server action wraps this; the MCP tool calls it
// directly.
//
// Lives here rather than in @sentinello/core because it reads rows from @sentinello/db, and db
// already depends on core — core importing db would be a workspace cycle. Core's boundary is
// deliberate: it receives ExportFinding[] and never rows, which is what lets the worker's webhook
// reuse buildAdvisoryMarkdown against a completely different query.

export type ProjectAdvisoryExport = {
    filename: string
    markdown: string
    projectId: string
    projectName: string
    depType: DepTypeFilter
    // Rendered rows, not distinct advisories. listCurrentFindingsForProject emits one row per
    // (scanner, advisory, dep path), so a vulnerability reported by both npm-audit and OSV appears
    // twice — this count will exceed the merged count the project page header shows.
    findingCount: number
    mutedExcludedCount: number
    generatedAt: number
}

// Returns null when the project id does not resolve, so each caller shapes its own failure: the
// server action throws, the MCP tool returns an isError result. Synchronous — every helper it calls
// is synchronous better-sqlite3. `generatedAt` is injected rather than read from Date.now() inside
// so the filename stamp and the document header can never disagree.
export function buildProjectAdvisoryExport(
    db: DrizzleDb,
    projectId: string,
    depType: DepTypeFilter,
    generatedAt: number
): ProjectAdvisoryExport | null {
    const project = getProjectById(db, projectId)
    if (!project) return null
    const root = getRootById(db, project.rootId)
    const rows = listCurrentFindingsForProject(db, project.id, generatedAt, depType)
    // Muted findings are a human's recorded accepted-risk decision. Excluding them keeps this
    // document consistent with the MCP list_findings tool and with the library-scope export (which
    // filters mutes in SQL), and stops the remediation prompt from instructing an agent to fix
    // something a human already signed off on.
    const active = rows.filter(function notMuted(r) {
        return !r.isMuted
    })
    const findings: ExportFinding[] = active.map(function toExport(r): ExportFinding {
        return {
            packageName: r.packageName,
            installedVersion: r.installedVersion,
            fixAvailable: r.fixAvailable,
            fixVersion: r.fixVersion,
            severity: r.severity as Severity,
            advisoryId: r.advisoryId,
            advisoryTitle: r.advisoryTitle,
            advisoryUrl: r.advisoryUrl,
            vulnerableRange: r.vulnerableRange,
            isProd: r.isProd,
            isDev: r.isDev,
            depPath: parseJsonArray(r.depPathJson)
        }
    })
    const displayName = project.alias || project.name
    const rootLabel = root?.label || root?.path || 'unknown root'
    const projectPath = project.relPath === '.' ? rootLabel : rootLabel + '/' + project.relPath
    const scope: ExportScope = {
        kind: 'project',
        projectName: displayName,
        projectPath,
        depType
    }
    const prompt = resolveExportPrompt(getConfigValue<string>(db, 'markdownExportPrompt'))
    return {
        filename: buildExportFilename(scope, generatedAt),
        markdown: buildAdvisoryMarkdown({ scope, prompt, findings, generatedAt }),
        projectId: project.id,
        projectName: displayName,
        depType,
        findingCount: findings.length,
        mutedExcludedCount: rows.length - active.length,
        generatedAt
    }
}
