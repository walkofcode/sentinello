import type { NotificationTarget, NotificationTargetKind } from '@sentinello/core'
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
export { sendWebhook, toWebhookVulnerability } from './webhook'

// Returns the sender function matching the target's kind. A single dispatch point so callers do not
// need to know which sender module to import.
export function senderFor(target: NotificationTarget): NotificationSender {
    if (target.kind === 'slack') return sendSlack
    if (target.kind === 'telegram') return sendTelegram
    return sendWebhook
}

// Senders by target kind, for a caller that supplies its own transport (the live-copy verification passes
// recording ones). A partial map on purpose: see transportFor.
export type NotificationSenders = Partial<Record<NotificationTargetKind, NotificationSender>>

// One sender over a map of senders by kind. A kind the map does not hold throws instead of falling back to the
// real sender of that kind: a run handed a recording map can never reach a real channel (SENTINEL-123).
export function transportFor(senders: NotificationSenders): NotificationSender {
    return function send(target, message) {
        const sender = senders[target.kind]
        if (sender === undefined) throw new Error('no sender for ' + target.kind + ' targets in this transport')
        return sender(target, message)
    }
}
