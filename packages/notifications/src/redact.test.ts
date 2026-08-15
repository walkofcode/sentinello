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

// Mirrors MIN_HIDDEN in redact.ts. Restated rather than exported: the constant is an implementation
// choice, but "at least this many characters never appear in the output" is the contract, and a test
// that imported the value would agree with the implementation even after someone lowered it to zero.
const MIN_HIDDEN_CHARS = 8

describe('maskSecret', function () {
    it('keeps a short head and tail of a long secret', function () {
        expect(maskSecret('abcdefghijklmnopqrstuvwx')).toBe('abcdefgh**REDACTED**uvwx')
    })

    // Anything short enough that an 8-character head and a 4-character tail would meet is dropped
    // entirely. 'abcdefg' is the case that used to come back as 'abcdefg**REDACTED**defg' — the whole
    // secret, printed, with four of its characters repeated for good measure.
    it.each(['', 'a', 'abcdef', 'abcdefg', 'abcdefghijkl', 'abcdefghijklm'])(
        'redacts %j completely because it is too short to mask',
        function (value) {
            expect(maskSecret(value)).toBe('**REDACTED**')
        }
    )

    // The boundary itself, pinned from both sides: one character short of the threshold must not leak.
    it('drops a secret one character below the masking threshold', function () {
        expect(maskSecret('a'.repeat(19))).toBe('**REDACTED**')
    })

    it('masks at the threshold, hiding at least eight characters', function () {
        const masked = maskSecret('abcdefghijklmnopqrst')
        expect(masked).toBe('abcdefgh**REDACTED**qrst')
        expect(masked).not.toContain('ijklmnop')
    })

    // The property the whole function exists for, stated directly rather than by example: whatever it
    // returns must never let the original be reassembled from the head and tail it kept.
    it.each([7, 12, 13, 19, 20, 40, 96])('never reveals every character of a %i-character secret', function (length) {
        const secret = Array.from({ length }, function char(_unused, i) {
            return String.fromCharCode(97 + (i % 26))
        }).join('')
        const masked = maskSecret(secret)
        expect(masked).not.toContain(secret)
        const revealed = masked.replace(/\*\*REDACTED\*\*/g, '').length
        expect(revealed).toBeLessThanOrEqual(Math.max(0, secret.length - MIN_HIDDEN_CHARS))
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
