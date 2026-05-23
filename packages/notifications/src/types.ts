import type { Finding, NotificationTarget } from '@sentinello/core'

// Structured context the webhook sender needs to build its JSON / text flavors. Slack and Telegram
// ignore it; it rides along on the shared RenderedMessage. The notifier populates it (with DB-derived
// root + the resolved advisory export) only for webhook targets, so the sender package stays DB-free.
export type WebhookPayloadContext = {
    event: 'findings' | 'scan_failure'
    isBaseline: boolean
    root: { id: string; label: string | null; path: string } | null
    project: { id: string; name: string; relPath: string; packageManager: string }
    findings: Finding[]
    failureSignature: string | null
    // The 'text' flavor body: the advisory export markdown (same as the portal's "Advisory export").
    advisoryText: string
}

// The rendered shape passed to every sender. `text` is a plain text fallback;
// senders that support rich formatting may use the `markdown` field. `webhook` is present only when
// the notifier built the message for a webhook target.
export type RenderedMessage = {
    title: string
    text: string
    markdown: string
    portalUrl: string | null
    webhook?: WebhookPayloadContext
}

export type SendResult =
    | { ok: true }
    | { ok: false; errorText: string }

export type NotificationSender = (target: NotificationTarget, message: RenderedMessage) => Promise<SendResult>
