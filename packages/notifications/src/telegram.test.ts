import { beforeEach, describe, expect, it, vi } from 'vitest'
import axios from 'axios'
import type { NotificationTarget } from '@sentinello/core'
import { sendTelegram } from './telegram'
import type { RenderedMessage } from './types'

// Two concerns here. The bot token is a credential that travels in the URL path, so it must be
// resolvable from the environment and must never survive into a persisted error string.
//
// The other is formatting. Telegram's MarkdownV2 mode requires escaping ~18 characters even when
// they are not formatting, so a single '.' or '-' in a package name or URL rejects the entire
// message — meaning a real vulnerability notification silently fails to arrive. This sender uses
// HTML mode instead, and these cases pin that a message full of dots and dashes still goes out.
//
// The fixture token is deliberately not shaped like a real one (real tokens are 9-12 digits, a
// colon, then 35 URL-safe characters): a realistic-looking fixture would trip secret scanning on
// push even though it is fabricated.

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

const BOT_TOKEN = 'not-a-real-bot-token'
const CHAT_ID = '-100200300'

function target(config: Record<string, unknown> = {}): NotificationTarget {
    return {
        id: 'target-1',
        kind: 'telegram',
        config: { botToken: BOT_TOKEN, chatId: CHAT_ID, ...config } as NotificationTarget['config'],
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

function sentBody(): Record<string, unknown> {
    return post.mock.calls[0]?.[1] as Record<string, unknown>
}

beforeEach(function resetMocks() {
    vi.clearAllMocks()
    isAxiosError.mockReturnValue(false)
    post.mockResolvedValue({ status: 200, data: { ok: true } })
})

describe('sendTelegram — request', function () {
    it('posts sendMessage for the configured bot and chat', async function () {
        const result = await sendTelegram(target(), message())
        expect(result).toEqual({ ok: true })
        expect(post.mock.calls[0]?.[0]).toBe('https://api.telegram.org/bot' + BOT_TOKEN + '/sendMessage')
        expect(sentBody().chat_id).toBe(CHAT_ID)
    })

    it('asks Telegram for HTML parsing and suppresses link previews', async function () {
        await sendTelegram(target(), message())
        expect(sentBody().parse_mode).toBe('HTML')
        expect(sentBody().disable_web_page_preview).toBe(true)
    })

    it('bounds the request with a timeout', async function () {
        await sendTelegram(target(), message())
        const config = post.mock.calls[0]?.[2] as { timeout?: number }
        expect(config.timeout).toBeGreaterThan(0)
    })

    it('fails without posting when the token or chat id is missing', async function () {
        expect((await sendTelegram(target({ botToken: '' }), message())).ok).toBe(false)
        expect((await sendTelegram(target({ chatId: '' }), message())).ok).toBe(false)
        expect(post).not.toHaveBeenCalled()
    })

    it('resolves env: references for both the token and the chat id', async function () {
        process.env.TEST_TG_TOKEN = BOT_TOKEN
        process.env.TEST_TG_CHAT = CHAT_ID
        try {
            await sendTelegram(
                target({ botToken: 'env:TEST_TG_TOKEN', chatId: 'env:TEST_TG_CHAT' }),
                message()
            )
            expect(post.mock.calls[0]?.[0]).toContain(BOT_TOKEN)
            expect(sentBody().chat_id).toBe(CHAT_ID)
        } finally {
            delete process.env.TEST_TG_TOKEN
            delete process.env.TEST_TG_CHAT
        }
    })

    it('treats an unresolvable env: reference as missing', async function () {
        delete process.env.TEST_TG_ABSENT
        const result = await sendTelegram(target({ botToken: 'env:TEST_TG_ABSENT' }), message())
        expect(result.ok).toBe(false)
        expect(post).not.toHaveBeenCalled()
    })
})

describe('sendTelegram — HTML conversion', function () {
    it('converts bold spans to HTML tags', async function () {
        await sendTelegram(target(), message({ markdown: '*app* has 2 new vulnerabilities' }))
        expect(sentBody().text).toBe('<b>app</b> has 2 new vulnerabilities')
    })

    it('escapes the three characters HTML mode actually cares about', async function () {
        await sendTelegram(target(), message({ markdown: 'a & b < c > d' }))
        expect(sentBody().text).toBe('a &amp; b &lt; c &gt; d')
    })

    // The reason this sender does not use MarkdownV2: these characters are all special there, and a
    // single unescaped one rejects the whole message, so the notification silently never arrives.
    it('passes dots, dashes, underscores and URLs through untouched', async function () {
        await sendTelegram(
            target(),
            message({ markdown: 'lodash 4.17.11 fixed in 4.17.21 https://example.test/a_b-c.d!(x)' })
        )
        expect(sentBody().text).toBe('lodash 4.17.11 fixed in 4.17.21 https://example.test/a_b-c.d!(x)')
    })

    it('escapes angle brackets before creating its own bold tags', async function () {
        await sendTelegram(target(), message({ markdown: '*<script>*' }))
        expect(sentBody().text).toBe('<b>&lt;script&gt;</b>')
    })

    it('converts several bold spans in one message', async function () {
        await sendTelegram(target(), message({ markdown: '*a* and *b*' }))
        expect(sentBody().text).toBe('<b>a</b> and <b>b</b>')
    })

    it('leaves an unpaired asterisk alone', async function () {
        await sendTelegram(target(), message({ markdown: '2 * 3 = 6' }))
        expect(sentBody().text).toBe('2 * 3 = 6')
    })

    it('does not let a bold span run across a line break', async function () {
        await sendTelegram(target(), message({ markdown: '*line one\nline two*' }))
        expect(sentBody().text).toBe('*line one\nline two*')
    })
})

describe('sendTelegram — failures', function () {
    // The bot token is in the request URL, and this error text is persisted and shown in the portal.
    it('redacts the bot token out of the error text', async function () {
        isAxiosError.mockReturnValue(true)
        post.mockRejectedValue({
            isAxiosError: true,
            message: 'Request failed for https://api.telegram.org/bot' + BOT_TOKEN + '/sendMessage',
            response: { status: 401, data: { description: 'Unauthorized' } }
        })
        const result = await sendTelegram(target(), message())
        expect(result.ok).toBe(false)
        expect(result.ok === false && result.errorText).not.toContain(BOT_TOKEN)
        expect(result.ok === false && result.errorText).toContain('REDACTED')
    })

    it('reports the status and serialises an object body', async function () {
        isAxiosError.mockReturnValue(true)
        post.mockRejectedValue({
            isAxiosError: true,
            message: 'Request failed with status code 400',
            response: { status: 400, data: { description: 'chat not found' } }
        })
        const result = await sendTelegram(target(), message())
        expect(result.ok === false && result.errorText).toContain('400')
        expect(result.ok === false && result.errorText).toContain('chat not found')
    })

    it('truncates a long response body', async function () {
        isAxiosError.mockReturnValue(true)
        post.mockRejectedValue({
            isAxiosError: true,
            message: 'failed',
            response: { status: 500, data: 'x'.repeat(500) }
        })
        const result = await sendTelegram(target(), message())
        const text = result.ok === false ? result.errorText : ''
        expect(text).toContain('…')
        expect(text.length).toBeLessThan(400)
    })

    it('describes a transport failure that carried no response', async function () {
        isAxiosError.mockReturnValue(true)
        post.mockRejectedValue({ isAxiosError: true, message: 'connect ETIMEDOUT' })
        const result = await sendTelegram(target(), message())
        expect(result.ok === false && result.errorText).toContain('no-status')
    })

    // axios does not guarantee a message on every error it raises; the status and body still carry the
    // diagnosis, so a blank message must not concatenate `undefined` into the persisted error text.
    it('still reports the status when the error carries no message', async function () {
        isAxiosError.mockReturnValue(true)
        post.mockRejectedValue({ isAxiosError: true, message: '', response: { status: 500, data: 'server_error' } })
        const result = await sendTelegram(target(), message())
        expect(result.ok).toBe(false)
        expect(result.ok === false && result.errorText).toContain('500')
        expect(result.ok === false && result.errorText).toContain('server_error')
        expect(result.ok === false && result.errorText).not.toContain('undefined')
    })

    it('handles a plain Error', async function () {
        post.mockRejectedValue(new Error('boom'))
        const result = await sendTelegram(target(), message())
        expect(result.ok === false && result.errorText).toContain('boom')
    })

    it('handles a thrown non-Error', async function () {
        post.mockRejectedValue('just a string')
        const result = await sendTelegram(target(), message())
        expect(result.ok === false && result.errorText).toContain('just a string')
    })
})
