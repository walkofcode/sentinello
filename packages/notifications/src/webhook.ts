import axios from 'axios'
import type { NotificationTarget, WebhookTargetConfig } from '@sentinello/core'
import { redactErrorText, redactTarget } from './redact'
import { validateWebhookUrl } from './ssrf'
import type { NotificationSender, RenderedMessage, SendResult, WebhookPayloadContext } from './types'

const REQUEST_TIMEOUT_MS = 10_000

export const sendWebhook: NotificationSender = async function sendWebhook(target, message) {
    return doSendWebhook(target, message)
}

async function doSendWebhook(target: NotificationTarget, message: RenderedMessage): Promise<SendResult> {
    const config = target.config as WebhookTargetConfig
    if (!config.url) {
        return { ok: false, errorText: 'missing webhook URL for ' + redactTarget(target) }
    }
    const validated = await validateWebhookUrl(config.url)
    if (!validated.ok) {
        return { ok: false, errorText: 'webhook URL rejected (' + validated.reason + ') for ' + redactTarget(target) }
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (config.headers) {
        for (const [k, v] of Object.entries(config.headers)) {
            headers[k] = v
        }
    }
    const flavor = config.flavor || 'json'
    const body = buildBody(flavor, message)
    try {
        await axios.post(validated.url, body, { timeout: REQUEST_TIMEOUT_MS, headers, maxRedirects: 0 })
        return { ok: true }
    } catch (err) {
        return { ok: false, errorText: redactErrorText(formatAxiosError(err)) }
    }
}

// Picks the body shape from the target's flavor. When no structured context is present (e.g. the
// operator's "Test send", which has no real scan behind it) we fall back to the simple notification
// envelope so connectivity tests still work regardless of flavor.
function buildBody(flavor: 'json' | 'text', message: RenderedMessage): unknown {
    const ctx = message.webhook
    if (!ctx) {
        return {
            title: message.title,
            text: message.text,
            markdown: message.markdown,
            portalUrl: message.portalUrl
        }
    }
    if (flavor === 'text') {
        return { text: ctx.advisoryText }
    }
    return buildJsonBody(ctx, message.portalUrl)
}

function buildJsonBody(ctx: WebhookPayloadContext, portalUrl: string | null): unknown {
    return {
        event: ctx.event,
        isBaseline: ctx.isBaseline,
        root: ctx.root,
        project: ctx.project,
        portalUrl,
        failureSignature: ctx.event === 'scan_failure' ? ctx.failureSignature : undefined,
        vulnerabilities: ctx.findings.map(function toVuln(f) {
            return {
                library: f.packageName,
                version: f.installedVersion,
                recommendedVersion: f.fixVersion,
                fixAvailable: f.fixAvailable,
                severity: f.severity,
                advisory: {
                    id: f.advisoryId,
                    title: f.advisoryTitle,
                    url: f.advisoryUrl
                },
                vulnerableRange: f.vulnerableRange,
                isProd: f.isProd,
                isDev: f.isDev,
                depPath: f.depPath
            }
        })
    }
}

function formatAxiosError(err: unknown): string {
    // Deliberately omits the response body: reflecting an internal service's reply back into the
    // persisted/displayed error would turn a blind SSRF into a readable one. Status + message only.
    if (axios.isAxiosError(err)) {
        const status = err.response && err.response.status || 'no-status'
        return 'webhook POST failed: ' + status + ' ' + (err.message || '')
    }
    if (err instanceof Error) return 'webhook POST failed: ' + err.message
    return 'webhook POST failed: ' + String(err)
}
