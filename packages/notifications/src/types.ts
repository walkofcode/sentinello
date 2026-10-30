import type { Finding, LabelledScanState, NotificationTarget, ProjectManifest } from '@sentinello/core'

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
    capability: { id: string; since: string; ecosystems: string[] }
    counts: { findings: number; projects: number; critical: number; sourceDisabledProjects: number }
}

// The rendered shape passed to every sender. `text` is a plain text fallback;
// senders that support rich formatting may use the `markdown` field. `webhook` is present only when
// the notifier built the message for a webhook target.
export type RenderedMessage = {
    title: string
    text: string
    markdown: string
    portalUrl: string | null
    webhook?: WebhookPayloadContext | CapabilitySummaryWebhook
}

export type SendResult =
    | { ok: true }
    | { ok: false; errorText: string }

export type NotificationSender = (target: NotificationTarget, message: RenderedMessage) => Promise<SendResult>
