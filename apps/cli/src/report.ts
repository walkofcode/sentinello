import { readFile } from 'node:fs/promises'
import {
    DEFAULT_EXPORT_PROMPT,
    buildAdvisoryMarkdown,
    buildExportFilename,
    isSourceUnavailableReason,
    meetsSeverityFloor,
    type ExportFinding,
    type ExportScope,
    type Severity
} from '@sentinello/core'
import type { RawFinding } from '@sentinello/scanners'
import type { CliOptions, DepTypeFilter } from './options'
import type { ProjectScanResult } from './scan'

// Turns scan results into the two things a run produces: the advisory markdown (the artifact a developer
// or agent acts on) and the counts the terminal summary renders. The markdown itself is built by
// @sentinello/core, the same renderer the portal's Export button uses — the CLI supplies a workspace scope
// so one document covers every project found.

export type SeverityCounts = Record<Severity, number>

export type ProjectSummary = {
    name: string
    relPath: string
    findingCount: number
    counts: SeverityCounts
    // Scanners that could not answer for this project, with the reason. Surfaced so "0 findings" is never
    // confused with "nothing could be checked".
    unauditable: { scanner: string; reasonCode: string; errorText: string | null }[]
}

export type RunSummary = {
    projects: ProjectSummary[]
    totalFindings: number
    counts: SeverityCounts
    findings: ExportFinding[]
}

function emptyCounts(): SeverityCounts {
    return { critical: 0, high: 0, moderate: 0, low: 0, info: 0 }
}

function matchesDepType(finding: RawFinding, depType: DepTypeFilter): boolean {
    if (depType === 'all') return true
    if (depType === 'prod') return finding.isProd
    return finding.isDev
}

// Builds the run summary, applying the dep-type and severity filters. Filtering happens here rather than
// during scanning so the scan itself is always complete — a narrower report never means a narrower scan.
export function summarize(results: readonly ProjectScanResult[], options: CliOptions): RunSummary {
    const projects: ProjectSummary[] = []
    const findings: ExportFinding[] = []
    const total = emptyCounts()
    let totalFindings = 0
    for (const result of results) {
        const counts = emptyCounts()
        let projectFindings = 0
        for (const finding of result.findings) {
            if (!matchesDepType(finding, options.depType)) continue
            if (!meetsSeverityFloor(finding.severity, options.minSeverity)) continue
            counts[finding.severity]++
            total[finding.severity]++
            projectFindings++
            totalFindings++
            findings.push({
                packageName: finding.packageName,
                installedVersion: finding.installedVersion,
                fixAvailable: finding.fixAvailable,
                fixVersion: finding.fixVersion,
                severity: finding.severity,
                advisoryId: finding.advisoryId,
                advisoryTitle: finding.advisoryTitle,
                advisoryUrl: finding.advisoryUrl,
                vulnerableRange: finding.vulnerableRange,
                isProd: finding.isProd,
                isDev: finding.isDev,
                depPath: finding.depPath,
                // Every finding carries its project, so a single severity-ordered document stays
                // unambiguous about which project each one belongs to.
                projectName: result.project.relPath === '.' ? result.project.name : result.project.relPath
            })
        }
        projects.push({
            name: result.project.name,
            relPath: result.project.relPath,
            findingCount: projectFindings,
            counts,
            unauditable: result.outcomes
                .filter(function notOk(o): boolean {
                    return o.status !== 'ok'
                })
                .map(function toEntry(o) {
                    return { scanner: o.scanner, reasonCode: o.reasonCode, errorText: o.errorText }
                })
        })
    }
    return { projects, totalFindings, counts: total, findings }
}

// Resolves the remediation prompt: a file when one was given, the built-in default otherwise, or nothing
// when the caller asked for findings alone.
export async function resolvePrompt(options: CliOptions): Promise<string> {
    if (!options.includePrompt) return ''
    if (!options.promptPath) return DEFAULT_EXPORT_PROMPT
    return await readFile(options.promptPath, 'utf8')
}

export function buildScope(options: CliOptions, projectCount: number): ExportScope {
    return {
        kind: 'workspace',
        rootPath: options.rootPath,
        projectCount,
        depType: options.depType
    }
}

export function renderMarkdown(summary: RunSummary, options: CliOptions, prompt: string, generatedAt: number): string {
    return buildAdvisoryMarkdown({
        scope: buildScope(options, summary.projects.length),
        prompt,
        findings: summary.findings,
        generatedAt
    })
}

export function defaultOutputFilename(options: CliOptions, generatedAt: number): string {
    return buildExportFilename(buildScope(options, 0), generatedAt)
}

// Machine-readable output for CI and scripting. Deliberately a flat findings array plus per-project
// counts, so `jq` can answer both "what broke" and "where" without walking a nested structure.
export function renderJson(summary: RunSummary, options: CliOptions, generatedAt: number): string {
    return JSON.stringify({
        generatedAt: new Date(generatedAt).toISOString(),
        root: options.rootPath,
        depType: options.depType,
        minSeverity: options.minSeverity,
        totals: summary.counts,
        totalFindings: summary.totalFindings,
        projects: summary.projects.map(function toJson(p) {
            return {
                name: p.name,
                path: p.relPath,
                findingCount: p.findingCount,
                counts: p.counts,
                unauditable: p.unauditable
            }
        }),
        findings: summary.findings
    }, null, 2) + '\n'
}

// Whether any project's scan lost an advisory source entirely — the cache was never downloaded, or could
// not be opened. Distinct from shouldFail: this is not "we found something", it is "we could not look".
//
// Only meaningful under a gate. `sentinello` with no --fail-on is a report, and a report is allowed to
// say a source was unavailable and carry on; the outcomes are already printed and land in the advisory.
// Under --fail-on the caller has asked a yes/no question, and zero findings from a source that never
// answered is not a no.
export function hasUnavailableSource(summary: RunSummary): boolean {
    return summary.projects.some(function projectLostASource(project): boolean {
        return project.unauditable.some(function lost(entry): boolean {
            return isSourceUnavailableReason(entry.reasonCode)
        })
    })
}

// Whether the run should exit non-zero, given --fail-on. Findings alone are a report, not a failure: the
// gate only applies when the caller explicitly asked for one.
export function shouldFail(summary: RunSummary, failOn: CliOptions['failOn']): boolean {
    if (failOn === 'none') return false
    if (failOn === 'any') return summary.totalFindings > 0
    for (const severity of Object.keys(summary.counts) as Severity[]) {
        if (summary.counts[severity] > 0 && meetsSeverityFloor(severity, failOn)) return true
    }
    return false
}
