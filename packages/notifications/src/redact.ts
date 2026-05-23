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

export function maskSecret(value: string): string {
    if (!value) return '**REDACTED**'
    const trimmed = value.trim()
    if (trimmed.length <= 6) return '**REDACTED**'
    const tail = trimmed.slice(-4)
    return trimmed.slice(0, 8) + '**REDACTED**' + tail
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
