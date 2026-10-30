import { describe, expect, it } from 'vitest'
import type { NotificationTarget, NotificationTargetKind } from '@sentinello/core'
import { senderFor, sendSlack, sendTelegram, sendWebhook, transportFor } from './index'
import type { RenderedMessage } from './types'

// The single dispatch point from a target to its sender. Getting it wrong would hand a target's
// config to a sender that reads different fields — a Telegram target routed to sendSlack would look
// for webhookUrl, find nothing, and report "missing webhook URL" for a perfectly valid target.

function target(kind: NotificationTargetKind): NotificationTarget {
    return {
        id: 'target-1',
        kind,
        config: {} as NotificationTarget['config'],
        severityFilter: ['critical'],
        envFilter: 'all',
        enabled: true,
        createdAt: 0,
        rootIds: [],
        projectIds: [],
        sourceScope: { mode: 'all', cells: [] }
    }
}

describe('senderFor', function () {
    it('routes a slack target to the slack sender', function () {
        expect(senderFor(target('slack'))).toBe(sendSlack)
    })

    it('routes a telegram target to the telegram sender', function () {
        expect(senderFor(target('telegram'))).toBe(sendTelegram)
    })

    it('routes a webhook target to the webhook sender', function () {
        expect(senderFor(target('webhook'))).toBe(sendWebhook)
    })

    // Webhook is the fallback rather than a throw: it is the generic HTTP sender, so an unrecognised
    // kind degrades to "POST it somewhere" instead of dropping the notification entirely.
    it('falls back to the webhook sender for an unrecognised kind', function () {
        expect(senderFor(target('something-else' as NotificationTargetKind))).toBe(sendWebhook)
    })
})

// SENTINEL-123: the live-copy verification hands the worker a recording map. A kind it does not cover must
// fail, never fall back to the real sender of that kind.
describe('transportFor', function () {
    const message: RenderedMessage = { title: 't', text: 't', markdown: 't', portalUrl: null }

    it('sends through the sender of the target\'s kind', async function () {
        const seen: string[] = []
        const send = transportFor({ slack: async function record(t) { seen.push(t.kind); return { ok: true } } })
        expect(await send(target('slack'), message)).toEqual({ ok: true })
        expect(seen).toEqual(['slack'])
    })

    it('throws for a kind the map does not hold', function () {
        expect(function send() { return transportFor({})(target('telegram'), message) }).toThrow('no sender for telegram targets in this transport')
    })
})
