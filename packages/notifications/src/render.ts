import { reasonCodeLabel, REASON_CODE_VALUES, type Finding, type Locale, type NotificationEvent, type ReasonCode, type Severity } from '@sentinello/core'
import type { RenderedMessage } from './types'

const REASON_CODE_SET = new Set<string>(REASON_CODE_VALUES)

// Render the failureSignature stored on the event. New events store "status:reason_code" (e.g.
// "error:no_lockfile"); legacy events store a scrubbed errorText one-liner. We humanise the
// structured form (in the configured notification locale) and pass the legacy form through unchanged.
function humaniseFailureSignature(sig: string, locale: Locale): string {
    const parts = sig.split(':')
    if (parts.length !== 2) return sig
    const code = parts[1] || ''
    if (!REASON_CODE_SET.has(code)) return sig
    return reasonCodeLabel(code as ReasonCode, locale)
}

// Builds notification message bodies. Pure functions — render is stateless and side-effect free.

export type RenderFindingInput = {
    projectName: string
    finding: Finding
    isBaseline: boolean
    portalBaseUrl: string | null
}

export type RenderBatchedFindingsInput = {
    projectName: string
    projectId: string
    findings: Finding[]
    isBaseline: boolean
    portalBaseUrl: string | null
}

export type RenderScanFailureInput = {
    projectName: string
    projectId: string
    event: NotificationEvent
    errorText: string | null
    portalBaseUrl: string | null
    locale?: Locale
}

const SEVERITY_LABEL: Record<Severity, string> = {
    critical: 'CRITICAL',
    high: 'HIGH',
    moderate: 'MODERATE',
    low: 'LOW',
    info: 'INFO'
}

export function renderSingleFinding(input: RenderFindingInput): RenderedMessage {
    const sev = SEVERITY_LABEL[input.finding.severity]
    const fix = input.finding.fixAvailable && input.finding.fixVersion && (' → fix: ' + input.finding.fixVersion) || (input.finding.fixAvailable && ' → fix available' || ' → no fix available')
    const title = '[' + sev + '] ' + input.finding.packageName + '@' + input.finding.installedVersion + ' in ' + input.projectName
    const portalLink = buildProjectUrl(input.portalBaseUrl, input.finding.projectId)
    const lines: string[] = []
    lines.push(input.isBaseline && '*Baseline finding* — first scan' || '*New finding*')
    lines.push('*Project:* ' + input.projectName)
    lines.push('*Package:* ' + input.finding.packageName + '@' + input.finding.installedVersion)
    lines.push('*Vulnerable range:* ' + input.finding.vulnerableRange)
    lines.push('*Severity:* ' + sev + fix)
    if (input.finding.advisoryTitle) {
        lines.push('*Advisory:* ' + input.finding.advisoryTitle)
    }
    if (input.finding.advisoryUrl) {
        lines.push('*Advisory URL:* ' + input.finding.advisoryUrl)
    }
    if (portalLink) {
        lines.push('*Portal:* ' + portalLink)
    }
    const markdown = lines.join('\n')
    const text = title + '\n' + (input.finding.advisoryUrl || '') + (portalLink && (' | ' + portalLink) || '')
    return {
        title,
        text,
        markdown,
        portalUrl: portalLink
    }
}

export function renderBatchedFindings(input: RenderBatchedFindingsInput): RenderedMessage {
    const headline = 'Sentinello found vulnerabilities in *' + input.projectName + '*:'
    const portalLink = buildProjectUrl(input.portalBaseUrl, input.projectId)
    const top = input.findings.slice(0, 8).map(formatLine).join('\n')
    const more = input.findings.length > 8 && ('\n…and ' + (input.findings.length - 8) + ' more') || ''
    const markdownLines: string[] = []
    markdownLines.push(headline)
    markdownLines.push(top + more)
    if (portalLink) {
        markdownLines.push('')
        markdownLines.push('Portal: ' + portalLink)
    }
    const markdown = markdownLines.join('\n')
    const text = stripMarkdown(markdown)
    return {
        title: stripMarkdown(headline),
        text,
        markdown,
        portalUrl: portalLink
    }
}

export function renderScanFailure(input: RenderScanFailureInput): RenderedMessage {
    const rawSig = input.event.failureSignature || 'unknown failure'
    const sig = humaniseFailureSignature(rawSig, input.locale || 'en')
    const title = '[SCAN FAILED] ' + input.projectName + ' — ' + sig
    const portalLink = buildProjectUrl(input.portalBaseUrl, input.projectId)
    const lines: string[] = []
    lines.push('*Scan failed* for *' + input.projectName + '*')
    lines.push('*Scanner:* ' + input.event.scanner)
    lines.push('*Failure:* ' + sig)
    if (input.errorText) {
        lines.push('*Error:* ' + input.errorText)
    }
    if (portalLink) {
        lines.push('*Portal:* ' + portalLink)
    }
    const markdown = lines.join('\n')
    return {
        title,
        text: stripMarkdown(markdown),
        markdown,
        portalUrl: portalLink
    }
}

function formatLine(finding: Finding): string {
    const sev = SEVERITY_LABEL[finding.severity]
    return '• [' + sev + '] ' + finding.packageName + '@' + finding.installedVersion + ' (' + finding.advisoryId + ')'
}

function buildProjectUrl(baseUrl: string | null, projectId: string): string | null {
    if (!baseUrl) return null
    const trimmed = baseUrl.replace(/\/+$/, '')
    return trimmed + '/projects/' + projectId
}

function stripMarkdown(input: string): string {
    return input.replace(/\*/g, '')
}
