import type { NotificationTarget, NotificationTargetConfig, SlackTargetConfig, TelegramTargetConfig, WebhookTargetConfig } from '@sentinello/core'

// Returns a safe-for-logs representation of a NotificationTarget. Raw config_json (which contains
// webhook URLs, bot tokens, chat ids) must NEVER appear in log lines or persisted error text.

export function redactTarget(target: NotificationTarget): string {
    if (target.kind === 'slack') {
        return 'slack(webhook=' + maskSecret(asSlack(target.config).webhookUrl) + ')'
    }
    if (target.kind === 'telegram') {
        const tg = asTelegram(target.config)
        return 'telegram(bot=' + maskSecret(tg.botToken) + ', chat=' + tg.chatId + ')'
    }
    return 'webhook(url=' + maskSecret(asWebhook(target.config).url) + ')'
}

// Best-effort redaction of an arbitrary error message: strip anything that looks like a URL containing
// hooks.slack.com, api.telegram.org, or generic bot tokens. Used when a sender's exception message
// might quote back a raw URL we sent.
export function redactErrorText(text: string): string {
    let out = text
    out = out.replace(/https:\/\/hooks\.slack\.com\/services\/[^\s"']+/g, 'https://hooks.slack.com/services/**REDACTED**')
    out = out.replace(/https:\/\/api\.telegram\.org\/bot[^\s"'/]+/g, 'https://api.telegram.org/bot**REDACTED**')
    out = out.replace(/\b\d{9,12}:[A-Za-z0-9_-]{30,}\b/g, '**REDACTED**')
    return out
}

const HEAD = 8
const TAIL = 4
// How many characters the mask must actually hide before masking is worth preferring to dropping the
// value outright. The guard used to be `length <= 6` while the head sliced 8 and the tail 4, so it only
// checked the value was longer than the tail and never that the two halves did not meet: every secret
// of 7 to 12 characters was reprinted in full — 'abcdefg' came back as 'abcdefg**REDACTED**defg' — and
// a 13-character one gave up all but a single character. Requiring a real gap is what makes the
// function's name true; below it, redacting entirely is the only honest answer.
const MIN_HIDDEN = 8

export function maskSecret(value: string): string {
    if (!value) return '**REDACTED**'
    const trimmed = value.trim()
    if (trimmed.length < HEAD + TAIL + MIN_HIDDEN) return '**REDACTED**'
    return trimmed.slice(0, HEAD) + '**REDACTED**' + trimmed.slice(-TAIL)
}

function asSlack(config: NotificationTargetConfig): SlackTargetConfig {
    return config as SlackTargetConfig
}

function asTelegram(config: NotificationTargetConfig): TelegramTargetConfig {
    return config as TelegramTargetConfig
}

function asWebhook(config: NotificationTargetConfig): WebhookTargetConfig {
    return config as WebhookTargetConfig
}
