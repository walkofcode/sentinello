import { beforeEach, describe, expect, it, vi } from 'vitest'
import axios from 'axios'
import type { NotificationTarget } from '@sentinello/core'
import { sendSlack } from './slack'
import type { RenderedMessage } from './types'

// Slack's incoming-webhook URL IS the credential — anyone holding it can post to the channel. So the
// two things worth pinning are that the URL can be stored as an env: reference rather than in the
// database, and that it never survives into an error string that gets persisted and shown in the UI.
//
// The fixture URL below is deliberately not shaped like a real Slack webhook (real ones are
// T________/B________/ plus a 24-char secret): a realistic-looking one would trip secret scanning
// on push even though it is fabricated.

vi.mock('axios', function mockAxios() {
    return {
        default: {
            post: vi.fn(),
            isAxiosError: vi.fn(function notAxiosError() {
                return false
            })
        }
    }
})

const post = vi.mocked(axios.post)
const isAxiosError = vi.mocked(axios.isAxiosError)

const HOOK_URL = 'https://hooks.slack.com/services/not-a-real-webhook'

function target(config: Record<string, unknown> = {}): NotificationTarget {
    return {
        id: 'target-1',
        kind: 'slack',
        config: { webhookUrl: HOOK_URL, ...config } as NotificationTarget['config'],
        severityFilter: ['critical', 'high'],
        envFilter: 'all',
        enabled: true,
        createdAt: 0,
        rootIds: [],
        projectIds: [],
        sourceScope: { mode: 'all', cells: [] }
    }
}

function message(overrides: Partial<RenderedMessage> = {}): RenderedMessage {
    return {
        title: 'New vulnerabilities in app',
        text: 'plain text body',
        markdown: '*app* has 2 new vulnerabilities',
        portalUrl: 'https://portal.example.test/projects/project-1',
        ...overrides
    }
}

beforeEach(function resetMocks() {
    vi.clearAllMocks()
    isAxiosError.mockReturnValue(false)
    post.mockResolvedValue({ status: 200, data: 'ok' })
})

describe('sendSlack', function () {
    it('posts the markdown rendering, which Slack formats natively', async function () {
        const result = await sendSlack(target(), message())
        expect(result).toEqual({ ok: true })
        expect(post.mock.calls[0]?.[0]).toBe(HOOK_URL)
        expect(post.mock.calls[0]?.[1]).toEqual({ text: '*app* has 2 new vulnerabilities' })
    })

    it('bounds the request with a timeout', async function () {
        await sendSlack(target(), message())
        const config = post.mock.calls[0]?.[2] as { timeout?: number }
        expect(config.timeout).toBeGreaterThan(0)
    })

    it('fails without posting when no webhook URL is configured', async function () {
        const result = await sendSlack(target({ webhookUrl: '' }), message())
        expect(result.ok).toBe(false)
        expect(post).not.toHaveBeenCalled()
    })

    // Storing the URL as env:NAME keeps the credential out of the database entirely.
    it('resolves an env: reference to the real URL', async function () {
        process.env.TEST_SLACK_HOOK = HOOK_URL
        try {
            await sendSlack(target({ webhookUrl: 'env:TEST_SLACK_HOOK' }), message())
            expect(post.mock.calls[0]?.[0]).toBe(HOOK_URL)
        } finally {
            delete process.env.TEST_SLACK_HOOK
        }
    })

    // An env: reference pointing at an unset variable resolves to empty, which must read as
    // "not configured" rather than posting to a bare or malformed URL.
    it('treats an unresolvable env: reference as missing', async function () {
        delete process.env.TEST_SLACK_MISSING
        const result = await sendSlack(target({ webhookUrl: 'env:TEST_SLACK_MISSING' }), message())
        expect(result.ok).toBe(false)
        expect(post).not.toHaveBeenCalled()
    })
})

describe('sendSlack — failures', function () {
    // The failing URL is the credential, and this error text gets persisted and rendered in the
    // portal's delivery log.
    it('redacts the webhook URL out of the error text', async function () {
        isAxiosError.mockReturnValue(true)
        post.mockRejectedValue({
            isAxiosError: true,
            message: 'Request failed for ' + HOOK_URL,
            response: { status: 404, data: 'no_service' }
        })
        const result = await sendSlack(target(), message())
        expect(result.ok).toBe(false)
        expect(result.ok === false && result.errorText).not.toContain('not-a-real-webhook')
        expect(result.ok === false && result.errorText).toContain('REDACTED')
    })

    it('reports the status and body Slack returned', async function () {
        isAxiosError.mockReturnValue(true)
        post.mockRejectedValue({
            isAxiosError: true,
            message: 'Request failed with status code 400',
            response: { status: 400, data: 'invalid_payload' }
        })
        const result = await sendSlack(target(), message())
        expect(result.ok === false && result.errorText).toContain('400')
        expect(result.ok === false && result.errorText).toContain('invalid_payload')
    })

    it('truncates a long response body', async function () {
        isAxiosError.mockReturnValue(true)
        post.mockRejectedValue({
            isAxiosError: true,
            message: 'failed',
            response: { status: 500, data: 'x'.repeat(500) }
        })
        const result = await sendSlack(target(), message())
        const text = result.ok === false ? result.errorText : ''
        expect(text).toContain('…')
        expect(text.length).toBeLessThan(400)
    })

    it('describes a transport failure that carried no response', async function () {
        isAxiosError.mockReturnValue(true)
        post.mockRejectedValue({ isAxiosError: true, message: 'connect ETIMEDOUT' })
        const result = await sendSlack(target(), message())
        expect(result.ok === false && result.errorText).toContain('no-status')
    })

    it('handles a plain Error', async function () {
        post.mockRejectedValue(new Error('boom'))
        const result = await sendSlack(target(), message())
        expect(result.ok === false && result.errorText).toContain('boom')
    })

    it('handles a thrown non-Error', async function () {
        post.mockRejectedValue('just a string')
        const result = await sendSlack(target(), message())
        expect(result.ok === false && result.errorText).toContain('just a string')
    })
})
