import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { senderFor, type NotificationSender } from '@sentinello/notifications'
import type { NotificationTarget, Finding, Project, Scan } from '@sentinello/core'
import {
    getDelivery,
    insertNotificationTarget,
    insertScan,
    listEventsForProject,
    openDb,
    runMigrations,
    setConfigValue,
    upsertProject,
    upsertRoot,
    type DrizzleDb,
    type SqliteDb
} from '@sentinello/db'
import { notifyForCompletedScan, normalizeFailureSignature } from './notifier'
import { CONFIG_KEYS } from './config-loader'
import type { ProjectScanOutcome } from './runner'

// The notifier does not decide WHAT to dispatch — selectDispatchablePairs does, and it is covered in
// packages/db. This suite is about the dispatch flow around it.
//
// The ordering rule is the load-bearing one: the attempt is recorded BEFORE the POST, so a crash
// between sending and recording success yields at most one duplicate rather than an unbounded
// resend loop. Grouping matters too — one batched message per target per scan, not one per finding,
// which is the difference between a notification and a flood.
//
// senderFor is mocked because the real senders POST over the network.

vi.mock('@sentinello/notifications', async function mockNotifications(importOriginal) {
    const actual = await importOriginal<typeof import('@sentinello/notifications')>()
    return { ...actual, senderFor: vi.fn() }
})

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'db', 'drizzle')

const ROOT_ID = 'root-1'
const PROJECT_ID = 'project-1'
const TARGET_ID = 'target-1'
const SCAN_ID = 'scan-1'
const T0 = Date.UTC(2026, 0, 1)

let db: DrizzleDb
let sqlite: SqliteDb
let dir: string
let send: ReturnType<typeof vi.fn> & NotificationSender

function target(overrides: Partial<NotificationTarget> = {}): NotificationTarget {
    return {
        id: TARGET_ID,
        kind: 'webhook',
        config: { url: 'https://hooks.example.test/incoming' },
        severityFilter: ['critical', 'high'],
        envFilter: 'all',
        enabled: true,
        createdAt: T0 - 1000,
        rootIds: [],
        projectIds: [],
        sourceScope: { mode: 'all', cells: [] },
        ...overrides
    }
}

function project(): Project {
    return {
        id: PROJECT_ID,
        rootId: ROOT_ID,
        relPath: 'app',
        name: 'app',
        alias: null,
        packageManager: 'npm',
        nvmrcVersion: null,
        gitBranch: 'main',
        ecosystems: ['npm'],
        muted: false,
        tags: [],
        createdAt: T0,
        updatedAt: T0
    }
}

function finding(overrides: Partial<Finding> = {}): Finding {
    return {
        id: 'finding-' + (overrides.advisoryId || 'CVE-2024-1'),
        projectId: PROJECT_ID,
        scanId: SCAN_ID,
        scanner: 'osv',
        source: 'osv',
        ecosystem: 'npm',
        advisoryId: 'CVE-2024-1',
        advisoryTitle: 'Prototype pollution',
        advisoryUrl: 'https://example.test/1',
        packageName: 'lodash',
        installedVersion: '4.17.11',
        vulnerableRange: '<4.17.21',
        severity: 'high',
        fixAvailable: true,
        fixVersion: '4.17.21',
        depPath: ['lodash'],
        isProd: true,
        isDev: false,
        firstDetectedAt: T0,
        lastSeenAt: T0,
        resolvedAt: null,
        ...overrides
    } as unknown as Finding
}

function scan(overrides: Partial<Scan> = {}): Scan {
    return {
        id: SCAN_ID,
        projectId: PROJECT_ID,
        startedAt: T0 - 1000,
        finishedAt: T0,
        scanner: 'osv',
        source: 'osv',
        ecosystem: 'npm',
        status: 'ok',
        reasonCode: 'ok',
        durationMs: 1000,
        errorText: null,
        rawJson: '',
        ...overrides
    } as Scan
}

function outcome(findings: Finding[], scanOverrides: Partial<Scan> = {}): ProjectScanOutcome {
    return { project: project(), scan: scan(scanOverrides), findings }
}

async function notify(o: ProjectScanOutcome, dryRun = false): Promise<void> {
    await notifyForCompletedScan({ db, outcome: o, dryRun })
}

beforeEach(async function setup() {
    vi.clearAllMocks()
    send = vi.fn(async function ok() { return { ok: true as const } }) as typeof send
    vi.mocked(senderFor).mockReturnValue(send)

    dir = await mkdtemp(join(tmpdir(), 'sentinello-notifier-'))
    const opened = openDb({ dbPath: join(dir, 'test.sqlite') })
    db = opened.db
    sqlite = opened.sqlite
    runMigrations(db, { migrationsFolder: MIGRATIONS })
    upsertRoot(db, { id: ROOT_ID, path: '/repo', label: 'Repos', createdAt: T0 })
    upsertProject(db, project())
    insertScan(db, scan())
    vi.spyOn(console, 'log').mockImplementation(function silence() {})
    vi.spyOn(console, 'error').mockImplementation(function silence() {})
})

afterEach(async function teardown() {
    vi.restoreAllMocks()
    sqlite.close()
    await rm(dir, { recursive: true, force: true })
})

describe('notifyForCompletedScan — event recording', function () {
    it('does nothing when the project no longer exists', async function () {
        const gone = outcome([finding()])
        gone.project = { ...project(), id: 'deleted-project' }
        await notify(gone)
        expect(send).not.toHaveBeenCalled()
    })

    it('records a discovery event for each finding', async function () {
        await notify(outcome([finding(), finding({ advisoryId: 'CVE-2024-2', packageName: 'express' })]))
        expect(listEventsForProject(db, PROJECT_ID)).toHaveLength(2)
    })

    it('records a scan-failure event for a non-ok scan', async function () {
        await notify(outcome([], { status: 'error', reasonCode: 'audit_unknown_failure', errorText: 'boom' }))
        const events = listEventsForProject(db, PROJECT_ID)
        expect(events).toHaveLength(1)
        expect(events[0]?.eventType).toBe('scan_failure')
    })

    it('records no failure event for an ok scan', async function () {
        await notify(outcome([finding()]))
        const events = listEventsForProject(db, PROJECT_ID)
        expect(events.every(function isFinding(e) { return e.eventType === 'finding' })).toBe(true)
    })

    it('sends nothing when there are no targets', async function () {
        await notify(outcome([finding()]))
        expect(send).not.toHaveBeenCalled()
    })
})

describe('notifyForCompletedScan — dispatch', function () {
    it('sends one batched message per target rather than one per finding', async function () {
        insertNotificationTarget(db, target())
        await notify(outcome([
            finding(),
            finding({ advisoryId: 'CVE-2024-2', packageName: 'express' }),
            finding({ advisoryId: 'CVE-2024-3', packageName: 'axios' })
        ]))
        expect(send).toHaveBeenCalledTimes(1)
    })

    it('sends to every eligible target', async function () {
        insertNotificationTarget(db, target({ id: 'a' }))
        insertNotificationTarget(db, target({ id: 'b' }))
        await notify(outcome([finding()]))
        expect(send).toHaveBeenCalledTimes(2)
    })

    it('sends findings and scan failures as separate messages', async function () {
        insertNotificationTarget(db, target())
        await notify(outcome([finding()], { status: 'error', reasonCode: 'audit_unknown_failure', errorText: 'boom' }))
        expect(send).toHaveBeenCalledTimes(2)
    })

    // Only webhook targets receive the structured payload; Slack and Telegram ignore it, so building
    // it for them would be wasted work carrying finding data they never use.
    it('attaches the webhook payload only for webhook targets', async function () {
        insertNotificationTarget(db, target({ kind: 'webhook' }))
        await notify(outcome([finding()]))
        expect(send.mock.calls[0]?.[1].webhook).toBeDefined()
        expect(send.mock.calls[0]?.[1].webhook.event).toBe('findings')

        send.mockClear()
        insertNotificationTarget(db, target({ id: 'slack-1', kind: 'slack', config: { webhookUrl: 'https://hooks.example.test/s' } }))
        await notify(outcome([finding({ advisoryId: 'CVE-2024-9' })]))
        const slackCall = send.mock.calls.find(function isSlack(c) { return c[0].kind === 'slack' })
        expect(slackCall?.[1].webhook).toBeUndefined()
    })

    it('marks a first-ever notification as a baseline', async function () {
        insertNotificationTarget(db, target())
        await notify(outcome([finding()]))
        expect(send.mock.calls[0]?.[1].webhook.isBaseline).toBe(true)
    })

    it('includes the portal url when one is configured', async function () {
        setConfigValue(db, CONFIG_KEYS.portalBaseUrl, 'https://portal.example.test')
        insertNotificationTarget(db, target())
        await notify(outcome([finding()]))
        expect(send.mock.calls[0]?.[1].portalUrl).toContain('https://portal.example.test')
    })

    it('carries the root context into the webhook payload', async function () {
        insertNotificationTarget(db, target())
        await notify(outcome([finding()]))
        expect(send.mock.calls[0]?.[1].webhook.root).toMatchObject({ id: ROOT_ID, label: 'Repos' })
    })
})

describe('notifyForCompletedScan — delivery bookkeeping', function () {
    // The ordering rule: attempt is recorded before the POST, so a crash mid-send costs at most one
    // duplicate instead of resending forever.
    it('records the attempt before sending', async function () {
        insertNotificationTarget(db, target())
        let attemptedWhenSent: number | null | undefined
        send.mockImplementation(async function capture() {
            const eventId = listEventsForProject(db, PROJECT_ID)[0]?.id as string
            attemptedWhenSent = getDelivery(db, eventId, TARGET_ID)?.firstAttemptedAt
            return { ok: true as const }
        })
        await notify(outcome([finding()]))
        expect(attemptedWhenSent).toEqual(expect.any(Number))
    })

    it('records success and stamps the event as notified', async function () {
        insertNotificationTarget(db, target())
        await notify(outcome([finding()]))
        const event = listEventsForProject(db, PROJECT_ID)[0]
        expect(getDelivery(db, event?.id as string, TARGET_ID)?.firstSucceededAt).toEqual(expect.any(Number))
        expect(event && listEventsForProject(db, PROJECT_ID)[0]?.firstNotifiedAt).toEqual(expect.any(Number))
    })

    it('records a failure without marking the event notified', async function () {
        insertNotificationTarget(db, target())
        send.mockResolvedValue({ ok: false, errorText: 'HTTP 500 from the webhook' })
        await notify(outcome([finding()]))
        const event = listEventsForProject(db, PROJECT_ID)[0]
        const delivery = getDelivery(db, event?.id as string, TARGET_ID)
        expect(delivery?.firstSucceededAt).toBeNull()
        expect(delivery?.lastErrorText).toContain('HTTP 500')
        expect(event?.firstNotifiedAt).toBeNull()
    })

    // The error text is persisted and rendered in the portal, so it goes through redaction first.
    it('redacts credentials out of a recorded failure', async function () {
        insertNotificationTarget(db, target())
        send.mockResolvedValue({
            ok: false,
            errorText: 'failed posting to https://hooks.slack.com/services/not-a-real-webhook'
        })
        await notify(outcome([finding()]))
        const event = listEventsForProject(db, PROJECT_ID)[0]
        const text = getDelivery(db, event?.id as string, TARGET_ID)?.lastErrorText || ''
        expect(text).not.toContain('not-a-real-webhook')
        expect(text).toContain('REDACTED')
    })

    it('does not resend an event that already succeeded', async function () {
        insertNotificationTarget(db, target())
        await notify(outcome([finding()]))
        expect(send).toHaveBeenCalledTimes(1)
        send.mockClear()
        await notify(outcome([finding()]))
        expect(send).not.toHaveBeenCalled()
    })

    it('retries an event whose delivery failed', async function () {
        insertNotificationTarget(db, target())
        send.mockResolvedValue({ ok: false, errorText: 'transient' })
        await notify(outcome([finding()]))
        send.mockClear()
        send.mockResolvedValue({ ok: true })
        await notify(outcome([finding()]))
        expect(send).toHaveBeenCalledTimes(1)
    })
})

describe('notifyForCompletedScan — dry run', function () {
    // Dry run must not touch the delivery ledger either, or the real send afterwards would be
    // suppressed as already-attempted.
    it('sends nothing and records nothing', async function () {
        insertNotificationTarget(db, target())
        await notify(outcome([finding()]), true)
        expect(send).not.toHaveBeenCalled()
        const event = listEventsForProject(db, PROJECT_ID)[0]
        expect(getDelivery(db, event?.id as string, TARGET_ID)).toBeNull()
    })

    it('still records the discovery events', async function () {
        insertNotificationTarget(db, target())
        await notify(outcome([finding()]), true)
        expect(listEventsForProject(db, PROJECT_ID)).toHaveLength(1)
    })
})

describe('normalizeFailureSignature', function () {
    // The signature is the dedupe key for scan-failure events. If it varied with a timestamp or a
    // path inside the error text, every failing scan would notify again instead of once.
    it('is stable across runs with the same status and reason', function () {
        const a = normalizeFailureSignature('error', 'audit_unknown_failure', 'failed at 12:01:33')
        const b = normalizeFailureSignature('error', 'audit_unknown_failure', 'failed at 18:44:02')
        expect(a).toBe(b)
    })

    it('distinguishes different reason codes', function () {
        expect(normalizeFailureSignature('error', 'audit_spawn_error', null))
            .not.toBe(normalizeFailureSignature('error', 'audit_unknown_failure', null))
    })

    it('distinguishes different statuses', function () {
        expect(normalizeFailureSignature('error', 'ok', null))
            .not.toBe(normalizeFailureSignature('unauditable', 'ok', null))
    })

    it('handles a missing error text', function () {
        expect(typeof normalizeFailureSignature('error', 'audit_unknown_failure', null)).toBe('string')
    })

    // Everything above takes the structured-reasonCode arm, which short-circuits before any scrubbing
    // happens. The scrubbing arm below is the legacy path: rows that pre-date the reason_code column
    // have only free-text errorText to key on, and that text carries a timestamp, a pid and a path
    // that all differ run to run. Unscrubbed, every retry of the same failure mints a NEW event row
    // and pages the operator again — the exact failure mode the signature exists to prevent.
    describe('the legacy errorText fallback', function () {
        it.each([
            ['no reason code at all', null],
            ['a reason code of ok', 'ok' as const]
        ])('scrubs errorText when there is %s', function (_label, reasonCode) {
            const signature = normalizeFailureSignature('error', reasonCode, 'spawn failed at 1767225600123')
            expect(signature).toBe('error: spawn failed at <ts>')
        })

        it.each([
            ['a unix-millisecond timestamp', 'failed at 1767225600123', 'error: failed at <ts>'],
            ['a pid written with a space', 'killed pid 41234', 'error: killed pid=<n>'],
            ['a pid written with an equals', 'killed pid=41234', 'error: killed pid=<n>'],
            ['a duration', 'gave up after 30000 ms', 'error: gave up after Nms'],
            ['a duration with no space', 'gave up after 30000ms', 'error: gave up after Nms'],
            ['an absolute path', 'ENOENT /srv/code/app/package.json', 'error: ENOENT <path>']
        ])('replaces %s', function (_label, errorText, expected) {
            expect(normalizeFailureSignature('error', null, errorText)).toBe(expected)
        })

        // All four substitutions in one string, which is what a real spawn failure looks like.
        it('collapses two runs of the same failure onto one signature', function () {
            const first = normalizeFailureSignature('error', null, 'pid 411 died after 30000 ms running /srv/a/node_modules/.bin/npm at 1767225600123')
            const second = normalizeFailureSignature('error', null, 'pid 987 died after 45000 ms running /srv/b/node_modules/.bin/npm at 1767225999999')
            expect(first).toBe(second)
            expect(first).toBe('error: pid=<n> died after Nms running <path> at <ts>')
        })

        // Bounded so a stack trace pasted into errorText cannot become a multi-kilobyte dedupe key
        // stored on every event row.
        it('truncates a very long error text', function () {
            const signature = normalizeFailureSignature('error', null, 'x'.repeat(500))
            expect(signature).toBe('error: ' + 'x'.repeat(200))
        })

        it('trims surrounding whitespace', function () {
            expect(normalizeFailureSignature('error', null, '   boom   ')).toBe('error: boom')
        })

        // Distinct from the reasonCode arm's output shape: 'error: text' with a space, versus
        // 'error:no_lockfile' without one. Keeping them distinguishable means a legacy row and a
        // structured row for the same failure never collide on one event.
        it('returns the bare status when there is no error text either', function () {
            expect(normalizeFailureSignature('unauditable', null, null)).toBe('unauditable')
            expect(normalizeFailureSignature('error', 'ok', '')).toBe('error')
        })

        it('keeps the structured and legacy shapes distinguishable', function () {
            expect(normalizeFailureSignature('error', 'no_lockfile', null)).toBe('error:no_lockfile')
            expect(normalizeFailureSignature('error', null, 'no_lockfile')).toBe('error: no_lockfile')
        })
    })
})
