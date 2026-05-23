import axios from 'axios'
import type { NotificationTarget, TelegramTargetConfig } from '@sentinello/core'
import { redactErrorText, redactTarget } from './redact'
import { resolveSecret } from './resolve'
import type { NotificationSender, RenderedMessage, SendResult } from './types'

const REQUEST_TIMEOUT_MS = 10_000

export const sendTelegram: NotificationSender = async function sendTelegram(target, message) {
    return doSendTelegram(target, message)
}

async function doSendTelegram(target: NotificationTarget, message: RenderedMessage): Promise<SendResult> {
    const config = target.config as TelegramTargetConfig
    const botToken = resolveSecret(config.botToken)
    const chatId = resolveSecret(config.chatId)
    if (!botToken || !chatId) {
        return { ok: false, errorText: 'missing botToken or chatId for ' + redactTarget(target) }
    }
    const url = 'https://api.telegram.org/bot' + botToken + '/sendMessage'
    try {
        await axios.post(
            url,
            {
                chat_id: chatId,
                text: toTelegramHtml(message.markdown),
                parse_mode: 'HTML',
                disable_web_page_preview: true
            },
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

// Telegram's MarkdownV2 mode requires escaping ~18 special characters even when they are NOT
// formatting — a single stray '.' or '-' in a package name or URL rejects the whole message. The
// old code escaped everything including our own '*' bold markers, so bold rendered as literal
// asterisks. HTML mode is far less brittle: only '&', '<', '>' need escaping. We escape those, then
// convert our markdown '*bold*' spans to '<b>bold</b>'. Everything else (URLs, dots, dashes) is
// passed through untouched and renders correctly.
function toTelegramHtml(input: string): string {
    const escaped = input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    return escaped.replace(/\*([^*\n]+)\*/g, '<b>$1</b>')
}

function formatAxiosError(err: unknown): string {
    if (axios.isAxiosError(err)) {
        const status = err.response && err.response.status || 'no-status'
        const data = err.response && err.response.data
        const dataText = typeof data === 'string' && data || data && JSON.stringify(data) || ''
        const truncated = dataText.length > 200 && (dataText.slice(0, 200) + '…') || dataText
        return 'telegram POST failed: ' + status + ' ' + (err.message || '') + (truncated && (' body=' + truncated) || '')
    }
    if (err instanceof Error) return 'telegram POST failed: ' + err.message
    return 'telegram POST failed: ' + String(err)
}
