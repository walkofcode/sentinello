import { describeFix, PLAIN_FIX_STYLE, reasonSide, summarizeRemediation, reasonCodeLabel, REASON_CODE_VALUES, SCAN_STATE_SIDE_SHORT, type Finding, type Locale, type NotificationEvent, type ReasonCode, type Severity } from '@sentinello/core'
import type { RenderedMessage } from './types'

const REASON_CODE_SET = new Set<string>(REASON_CODE_VALUES)

// Render the failureSignature stored on the event. New events store "status:reason_code" (e.g.
// "error:no_lockfile"); legacy events store a scrubbed errorText one-liner. We humanise the
// structured form (in the configured notification locale) and pass the legacy form through unchanged.
function humaniseFailureSignature(sig: string, locale: Locale): string {
    const code = signatureReasonCode(sig)
    return code === null ? sig : reasonCodeLabel(code, locale)
}

// The reason code a structured signature carries, or null for a legacy one-liner.
function signatureReasonCode(sig: string): ReasonCode | null {
    const parts = sig.split(':')
    if (parts.length !== 2) return null
    const code = parts[1] || ''
    if (!REASON_CODE_SET.has(code)) return null
    return code as ReasonCode
}

// Builds notification message bodies. Pure functions — render is stateless and side-effect free.

export type RenderFindingInput = {
    projectName: string
    gitBranch: string | null
    finding: Finding
    isBaseline: boolean
    portalBaseUrl: string | null
}

export type RenderBatchedFindingsInput = {
    projectName: string
    projectId: string
    gitBranch: string | null
    findings: Finding[]
    isBaseline: boolean
    portalBaseUrl: string | null
}

export type RenderScanFailureInput = {
    projectName: string
    projectId: string
    gitBranch: string | null
    event: NotificationEvent
    errorText: string | null
    portalBaseUrl: string | null
    locale?: Locale
}

// Recipients act on notifications without opening the portal, so the branch the findings came from
// belongs in the message body. Omitted entirely for non-git projects rather than rendered as "none".
function pushBranchLine(lines: string[], gitBranch: string | null): void {
    if (!gitBranch) return
    lines.push('*Branch:* ' + gitBranch)
}

const SEVERITY_LABEL: Record<Severity, string> = {
    critical: 'CRITICAL',
    high: 'HIGH',
    moderate: 'MODERATE',
    low: 'LOW',
    info: 'INFO'
}

// findings.severity is typed Severity but stored in a plain TEXT column with no CHECK constraint, and
// it is written from whatever an advisory feed said. A direct index therefore returned undefined for
// anything unexpected — including a row written before a grade was normalised — and the operator got an
// alert headed "[undefined]". Echoing the value back uppercased says what the source actually claimed,
// which is more use than a fabricated grade and can never print undefined.
function severityLabel(severity: string): string {
    const normalized = severity.trim().toLowerCase() as Severity
    return SEVERITY_LABEL[normalized] || severity.trim().toUpperCase() || SEVERITY_LABEL.moderate
}

export function renderSingleFinding(input: RenderFindingInput): RenderedMessage {
    const sev = severityLabel(input.finding.severity)
    // The same wording as the advisory export's Fix line: only a released fix reads as an upgrade.
    const fix = ' → ' + describeFix(input.finding, PLAIN_FIX_STYLE)
    const title = '[' + sev + '] ' + input.finding.packageName + '@' + input.finding.installedVersion + ' in ' + input.projectName
    const portalLink = buildProjectUrl(input.portalBaseUrl, input.finding.projectId)
    const lines: string[] = []
    lines.push(input.isBaseline && '*Baseline finding* — first scan' || '*New finding*')
    lines.push('*Project:* ' + input.projectName)
    pushBranchLine(lines, input.gitBranch)
    lines.push('*Package:* ' + input.finding.packageName + '@' + input.finding.installedVersion)
    lines.push('*Vulnerable range:* ' + input.finding.vulnerableRange)
    lines.push('*Severity:* ' + sev + fix)
    if (input.finding.fixStatus === 'none_released' && input.finding.remediation) {
        lines.push('*Way out:* ' + summarizeRemediation(input.finding.remediation, PLAIN_FIX_STYLE))
    }
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
    pushBranchLine(markdownLines, input.gitBranch)
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

// A failure whose cause is on the project's side (no lockfile, an unsupported lockfile, …) is not a scan
// that broke: the project cannot be scanned until someone changes it, and the message says so. A failure
// on this install's side (a tool missing, a database not downloaded, a timeout) keeps "[SCAN FAILED]": the
// operator's fix. A legacy signature with no reason code cannot be placed, so it keeps the old wording.
export function renderScanFailure(input: RenderScanFailureInput): RenderedMessage {
    const rawSig = input.event.failureSignature || 'unknown failure'
    const sig = humaniseFailureSignature(rawSig, input.locale || 'en')
    const code = signatureReasonCode(rawSig)
    const projectSide = code !== null && reasonSide(code) === 'project'
    const title = (projectSide ? '[CANNOT BE SCANNED] ' : '[SCAN FAILED] ') + input.projectName + ' — ' + sig
    const portalLink = buildProjectUrl(input.portalBaseUrl, input.projectId)
    const lines: string[] = []
    lines.push(projectSide ? '*Cannot be scanned:* *' + input.projectName + '*' : '*Scan failed* for *' + input.projectName + '*')
    pushBranchLine(lines, input.gitBranch)
    lines.push('*Scanner:* ' + input.event.scanner)
    lines.push((projectSide ? '*Reason:* ' : '*Failure:* ') + sig)
    if (code !== null) lines.push('*Whose fix:* ' + SCAN_STATE_SIDE_SHORT[reasonSide(code)])
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
    const sev = severityLabel(finding.severity)
    const line = '• [' + sev + '] ' + finding.packageName + '@' + finding.installedVersion + ' (' + finding.advisoryId + ') — ' + describeFix(finding, PLAIN_FIX_STYLE)
    if (finding.fixStatus !== 'none_released' || !finding.remediation) return line
    return line + '\n    Way out: ' + summarizeRemediation(finding.remediation, PLAIN_FIX_STYLE)
}

function buildProjectUrl(baseUrl: string | null, projectId: string): string | null {
    if (!baseUrl) return null
    const trimmed = baseUrl.replace(/\/+$/, '')
    return trimmed + '/projects/' + projectId
}

function stripMarkdown(input: string): string {
    return input.replace(/\*/g, '')
}
