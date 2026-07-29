import { beforeEach, describe, expect, it, vi } from 'vitest'
import axios from 'axios'
import type { Finding, NotificationTarget } from '@sentinello/core'
import { sendWebhook } from './webhook'
import { validateWebhookUrl } from './ssrf'
import type { RenderedMessage, WebhookPayloadContext } from './types'

// The webhook sender is the last thing between a finding and an arbitrary operator-supplied URL, so
// the two guards on this path are the point of the suite: nothing is posted before the SSRF check
// clears the URL, and no response body is ever reflected into the error text — doing so would turn a
// blind SSRF into a readable one.
//
// axios is mocked because this posts to the network. ./ssrf is mocked because validateWebhookUrl
// resolves DNS; its real logic is already covered by ssrf.test.ts, and stubbing it here lets each
// case choose whether the URL was accepted or rejected.

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

vi.mock('./ssrf', function mockSsrf() {
    return { validateWebhookUrl: vi.fn() }
})

const post = vi.mocked(axios.post)
const isAxiosError = vi.mocked(axios.isAxiosError)
const validate = vi.mocked(validateWebhookUrl)

const URL_OK = 'https://hooks.example.test/incoming'

function target(config: Record<string, unknown> = {}): NotificationTarget {
    return {
        id: 'target-1',
        kind: 'webhook',
        config: { url: URL_OK, ...config } as NotificationTarget['config'],
        severityFilter: ['critical', 'high'],
        envFilter: 'all',
        enabled: true,
        createdAt: 0,
        rootIds: [],
        projectIds: [],
        sourceScope: { mode: 'all', cells: [] }
    }
}

function finding(overrides: Partial<Finding> = {}): Finding {
    return {
        packageName: 'lodash',
        installedVersion: '4.17.11',
        fixAvailable: true,
        fixVersion: '4.17.21',
        severity: 'high',
        advisoryId: 'CVE-2024-1',
        advisoryTitle: 'Prototype pollution',
        advisoryUrl: 'https://example.test/advisory/1',
        vulnerableRange: '<4.17.21',
        isProd: true,
        isDev: false,
        depPath: ['lodash'],
        ...overrides
    } as unknown as Finding
}

function webhookContext(overrides: Partial<WebhookPayloadContext> = {}): WebhookPayloadContext {
    return {
        event: 'findings',
        isBaseline: false,
        root: { id: 'root-1', label: 'Repos', path: '/repo' },
        project: { id: 'project-1', name: 'app', relPath: 'app', packageManager: 'npm' },
        findings: [finding()],
        failureSignature: null,
        advisoryText: '# Advisory export',
        ...overrides
    }
}

function message(overrides: Partial<RenderedMessage> = {}): RenderedMessage {
    return {
        title: 'New vulnerabilities in app',
        text: 'plain text body',
        markdown: '*bold* body',
        portalUrl: 'https://portal.example.test/projects/project-1',
        ...overrides
    }
}

beforeEach(function resetMocks() {
    vi.clearAllMocks()
    isAxiosError.mockReturnValue(false)
    validate.mockResolvedValue({ ok: true, url: URL_OK })
    post.mockResolvedValue({ status: 200, data: '' })
})

describe('sendWebhook — guards', function () {
    it('fails without posting when the target has no URL', async function () {
        const result = await sendWebhook(target({ url: '' }), message())
        expect(result.ok).toBe(false)
        expect(post).not.toHaveBeenCalled()
    })

    // The SSRF check has to happen before the request, not alongside it.
    it('does not post when the URL is rejected as unsafe', async function () {
        validate.mockResolvedValue({ ok: false, reason: 'resolves to a private address' })
        const result = await sendWebhook(target(), message())
        expect(post).not.toHaveBeenCalled()
        expect(result.ok).toBe(false)
        expect(result.ok === false && result.errorText).toContain('resolves to a private address')
    })

    // The validator may normalise or pin the URL; the sender must post to what it returned rather
    // than to the raw operator-supplied string, or the check could be sidestepped.
    it('posts to the URL the validator returned, not the configured one', async function () {
        validate.mockResolvedValue({ ok: true, url: 'https://hooks.example.test/normalised' })
        await sendWebhook(target(), message())
        expect(post.mock.calls[0]?.[0]).toBe('https://hooks.example.test/normalised')
    })

    // Redirects are how an allowed host hands the request to a disallowed one after validation.
    it('refuses to follow redirects', async function () {
        await sendWebhook(target(), message())
        expect(post.mock.calls[0]?.[2]).toMatchObject({ maxRedirects: 0 })
    })

    it('bounds the request with a timeout', async function () {
        await sendWebhook(target(), message())
        const config = post.mock.calls[0]?.[2] as { timeout?: number }
        expect(typeof config.timeout).toBe('number')
        expect(config.timeout).toBeGreaterThan(0)
    })
})

describe('sendWebhook — headers', function () {
    it('sends JSON content type by default', async function () {
        await sendWebhook(target(), message())
        expect(post.mock.calls[0]?.[2]).toMatchObject({ headers: { 'Content-Type': 'application/json' } })
    })

    it('merges operator-supplied headers', async function () {
        await sendWebhook(target({ headers: { 'X-Team': 'platform' } }), message())
        const config = post.mock.calls[0]?.[2] as { headers: Record<string, string> }
        expect(config.headers['X-Team']).toBe('platform')
        expect(config.headers['Content-Type']).toBe('application/json')
    })

    it('lets an operator header override the default content type', async function () {
        await sendWebhook(target({ headers: { 'Content-Type': 'application/custom' } }), message())
        const config = post.mock.calls[0]?.[2] as { headers: Record<string, string> }
        expect(config.headers['Content-Type']).toBe('application/custom')
    })
})

describe('sendWebhook — body shape', function () {
    it('sends the structured JSON payload for the json flavor', async function () {
        await sendWebhook(target({ flavor: 'json' }), message({ webhook: webhookContext() }))
        const body = post.mock.calls[0]?.[1] as Record<string, unknown>
        expect(body.event).toBe('findings')
        expect(body.isBaseline).toBe(false)
        expect(body.project).toMatchObject({ id: 'project-1', name: 'app' })
        expect(body.vulnerabilities).toHaveLength(1)
    })

    it('defaults to the json flavor when none is configured', async function () {
        await sendWebhook(target(), message({ webhook: webhookContext() }))
        const body = post.mock.calls[0]?.[1] as Record<string, unknown>
        expect(body.vulnerabilities).toBeDefined()
    })

    it('renames finding fields to the documented payload vocabulary', async function () {
        await sendWebhook(target(), message({ webhook: webhookContext() }))
        const body = post.mock.calls[0]?.[1] as { vulnerabilities: Record<string, unknown>[] }
        expect(body.vulnerabilities[0]).toMatchObject({
            library: 'lodash',
            version: '4.17.11',
            recommendedVersion: '4.17.21',
            advisory: { id: 'CVE-2024-1' }
        })
    })

    it('sends just the advisory text for the text flavor', async function () {
        await sendWebhook(target({ flavor: 'text' }), message({ webhook: webhookContext() }))
        expect(post.mock.calls[0]?.[1]).toEqual({ text: '# Advisory export' })
    })

    it('carries the failure signature only for a scan_failure event', async function () {
        await sendWebhook(
            target(),
            message({ webhook: webhookContext({ event: 'scan_failure', failureSignature: 'audit_spawn_error' }) })
        )
        expect((post.mock.calls[0]?.[1] as Record<string, unknown>).failureSignature).toBe('audit_spawn_error')
    })

    it('omits the failure signature for a findings event', async function () {
        await sendWebhook(
            target(),
            message({ webhook: webhookContext({ event: 'findings', failureSignature: 'ignored' }) })
        )
        expect((post.mock.calls[0]?.[1] as Record<string, unknown>).failureSignature).toBeUndefined()
    })

    // The operator's "Test send" has no scan behind it, so there is no structured context. It must
    // still deliver something, or connectivity testing would be impossible.
    it('falls back to the simple envelope when there is no structured context', async function () {
        await sendWebhook(target({ flavor: 'json' }), message())
        expect(post.mock.calls[0]?.[1]).toEqual({
            title: 'New vulnerabilities in app',
            text: 'plain text body',
            markdown: '*bold* body',
            portalUrl: 'https://portal.example.test/projects/project-1'
        })
    })

    it('falls back to the simple envelope even for the text flavor', async function () {
        await sendWebhook(target({ flavor: 'text' }), message())
        expect(post.mock.calls[0]?.[1]).toMatchObject({ title: 'New vulnerabilities in app' })
    })
})

describe('sendWebhook — failures', function () {
    it('reports success when the post resolves', async function () {
        expect(await sendWebhook(target(), message())).toEqual({ ok: true })
    })

    // Reflecting the response body would let an operator read an internal service's reply out of the
    // stored error — a blind SSRF made readable. Status and message only.
    it('never reflects the response body into the error text', async function () {
        isAxiosError.mockReturnValue(true)
        post.mockRejectedValue({
            isAxiosError: true,
            message: 'Request failed with status code 500',
            response: { status: 500, data: 'INTERNAL SECRET FROM THE TARGET SERVICE' }
        })
        const result = await sendWebhook(target(), message())
        expect(result.ok).toBe(false)
        expect(result.ok === false && result.errorText).toContain('500')
        expect(result.ok === false && result.errorText).not.toContain('INTERNAL SECRET')
    })

    it('describes a transport failure that carried no response', async function () {
        isAxiosError.mockReturnValue(true)
        post.mockRejectedValue({ isAxiosError: true, message: 'connect ECONNREFUSED' })
        const result = await sendWebhook(target(), message())
        expect(result.ok === false && result.errorText).toContain('no-status')
        expect(result.ok === false && result.errorText).toContain('ECONNREFUSED')
    })

    it('handles a plain Error', async function () {
        post.mockRejectedValue(new Error('boom'))
        const result = await sendWebhook(target(), message())
        expect(result.ok === false && result.errorText).toContain('boom')
    })

    it('handles a thrown non-Error', async function () {
        post.mockRejectedValue('just a string')
        const result = await sendWebhook(target(), message())
        expect(result.ok === false && result.errorText).toContain('just a string')
    })
})
