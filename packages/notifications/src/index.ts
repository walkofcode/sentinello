import type { NotificationTarget } from '@sentinello/core'
import { sendSlack } from './slack'
import { sendTelegram } from './telegram'
import { sendWebhook } from './webhook'
import type { NotificationSender } from './types'

export * from './types'
export * from './render'
export * from './redact'
export * from './resolve'
export { sendSlack } from './slack'
export { sendTelegram } from './telegram'
export { sendWebhook } from './webhook'

// Returns the sender function matching the target's kind. A single dispatch point so callers do not
// need to know which sender module to import.
export function senderFor(target: NotificationTarget): NotificationSender {
    if (target.kind === 'slack') return sendSlack
    if (target.kind === 'telegram') return sendTelegram
    return sendWebhook
}
