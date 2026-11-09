import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NotificationTarget, Severity } from '@sentinello/core'
import {
    getDashboardSummary,
    insertMute,
    insertNotificationTarget,
    insertScan,
    listDigestDeliveries,
    schema,
    setConfigValue,
    setNotificationTargetDigest,
    setNotificationTargetEnabled,
    upsertRoot
} from '@sentinello/db'
import type { NotificationSender, RenderedMessage, SendResult } from '@sentinello/notifications'
import { closeWorkerTestDb, openWorkerTestDb, seedProject, T0, type WorkerTestDb } from './worker-test-db.fixture'
import { runDigestTick } from './weekly-digest'

// The production transport, so no test can reach a real network send: the one that names no sender records here.
const transport = vi.hoisted(function holder() { return { sent: [] as string[] } })

vi.mock('./transport', function mockTransport() {
    return {
        sendByKind: async function sendByKind(target: { id: string }) {
            transport.sent.push(target.id)
            return { ok: true }
        }
    }
})

// One digest per enabled target per calendar week. The due-time arithmetic has its own test in core; these replay
// the tick against the real ledger, with a fixed clock and a recording sender. 2026-11-02 is a Monday, ISO week 45.

const MONDAY_0900_UTC = Date.UTC(2026, 10, 2, 9)
const HOUR = 3_600_000
const DAY = 24 * HOUR

let handle: WorkerTestDb
let sent: { targetId: string; message: RenderedMessage }[]
let answers: SendResult[]

const send: NotificationSender = async function recording(target, message) {
    sent.push({ targetId: target.id, message })
    return answers.shift() ?? { ok: true }
}

function target(id: string, overrides: Partial<NotificationTarget> = {}): void {
    insertNotificationTarget(handle.db, {
        id, kind: 'webhook', config: { url: 'https://hooks.example.test/' + id }, severityFilter: ['critical', 'high', 'moderate', 'low', 'info'], envFilter: 'all', enabled: true,
        createdAt: T0, rootIds: [], projectIds: [], sourceScope: { mode: 'all', cells: [] }, delivery: 'per_project', weeklyDigest: true, digestEligibleSinceAt: null, ...overrides
    })
}

function tick(now: number): Promise<void> {
    return runDigestTick({ db: handle.db, send, now })
}

function zone(timezone: string): void {
    setConfigValue(handle.db, 'schedule', { intervalHours: 24, startHour: 0, timezone })
}

function schedule(day: number, hour: number): void {
    setConfigValue(handle.db, 'weeklyDigest', { day, hour })
}

let seq = 0

function finding(projectId: string, severity: Severity, overrides: Partial<typeof schema.findings.$inferInsert> = {}): void {
    seq += 1
    handle.db.insert(schema.findings).values({
        id: 'f-' + seq, scanId: 'scan-' + projectId, projectId, scanner: 'npm-audit', source: 'npm-audit', ecosystem: 'npm', advisoryId: 'GHSA-' + seq, packageName: 'pkg-' + seq,
        installedVersion: '1.0.0', vulnerableRange: '<2', severity, firstDetectedAt: T0, lastSeenAt: T0, ...overrides
    }).run()
}

function scan(projectId: string, status: 'ok' | 'error' = 'ok'): void {
    insertScan(handle.db, {
        id: 'scan-' + projectId, projectId, startedAt: T0, finishedAt: T0, scanner: 'npm-audit', source: 'npm-audit', ecosystem: 'npm', status,
        reasonCode: status === 'ok' ? 'ok' : 'audit_spawn_error', durationMs: 1, errorText: null, rawJson: '{}'
    })
}

beforeEach(async function setup() {
    handle = await openWorkerTestDb('worker-digest')
    vi.spyOn(console, 'log').mockImplementation(function silence() {})
    vi.spyOn(console, 'error').mockImplementation(function silence() {})
    sent = []
    answers = []
    transport.sent = []
    seq = 0
    zone('UTC')
    upsertRoot(handle.db, { id: 'root-a', path: '/roots/a', label: null, createdAt: T0 })
    seedProject(handle.db, { id: 'p-a', rootId: 'root-a', relPath: 'svc', name: 'svc' })
    seedProject(handle.db, { id: 'p-b', rootId: 'root-a', relPath: 'shop', name: 'shop' })
    scan('p-a')
    scan('p-b')
})

afterEach(async function teardown() {
    vi.restoreAllMocks()
    await closeWorkerTestDb(handle)
})

describe('one digest per week', function () {
    it('goes out once at the due hour, and not again across ticks or a restart', async function () {
        target('t')
        await tick(MONDAY_0900_UTC - 1000)
        sent = []
        await tick(MONDAY_0900_UTC - 1)
        expect(sent).toEqual([])
        await tick(MONDAY_0900_UTC)
        expect(sent).toHaveLength(1)
        await tick(MONDAY_0900_UTC + 15 * 60_000)
        await tick(MONDAY_0900_UTC + 2 * DAY)
        expect(sent).toHaveLength(1)
        await tick(MONDAY_0900_UTC + 7 * DAY)
        expect(sent).toHaveLength(2)
    })

    it('goes through the production transport when the tick is given no sender, and closes the row', async function () {
        target('t')
        await runDigestTick({ db: handle.db, now: MONDAY_0900_UTC })
        expect(transport.sent).toEqual(['t'])
        expect(sent).toEqual([])
        expect(listDigestDeliveries(handle.db, 't')[0]?.firstSucceededAt).toBe(MONDAY_0900_UTC)
    })

    it('still says so with nothing outstanding, and links the portal', async function () {
        target('t')
        setConfigValue(handle.db, 'portalBaseUrl', 'https://sentinello.example/')
        await tick(MONDAY_0900_UTC)
        expect(sent[0]?.message.markdown).toBe('*Sentinello weekly digest:* Nothing outstanding\n*Portal:* https://sentinello.example')
    })

    it('sends one after a worker was down for weeks, and closes what those weeks left open', async function () {
        target('t')
        answers = [{ ok: false, errorText: 'down' }]
        await tick(MONDAY_0900_UTC - 21 * DAY)
        sent = []
        await tick(MONDAY_0900_UTC + 3 * DAY)
        expect(sent).toHaveLength(1)
        const rows = listDigestDeliveries(handle.db, 't')
        expect(rows.map(function key(r) { return r.weekKey })).toEqual(['2026-W45', '2026-W42'])
        expect(rows[1]?.suppressedReason).toBe('superseded')
    })

    it('retries hourly after a failure, tells it once, and gives up when the budget is spent', async function () {
        target('t')
        answers = [{ ok: false, errorText: 'down' }]
        await tick(MONDAY_0900_UTC)
        await tick(MONDAY_0900_UTC + 15 * 60_000)
        expect(sent).toHaveLength(1)
        await tick(MONDAY_0900_UTC + HOUR)
        expect(sent).toHaveLength(2)
        await tick(MONDAY_0900_UTC + 2 * HOUR)
        expect(sent).toHaveLength(2)
        expect(listDigestDeliveries(handle.db, 't')[0]?.firstSucceededAt).not.toBeNull()
        target('dead')
        sent = []
        answers = Array.from({ length: 5 }, function down() { return { ok: false as const, errorText: 'down' } })
        for (let hour = 0; hour < 8; hour++) await tick(MONDAY_0900_UTC + hour * HOUR)
        expect(to('dead')).toHaveLength(5)
        expect(listDigestDeliveries(handle.db, 'dead')[0]?.gaveUpAt).not.toBeNull()
        expect(listDigestDeliveries(handle.db, 'dead')[0]?.lastErrorText).toBe('down')
    })

    it('closes a row whose budget a crash spent', async function () {
        target('t')
        answers = [{ ok: false, errorText: 'down' }]
        await tick(MONDAY_0900_UTC)
        handle.db.update(schema.digestDeliveries).set({ attempts: 5 }).run()
        sent = []
        await tick(MONDAY_0900_UTC + HOUR)
        expect(sent).toEqual([])
        expect(listDigestDeliveries(handle.db, 't')[0]?.gaveUpAt).not.toBeNull()
    })

    it('in dry run logs, closes the row, and sends nothing late', async function () {
        target('t')
        setConfigValue(handle.db, 'dryRunNotify', true)
        await tick(MONDAY_0900_UTC)
        setConfigValue(handle.db, 'dryRunNotify', false)
        await tick(MONDAY_0900_UTC + HOUR)
        expect(sent).toEqual([])
        expect(listDigestDeliveries(handle.db, 't')[0]?.dryRunAt).not.toBeNull()
    })

    it('a timezone it does not know fails the tick, loudly, and sends nothing', async function () {
        target('t')
        zone('Mars/Olympus')
        await expect(tick(MONDAY_0900_UTC)).rejects.toThrow()
        expect(sent).toEqual([])
    })
})

function to(id: string): RenderedMessage[] {
    return sent.filter(function mine(s) { return s.targetId === id }).map(function message(s) { return s.message })
}

describe('who is owed', function () {
    it('nothing for a target disabled at the due instant, and turning it back on the same week sends nothing until next week', async function () {
        target('t', { enabled: false })
        await tick(MONDAY_0900_UTC)
        expect(listDigestDeliveries(handle.db, 't')[0]?.suppressedReason).toBe('target_disabled')
        setNotificationTargetEnabled(handle.db, 't', true, MONDAY_0900_UTC + HOUR)
        await tick(MONDAY_0900_UTC + 2 * HOUR)
        expect(sent).toEqual([])
        await tick(MONDAY_0900_UTC + 7 * DAY)
        expect(sent).toHaveLength(1)
    })

    it('nothing for a target with the digest off', async function () {
        target('t', { weeklyDigest: false })
        await tick(MONDAY_0900_UTC)
        expect(sent).toEqual([])
        expect(listDigestDeliveries(handle.db, 't')[0]?.suppressedReason).toBe('digest_off')
    })

    it('nothing when it was disabled at due and enabled before the worker restarted, for either flag', async function () {
        target('enabled-flag', { enabled: false })
        target('digest-flag', { weeklyDigest: false })
        // No tick sees either: the worker is down across the due instant.
        setNotificationTargetEnabled(handle.db, 'enabled-flag', true, MONDAY_0900_UTC + HOUR)
        setNotificationTargetDigest(handle.db, 'digest-flag', true, MONDAY_0900_UTC + HOUR)
        await tick(MONDAY_0900_UTC + 2 * HOUR)
        expect(sent).toEqual([])
        expect(listDigestDeliveries(handle.db, 'enabled-flag')[0]?.suppressedReason).toBe('not_eligible_at_due')
        expect(listDigestDeliveries(handle.db, 'digest-flag')[0]?.suppressedReason).toBe('not_eligible_at_due')
    })

    it('nothing for a target created after the due instant', async function () {
        target('late', { createdAt: MONDAY_0900_UTC + HOUR })
        await tick(MONDAY_0900_UTC + 2 * HOUR)
        expect(sent).toEqual([])
        await tick(MONDAY_0900_UTC + 7 * DAY)
        expect(sent).toHaveLength(1)
    })

    // A row from before the column has no boundary of its own: how old the target is decides.
    it('judges a target with no eligibility boundary by when it was created', async function () {
        target('old')
        target('late', { createdAt: MONDAY_0900_UTC + HOUR })
        handle.db.update(schema.notificationTargets).set({ digestEligibleSinceAt: null }).run()
        await tick(MONDAY_0900_UTC + 2 * HOUR)
        expect(to('old')).toHaveLength(1)
        expect(to('late')).toEqual([])
        expect(listDigestDeliveries(handle.db, 'late')[0]?.suppressedReason).toBe('not_eligible_at_due')
    })

    it('suppresses an open retry of a target switched off since, either way', async function () {
        target('a')
        target('b')
        answers = [{ ok: false, errorText: 'down' }, { ok: false, errorText: 'down' }]
        await tick(MONDAY_0900_UTC)
        setNotificationTargetEnabled(handle.db, 'a', false, MONDAY_0900_UTC + 1)
        setNotificationTargetDigest(handle.db, 'b', false, MONDAY_0900_UTC + 1)
        sent = []
        await tick(MONDAY_0900_UTC + HOUR)
        expect(sent).toEqual([])
        expect(listDigestDeliveries(handle.db, 'a')[0]?.suppressedReason).toBe('target_disabled')
        expect(listDigestDeliveries(handle.db, 'b')[0]?.suppressedReason).toBe('digest_off')
    })
})

describe('schedule edits', function () {
    it('Monday\'s digest, then a move to Tuesday, sends no second one that week', async function () {
        target('t')
        await tick(MONDAY_0900_UTC)
        schedule(2, 9)
        await tick(MONDAY_0900_UTC + DAY)
        expect(sent).toHaveLength(1)
        expect(listDigestDeliveries(handle.db, 't')).toHaveLength(1)
        await tick(MONDAY_0900_UTC + 8 * DAY)
        expect(sent).toHaveLength(2)
    })

    it('moving the day earlier in a week with no row sends at the next tick, like a worker that was down', async function () {
        target('t')
        schedule(5, 9)
        await tick(MONDAY_0900_UTC + DAY)
        const before = sent.length
        schedule(1, 9)
        // Tuesday of W45: Friday's week was W44, whose row reserves nothing of this one.
        await tick(MONDAY_0900_UTC + DAY + 15 * 60_000)
        expect(sent).toHaveLength(before + 1)
    })

    it('a timezone edit across a week boundary does not mint a second week', async function () {
        target('t')
        // Monday 2026-11-02 09:00 in Pacific/Kiritimati, UTC+14, is Sunday 2026-11-01 19:00 UTC: week 45 there, week 44 in UTC.
        schedule(1, 9)
        zone('Pacific/Kiritimati')
        const kiritimatiMonday = Date.UTC(2026, 10, 1, 19)
        await tick(kiritimatiMonday)
        expect(sent).toHaveLength(1)
        expect(listDigestDeliveries(handle.db, 't')[0]?.weekKey).toBe('2026-W45')
        // The same instant in UTC is Sunday, week 44. Later that Sunday, a Sunday digest in UTC reads W44, and the row
        // above re-keys to W44 under the new zone, at or after it: it reserves the week.
        zone('UTC')
        schedule(0, 20)
        await tick(Date.UTC(2026, 10, 1, 20))
        expect(sent).toHaveLength(1)
    })

    it('a failed attempt, then a day edit, then a timezone edit, retries on its own row: one message', async function () {
        target('t')
        answers = [{ ok: false, errorText: 'down' }]
        await tick(MONDAY_0900_UTC)
        schedule(3, 9)
        zone('Asia/Kolkata')
        sent = []
        await tick(MONDAY_0900_UTC + 3 * DAY + HOUR)
        expect(sent).toHaveLength(1)
        const rows = listDigestDeliveries(handle.db, 't')
        expect(rows).toHaveLength(1)
        expect(rows[0]?.firstSucceededAt).not.toBeNull()
        await tick(MONDAY_0900_UTC + 4 * DAY)
        expect(sent).toHaveLength(1)
    })

    it('fires in Asia/Kathmandu at its local hour', async function () {
        target('t')
        zone('Asia/Kathmandu')
        await tick(Date.UTC(2026, 10, 2, 3, 14, 58))
        sent = []
        await tick(Date.UTC(2026, 10, 2, 3, 14, 59))
        expect(sent).toEqual([])
        await tick(Date.UTC(2026, 10, 2, 3, 15))
        expect(sent).toHaveLength(1)
    })
})

describe('what it says', function () {
    it('counts what the dashboard counts under equal filters, and lists critical and high', async function () {
        target('t')
        finding('p-a', 'critical', { packageName: 'axios' })
        finding('p-a', 'high', { packageName: 'lodash', fixStatus: 'released', fixVersion: '2.0.0', fixAvailable: true, fixCheckJson: JSON.stringify({ v: 1, checkedAt: T0, registry: 'ok', packageDataAsOf: T0, unevaluable: null, sources: [] }) })
        finding('p-b', 'moderate')
        finding('p-b', 'unrated')
        finding('p-b', 'low')
        // One vulnerability two sources report counts once.
        finding('p-a', 'high', { packageName: 'qs', advisoryKey: 'GHSA-same', advisoryId: 'GHSA-same' })
        finding('p-a', 'high', { packageName: 'qs', advisoryKey: 'GHSA-same', advisoryId: 'GHSA-same', source: 'osv', scanner: 'osv' })
        setConfigValue(handle.db, 'sources.osv.npm.enabled', true)
        await tick(MONDAY_0900_UTC)
        const counts = (sent[0]?.message.webhook as { counts: Record<Severity, number> }).counts
        expect(counts).toEqual(getDashboardSummary(handle.db, MONDAY_0900_UTC, 'all').severityCounts)
        expect(counts).toEqual({ critical: 1, high: 2, moderate: 1, unrated: 1, low: 1, info: 0 })
        expect(sent[0]?.message.markdown).toContain('*CRITICAL*\n• svc › axios (Node.js): 1 advisory, no fix released')
        expect(sent[0]?.message.markdown).toContain('• svc › lodash (Node.js): 1 advisory, fix 2.0.0')
        expect(sent[0]?.message.markdown).toContain('• svc › qs (Node.js): 1 advisory')
    })

    // The portal is another process, and can delete the project between the worker's reads.
    it('names a project that is gone by its id', async function () {
        target('t')
        finding('p-a', 'high', { packageName: 'lodash' })
        handle.sqlite.pragma('foreign_keys = OFF')
        handle.sqlite.prepare('DELETE FROM projects WHERE id = ?').run('p-a')
        await tick(MONDAY_0900_UTC)
        expect(sent[0]?.message.markdown).toContain('• p-a › lodash (Node.js): 1 advisory')
    })

    it('narrows by the target\'s severity filter, env filter, root scope and mutes', async function () {
        finding('p-a', 'critical', { isProd: false, isDev: true })
        finding('p-a', 'high')
        finding('p-b', 'moderate')
        finding('p-b', 'unrated')
        target('critical-only', { severityFilter: ['critical'] })
        target('moderate-only', { severityFilter: ['moderate'] })
        target('prod', { envFilter: 'prod' })
        insertMute(handle.db, { id: 'm', scope: 'project', projectId: 'p-b', reason: 'r', author: 'a', createdAt: T0, expiresAt: null })
        await tick(MONDAY_0900_UTC)
        function countsOf(id: string) { return (to(id)[0]?.webhook as { counts: Record<Severity, number> }).counts }
        expect(countsOf('critical-only').critical).toBe(1)
        expect(countsOf('critical-only').high).toBe(0)
        expect(countsOf('moderate-only')).toEqual({ critical: 0, high: 0, moderate: 0, unrated: 0, low: 0, info: 0 })
        expect(countsOf('prod').critical).toBe(0)
        expect(countsOf('prod').high).toBe(1)
        expect((to('moderate-only')[0]?.webhook as { listed: unknown[] }).listed).toEqual([])
    })

    it('lists what cannot be scanned, by the same query as the run summary, and a project mute hides it', async function () {
        target('t')
        handle.db.delete(schema.scans).run()
        scan('p-a', 'error')
        scan('p-b', 'error')
        insertMute(handle.db, { id: 'm', scope: 'project', projectId: 'p-b', reason: 'r', author: 'a', createdAt: T0, expiresAt: null })
        await tick(MONDAY_0900_UTC)
        expect(sent[0]?.message.markdown).toContain('*Cannot be fully scanned*\n• svc:')
        expect(sent[0]?.message.markdown).not.toContain('• shop:')
        expect(sent[0]?.message.title).toContain('Nothing outstanding')
    })
})
