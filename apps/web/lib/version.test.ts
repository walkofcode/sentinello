import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setConfigValue } from '@sentinello/db'
import { closePortalTestDb, openPortalTestDb, type PortalTestDb } from './portal-test-db.fixture'

// The version shown in the footer and /api/health, plus the GitHub update check behind the
// "vX available" badge.
//
// Both caches here are MODULE-LEVEL (cachedVersion, cachedInfo), which is the whole reason every test
// re-imports through vi.resetModules(): without it the first test's resolved version would leak into
// every later one and the TTL assertions would be meaningless. That is not a test-only quirk — it is
// the behaviour under test, since the cache is what stops a footer render hitting GitHub per request.

const FEED = 'https://github.test/releases/latest'

let handle: PortalTestDb
let fetchMock: ReturnType<typeof vi.fn>

// Fresh module instance per test, so the module-level caches start empty.
async function loadVersion() {
    vi.resetModules()
    return await import('./version')
}

function release(body: Record<string, unknown>, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

// A Response body can only be read once, so any test whose fetch is called more than once has to mint
// a fresh one per call — mockResolvedValue would hand the second call an already-consumed body and the
// resulting parse failure would look exactly like a network error.
function alwaysReturns(body: Record<string, unknown>, status = 200): void {
    fetchMock.mockImplementation(function respond() {
        return Promise.resolve(release(body, status))
    })
}

beforeEach(async function setup() {
    handle = await openPortalTestDb('version')
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('SENTINELLO_UPDATE_FEED_URL', FEED)
})

afterEach(async function teardown() {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.useRealTimers()
    await closePortalTestDb(handle)
})

describe('getCurrentVersion', function () {
    it('prefers the version baked in by the Docker image', async function () {
        vi.stubEnv('SENTINELLO_VERSION', '1.3.0')
        const { getCurrentVersion } = await loadVersion()
        expect(getCurrentVersion()).toBe('1.3.0')
    })

    // The publish-image workflow's docker/metadata-action emits the full tag ref ("v1.3.0"), and the
    // footer template is "Sentinello v{version}" — without the strip it renders "vv1.3.0".
    it('strips a leading v from the baked-in tag', async function () {
        vi.stubEnv('SENTINELLO_VERSION', 'v1.3.0')
        const { getCurrentVersion } = await loadVersion()
        expect(getCurrentVersion()).toBe('1.3.0')
    })

    it('trims whitespace around the baked-in tag', async function () {
        vi.stubEnv('SENTINELLO_VERSION', '  v2.0.1  ')
        const { getCurrentVersion } = await loadVersion()
        expect(getCurrentVersion()).toBe('2.0.1')
    })

    // The dev fallback walks up to the monorepo ROOT package.json. It must NOT stop at a workspace —
    // apps/cli is also named 'sentinello' and carries a frozen 0.1.0, so matching on the bare name
    // would report the CLI's version as the portal's.
    it('falls back to the monorepo root version in development', async function () {
        vi.stubEnv('SENTINELLO_VERSION', '')
        const { getCurrentVersion } = await loadVersion()
        expect(getCurrentVersion()).toMatch(/^\d+\.\d+\.\d+/)
    })

    it('caches after the first resolution', async function () {
        vi.stubEnv('SENTINELLO_VERSION', '1.0.0')
        const { getCurrentVersion } = await loadVersion()
        expect(getCurrentVersion()).toBe('1.0.0')
        vi.stubEnv('SENTINELLO_VERSION', '9.9.9')
        expect(getCurrentVersion()).toBe('1.0.0')
    })
})

describe('getVersionInfo — disabled', function () {
    it('reports disabled when the feed is switched off by env', async function () {
        vi.stubEnv('SENTINELLO_UPDATE_FEED_URL', 'off')
        const { getVersionInfo } = await loadVersion()
        const info = await getVersionInfo()
        expect(info).toMatchObject({ source: 'disabled', latest: null, updateAvailable: false, releaseUrl: null })
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('reports disabled when the operator turned update checks off', async function () {
        setConfigValue(handle.db, 'update_checks_enabled', false)
        const { getVersionInfo } = await loadVersion()
        expect((await getVersionInfo()).source).toBe('disabled')
        expect(fetchMock).not.toHaveBeenCalled()
    })

    // Absent means "never configured", which must default ON rather than silently never checking.
    it('checks when the flag has never been set', async function () {
        fetchMock.mockResolvedValue(release({ tag_name: 'v1.0.0' }))
        const { getVersionInfo } = await loadVersion()
        expect((await getVersionInfo()).source).toBe('github')
    })

    it('checks when the flag is explicitly on', async function () {
        setConfigValue(handle.db, 'update_checks_enabled', true)
        fetchMock.mockResolvedValue(release({ tag_name: 'v1.0.0' }))
        const { getVersionInfo } = await loadVersion()
        expect((await getVersionInfo()).source).toBe('github')
    })
})

describe('getVersionInfo — the update check', function () {
    it('reports an update when the release is newer', async function () {
        vi.stubEnv('SENTINELLO_VERSION', '1.0.0')
        fetchMock.mockResolvedValue(release({ tag_name: 'v1.2.0', html_url: 'https://github.test/r/1.2.0' }))
        const { getVersionInfo } = await loadVersion()
        expect(await getVersionInfo()).toMatchObject({
            current: '1.0.0',
            latest: '1.2.0',
            updateAvailable: true,
            releaseUrl: 'https://github.test/r/1.2.0',
            source: 'github'
        })
    })

    it.each([
        ['1.0.0', '1.0.0', false],
        ['1.0.0', '0.9.0', false],
        ['1.0.0', '1.0.1', true],
        ['1.0.0', '1.1.0', true],
        ['1.0.0', '2.0.0', true],
        ['1.9.0', '1.10.0', true],
        ['2.0.0', '10.0.0', true],
        ['1.0', '1.0.1', true],
        ['1.0.0', '1.0.0-rc.1', false]
    ])('compares current %s against latest %s as updateAvailable=%s', async function (current, latest, expected) {
        vi.stubEnv('SENTINELLO_VERSION', current as string)
        fetchMock.mockResolvedValue(release({ tag_name: latest as string }))
        const { getVersionInfo } = await loadVersion()
        expect((await getVersionInfo()).updateAvailable).toBe(expected)
    })

    it('sends the GitHub API headers', async function () {
        fetchMock.mockResolvedValue(release({ tag_name: 'v1.0.0' }))
        const { getVersionInfo } = await loadVersion()
        await getVersionInfo()
        expect(String(fetchMock.mock.calls[0]?.[0])).toBe(FEED)
        const init = fetchMock.mock.calls[0]?.[1] as RequestInit
        expect(init.headers).toMatchObject({ Accept: 'application/vnd.github+json' })
        expect(init.signal).toBeInstanceOf(AbortSignal)
    })

    it('reports no latest version when the release carries no tag', async function () {
        fetchMock.mockResolvedValue(release({ html_url: 'https://github.test/r' }))
        const { getVersionInfo } = await loadVersion()
        expect(await getVersionInfo()).toMatchObject({ latest: null, updateAvailable: false })
    })

    it('reports a null release URL when the release omits one', async function () {
        fetchMock.mockResolvedValue(release({ tag_name: 'v9.0.0' }))
        const { getVersionInfo } = await loadVersion()
        expect((await getVersionInfo()).releaseUrl).toBeNull()
    })
})

describe('getVersionInfo — failure and caching', function () {
    it('reports the HTTP status as the error on a non-OK response', async function () {
        fetchMock.mockResolvedValue(release({}, 503))
        const { getVersionInfo } = await loadVersion()
        const info = await getVersionInfo()
        expect(info.source).toBe('error')
        expect(info.error).toContain('503')
        expect(info.updateAvailable).toBe(false)
    })

    it('reports a thrown network error', async function () {
        fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
        const { getVersionInfo } = await loadVersion()
        expect(await getVersionInfo()).toMatchObject({ source: 'error', error: 'ECONNREFUSED' })
    })

    it('still reports the current version when the check fails', async function () {
        vi.stubEnv('SENTINELLO_VERSION', '1.0.0')
        fetchMock.mockRejectedValue(new Error('offline'))
        const { getVersionInfo } = await loadVersion()
        expect((await getVersionInfo()).current).toBe('1.0.0')
    })

    it('describes a non-Error throw rather than losing it', async function () {
        fetchMock.mockRejectedValue('just a string')
        const { getVersionInfo } = await loadVersion()
        expect((await getVersionInfo()).error).toBe('unknown update-check error')
    })

    // The cache is what stops a footer render hitting GitHub on every request.
    it('serves the second call from cache without re-fetching', async function () {
        fetchMock.mockResolvedValue(release({ tag_name: 'v1.0.0' }))
        const { getVersionInfo } = await loadVersion()
        expect((await getVersionInfo()).source).toBe('github')
        expect((await getVersionInfo()).source).toBe('cache')
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('re-checks once the success TTL has elapsed', async function () {
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(Date.UTC(2026, 0, 1))
        alwaysReturns({ tag_name: 'v1.0.0' })
        const { getVersionInfo } = await loadVersion()
        expect((await getVersionInfo()).source).toBe('github')
        vi.setSystemTime(Date.UTC(2026, 0, 1) + 6 * 60 * 60 * 1000 + 1)
        expect((await getVersionInfo()).source).toBe('github')
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    // A transient GitHub outage must not lock the check out for the full 6 hours.
    it('retries a failure after 15 minutes rather than the 6-hour success TTL', async function () {
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(Date.UTC(2026, 0, 1))
        fetchMock.mockRejectedValue(new Error('offline'))
        const { getVersionInfo } = await loadVersion()
        expect((await getVersionInfo()).source).toBe('error')

        vi.setSystemTime(Date.UTC(2026, 0, 1) + 14 * 60 * 1000)
        expect((await getVersionInfo()).source).toBe('cache')
        expect(fetchMock).toHaveBeenCalledTimes(1)

        vi.setSystemTime(Date.UTC(2026, 0, 1) + 15 * 60 * 1000 + 1)
        alwaysReturns({ tag_name: 'v1.0.0' })
        expect((await getVersionInfo()).source).toBe('github')
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('stamps checkedAt as an ISO timestamp', async function () {
        fetchMock.mockResolvedValue(release({ tag_name: 'v1.0.0' }))
        const { getVersionInfo } = await loadVersion()
        expect((await getVersionInfo()).checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })
})
