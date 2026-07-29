import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { revalidatePath } from 'next/cache'
import { senderFor, type NotificationSender } from '@sentinello/notifications'
import {
    claimPendingSignals,
    getConfigValue,
    getNotificationTargetById,
    getRootById,
    getRootByPath,
    insertNotificationTarget,
    listNotificationTargets,
    listRoots,
    setTargetProjects,
    setTargetRoots,
    upsertFindingEvent
} from '@sentinello/db'
import { sourceEnabledKey } from '@sentinello/core'
import type { NotificationTarget } from '@sentinello/core'
import {
    closePortalTestDb,
    finding,
    openPortalTestDb,
    ROOT_ID,
    scanProject,
    seedProject,
    seedRoot,
    T0,
    type PortalTestDb
} from '@/lib/portal-test-db.fixture'
import {
    deleteNotificationTargetAction,
    deleteRootAction,
    duplicateNotificationTargetAction,
    listDirectoryAction,
    refreshSourceAction,
    sendHistoricalToTargetAction,
    setNotificationTargetEnabledAction,
    testSendNotificationTargetAction,
    updateAdvancedSettingsAction,
    updateFilterDefaultsAction,
    updateNotificationTargetAction,
    updateRootLabelAction,
    updateScheduleAction,
    updateSourceCellAction,
    upsertNotificationTargetAction,
    upsertRootAction
} from './settings'

vi.mock('next/cache', function stubNextCache() {
    return { revalidatePath: vi.fn() }
})

// The only action that fires a real outbound HTTP request is testSendNotificationTargetAction. The
// transports themselves are covered at 99% in packages/notifications; what matters here is that the
// action looks the target up, hands it to the right sender, and maps the result faithfully.
vi.mock('@sentinello/notifications', function stubSender() {
    return { senderFor: vi.fn() }
})

let handle: PortalTestDb

function bustedPaths(): string[] {
    return vi.mocked(revalidatePath).mock.calls.map(function first(call) { return call[0] })
}

function signalKinds(): string[] {
    return claimPendingSignals(handle.db, T0).map(function kind(s) { return s.kind })
}

function seedTarget(id: string, overrides: Partial<NotificationTarget> = {}): NotificationTarget {
    const target = {
        id,
        kind: 'slack',
        config: { webhookUrl: 'https://hooks.example.test/abc' },
        severityFilter: ['critical', 'high'],
        envFilter: 'all',
        enabled: true,
        createdAt: T0,
        rootIds: [],
        projectIds: [],
        sourceScope: { mode: 'all', cells: [] },
        ...overrides
    } as NotificationTarget
    insertNotificationTarget(handle.db, target)
    // The scope lives in join tables, not on the target row — insertNotificationTarget alone leaves a
    // target that reads back with empty rootIds/projectIds no matter what was passed.
    setTargetRoots(handle.db, target.id, target.rootIds)
    setTargetProjects(handle.db, target.id, target.projectIds)
    return target
}

beforeEach(async function setup() {
    vi.mocked(revalidatePath).mockClear()
    vi.mocked(senderFor).mockReset()
    handle = await openPortalTestDb('settings-action')
    seedRoot(handle.db)
    seedProject(handle.db, 'project-1')
})

afterEach(async function teardown() {
    await closePortalTestDb(handle)
})

// --- Roots ---

describe('upsertRootAction', function () {
    it('creates a root with a content-addressed id and reports it as new', async function () {
        const result = await upsertRootAction('/srv/newcode', 'New Code')

        expect(result.isNew).toBe(true)
        expect(getRootById(handle.db, result.id)).toMatchObject({ path: '/srv/newcode', label: 'New Code' })
    })

    // The id is sha256(path), so re-adding the same path must land on the existing row rather than
    // creating a duplicate root that would double every project underneath it.
    it('updates the existing row when the path is already registered', async function () {
        const result = await upsertRootAction('/srv/code', 'Renamed')

        expect(result).toEqual({ id: ROOT_ID, isNew: false })
        expect(listRoots(handle.db)).toHaveLength(1)
        expect(getRootById(handle.db, ROOT_ID)?.label).toBe('Renamed')
    })

    // The path is the identity, so it is normalized before lookup — otherwise '/srv/code/' and
    // '/srv/code' would be two roots scanning the same tree.
    it('resolves and trims the path before using it as identity', async function () {
        const result = await upsertRootAction('  /srv/code/../code/  ', 'Same place')

        expect(result).toEqual({ id: ROOT_ID, isNew: false })
        expect(listRoots(handle.db)).toHaveLength(1)
    })

    it('normalizes a blank label to null so the UI renders its placeholder', async function () {
        const result = await upsertRootAction('/srv/newcode', '   ')

        expect(getRootById(handle.db, result.id)?.label).toBeNull()
    })

    it('preserves the original createdAt when updating an existing root', async function () {
        await upsertRootAction('/srv/code', 'Renamed')

        expect(getRootById(handle.db, ROOT_ID)?.createdAt).toBe(T0)
    })

    it('busts the roots page and the projects list', async function () {
        await upsertRootAction('/srv/newcode', 'New')

        expect(bustedPaths()).toEqual(['/settings/roots', '/projects'])
    })
})

describe('deleteRootAction', function () {
    it('removes the root', async function () {
        await deleteRootAction(ROOT_ID)

        expect(listRoots(handle.db)).toEqual([])
    })

    it('is a no-op for an unknown id', async function () {
        await expect(deleteRootAction('nope')).resolves.toBeUndefined()
        expect(listRoots(handle.db)).toHaveLength(1)
    })

    it('busts the roots page and the projects list', async function () {
        await deleteRootAction(ROOT_ID)

        expect(bustedPaths()).toEqual(['/settings/roots', '/projects'])
    })
})

describe('updateRootLabelAction', function () {
    it('renames the root', async function () {
        await updateRootLabelAction(ROOT_ID, 'Production code')

        expect(getRootById(handle.db, ROOT_ID)?.label).toBe('Production code')
    })

    it('normalizes a whitespace-only label to null', async function () {
        await updateRootLabelAction(ROOT_ID, '   ')

        expect(getRootById(handle.db, ROOT_ID)?.label).toBeNull()
    })

    // The path is immutable (the id is its hash); only the human label changes.
    it('leaves the path untouched', async function () {
        await updateRootLabelAction(ROOT_ID, 'Production code')

        expect(getRootByPath(handle.db, '/srv/code')?.id).toBe(ROOT_ID)
    })

    it('throws on an unknown root', async function () {
        await expect(updateRootLabelAction('nope', 'x')).rejects.toThrow('root not found: nope')
    })

    // The notifications page lists roots by label for target scoping, so a rename has to bust it too.
    it('busts the roots, notifications and projects pages', async function () {
        await updateRootLabelAction(ROOT_ID, 'Production code')

        expect(bustedPaths()).toEqual(['/settings/roots', '/settings/notifications', '/projects'])
    })
})

describe('listDirectoryAction', function () {
    let browseDir: string

    beforeEach(async function seedTree() {
        browseDir = await mkdtemp(join(tmpdir(), 'sentinello-browse-'))
        await mkdir(join(browseDir, 'alpha'))
        await mkdir(join(browseDir, 'beta'))
        await mkdir(join(browseDir, '.hidden'))
        await writeFile(join(browseDir, 'notes.txt'), 'not a directory')
    })

    afterEach(async function cleanTree() {
        await rm(browseDir, { recursive: true, force: true })
    })

    function names(entries: { name: string }[]): string[] {
        return entries.map(function pick(e) { return e.name })
    }

    // Only directories are offered — the operator is picking a scan root, not a file.
    it('lists only subdirectories, sorted by name', async function () {
        const result = await listDirectoryAction(browseDir, false)

        expect(names(result.entries)).toEqual(['alpha', 'beta'])
        expect(result.error).toBeUndefined()
    })

    it('hides dotfiles unless asked for them', async function () {
        const result = await listDirectoryAction(browseDir, true)

        expect(names(result.entries)).toEqual(['.hidden', 'alpha', 'beta'])
    })

    it('reports the parent so the browser can walk up', async function () {
        const result = await listDirectoryAction(browseDir, false)

        expect(result.parent).not.toBeNull()
        expect(browseDir.startsWith(result.parent as string)).toBe(true)
    })

    it('reports a null parent at the filesystem root', async function () {
        const result = await listDirectoryAction('/', false)

        expect(result.parent).toBeNull()
    })

    it('returns an error rather than throwing when the path is a file', async function () {
        const result = await listDirectoryAction(join(browseDir, 'notes.txt'), false)

        expect(result.error).toBe('Not a directory')
        expect(result.entries).toEqual([])
    })

    it('returns the underlying error when the path does not exist', async function () {
        const result = await listDirectoryAction(join(browseDir, 'does-not-exist'), false)

        expect(result.error).toContain('ENOENT')
        expect(result.entries).toEqual([])
    })

    // A broken symlink is the ordinary case for an entry that cannot be stat'd. Skipping it keeps
    // one bad link from blanking the whole picker.
    it('skips entries it cannot stat instead of failing the listing', async function () {
        await symlink(join(browseDir, 'nowhere'), join(browseDir, 'dangling'))

        const result = await listDirectoryAction(browseDir, false)

        expect(names(result.entries)).toEqual(['alpha', 'beta'])
    })

    it('starts at the home directory when given an empty path', async function () {
        const result = await listDirectoryAction('   ', false)

        expect(result.path).toBe(process.env.HOME)
    })
})

// --- Schedule ---

describe('updateScheduleAction', function () {
    it('persists the parsed schedule', async function () {
        await updateScheduleAction(6, 2, 'Europe/Madrid')

        expect(getConfigValue(handle.db, 'schedule')).toEqual({
            intervalHours: 6,
            startHour: 2,
            timezone: 'Europe/Madrid'
        })
    })

    it('defaults startHour to 0', async function () {
        await updateScheduleAction(24)

        expect(getConfigValue<{ startHour: number }>(handle.db, 'schedule')?.startHour).toBe(0)
    })

    // Without the signal the running node-cron task keeps the old expression until the next process
    // restart, so the operator's change appears to do nothing for hours.
    it('signals the worker to rebuild its cron task', async function () {
        await updateScheduleAction(3)

        expect(signalKinds()).toEqual(['reload-schedule'])
    })

    it.each([[2], [5], [0], [48]])('rejects an unsupported interval of %i hours', async function (hours) {
        await expect(updateScheduleAction(hours)).rejects.toThrow()
        expect(getConfigValue(handle.db, 'schedule')).toBeNull()
    })

    it.each([[-1], [24], [1.5]])('rejects an out-of-range startHour of %s', async function (startHour) {
        await expect(updateScheduleAction(6, startHour)).rejects.toThrow()
    })

    // The timezone is round-tripped through Intl rather than pattern-matched, so a plausible-looking
    // but non-existent zone is caught here instead of crashing the worker's cron builder.
    it('rejects a timezone Intl does not recognize', async function () {
        await expect(updateScheduleAction(6, 0, 'Europe/Atlantis')).rejects.toThrow()
    })

    it('does not signal the worker when validation fails', async function () {
        await expect(updateScheduleAction(5)).rejects.toThrow()

        expect(signalKinds()).toEqual([])
    })

    it('busts the schedule settings page', async function () {
        await updateScheduleAction(1)

        expect(bustedPaths()).toEqual(['/settings/schedule'])
    })
})

// --- Notifications ---

describe('upsertNotificationTargetAction', function () {
    const slackInput = {
        kind: 'slack' as const,
        config: { webhookUrl: 'https://hooks.example.test/abc' },
        severityFilter: ['critical', 'high'] as never,
        envFilter: 'all' as const,
        enabled: true,
        rootIds: [],
        projectIds: []
    }

    it('creates a slack target', async function () {
        await upsertNotificationTargetAction(slackInput)

        const [created] = listNotificationTargets(handle.db)
        expect(created).toMatchObject({ kind: 'slack', enabled: true, envFilter: 'all' })
    })

    it.each([
        ['telegram', { botToken: 'token', chatId: '123' }],
        ['webhook', { url: 'https://example.test/hook', flavor: 'json' }]
    ])('creates a %s target', async function (kind, config) {
        await upsertNotificationTargetAction({ ...slackInput, kind: kind as never, config: config as never })

        expect(listNotificationTargets(handle.db)[0].kind).toBe(kind)
    })

    // Each kind has its own required credential shape; a target saved without it would fail silently
    // at the first dispatch rather than at the point the operator can fix it.
    it.each([
        ['slack', {}],
        ['telegram', { botToken: 'token' }],
        ['webhook', {}]
    ])('rejects a %s target with an incomplete config', async function (kind, config) {
        await expect(
            upsertNotificationTargetAction({ ...slackInput, kind: kind as never, config: config as never })
        ).rejects.toThrow()
        expect(listNotificationTargets(handle.db)).toEqual([])
    })

    // An empty severity filter would be a target that can never fire — almost certainly a UI bug
    // rather than an intent, so it is rejected instead of silently stored.
    it('rejects an empty severity filter', async function () {
        await expect(
            upsertNotificationTargetAction({ ...slackInput, severityFilter: [] as never })
        ).rejects.toThrow()
    })

    it('defaults the source scope to every cell', async function () {
        await upsertNotificationTargetAction(slackInput)

        expect(listNotificationTargets(handle.db)[0].sourceScope).toEqual({ mode: 'all', cells: [] })
    })

    it('stores an explicit source scope', async function () {
        await upsertNotificationTargetAction({
            ...slackInput,
            sourceScope: { mode: 'selected', cells: [{ source: 'osv', ecosystem: 'PyPI' }] }
        })

        expect(listNotificationTargets(handle.db)[0].sourceScope).toEqual({
            mode: 'selected',
            cells: [{ source: 'osv', ecosystem: 'PyPI' }]
        })
    })

    it('stores the root and project scope rows', async function () {
        await upsertNotificationTargetAction({ ...slackInput, rootIds: [ROOT_ID], projectIds: ['project-1'] })

        expect(listNotificationTargets(handle.db)[0]).toMatchObject({ rootIds: [ROOT_ID], projectIds: ['project-1'] })
    })

    // An unknown id means the UI's state has diverged from the DB — e.g. a root was deleted in
    // another tab mid-edit. Failing loudly beats silently narrowing the target's scope.
    it('throws on an unknown root id rather than dropping it', async function () {
        await expect(
            upsertNotificationTargetAction({ ...slackInput, rootIds: ['root-gone'] })
        ).rejects.toThrow('unknown root id: root-gone')
    })

    it('throws on an unknown project id rather than dropping it', async function () {
        await expect(
            upsertNotificationTargetAction({ ...slackInput, projectIds: ['project-gone'] })
        ).rejects.toThrow('unknown project id: project-gone')
    })

    it('busts the notifications page', async function () {
        await upsertNotificationTargetAction(slackInput)

        expect(bustedPaths()).toEqual(['/settings/notifications'])
    })
})

describe('setNotificationTargetEnabledAction', function () {
    it('disables and re-enables a target', async function () {
        seedTarget('target-1')

        await setNotificationTargetEnabledAction('target-1', false)
        expect(getNotificationTargetById(handle.db, 'target-1')?.enabled).toBe(false)

        await setNotificationTargetEnabledAction('target-1', true)
        expect(getNotificationTargetById(handle.db, 'target-1')?.enabled).toBe(true)
    })

    it('busts the notifications page', async function () {
        seedTarget('target-1')

        await setNotificationTargetEnabledAction('target-1', false)

        expect(bustedPaths()).toEqual(['/settings/notifications'])
    })
})

describe('deleteNotificationTargetAction', function () {
    it('removes the target', async function () {
        seedTarget('target-1')

        await deleteNotificationTargetAction('target-1')

        expect(getNotificationTargetById(handle.db, 'target-1')).toBeNull()
    })

    it('is a no-op for an unknown id', async function () {
        await expect(deleteNotificationTargetAction('nope')).resolves.toBeUndefined()
    })
})

describe('updateNotificationTargetAction', function () {
    it('updates the severity and env filters', async function () {
        seedTarget('target-1')

        await updateNotificationTargetAction({
            id: 'target-1',
            severityFilter: ['low'] as never,
            envFilter: 'prod',
            enabled: false
        })

        expect(getNotificationTargetById(handle.db, 'target-1')).toMatchObject({
            severityFilter: ['low'],
            envFilter: 'prod',
            enabled: false
        })
    })

    // Credentials are deliberately immutable here — to rotate a secret the operator deletes and
    // recreates the target. This keeps the edit form free of a "replace secret" gate.
    it('leaves the stored config untouched', async function () {
        seedTarget('target-1')

        await updateNotificationTargetAction({
            id: 'target-1',
            severityFilter: ['low'] as never,
            envFilter: 'prod',
            enabled: true
        })

        expect(getNotificationTargetById(handle.db, 'target-1')?.config).toEqual({
            webhookUrl: 'https://hooks.example.test/abc'
        })
    })

    it('throws on an unknown target', async function () {
        await expect(
            updateNotificationTargetAction({ id: 'nope', severityFilter: ['low'] as never, envFilter: 'all', enabled: true })
        ).rejects.toThrow('notification target not found: nope')
    })

    // Scope is replaced wholesale when provided, so an empty array is the "everything" gesture and
    // must clear the existing rows rather than being ignored as a no-op.
    it('replaces the root scope wholesale, including clearing it', async function () {
        seedTarget('target-1', { rootIds: [ROOT_ID] })

        await updateNotificationTargetAction({
            id: 'target-1',
            severityFilter: ['low'] as never,
            envFilter: 'all',
            enabled: true,
            rootIds: []
        })

        expect(getNotificationTargetById(handle.db, 'target-1')?.rootIds).toEqual([])
    })

    // Omitting the field entirely is different from passing an empty array: it means "don't touch".
    it('leaves the scope alone when the field is omitted', async function () {
        seedTarget('target-1')
        await updateNotificationTargetAction({
            id: 'target-1',
            severityFilter: ['low'] as never,
            envFilter: 'all',
            enabled: true,
            rootIds: [ROOT_ID],
            projectIds: ['project-1']
        })

        await updateNotificationTargetAction({
            id: 'target-1',
            severityFilter: ['high'] as never,
            envFilter: 'all',
            enabled: true
        })

        expect(getNotificationTargetById(handle.db, 'target-1')).toMatchObject({
            rootIds: [ROOT_ID],
            projectIds: ['project-1']
        })
    })

    it('validates ids in a replacement scope', async function () {
        seedTarget('target-1')

        await expect(
            updateNotificationTargetAction({
                id: 'target-1',
                severityFilter: ['low'] as never,
                envFilter: 'all',
                enabled: true,
                projectIds: ['project-gone']
            })
        ).rejects.toThrow('unknown project id: project-gone')
    })

    it('updates the source scope when provided', async function () {
        seedTarget('target-1')

        await updateNotificationTargetAction({
            id: 'target-1',
            severityFilter: ['low'] as never,
            envFilter: 'all',
            enabled: true,
            sourceScope: { mode: 'selected', cells: [{ source: 'osv', ecosystem: 'npm' }] }
        })

        expect(getNotificationTargetById(handle.db, 'target-1')?.sourceScope).toEqual({
            mode: 'selected',
            cells: [{ source: 'osv', ecosystem: 'npm' }]
        })
    })
})

describe('duplicateNotificationTargetAction', function () {
    it('copies the target under a new id', async function () {
        seedTarget('target-1', { rootIds: [ROOT_ID], projectIds: ['project-1'] })

        const { id } = await duplicateNotificationTargetAction('target-1')

        expect(id).not.toBe('target-1')
        expect(getNotificationTargetById(handle.db, id)).toMatchObject({
            kind: 'slack',
            config: { webhookUrl: 'https://hooks.example.test/abc' },
            severityFilter: ['critical', 'high'],
            envFilter: 'all',
            enabled: true,
            rootIds: [ROOT_ID],
            projectIds: ['project-1']
        })
    })

    it('leaves the original in place', async function () {
        seedTarget('target-1')

        await duplicateNotificationTargetAction('target-1')

        expect(getNotificationTargetById(handle.db, 'target-1')).not.toBeNull()
    })

    it('throws on an unknown target', async function () {
        await expect(duplicateNotificationTargetAction('nope')).rejects.toThrow('notification target not found: nope')
    })
})

describe('testSendNotificationTargetAction', function () {
    it('reports success when the sender succeeds', async function () {
        seedTarget('target-1')
        vi.mocked(senderFor).mockReturnValue(async function ok() { return { ok: true } })

        expect(await testSendNotificationTargetAction('target-1')).toEqual({ ok: true })
    })

    it('surfaces the sender error text so the operator can act on it', async function () {
        seedTarget('target-1')
        vi.mocked(senderFor).mockReturnValue(async function fail() {
            return { ok: false, errorText: 'blocked by SSRF guard' }
        })

        expect(await testSendNotificationTargetAction('target-1')).toEqual({
            ok: false,
            errorText: 'blocked by SSRF guard'
        })
    })

    // The only action that returns an error rather than throwing for a missing row — it feeds a
    // status pill next to the button, not an error boundary.
    it('returns an error result rather than throwing for an unknown target', async function () {
        expect(await testSendNotificationTargetAction('nope')).toEqual({ ok: false, errorText: 'target not found' })
        expect(vi.mocked(senderFor)).not.toHaveBeenCalled()
    })

    it('sends a message carrying the Sentinello test-send marker', async function () {
        seedTarget('target-1')
        const send = vi.fn<NotificationSender>(async function ok() { return { ok: true } })
        vi.mocked(senderFor).mockReturnValue(send)

        await testSendNotificationTargetAction('target-1')

        expect(send.mock.calls[0][1]).toMatchObject({ title: '[Sentinello] Test send' })
    })
})

describe('sendHistoricalToTargetAction', function () {
    it('inserts a placeholder delivery for every existing event', async function () {
        scanProject(handle.db, 'project-1', [finding()])
        upsertFindingEvent(handle.db, {
            projectId: 'project-1',
            source: 'npm-audit',
            ecosystem: 'npm',
            advisoryId: 'CVE-2024-1',
            packageName: 'lodash',
            severity: 'high',
            firstScanId: 'scan-1',
            at: T0
        })
        seedTarget('target-1')

        expect(await sendHistoricalToTargetAction('target-1')).toEqual({ inserted: 1 })
    })

    it('reports zero when there is no history to send', async function () {
        seedTarget('target-1')

        expect(await sendHistoricalToTargetAction('target-1')).toEqual({ inserted: 0 })
    })

    it('throws on an unknown target', async function () {
        await expect(sendHistoricalToTargetAction('nope')).rejects.toThrow('notification target not found: nope')
    })
})

// --- Advanced ---

describe('updateAdvancedSettingsAction', function () {
    const base = {
        parallelism: 4,
        watcherEnabled: true,
        watcherRoots: ['/srv/code'],
        globalIgnore: ['**/dist/**'],
        dryRunNotify: false
    }

    it('persists each setting under its own key', async function () {
        await updateAdvancedSettingsAction(base)

        expect(getConfigValue(handle.db, 'parallelism')).toBe(4)
        expect(getConfigValue(handle.db, 'watcherEnabled')).toBe(true)
        expect(getConfigValue(handle.db, 'watcherRoots')).toEqual(['/srv/code'])
        expect(getConfigValue(handle.db, 'globalIgnore')).toEqual(['**/dist/**'])
        expect(getConfigValue(handle.db, 'dryRunNotify')).toBe(false)
    })

    it.each([[0], [65], [2.5]])('rejects a parallelism of %s', async function (parallelism) {
        await expect(updateAdvancedSettingsAction({ ...base, parallelism })).rejects.toThrow()
    })

    it.each([[1], [64]])('accepts a parallelism of %i at the boundary', async function (parallelism) {
        await expect(updateAdvancedSettingsAction({ ...base, parallelism })).resolves.toBeUndefined()
    })

    // portalBaseUrl and notificationLocale are written only when meaningfully set. An empty submission
    // must leave the previous value alone rather than blanking the links in every outbound message.
    it('writes the portal base url when one is given', async function () {
        await updateAdvancedSettingsAction({ ...base, portalBaseUrl: 'https://sentinello.example.test' })

        expect(getConfigValue(handle.db, 'portalBaseUrl')).toBe('https://sentinello.example.test')
    })

    it('leaves an existing portal base url alone when the field is empty', async function () {
        await updateAdvancedSettingsAction({ ...base, portalBaseUrl: 'https://sentinello.example.test' })
        await updateAdvancedSettingsAction({ ...base, portalBaseUrl: '' })

        expect(getConfigValue(handle.db, 'portalBaseUrl')).toBe('https://sentinello.example.test')
    })

    it('stores a supported notification locale', async function () {
        await updateAdvancedSettingsAction({ ...base, notificationLocale: 'es' })

        expect(getConfigValue(handle.db, 'notificationLocale')).toBe('es')
    })

    // An unsupported locale has no message catalog, so storing it would make every notification fall
    // back at render time. It is dropped rather than rejected.
    it('ignores a locale outside the supported set', async function () {
        await updateAdvancedSettingsAction({ ...base, notificationLocale: 'tlh' })

        expect(getConfigValue(handle.db, 'notificationLocale')).toBeNull()
    })

    it('busts the advanced settings page', async function () {
        await updateAdvancedSettingsAction(base)

        expect(bustedPaths()).toEqual(['/settings/advanced'])
    })
})

// --- Sources ---

describe('updateSourceCellAction', function () {
    it('enables a cell and signals the worker to start its runtime', async function () {
        await updateSourceCellAction({ source: 'osv', ecosystem: 'PyPI', enabled: true })

        expect(getConfigValue(handle.db, sourceEnabledKey('osv', 'PyPI'))).toBe(true)
        expect(signalKinds()).toEqual(['reload-sources'])
    })

    it('disables a cell once another one is active', async function () {
        await updateSourceCellAction({ source: 'osv', ecosystem: 'npm', enabled: true })

        await updateSourceCellAction({ source: 'npm-audit', ecosystem: 'npm', enabled: false })

        expect(getConfigValue(handle.db, sourceEnabledKey('npm-audit', 'npm'))).toBe(false)
    })

    // The "always a source on" invariant. npm-audit/npm is enabled by default and is the only active
    // cell on a fresh install, so turning it off would leave Sentinello fully blind.
    it('refuses to disable the last active cell', async function () {
        await expect(
            updateSourceCellAction({ source: 'npm-audit', ecosystem: 'npm', enabled: false })
        ).rejects.toThrow('At least one vulnerability source must stay enabled')

        expect(getConfigValue(handle.db, sourceEnabledKey('npm-audit', 'npm'))).toBeNull()
    })

    it('does not signal the worker when the invariant rejects the write', async function () {
        await expect(
            updateSourceCellAction({ source: 'npm-audit', ecosystem: 'npm', enabled: false })
        ).rejects.toThrow()

        expect(signalKinds()).toEqual([])
    })

    it('rejects an ecosystem outside the registry', async function () {
        await expect(
            updateSourceCellAction({ source: 'osv', ecosystem: 'CocoaPods', enabled: true })
        ).rejects.toThrow('Unknown ecosystem: CocoaPods')
    })

    // npm-audit is JavaScript's native source and never answers for anything else, so the matrix
    // must not let an operator switch on a cell that can never produce findings.
    it('rejects a source that cannot answer for the ecosystem', async function () {
        await expect(
            updateSourceCellAction({ source: 'npm-audit', ecosystem: 'PyPI', enabled: true })
        ).rejects.toThrow('does not answer for ecosystem PyPI')
    })

    it('rejects an empty source or ecosystem', async function () {
        await expect(updateSourceCellAction({ source: '', ecosystem: 'npm', enabled: true })).rejects.toThrow()
        await expect(updateSourceCellAction({ source: 'osv', ecosystem: '', enabled: true })).rejects.toThrow()
    })

    it('busts the sources settings page', async function () {
        await updateSourceCellAction({ source: 'osv', ecosystem: 'npm', enabled: true })

        expect(bustedPaths()).toEqual(['/settings/sources'])
    })
})

describe('refreshSourceAction', function () {
    it('signals a gemnasium re-sync', async function () {
        await refreshSourceAction('gemnasium')

        expect(signalKinds()).toEqual(['refresh-gemnasium'])
    })

    it('signals an osv re-sync', async function () {
        await refreshSourceAction('osv')

        expect(signalKinds()).toEqual(['refresh-osv'])
    })

    // Anything that is not gemnasium falls through to the osv signal. The worker no-ops when the
    // source is disabled everywhere, so an unexpected value costs one wasted tick at most.
    it('falls back to the osv signal for an unrecognized source', async function () {
        await refreshSourceAction('something-else')

        expect(signalKinds()).toEqual(['refresh-osv'])
    })
})

// --- Filter defaults ---

describe('updateFilterDefaultsAction', function () {
    it('persists the defaults', async function () {
        await updateFilterDefaultsAction({ depType: 'prod', minSeverity: 'high', sort: 'severity' })

        expect(getConfigValue(handle.db, 'filterDefaults')).toEqual({
            depType: 'prod',
            minSeverity: 'high',
            sort: 'severity'
        })
    })

    // The empty string is a real value here: "no minimum severity", i.e. show everything.
    it('accepts an empty minimum severity meaning no floor', async function () {
        await updateFilterDefaultsAction({ depType: 'all', minSeverity: '', sort: 'name' })

        expect(getConfigValue<{ minSeverity: string }>(handle.db, 'filterDefaults')?.minSeverity).toBe('')
    })

    it('rejects a severity outside the known set', async function () {
        await expect(
            updateFilterDefaultsAction({ depType: 'all', minSeverity: 'urgent' as never, sort: 'name' })
        ).rejects.toThrow()
    })

    it('rejects an empty sort key', async function () {
        await expect(
            updateFilterDefaultsAction({ depType: 'all', minSeverity: '', sort: '' })
        ).rejects.toThrow()
    })

    it('busts the defaults page and the dashboard', async function () {
        await updateFilterDefaultsAction({ depType: 'all', minSeverity: '', sort: 'name' })

        expect(bustedPaths()).toEqual(['/settings/defaults', '/'])
    })
})
