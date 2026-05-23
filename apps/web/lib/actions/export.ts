'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import {
    getConfigValue,
    getProjectById,
    getRootById,
    listCurrentFindingsForProject,
    listLibraryUsage,
    setConfigValue
} from '@sentinello/db'
import type { DepTypeFilter, Severity } from '@sentinello/core'
import { getDb } from '@/lib/db'
import {
    buildAdvisoryMarkdown,
    buildExportFilename,
    resolveExportPrompt,
    type ExportFinding,
    type ExportScope
} from '@/lib/export-markdown'

const depTypeSchema = z.enum(['all', 'prod', 'dev'])

// Helper: parse the JSON-encoded depPath that the project finding query returns as a string.
// Library usage rows don't include dep path, so this is only called on the project path.
function parseDepPath(json: string): string[] {
    try {
        const parsed = JSON.parse(json)
        if (Array.isArray(parsed)) return parsed.filter(function isString(v): v is string { return typeof v === 'string' })
        return []
    } catch {
        return []
    }
}

export async function exportProjectAdvisoryMarkdownAction(
    projectId: string,
    depType: DepTypeFilter
): Promise<{ filename: string; markdown: string }> {
    const parsedDep = depTypeSchema.parse(depType)
    const db = getDb()
    const project = getProjectById(db, projectId)
    if (!project) throw new Error('project not found: ' + projectId)
    const root = getRootById(db, project.rootId)
    const now = Date.now()
    const rows = listCurrentFindingsForProject(db, project.id, now, parsedDep)
    const findings: ExportFinding[] = rows.map(function toExport(r): ExportFinding {
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
            depPath: parseDepPath(r.depPathJson)
        }
    })
    const displayName = project.alias || project.name
    const rootLabel = root?.label || root?.path || 'unknown root'
    const projectPath = project.relPath === '.' ? rootLabel : rootLabel + '/' + project.relPath
    const scope: ExportScope = {
        kind: 'project',
        projectName: displayName,
        projectPath,
        depType: parsedDep
    }
    const prompt = resolveExportPrompt(getConfigValue<string>(db, 'markdownExportPrompt'))
    const markdown = buildAdvisoryMarkdown({ scope, prompt, findings, generatedAt: now })
    const filename = buildExportFilename(scope, now)
    return { filename, markdown }
}

export async function exportLibraryAdvisoryMarkdownAction(
    packageName: string,
    depType: DepTypeFilter
): Promise<{ filename: string; markdown: string }> {
    const parsedDep = depTypeSchema.parse(depType)
    const trimmed = packageName.trim()
    if (trimmed.length === 0) throw new Error('packageName is required')
    const db = getDb()
    const now = Date.now()
    const rows = listLibraryUsage(db, trimmed, now, parsedDep)
    const findings: ExportFinding[] = rows.map(function toExport(r): ExportFinding {
        return {
            packageName: trimmed,
            installedVersion: r.installedVersion,
            // Library usage rows don't carry fix metadata in the current query — the dep path and
            // fix version columns aren't selected. Mark fixAvailable=false / fixVersion=null so the
            // formatter renders the "check the advisory" guidance instead of inventing a target.
            fixAvailable: false,
            fixVersion: null,
            severity: r.severity as Severity,
            advisoryId: r.advisoryId,
            advisoryTitle: r.advisoryTitle,
            advisoryUrl: r.advisoryUrl,
            vulnerableRange: r.vulnerableRange,
            isProd: r.isProd,
            isDev: r.isDev,
            depPath: [],
            projectName: r.projectName
        }
    })
    const scope: ExportScope = {
        kind: 'library',
        packageName: trimmed,
        depType: parsedDep
    }
    const prompt = resolveExportPrompt(getConfigValue<string>(db, 'markdownExportPrompt'))
    const markdown = buildAdvisoryMarkdown({ scope, prompt, findings, generatedAt: now })
    const filename = buildExportFilename(scope, now)
    return { filename, markdown }
}

const promptSchema = z.string().trim().min(1, 'prompt cannot be empty').max(20000)

export async function updateExportPromptAction(prompt: string): Promise<void> {
    const parsed = promptSchema.parse(prompt)
    const db = getDb()
    setConfigValue(db, 'markdownExportPrompt', parsed)
    revalidatePath('/settings/export')
}

// "Reset to default" — wipe the override by writing null. The resolver in export-markdown.ts treats
// null / empty as "use the built-in default", so we don't need a separate delete path.
export async function resetExportPromptAction(): Promise<void> {
    const db = getDb()
    setConfigValue(db, 'markdownExportPrompt', null)
    revalidatePath('/settings/export')
}
