import type { NotificationSender } from '@sentinello/notifications'
import { senderFor } from '@sentinello/notifications'

// The production transport: each target's real sender. The notifier and the baseline dispatcher both send
// through a `send` they are given, defaulting to this one, so a verification run can hand them a recording
// transport (transportFor over a recording map) and nothing else changes (SENTINEL-123).
export function sendByKind(target: Parameters<NotificationSender>[0], message: Parameters<NotificationSender>[1]): ReturnType<NotificationSender> {
    return senderFor(target)(target, message)
}
