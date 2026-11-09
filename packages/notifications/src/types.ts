import type { Finding, LabelledScanState, Locale, NotificationTarget, ProjectManifest, Severity, SourceCell } from '@sentinello/core'

// Structured context the webhook sender needs to build its JSON / text flavors. Slack and Telegram
// ignore it; it rides along on the shared RenderedMessage. The notifier populates it (with DB-derived
// root + the resolved advisory export) only for webhook targets, so the sender package stays DB-free.
export type WebhookPayloadContext = {
    event: 'findings' | 'scan_failure'
    isBaseline: boolean
    root: { id: string; label: string | null; path: string } | null
    // `ecosystems` and `manifests` (each { path, ecosystem, kind }) are what discovery recorded: every
    // language the project has, and every manifest it reads. Additive.
    project: { id: string; name: string; relPath: string; packageManager: string; ecosystems: string[]; manifests: ProjectManifest[] }
    findings: Finding[]
    failureSignature: string | null
    // The project's scan state as the notifier read it after recording the scan, labelled in the
    // notification locale: whether it could be scanned at all, and why not.
    scanState: LabelledScanState
    // The 'text' flavor body: the advisory export markdown (same as the portal's "Advisory export").
    advisoryText: string
}

// The silent baseline's summary as a webhook receives it (JSON flavor): which capability, and the counts the
// message states for this target, under its own scope, filters and mutes.
export type CapabilitySummaryWebhook = {
    event: 'capability_summary'
    // `since` is the release that added the capability; null, with `cells`, when an operator switched a source on.
    capability: { id: string; since: string | null; ecosystems: string[]; cells?: SourceCell[] }
    counts: { findings: number; projects: number; critical: number; sourceDisabledProjects: number }
}

// One package of one project, as the run summary and the digest list it.
export type FleetPackageLine = {
    projectId: string
    projectName: string
    packageName: string
    ecosystem: string
    severity: 'critical' | 'high'
    advisories: number
    // The fix of its worst advisory that has one; null when none has a released fix.
    topFix: { version: string; untagged: boolean } | null
}

// A package of a project with something resolved.
export type FleetResolvedLine = {
    projectId: string
    projectName: string
    packageName: string
    ecosystem: string
    advisories: number
}

export type FleetUnscannableLine = {
    projectId: string
    projectName: string
    state: 'cannot_scan' | 'partial'
    reason: string
}

// The run summary and the weekly digest as a webhook receives them (JSON flavor): the whole lists, never truncated.
export type FleetSummaryWebhook = {
    event: 'run_summary' | 'weekly_digest'
    locale: Locale
    counts: Record<Severity, number>
    listed: FleetPackageLine[]
    // The digest lists no resolved rows.
    resolved: FleetResolvedLine[]
    unscannable: FleetUnscannableLine[]
}

// The rendered shape passed to every sender. `text` is a plain text fallback;
// senders that support rich formatting may use the `markdown` field. `webhook` is present only when
// the notifier built the message for a webhook target.
export type RenderedMessage = {
    title: string
    text: string
    markdown: string
    portalUrl: string | null
    webhook?: WebhookPayloadContext | CapabilitySummaryWebhook | FleetSummaryWebhook
}

export type SendResult =
    | { ok: true }
    | { ok: false; errorText: string }

export type NotificationSender = (target: NotificationTarget, message: RenderedMessage) => Promise<SendResult>
