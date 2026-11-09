import { fixKindOf, maxSeverity, outranksSeverity, SEVERITY_ORDER, getEcosystem, type Finding, type Locale, type NotificationTargetKind, type Severity } from '@sentinello/core'
import { FLEET_SUMMARY_COPY } from './fleet-copy'
import { toTelegramHtml } from './telegram'
import type { FleetPackageLine, FleetResolvedLine, FleetSummaryWebhook, FleetUnscannableLine, RenderedMessage } from './types'

// The one message of a run summary and of a weekly digest: how the whole system is doing, not a message per project.
// Pure, like render.ts. The worker decides what it covers; this decides what fits.

export type FleetCounts = Record<Severity, number>

export type RenderFleetSummaryInput = {
    kind: 'run_summary' | 'weekly_digest'
    targetKind: NotificationTargetKind
    counts: FleetCounts
    // CRITICAL and HIGH, by project then package.
    listed: readonly FleetPackageLine[]
    resolved: readonly FleetResolvedLine[]
    unscannable: readonly FleetUnscannableLine[]
    portalBaseUrl: string | null
    locale?: Locale
}

// What a channel accepts, in the characters it counts. Telegram refuses a message over 4096 once it is HTML-escaped,
// so it is measured in that form. Slack cuts an incoming webhook's text at 40,000. A webhook is ours to read whole.
const CHARACTER_LIMIT: Record<NotificationTargetKind, number> = {
    telegram: 4096,
    slack: 40_000,
    webhook: Number.POSITIVE_INFINITY
}

function measure(targetKind: NotificationTargetKind, markdown: string): number {
    return targetKind === 'telegram' ? toTelegramHtml(markdown).length : markdown.length
}

function ecosystemLabel(ecosystem: string): string {
    return getEcosystem(ecosystem)?.displayName ?? ecosystem
}

// Rows that are one vulnerability (one advisory identity in one package of one project) count once, at their worst
// grade, as the dashboard groups them. The fallback is advisoryIdentitySql's.
function identityOf(f: Finding): string {
    return f.advisoryKey ?? f.source + ':' + f.advisoryId
}

// Findings into what the message lists and counts. `projectName` names a project for a reader.
export function summarizeFleetFindings(findings: readonly Finding[], projectName: (projectId: string) => string): { counts: FleetCounts; listed: FleetPackageLine[] } {
    const groups = new Map<string, { finding: Finding; severity: Severity; rows: Finding[] }>()
    for (const f of findings) {
        const key = [f.projectId, f.ecosystem, f.packageName, identityOf(f)].join('|')
        const group = groups.get(key)
        if (group) {
            group.severity = maxSeverity([group.severity, f.severity])
            group.rows.push(f)
        } else {
            groups.set(key, { finding: f, severity: f.severity, rows: [f] })
        }
    }
    const counts: FleetCounts = { critical: 0, high: 0, moderate: 0, unrated: 0, low: 0, info: 0 }
    const lines = new Map<string, FleetPackageLine & { fixFrom: Severity | null }>()
    for (const group of groups.values()) {
        counts[group.severity] += 1
        if (group.severity !== 'critical' && group.severity !== 'high') continue
        const f = group.finding
        const key = [f.projectId, f.ecosystem, f.packageName].join('|')
        const line = lines.get(key) ?? { projectId: f.projectId, projectName: projectName(f.projectId), packageName: f.packageName, ecosystem: f.ecosystem, severity: group.severity, advisories: 0, topFix: null, fixFrom: null }
        line.advisories += 1
        line.severity = maxSeverity([line.severity, group.severity]) as 'critical' | 'high'
        const fix = group.rows.find(function released(r) { return r.fixStatus === 'released' && r.fixVersion !== null })
        if (fix !== undefined && (line.fixFrom === null || outranksSeverity(group.severity, line.fixFrom))) {
            line.topFix = { version: fix.fixVersion as string, untagged: fixKindOf(fix) === 'untagged_commit' }
            line.fixFrom = group.severity
        }
        lines.set(key, line)
    }
    const listed = Array.from(lines.values()).map(function withoutCursor({ fixFrom: _fixFrom, ...line }) { return line })
    return { counts, listed: sortFleetLines(listed) }
}

// By project, then package: what "listed by project" reads as when each line says its project.
export function sortFleetLines<T extends { projectName: string; packageName?: string }>(lines: readonly T[]): T[] {
    return lines.slice().sort(function byProjectThenPackage(a, b) {
        return a.projectName.localeCompare(b.projectName) || (a.packageName ?? '').localeCompare(b.packageName ?? '')
    })
}

function countsText(counts: FleetCounts): string {
    return SEVERITY_ORDER.map(function one(severity) { return counts[severity] + ' ' + severity }).join(', ')
}

function packageLine(line: FleetPackageLine, locale: Locale): string {
    const copy = FLEET_SUMMARY_COPY[locale]
    const fix = line.topFix === null ? copy.noFix : line.topFix.untagged ? copy.untaggedFix(line.topFix.version) : copy.fix(line.topFix.version)
    return '• ' + line.projectName + ' › ' + line.packageName + ' (' + ecosystemLabel(line.ecosystem) + '): ' + copy.advisories(line.advisories) + ', ' + fix
}

function resolvedLine(line: FleetResolvedLine, locale: Locale): string {
    return '• ' + line.projectName + ' › ' + line.packageName + ' (' + ecosystemLabel(line.ecosystem) + '): ' + FLEET_SUMMARY_COPY[locale].advisories(line.advisories)
}

function unscannableLine(line: FleetUnscannableLine): string {
    return '• ' + line.projectName + ': ' + line.reason
}

// One titled list, whose lines past `keep` are said as a count. An empty list says nothing at all.
function section(heading: string, lines: readonly string[], keep: number, locale: Locale): string[] {
    if (lines.length === 0) return []
    const shown = lines.slice(0, keep)
    const left = lines.length - shown.length
    return ['*' + heading + '*', ...shown, ...(left > 0 ? [FLEET_SUMMARY_COPY[locale].andMore(left)] : [])]
}

export function renderFleetSummary(input: RenderFleetSummaryInput): RenderedMessage {
    const locale = input.locale ?? 'en'
    const copy = FLEET_SUMMARY_COPY[locale]
    const heading = input.kind === 'run_summary' ? copy.runSummaryTitle : copy.digestTitle
    const total = SEVERITY_ORDER.reduce(function sum(n, severity) { return n + input.counts[severity] }, 0)
    // A digest with nothing says so. A run summary with no finding is about what else it lists, and its zeros are true.
    const headline = input.kind === 'weekly_digest' && total === 0 ? copy.nothingOutstanding : countsText(input.counts)
    const title = heading + ': ' + headline
    const portalUrl = input.portalBaseUrl ? input.portalBaseUrl.replace(/\/+$/, '') : null
    const critical = input.listed.filter(function isCritical(l) { return l.severity === 'critical' }).map(function text(l) { return packageLine(l, locale) })
    const high = input.listed.filter(function isHigh(l) { return l.severity === 'high' }).map(function text(l) { return packageLine(l, locale) })
    const resolved = input.resolved.map(function text(l) { return resolvedLine(l, locale) })
    const unscannable = input.unscannable.map(unscannableLine)
    const unscannableHeading = input.kind === 'run_summary' ? copy.newlyUnscannableHeading : copy.currentlyUnscannableHeading
    function compose(keep: { resolved: number; unscannable: number; high: number; critical: number }): string {
        return [
            '*' + heading + ':* ' + headline,
            ...section('CRITICAL', critical, keep.critical, locale),
            ...section('HIGH', high, keep.high, locale),
            ...section(unscannableHeading, unscannable, keep.unscannable, locale),
            ...section(copy.resolvedHeading, resolved, keep.resolved, locale),
            ...(portalUrl ? ['*Portal:* ' + portalUrl] : [])
        ].join('\n')
    }
    const limit = CHARACTER_LIMIT[input.targetKind]
    const keep = { resolved: resolved.length, unscannable: unscannable.length, high: high.length, critical: critical.length }
    // Only lists are cut, in a fixed order, each as far as it takes before the next is touched: the counts are in
    // the line that is never cut. Keeping a line more always lengthens the message by more than the shorter count
    // it replaces can save, so the longest prefix that fits can be searched for.
    for (const list of ['resolved', 'unscannable', 'high', 'critical'] as const) {
        if (measure(input.targetKind, compose(keep)) <= limit) break
        let fits = 0
        let over = keep[list]
        while (over - fits > 1) {
            const middle = Math.floor((fits + over) / 2)
            if (measure(input.targetKind, compose({ ...keep, [list]: middle })) <= limit) fits = middle
            else over = middle
        }
        keep[list] = fits
    }
    const markdown = compose(keep)
    const webhook: FleetSummaryWebhook = {
        event: input.kind,
        locale,
        counts: input.counts,
        listed: [...input.listed],
        resolved: [...input.resolved],
        unscannable: [...input.unscannable]
    }
    return { title, text: markdown.replace(/\*/g, ''), markdown, portalUrl, webhook }
}
