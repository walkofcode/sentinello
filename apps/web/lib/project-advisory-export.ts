import {
    getConfigValue,
    getProjectById,
    getRootById,
    listCurrentFindingsForProject,
    type DrizzleDb
} from '@sentinello/db'
import type { DepTypeFilter } from '@sentinello/core'
import { mergeFindings } from '@/lib/merge-findings'
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
    // Distinct advisories, not raw rows. listCurrentFindingsForProject emits one row per
    // (scanner, advisory, dep path), so a vulnerability reported by both npm-audit and OSV arrives
    // twice; mergeFindings collapses those to one entry. This count therefore matches the project
    // page header and the dashboard's severity totals, and is deliberately LOWER than the row count
    // the MCP list_findings tool returns.
    findingCount: number
    // Also in the deduped grain: advisories excluded entirely because every row reporting them is
    // muted. An advisory muted on one source but still reported by another is not excluded, and is
    // not counted here.
    mutedExcludedCount: number
    generatedAt: number
}

// The document's raw ingredients, before rendering. Split out from buildProjectAdvisoryExport because
// the MCP tool has to render a size-bounded PAGE rather than the whole document, and it cannot do that
// from a finished markdown string. The portal download goes on using buildProjectAdvisoryExport below.
export type ProjectAdvisoryParts = {
    scope: ExportScope
    prompt: string
    findings: ExportFinding[]
    projectId: string
    projectName: string
    depType: DepTypeFilter
    mutedExcludedCount: number
    generatedAt: number
}

// Returns null when the project id does not resolve, so each caller shapes its own failure: the
// server action throws, the MCP tool returns an isError result. Synchronous — every helper it calls
// is synchronous better-sqlite3. `generatedAt` is injected rather than read from Date.now() inside
// so the filename stamp and the document header can never disagree.
export function buildProjectAdvisoryParts(
    db: DrizzleDb,
    projectId: string,
    depType: DepTypeFilter,
    generatedAt: number
): ProjectAdvisoryParts | null {
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
    // Merge AFTER filtering mutes, never before. A vulnerability muted on npm-audit but still reported
    // by OSV must stay in the document — merging first would let one muted row silence a group that
    // another source is still flagging.
    const merged = mergeFindings(active)
    const findings: ExportFinding[] = merged.map(function toExport(m): ExportFinding {
        const advisoryIds = [...new Set(m.identities.map(function idOf(i) { return i.advisoryId }))]
        return {
            packageName: m.packageName,
            installedVersion: m.installedVersion,
            fixAvailable: m.fixAvailable,
            fixVersion: m.fixVersion,
            severity: m.severity,
            advisoryId: m.advisoryId,
            advisoryTitle: m.advisoryTitle,
            advisoryUrl: m.advisoryUrl,
            vulnerableRange: m.vulnerableRange,
            isProd: m.isProd,
            isDev: m.isDev,
            // depPaths supersedes depPath in the renderer; depPath keeps the object coherent for any
            // consumer reading the single-path field.
            depPath: m.depPaths[0] || [],
            sources: m.scanners,
            advisoryIds,
            depPaths: m.depPaths
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
        scope,
        prompt,
        findings,
        projectId: project.id,
        projectName: displayName,
        depType,
        // Deduped on both sides so the two counts share a grain: advisories that exist at all, minus
        // the ones that survived the mute filter.
        mutedExcludedCount: mergeFindings(rows).length - findings.length,
        generatedAt
    }
}

// The whole document, unpaginated — what the portal's Download .md button serves.
export function buildProjectAdvisoryExport(
    db: DrizzleDb,
    projectId: string,
    depType: DepTypeFilter,
    generatedAt: number
): ProjectAdvisoryExport | null {
    const parts = buildProjectAdvisoryParts(db, projectId, depType, generatedAt)
    if (!parts) return null
    return {
        filename: buildExportFilename(parts.scope, generatedAt),
        markdown: buildAdvisoryMarkdown({
            scope: parts.scope,
            prompt: parts.prompt,
            findings: parts.findings,
            generatedAt
        }),
        projectId: parts.projectId,
        projectName: parts.projectName,
        depType: parts.depType,
        findingCount: parts.findings.length,
        mutedExcludedCount: parts.mutedExcludedCount,
        generatedAt
    }
}
