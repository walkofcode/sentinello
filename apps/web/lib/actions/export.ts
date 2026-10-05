'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { getConfigValue, listLibraryUsage, listScanStatesForProjects, setConfigValue } from '@sentinello/db'
import type { DepTypeFilter, ExportScanState, Severity } from '@sentinello/core'
import { getDb } from '@/lib/db'
import { run, type ActionResult } from '@/lib/actions/action-result'
import { buildProjectAdvisoryExport } from '@/lib/project-advisory-export'
import {
    buildAdvisoryMarkdown,
    buildExportFilename,
    resolveExportPrompt,
    type ExportFinding,
    type ExportScope
} from '@/lib/export-markdown'

const depTypeSchema = z.enum(['all', 'prod', 'dev'])

// Narrowed to the two fields the download button reads. This is a client-callable server action, so
// every extra field on the return value is serialized to the browser on each click.
export async function exportProjectAdvisoryMarkdownAction(
    projectId: string,
    depType: DepTypeFilter
): Promise<{ filename: string; markdown: string }> {
    const parsedDep = depTypeSchema.parse(depType)
    const result = buildProjectAdvisoryExport(getDb(), projectId, parsedDep, Date.now())
    if (!result) throw new Error('project not found: ' + projectId)
    return { filename: result.filename, markdown: result.markdown }
}

export async function exportLibraryAdvisoryMarkdownAction(
    packageName: string,
    depType: DepTypeFilter,
    ecosystem?: string
): Promise<{ filename: string; markdown: string }> {
    const parsedDep = depTypeSchema.parse(depType)
    const trimmed = packageName.trim()
    if (trimmed.length === 0) throw new Error('packageName is required')
    const db = getDb()
    const now = Date.now()
    // Scope the export to the (ecosystem, packageName) cell the detail page is showing so a same-named
    // package in another ecosystem isn't folded into the same advisory dump.
    const rows = listLibraryUsage(db, trimmed, now, parsedDep, ecosystem)
    const findings: ExportFinding[] = rows.map(function toExport(r): ExportFinding {
        return {
            packageName: trimmed,
            installedVersion: r.installedVersion,
            fixAvailable: r.fixAvailable,
            fixVersion: r.fixVersion,
            fixStatus: r.fixStatus,
            fixCheck: r.fixCheck,
            remediation: r.remediation,
            notRecheckedBecause: r.notRecheckedBecause,
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
    const markdown = buildAdvisoryMarkdown({ scope, prompt, findings, generatedAt: now, scanStates: libraryScanStates(db, rows) })
    const filename = buildExportFilename(scope, now)
    return { filename, markdown }
}

// The state of every project the export lists a finding of, and no other. A row's own annotation covers only
// its source: a partial project whose failed source is not the one reporting this library would otherwise
// lose its warning entirely.
function libraryScanStates(db: ReturnType<typeof getDb>, rows: ReturnType<typeof listLibraryUsage>): ExportScanState[] {
    const names = new Map<string, string>()
    for (const r of rows) if (!names.has(r.projectId)) names.set(r.projectId, r.projectName)
    const states = Array.from(listScanStatesForProjects(db, Array.from(names.keys())), function entry([projectId, scanState]): ExportScanState {
        return { projectName: names.get(projectId) as string, projectPath: null, scanState }
    })
    return states.sort(function byName(a, b) { return a.projectName.localeCompare(b.projectName) })
}

const promptSchema = z.string().trim().min(1, 'prompt cannot be empty').max(20000)

export async function updateExportPromptAction(prompt: string): Promise<ActionResult> {
    return await run(function body() {
        const parsed = promptSchema.parse(prompt)
        const db = getDb()
        setConfigValue(db, 'markdownExportPrompt', parsed)
        revalidatePath('/settings/export')
    })
}

// "Reset to default" — wipe the override by writing null. The resolver in export-markdown.ts treats
// null / empty as "use the built-in default", so we don't need a separate delete path.
export async function resetExportPromptAction(): Promise<void> {
    const db = getDb()
    setConfigValue(db, 'markdownExportPrompt', null)
    revalidatePath('/settings/export')
}
