import { describe, expect, it } from 'vitest'
import type { NotificationTarget, NotificationTargetConfig } from '@sentinello/core'
import { maskSecret, redactErrorText, redactTarget } from './redact'

// Raw target config carries webhook URLs and bot tokens. These must never reach a log line or a
// persisted error string, so each assertion below checks the SECRET IS ABSENT rather than only
// checking the redacted form looks right — the absence is the property that matters.

function target(kind: NotificationTarget['kind'], config: NotificationTargetConfig): NotificationTarget {
    return {
        id: 'target-1',
        kind,
        config,
        severityFilter: [],
        envFilter: 'all',
        enabled: true,
        createdAt: 0,
        rootIds: [],
        projectIds: [],
        sourceScope: { mode: 'all', cells: [] }
    }
}

// Deliberately NOT shaped like real credentials. The redaction patterns only need "https://
// hooks.slack.com/services/" followed by anything, and 9-12 digits + ':' + a 30-char tail, so these
// fixtures exercise them fully while staying obviously synthetic — a realistic-looking fixture trips
// GitHub's push protection and reads like a leaked secret to anyone skimming the diff.
const SLACK_SECRET_TAIL = 'not-a-real-webhook-only-a-test-fixture'
const SLACK_URL = 'https://hooks.slack.com/services/' + SLACK_SECRET_TAIL
const BOT_TOKEN = '123456789:not-a-real-bot-token-only-a-test-fixture'

describe('maskSecret', function () {
    it('keeps a short head and tail of a long secret', function () {
        expect(maskSecret('abcdefghijklmnop')).toBe('abcdefgh**REDACTED**mnop')
    })

    // Anything short enough that a head+tail would expose most of it is dropped entirely.
    it.each(['', 'a', 'abcdef'])('redacts %j completely because it is too short to mask', function (value) {
        expect(maskSecret(value)).toBe('**REDACTED**')
    })

    it('masks a seven-character secret rather than dropping it', function () {
        expect(maskSecret('abcdefg')).toBe('abcdefg**REDACTED**defg')
    })

    it('trims before measuring', function () {
        expect(maskSecret('  abcdef  ')).toBe('**REDACTED**')
    })

    it('never reproduces the middle of a long secret', function () {
        expect(maskSecret(SLACK_URL)).not.toContain(SLACK_SECRET_TAIL)
    })
})

describe('redactTarget', function () {
    it('masks a slack webhook url', function () {
        const out = redactTarget(target('slack', { webhookUrl: SLACK_URL }))
        expect(out).toContain('slack(webhook=')
        expect(out).toContain('**REDACTED**')
        expect(out).not.toContain(SLACK_SECRET_TAIL)
    })

    // The chat id is not a credential and stays readable so an operator can tell targets apart; the
    // bot token is the secret and must not survive.
    it('masks a telegram bot token but keeps the chat id', function () {
        const out = redactTarget(target('telegram', { botToken: BOT_TOKEN, chatId: '-1001234567890' }))
        expect(out).toContain('chat=-1001234567890')
        expect(out).not.toContain(BOT_TOKEN)
    })

    it('masks a generic webhook url', function () {
        const out = redactTarget(target('webhook', { url: 'https://example.com/hook/s3cr3tp4thv4lue' }))
        expect(out).toContain('webhook(url=')
        expect(out).not.toContain('s3cr3tp4thv4lue')
    })
})

describe('redactErrorText', function () {
    it('redacts a slack webhook url quoted back in an error', function () {
        const out = redactErrorText('POST failed for ' + SLACK_URL + ' (503)')
        expect(out).toBe('POST failed for https://hooks.slack.com/services/**REDACTED** (503)')
    })

    it('redacts a telegram api url quoted back in an error', function () {
        const out = redactErrorText('connect ETIMEDOUT https://api.telegram.org/bot' + BOT_TOKEN + '/sendMessage')
        expect(out).not.toContain(BOT_TOKEN)
        expect(out).toContain('https://api.telegram.org/bot**REDACTED**')
    })

    // A bare token with no surrounding URL — the shape alone (digits, colon, long tail) is enough.
    it('redacts a bare bot token anywhere in the text', function () {
        const out = redactErrorText('unauthorized for ' + BOT_TOKEN + ' retrying')
        expect(out).toBe('unauthorized for **REDACTED** retrying')
    })

    it('redacts several occurrences, not just the first', function () {
        const out = redactErrorText(SLACK_URL + ' and ' + SLACK_URL)
        expect(out).not.toContain(SLACK_SECRET_TAIL)
        expect(out.match(/\*\*REDACTED\*\*/g)).toHaveLength(2)
    })

    it('leaves text with no secrets untouched', function () {
        expect(redactErrorText('ECONNREFUSED after 3 attempts')).toBe('ECONNREFUSED after 3 attempts')
    })

    it('returns empty text unchanged', function () {
        expect(redactErrorText('')).toBe('')
    })
})
