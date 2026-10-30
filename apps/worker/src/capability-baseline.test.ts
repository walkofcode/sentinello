import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Capability, NotificationTarget, ReasonCode, Severity } from '@sentinello/core'
import {
    claimCompletedBaselines,
    deleteNotificationTarget,
    getBaselineState,
    insertMute,
    insertNotificationTarget,
    insertScan,
    listSummaryDeliveries,
    schema,
    seedCapabilityBaselines,
    setConfigValue,
    setNotificationTargetEnabled,
    setTargetRoots,
    upsertFindingEvent,
    upsertRoot
} from '@sentinello/db'
import type { NotificationSender, RenderedMessage, SendResult } from '@sentinello/notifications'
import { closeWorkerTestDb, openWorkerTestDb, seedProject, T0, type WorkerTestDb } from './worker-test-db.fixture'
import { senderFor } from '@sentinello/notifications'
import { MAX_SUMMARY_ATTEMPTS, dispatchCapabilitySummaries, onCompletedSweep } from './capability-baseline'
import type { ProjectScanOutcome } from './runner'

// The real senders POST over the network; the default path is proven against a recording stand-in.
vi.mock('@sentinello/notifications', async function mockNotifications(importOriginal) {
    const actual = await importOriginal<typeof import('@sentinello/notifications')>()
    return { ...actual, senderFor: vi.fn() }
})

// The silent baseline: the first completed sweep after an upgrade records the new languages' findings
// without a message each, and every enabled target gets ONE summary, counted under its own policy. The
// rules worth pinning are the ones about sending: never a stale summary on retry (SENTINEL-124) and never
// two sends of one summary, however dispatches overlap (SENTINEL-125).

const CAPABILITY: Capability = { id: 'languages-3.8', since: '3.8.0', ecosystems: ['PyPI', 'Go', 'crates.io', 'RubyGems'] }
const CAPABILITIES = [CAPABILITY]

let handle: WorkerTestDb
let sent: { targetId: string; message: RenderedMessage }[]

function target(id: string, overrides: Partial<NotificationTarget> = {}): NotificationTarget {
    const row: NotificationTarget = {
        id,
        kind: 'webhook',
        config: { url: 'https://hooks.example.test/' + id },
        severityFilter: ['critical', 'high', 'moderate', 'low', 'info'],
        envFilter: 'all',
        enabled: true,
        createdAt: T0,
        rootIds: [],
        projectIds: [],
        sourceScope: { mode: 'all', cells: [] },
        ...overrides
    }
    insertNotificationTarget(handle.db, row)
    if (row.rootIds.length > 0) setTargetRoots(handle.db, id, row.rootIds)
    return row
}

// A sender that records every call and answers what `answers` says, in order (ok once they run out).
function recordingSender(answers: SendResult[] = []): NotificationSender {
    return async function send(t, message) {
        sent.push({ targetId: t.id, message })
        return answers.shift() ?? { ok: true }
    }
}

let eventSeq = 0

// A finding event the baseline recorded silently.
function baselineEvent(projectId: string, severity: Severity = 'high', ecosystem: 'PyPI' | 'RubyGems' = 'PyPI', packageName?: string): void {
    eventSeq += 1
    upsertFindingEvent(handle.db, {
        projectId,
        source: 'osv',
        ecosystem,
        advisoryId: 'GHSA-' + eventSeq,
        packageName: packageName ?? 'pkg-' + eventSeq,
        severity,
        firstScanId: 'scan-' + projectId,
        at: T0,
        baselineOf: CAPABILITY.id
    })
}

function scanOf(projectId: string): void {
    insertScan(handle.db, {
        id: 'scan-' + projectId, projectId, startedAt: T0, finishedAt: T0, scanner: 'osv', source: 'osv', ecosystem: 'PyPI',
        status: 'ok', reasonCode: 'ok', durationMs: 1, errorText: null, rawJson: '{}'
    })
}

function deliveries() {
    return new Map(listSummaryDeliveries(handle.db, CAPABILITY.id).map(function byTarget(d) { return [d.targetId, d] }))
}

function dispatch(send: NotificationSender, dryRun = false): Promise<void> {
    return dispatchCapabilitySummaries({ db: handle.db, dryRun, send, capabilities: CAPABILITIES, portalBaseUrl: null })
}

beforeEach(async function setup() {
    sent = []
    eventSeq = 0
    handle = await openWorkerTestDb('worker-baseline')
    upsertRoot(handle.db, { id: 'root-a', path: '/roots/a', label: null, createdAt: T0 })
    upsertRoot(handle.db, { id: 'root-b', path: '/roots/b', label: null, createdAt: T0 })
    seedProject(handle.db, { id: 'p-a', rootId: 'root-a', relPath: 'svc', name: 'svc', ecosystems: ['PyPI'] })
    seedProject(handle.db, { id: 'p-b', rootId: 'root-b', relPath: 'shop', name: 'shop', ecosystems: ['RubyGems'] })
    scanOf('p-a')
    scanOf('p-b')
    // An upgraded install: it has scanned before, so 3.8's languages start a baseline.
    seedCapabilityBaselines(handle.db, CAPABILITIES, T0)
    // OSV is on for both languages, so neither project counts as source-disabled unless a test says so.
    setConfigValue(handle.db, 'sources.osv.PyPI.enabled', true)
    setConfigValue(handle.db, 'sources.osv.RubyGems.enabled', true)
    vi.spyOn(console, 'log').mockImplementation(function silence() {})
    vi.spyOn(console, 'error').mockImplementation(function silence() {})
})

afterEach(async function teardown() {
    vi.restoreAllMocks()
    await closeWorkerTestDb(handle)
})

describe('seeding a capability', function () {
    it('starts an upgraded install pending, and leaves a known capability alone', function () {
        expect(getBaselineState(handle.db, CAPABILITY.id)).toBe('pending')
        claimCompletedBaselines(handle.db, CAPABILITIES, T0)
        seedCapabilityBaselines(handle.db, CAPABILITIES, T0)
        expect(getBaselineState(handle.db, CAPABILITY.id)).toBe('swept')
    })

    it('records a fresh install done at once: there is nothing that existed all along', async function () {
        const fresh = await openWorkerTestDb('worker-baseline-fresh')
        seedCapabilityBaselines(fresh.db, CAPABILITIES, T0)
        expect(getBaselineState(fresh.db, CAPABILITY.id)).toBe('done')
        await closeWorkerTestDb(fresh)
    })
})

describe('one summary per enabled target, under its own policy', function () {
    it('counts each target under its own root and cell scope and sends each exactly one summary', async function () {
        baselineEvent('p-a', 'critical')
        baselineEvent('p-a', 'high')
        baselineEvent('p-b', 'high', 'RubyGems')
        target('everything')
        target('team-a', { rootIds: ['root-a'] })
        target('ruby-only', { sourceScope: { mode: 'selected', cells: [{ source: 'osv', ecosystem: 'RubyGems' }] } })
        target('switched-off', { enabled: false })
        await onCompletedSweep(handle.db, [], { send: recordingSender(), capabilities: CAPABILITIES })
        const counts = Object.fromEntries(Array.from(deliveries(), function count([id, d]) { return [id, d.counts] }))
        expect(counts).toEqual({
            everything: { findings: 3, projects: 2, critical: 1, sourceDisabledProjects: 0 },
            'team-a': { findings: 2, projects: 1, critical: 1, sourceDisabledProjects: 0 },
            'ruby-only': { findings: 1, projects: 1, critical: 0, sourceDisabledProjects: 0 }
        })
        expect(sent.map(function to(s) { return s.targetId }).sort()).toEqual(['everything', 'ruby-only', 'team-a'])
        expect(sent.find(function e(s) { return s.targetId === 'everything' })?.message.text)
            .toBe('Sentinello 3.8 now checks Python/Go/Rust/Ruby: 3 findings across 2 projects, 1 critical')
        expect(getBaselineState(handle.db, CAPABILITY.id)).toBe('done')
    })

    it('reduces the counts by the target severity, prod/dev filter and active mutes', async function () {
        baselineEvent('p-a', 'critical', 'PyPI', 'django')
        baselineEvent('p-a', 'low', 'PyPI', 'requests')
        baselineEvent('p-b', 'high', 'RubyGems', 'rack')
        target('critical-only', { severityFilter: ['critical'] })
        target('prod-only', { envFilter: 'prod' })
        target('everything')
        insertMute(handle.db, { id: 'm1', scope: 'finding', projectId: 'p-b', scanner: 'osv', ecosystem: 'RubyGems', advisoryId: 'GHSA-3', packageName: 'rack', reason: 'accepted', author: 'ops', createdAt: T0, expiresAt: null })
        await onCompletedSweep(handle.db, [], { send: recordingSender(), capabilities: CAPABILITIES })
        const counts = deliveries()
        expect(counts.get('critical-only')?.counts).toMatchObject({ findings: 1, critical: 1 })
        // No findings row backs these events, so none is prod: a prod-only target is told of none.
        expect(counts.get('prod-only')?.counts).toMatchObject({ findings: 0, projects: 0 })
        expect(counts.get('everything')?.counts).toMatchObject({ findings: 2, projects: 1 })
    })

    // The default install: OSV and gemnasium are off, so nothing was checked — and the summary says so.
    it('sends an honest zero, with the projects no source answers for counted in the target scope', async function () {
        setConfigValue(handle.db, 'sources.osv.PyPI.enabled', false)
        setConfigValue(handle.db, 'sources.osv.RubyGems.enabled', false)
        target('everything')
        target('team-b', { rootIds: ['root-b'] })
        await onCompletedSweep(handle.db, [], { send: recordingSender(), capabilities: CAPABILITIES })
        expect(deliveries().get('everything')?.counts).toEqual({ findings: 0, projects: 0, critical: 0, sourceDisabledProjects: 2 })
        expect(deliveries().get('team-b')?.counts).toEqual({ findings: 0, projects: 0, critical: 0, sourceDisabledProjects: 1 })
        expect(sent.find(function e(s) { return s.targetId === 'team-b' })?.message.text)
            .toBe('Sentinello 3.8 now checks Python/Go/Rust/Ruby: 0 findings across 0 projects, 0 critical\n1 project has no enabled source, turn one on in Settings → Sources')
    })

    it('sends through the sender of the target kind when none is injected', async function () {
        target('everything')
        vi.mocked(senderFor).mockReturnValue(recordingSender())
        await onCompletedSweep(handle.db, [], { capabilities: CAPABILITIES })
        expect(sent.map(function to(s) { return s.targetId })).toEqual(['everything'])
    })

    it('closes a baseline with no target at all', async function () {
        await onCompletedSweep(handle.db, [], { send: recordingSender(), capabilities: CAPABILITIES })
        expect(sent).toEqual([])
        expect(getBaselineState(handle.db, CAPABILITY.id)).toBe('done')
    })

    it('only logs under dry-run, makes zero sender calls, and never sends that summary later', async function () {
        baselineEvent('p-a')
        target('everything')
        setConfigValue(handle.db, 'dryRunNotify', true)
        await onCompletedSweep(handle.db, [], { send: recordingSender(), capabilities: CAPABILITIES })
        expect(sent).toEqual([])
        expect(deliveries().get('everything')?.dryRunAt).not.toBeNull()
        setConfigValue(handle.db, 'dryRunNotify', false)
        await onCompletedSweep(handle.db, [], { send: recordingSender(), capabilities: CAPABILITIES })
        expect(sent).toEqual([])
        expect(getBaselineState(handle.db, CAPABILITY.id)).toBe('done')
    })

    it('writes one set of rows when two completions race', function () {
        target('everything')
        expect(claimCompletedBaselines(handle.db, CAPABILITIES, T0)).toEqual([CAPABILITY.id])
        expect(claimCompletedBaselines(handle.db, CAPABILITIES, T0)).toEqual([])
        expect(listSummaryDeliveries(handle.db, CAPABILITY.id)).toHaveLength(1)
    })
})

describe('retries', function () {
    it('retries a failed target on the next completed sweep and never resends the delivered one', async function () {
        baselineEvent('p-a')
        target('slack')
        target('hook')
        const first = recordingSender([{ ok: false, errorText: 'channel down' }])
        await onCompletedSweep(handle.db, [], { send: first, capabilities: CAPABILITIES })
        const failed = sent[0]?.targetId as string
        const delivered = sent[1]?.targetId as string
        expect(deliveries().get(failed)).toMatchObject({ attempts: 1, lastErrorText: 'channel down', firstSucceededAt: null })
        expect(getBaselineState(handle.db, CAPABILITY.id)).toBe('swept')
        sent = []
        await onCompletedSweep(handle.db, [], { send: recordingSender(), capabilities: CAPABILITIES })
        expect(sent.map(function to(s) { return s.targetId })).toEqual([failed])
        expect(deliveries().get(delivered)?.attempts).toBe(1)
        expect(getBaselineState(handle.db, CAPABILITY.id)).toBe('done')
    })

    it('gives up after the attempt budget, and closes the baseline', async function () {
        baselineEvent('p-a')
        target('hook')
        const down = { ok: false as const, errorText: 'still down' }
        for (let n = 0; n < MAX_SUMMARY_ATTEMPTS + 2; n++) await onCompletedSweep(handle.db, [], { send: recordingSender([down]), capabilities: CAPABILITIES })
        expect(sent).toHaveLength(MAX_SUMMARY_ATTEMPTS)
        expect(deliveries().get('hook')?.gaveUpAt).not.toBeNull()
        expect(getBaselineState(handle.db, CAPABILITY.id)).toBe('done')
    })

    // SENTINEL-124: a retry rechecks the target's CURRENT policy; a stale summary is dropped, never sent.
    describe('after a failed attempt', function () {
        beforeEach(async function failOnce() {
            baselineEvent('p-a', 'critical', 'PyPI', 'django')
            baselineEvent('p-b', 'high', 'RubyGems', 'rack')
            target('hook')
            await onCompletedSweep(handle.db, [], { send: recordingSender([{ ok: false, errorText: 'down' }]), capabilities: CAPABILITIES })
            sent = []
        })

        it('makes zero sender calls once the target is disabled, and records why', async function () {
            setNotificationTargetEnabled(handle.db, 'hook', false)
            await onCompletedSweep(handle.db, [], { send: recordingSender(), capabilities: CAPABILITIES })
            setNotificationTargetEnabled(handle.db, 'hook', true)
            await onCompletedSweep(handle.db, [], { send: recordingSender(), capabilities: CAPABILITIES })
            expect(sent).toEqual([])
            expect(deliveries().get('hook')?.suppressedReason).toBe('target_disabled')
            expect(getBaselineState(handle.db, CAPABILITY.id)).toBe('done')
        })

        it('makes zero sender calls once its root scope is restricted', async function () {
            setTargetRoots(handle.db, 'hook', ['root-a'])
            await onCompletedSweep(handle.db, [], { send: recordingSender(), capabilities: CAPABILITIES })
            expect(sent).toEqual([])
            expect(deliveries().get('hook')?.suppressedReason).toBe('policy_changed')
        })

        it('makes zero sender calls once a counted finding is muted', async function () {
            insertMute(handle.db, { id: 'm1', scope: 'finding', projectId: 'p-a', scanner: 'osv', ecosystem: 'PyPI', advisoryId: 'GHSA-1', packageName: 'django', reason: 'accepted', author: 'ops', createdAt: T0, expiresAt: null })
            await onCompletedSweep(handle.db, [], { send: recordingSender(), capabilities: CAPABILITIES })
            expect(sent).toEqual([])
            expect(deliveries().get('hook')?.suppressedReason).toBe('eligibility_changed')
        })

        it('still retries and succeeds after a mute that touches nothing it counted', async function () {
            insertMute(handle.db, { id: 'm1', scope: 'finding', projectId: 'p-a', scanner: 'osv', ecosystem: 'npm', advisoryId: 'GHSA-1', packageName: 'django', reason: 'accepted', author: 'ops', createdAt: T0, expiresAt: null })
            await onCompletedSweep(handle.db, [], { send: recordingSender(), capabilities: CAPABILITIES })
            expect(sent).toHaveLength(1)
            expect(deliveries().get('hook')).toMatchObject({ suppressedAt: null, attempts: 2 })
            expect(deliveries().get('hook')?.firstSucceededAt).not.toBeNull()
        })
    })
})

// 3.8.1 (SENTINEL-159): a sweep closes a capability's baseline only if every enabled source answered for its
// languages. On the 3.8.0 upgrade a sweep ran while the OSV cache was rebuilding, its scans said "not
// downloaded yet", and the baseline closed on a summary of zero findings.
describe('a sweep in which a cache was not ready', function () {
    // One scan of the sweep, as the runner hands it back.
    function outcome(scanner: string, ecosystem: string, status: 'ok' | 'unauditable', reasonCode: ReasonCode): ProjectScanOutcome {
        return {
            project: { id: 'p-a' },
            scan: { id: 'scan-' + scanner + '-' + ecosystem, scanner, source: scanner, ecosystem, status, reasonCode },
            findings: []
        } as unknown as ProjectScanOutcome
    }

    afterEach(function restoreFeeds() {
        vi.unstubAllEnvs()
    })

    it('leaves the baseline pending when a source could not answer for one of its languages', async function () {
        baselineEvent('p-a')
        target('everything')
        await onCompletedSweep(handle.db, [outcome('osv', 'PyPI', 'ok', 'ok'), outcome('gemnasium', 'PyPI', 'unauditable', 'osv_db_not_seeded')], { send: recordingSender(), capabilities: CAPABILITIES })
        expect(getBaselineState(handle.db, CAPABILITY.id)).toBe('pending')
        expect(sent).toEqual([])
        expect(listSummaryDeliveries(handle.db, CAPABILITY.id)).toEqual([])
        expect(vi.mocked(console.log).mock.calls.map(function first(c) { return String(c[0]) }))
            .toContain('[baseline] languages-3.8 stays pending: 1 scan of its languages could not answer while an advisory cache was not ready')
    })

    it('counts the gemnasium cache not downloaded yet the same way', async function () {
        target('everything')
        const notReady = [outcome('gemnasium', 'RubyGems', 'unauditable', 'gemnasium_db_not_seeded'), outcome('gemnasium', 'PyPI', 'unauditable', 'gemnasium_db_not_seeded')]
        await onCompletedSweep(handle.db, notReady, { send: recordingSender(), capabilities: CAPABILITIES })
        expect(getBaselineState(handle.db, CAPABILITY.id)).toBe('pending')
        expect(vi.mocked(console.log).mock.calls.map(function first(c) { return String(c[0]) }))
            .toContain('[baseline] languages-3.8 stays pending: 2 scans of its languages could not answer while an advisory cache was not ready')
    })

    it('closes it on the next sweep, once every source answered', async function () {
        baselineEvent('p-a')
        target('everything')
        await onCompletedSweep(handle.db, [outcome('osv', 'PyPI', 'unauditable', 'osv_db_not_seeded')], { send: recordingSender(), capabilities: CAPABILITIES })
        await onCompletedSweep(handle.db, [outcome('osv', 'PyPI', 'ok', 'ok')], { send: recordingSender(), capabilities: CAPABILITIES })
        expect(getBaselineState(handle.db, CAPABILITY.id)).toBe('done')
        expect(sent).toHaveLength(1)
        expect(sent[0]?.message.text).toBe('Sentinello 3.8 now checks Python/Go/Rust/Ruby: 1 finding across 1 project, 0 critical')
    })

    // npm is no language of the capability: its cache rebuilding says nothing about what the summary counts.
    it('closes it when only another language waited on a cache', async function () {
        target('everything')
        await onCompletedSweep(handle.db, [outcome('osv', 'npm', 'unauditable', 'osv_db_not_seeded'), outcome('osv', 'PyPI', 'ok', 'ok')], { send: recordingSender(), capabilities: CAPABILITIES })
        expect(getBaselineState(handle.db, CAPABILITY.id)).toBe('done')
    })

    // Every other failure is the project's or the install's for good, and is reported as such: waiting for it
    // would hold the baseline until someone fixes it.
    it('closes it on a failure that is not a cache getting ready', async function () {
        target('everything')
        await onCompletedSweep(handle.db, [outcome('osv', 'PyPI', 'unauditable', 'no_lockfile'), outcome('gemnasium', 'PyPI', 'unauditable', 'gemnasium_db_unavailable')], { send: recordingSender(), capabilities: CAPABILITIES })
        expect(getBaselineState(handle.db, CAPABILITY.id)).toBe('done')
    })

    // A feed switched off downloads nothing: its "not downloaded yet" is final, never a cache on its way.
    it('closes it when the feed of the cache that is not ready is switched off', async function () {
        target('everything')
        vi.stubEnv('SENTINELLO_OSV_FEED_URL', 'off')
        vi.stubEnv('SENTINELLO_GEMNASIUM_FEED_URL', 'off')
        const final = [outcome('osv', 'PyPI', 'unauditable', 'osv_db_not_seeded'), outcome('gemnasium', 'RubyGems', 'unauditable', 'gemnasium_db_not_seeded')]
        await onCompletedSweep(handle.db, final, { send: recordingSender(), capabilities: CAPABILITIES })
        expect(getBaselineState(handle.db, CAPABILITY.id)).toBe('done')
    })

    it('still holds a gemnasium cell whose own feed is on while only the OSV feed is off', async function () {
        target('everything')
        vi.stubEnv('SENTINELLO_OSV_FEED_URL', 'off')
        await onCompletedSweep(handle.db, [outcome('gemnasium', 'Go', 'unauditable', 'gemnasium_db_not_seeded')], { send: recordingSender(), capabilities: CAPABILITIES })
        expect(getBaselineState(handle.db, CAPABILITY.id)).toBe('pending')
    })
})

// SENTINEL-125: two overlapping dispatches make one sender call per summary.
describe('exclusive dispatch', function () {
    // A sender whose first call blocks until the test releases it.
    function blockedSender(): { send: NotificationSender; release: () => void; calls: () => number } {
        let calls = 0
        let release: () => void = function unset() {}
        const gate = new Promise<void>(function hold(resolve) { release = resolve })
        return {
            send: async function send(t, message) {
                calls += 1
                sent.push({ targetId: t.id, message })
                if (calls === 1) await gate
                return { ok: true }
            },
            release: function go() { release() },
            calls: function count() { return calls }
        }
    }

    it.each([
        ['a fresh summary', false],
        ['a summary whose earlier attempt failed', true]
    ])('sends %s once while a second dispatch waits behind the first', async function (_label, failedBefore) {
        baselineEvent('p-a')
        target('hook')
        claimCompletedBaselines(handle.db, CAPABILITIES, T0)
        if (failedBefore) await dispatch(recordingSender([{ ok: false, errorText: 'down' }]))
        sent = []
        const blocked = blockedSender()
        const first = dispatch(blocked.send)
        const second = dispatch(blocked.send)
        await vi.waitFor(function started() { expect(blocked.calls()).toBe(1) })
        blocked.release()
        await Promise.all([first, second])
        expect(blocked.calls()).toBe(1)
        expect(deliveries().get('hook')?.attempts).toBe(failedBefore ? 2 : 1)
    })

    it('keeps serving the queue after a dispatch that threw', async function () {
        baselineEvent('p-a')
        target('hook')
        claimCompletedBaselines(handle.db, CAPABILITIES, T0)
        await expect(dispatch(async function boom() { throw new Error('transport exploded') })).rejects.toThrow('transport exploded')
        await dispatch(recordingSender())
        expect(sent).toHaveLength(1)
        expect(deliveries().get('hook')?.attempts).toBe(2)
    })

    it('skips a summary whose target is deleted while an earlier one is being sent', async function () {
        baselineEvent('p-a')
        target('a-first')
        target('b-second')
        claimCompletedBaselines(handle.db, CAPABILITIES, T0)
        await dispatch(async function deleteTheOther(t, message) {
            sent.push({ targetId: t.id, message })
            deleteNotificationTarget(handle.db, t.id === 'a-first' ? 'b-second' : 'a-first')
            return { ok: true }
        })
        expect(sent).toHaveLength(1)
        expect(getBaselineState(handle.db, CAPABILITY.id)).toBe('done')
    })

    // A crash between recording the attempt and recording its outcome: the next process does not know whether
    // the channel took it, so it retries — once.
    it('retries, once, an attempt a previous process recorded without an outcome', async function () {
        baselineEvent('p-a')
        target('hook')
        claimCompletedBaselines(handle.db, CAPABILITIES, T0)
        handle.db.update(schema.capabilitySummaryDeliveries).set({ attempts: 1, firstAttemptedAt: T0, lastAttemptedAt: T0 }).run()
        vi.resetModules()
        const restarted = await import('./capability-baseline')
        await restarted.dispatchCapabilitySummaries({ db: handle.db, dryRun: false, send: recordingSender(), capabilities: CAPABILITIES })
        await restarted.dispatchCapabilitySummaries({ db: handle.db, dryRun: false, send: recordingSender(), capabilities: CAPABILITIES })
        expect(sent).toHaveLength(1)
        expect(deliveries().get('hook')).toMatchObject({ attempts: 2 })
        expect(deliveries().get('hook')?.firstSucceededAt).not.toBeNull()
    })
})
