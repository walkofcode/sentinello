import axios from 'axios'
import type { NotificationTarget, WebhookTargetConfig } from '@sentinello/core'
import { redactErrorText, redactTarget } from './redact'
import { resolveSecret } from './resolve'
import type { NotificationSender, RenderedMessage, SendResult, WebhookPayloadContext } from './types'

const REQUEST_TIMEOUT_MS = 10_000

export const sendWebhook: NotificationSender = async function sendWebhook(target, message) {
    return doSendWebhook(target, message)
}

async function doSendWebhook(target: NotificationTarget, message: RenderedMessage): Promise<SendResult> {
    const config = target.config as WebhookTargetConfig
    const url = resolveSecret(config.url)
    if (!url) {
        return { ok: false, errorText: 'missing webhook URL for ' + redactTarget(target) }
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (config.headers) {
        for (const [k, v] of Object.entries(config.headers)) {
            headers[k] = resolveSecret(v)
        }
    }
    const flavor = config.flavor || 'json'
    const body = buildBody(flavor, message)
    try {
        await axios.post(url, body, { timeout: REQUEST_TIMEOUT_MS, headers })
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
    if (axios.isAxiosError(err)) {
        const status = err.response && err.response.status || 'no-status'
        const data = err.response && err.response.data
        const dataText = typeof data === 'string' && data || data && JSON.stringify(data) || ''
        const truncated = dataText.length > 200 && (dataText.slice(0, 200) + '…') || dataText
        return 'webhook POST failed: ' + status + ' ' + (err.message || '') + (truncated && (' body=' + truncated) || '')
    }
    if (err instanceof Error) return 'webhook POST failed: ' + err.message
    return 'webhook POST failed: ' + String(err)
}
