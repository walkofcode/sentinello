import axios from 'axios'
import type { NotificationTarget, SlackTargetConfig } from '@sentinello/core'
import { redactErrorText, redactTarget } from './redact'
import { resolveSecret } from './resolve'
import type { NotificationSender, RenderedMessage, SendResult } from './types'

const REQUEST_TIMEOUT_MS = 10_000

// Slack incoming webhooks accept a simple { text } body. We send the markdown rendering, which Slack
// renders natively (basic *bold* and bullet points). We do NOT use Slack Block Kit in v1 — keeping the
// payload portable across other webhook compatibilities is more valuable than richer formatting.

export const sendSlack: NotificationSender = async function sendSlack(target, message) {
    return doSendSlack(target, message)
}

async function doSendSlack(target: NotificationTarget, message: RenderedMessage): Promise<SendResult> {
    const config = target.config as SlackTargetConfig
    const url = resolveSecret(config.webhookUrl)
    if (!url) {
        return { ok: false, errorText: 'missing webhook URL for ' + redactTarget(target) }
    }
    try {
        await axios.post(
            url,
            { text: message.markdown },
            {
                timeout: REQUEST_TIMEOUT_MS,
                headers: { 'Content-Type': 'application/json' }
            }
        )
        return { ok: true }
    } catch (err) {
        return { ok: false, errorText: redactErrorText(formatAxiosError(err)) }
    }
}

function formatAxiosError(err: unknown): string {
    if (axios.isAxiosError(err)) {
        const status = err.response && err.response.status || 'no-status'
        const body = err.response && typeof err.response.data === 'string' && err.response.data || ''
        const truncated = body.length > 200 && (body.slice(0, 200) + '…') || body
        return 'slack POST failed: ' + status + ' ' + (err.message || '') + (truncated && (' body=' + truncated) || '')
    }
    if (err instanceof Error) return 'slack POST failed: ' + err.message
    return 'slack POST failed: ' + String(err)
}
