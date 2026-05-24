'use server'

import { revalidatePath } from 'next/cache'
import { isLocale } from '@/i18n/config'
import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve as resolvePath } from 'node:path'
import { ulid } from 'ulid'
import { z } from 'zod'
import {
    backfillForNewTarget,
    deleteNotificationTarget,
    deleteRoot,
    enqueueWorkerSignal,
    getNotificationTargetById,
    getRootById,
    getRootByPath,
    insertNotificationTarget,
    listProjects,
    listRoots,
    rootId,
    setConfigValue,
    setNotificationTargetEnabled,
    setTargetProjects,
    setTargetRoots,
    updateNotificationTarget,
    updateRootLabel,
    upsertRoot
} from '@sentinello/db'
import type {
    NotificationTarget,
    NotificationTargetConfig,
    NotificationTargetKind,
    Severity
} from '@sentinello/core'
import { senderFor } from '@sentinello/notifications'
import { getDb } from '@/lib/db'

const SEVERITY_VALUES = ['critical', 'high', 'moderate', 'low', 'info'] as const

// --- Roots ---

export async function upsertRootAction(
    rawPath: string,
    label: string
): Promise<{ id: string; isNew: boolean }> {
    const db = getDb()
    const path = resolvePath(rawPath.trim())
    const existing = getRootByPath(db, path)
    if (existing) {
        upsertRoot(db, {
            ...existing,
            path,
            label: label.trim() || null
        })
        revalidatePath('/settings/roots')
        revalidatePath('/projects')
        return { id: existing.id, isNew: false }
    }
    const id = rootId(path)
    upsertRoot(db, {
        id,
        path,
        label: label.trim() || null,
        createdAt: Date.now()
    })
    revalidatePath('/settings/roots')
    revalidatePath('/projects')
    return { id, isNew: true }
}

export async function deleteRootAction(id: string): Promise<void> {
    const db = getDb()
    deleteRoot(db, id)
    revalidatePath('/settings/roots')
    revalidatePath('/projects')
}

// Inline rename support. The path is immutable (id is sha256(path)); only the human label changes.
// An empty / whitespace-only label is normalized to null so the UI renders the "—" placeholder
// instead of an empty string.
export async function updateRootLabelAction(id: string, rawLabel: string): Promise<void> {
    const db = getDb()
    const existing = getRootById(db, id)
    if (!existing) throw new Error('root not found: ' + id)
    const trimmed = rawLabel.trim()
    const label = trimmed.length === 0 ? null : trimmed
    updateRootLabel(db, id, label)
    revalidatePath('/settings/roots')
    revalidatePath('/settings/notifications')
    revalidatePath('/projects')
}

// Server-side directory browser used by the Add Root modal. The web and worker share the host
// filesystem, so listing dirs here is no incremental risk over the existing free-form path input.
// An empty `rawPath` starts at the operator's home directory.
export type DirectoryListing = {
    path: string
    parent: string | null
    entries: { name: string; path: string }[]
    error?: string
}

export async function listDirectoryAction(rawPath: string, showHidden: boolean): Promise<DirectoryListing> {
    const target = rawPath.trim().length === 0 ? homedir() : resolvePath(rawPath.trim())
    const parent = dirname(target) === target ? null : dirname(target)
    try {
        const stat = statSync(target)
        if (!stat.isDirectory()) {
            return { path: target, parent, entries: [], error: 'Not a directory' }
        }
        const names = readdirSync(target)
        const entries: { name: string; path: string }[] = []
        for (const name of names) {
            if (!showHidden && name.startsWith('.')) continue
            const full = resolvePath(target, name)
            try {
                const child = statSync(full)
                if (child.isDirectory()) entries.push({ name, path: full })
            } catch {
                // skip entries we can't stat (broken symlinks, EACCES on the child, etc.)
            }
        }
        entries.sort(function byName(a, b) { return a.name.localeCompare(b.name) })
        return { path: target, parent, entries }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { path: target, parent, entries: [], error: message }
    }
}

// --- Schedule ---

// Validates an IANA timezone name by round-tripping it through Intl. Throws on an unknown id.
function isValidTimezone(tz: string): boolean {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz })
        return true
    } catch {
        return false
    }
}

// startHour anchors the time-of-day for any interval other than 1h (hourly needs no anchor), and is
// interpreted in `timezone` (an IANA name). e.g. 6h + startHour 2 + 'Europe/Madrid' fires at 02:00,
// 08:00, 14:00, 20:00 Madrid time. startHour defaults to 0; timezone is optional (the worker falls
// back to its system timezone when unset).
const scheduleSchema = z.object({
    intervalHours: z.union([z.literal(1), z.literal(3), z.literal(6), z.literal(12), z.literal(24)]),
    startHour: z.number().int().min(0).max(23).default(0),
    timezone: z.string().min(1).refine(isValidTimezone, { message: 'invalid timezone' }).optional()
})

export async function updateScheduleAction(intervalHours: number, startHour = 0, timezone?: string): Promise<void> {
    const parsed = scheduleSchema.parse({ intervalHours, startHour, timezone })
    const db = getDb()
    setConfigValue(db, 'schedule', parsed)
    // Ping the worker via the scan-request-poller mailbox so the running node-cron task is rebuilt
    // with the new expression/timezone within ~5s instead of waiting for the next process restart.
    enqueueWorkerSignal(db, 'reload-schedule', Date.now())
    revalidatePath('/settings/schedule')
}

// --- Notifications ---

const severityFilterSchema = z.array(z.enum(SEVERITY_VALUES)).min(1)

const targetConfigSchemas: Record<NotificationTargetKind, z.ZodTypeAny> = {
    slack: z.object({ webhookUrl: z.string().min(1) }),
    telegram: z.object({ botToken: z.string().min(1), chatId: z.string().min(1) }),
    webhook: z.object({
        url: z.string().min(1),
        headers: z.record(z.string(), z.string()).optional(),
        flavor: z.enum(['json', 'text']).optional()
    })
}

const rootIdsSchema = z.array(z.string().min(1)).default([])
const projectIdsSchema = z.array(z.string().min(1)).default([])

// Guards that every id refers to a real root. Empty list is fine (= "all roots"). Throws on the
// first unknown id rather than silently dropping it — operators should see a clear error if the UI
// state diverges from the DB (e.g. a root got deleted in another tab while editing).
function validateRootIds(db: ReturnType<typeof getDb>, rootIds: string[]): void {
    if (rootIds.length === 0) return
    const known = new Set(listRoots(db).map(function pickId(r) { return r.id }))
    for (const id of rootIds) {
        if (!known.has(id)) throw new Error('unknown root id: ' + id)
    }
}

// Same guard for the explicit project allow-list.
function validateProjectIds(db: ReturnType<typeof getDb>, projectIds: string[]): void {
    if (projectIds.length === 0) return
    const known = new Set(listProjects(db).map(function pickId(p) { return p.id }))
    for (const id of projectIds) {
        if (!known.has(id)) throw new Error('unknown project id: ' + id)
    }
}

export async function upsertNotificationTargetAction(input: {
    kind: NotificationTargetKind
    config: NotificationTargetConfig
    severityFilter: Severity[]
    enabled: boolean
    rootIds: string[]
    projectIds: string[]
}): Promise<void> {
    const schema = targetConfigSchemas[input.kind]
    schema.parse(input.config)
    const severityFilter = severityFilterSchema.parse(input.severityFilter)
    const rootIds = rootIdsSchema.parse(input.rootIds)
    const projectIds = projectIdsSchema.parse(input.projectIds)
    const db = getDb()
    validateRootIds(db, rootIds)
    validateProjectIds(db, projectIds)
    const target: NotificationTarget = {
        id: ulid(),
        kind: input.kind,
        config: input.config,
        severityFilter,
        enabled: input.enabled,
        createdAt: Date.now(),
        rootIds,
        projectIds
    }
    insertNotificationTarget(db, target)
    setTargetRoots(db, target.id, rootIds)
    setTargetProjects(db, target.id, projectIds)
    revalidatePath('/settings/notifications')
}

export async function setNotificationTargetEnabledAction(id: string, enabled: boolean): Promise<void> {
    const db = getDb()
    setNotificationTargetEnabled(db, id, enabled)
    revalidatePath('/settings/notifications')
}

export async function deleteNotificationTargetAction(id: string): Promise<void> {
    const db = getDb()
    deleteNotificationTarget(db, id)
    revalidatePath('/settings/notifications')
}

// Update an existing target. `replaceConfig` is null when the operator does NOT want to change the
// saved secret payload — only the severity filter and enabled flag are persisted in that case. When
// the operator clicks "Replace secret" in the UI, the new full config is sent and overwrites the
// stored one. The kind cannot change because the config shape is kind-specific.
export async function updateNotificationTargetAction(input: {
    id: string
    replaceConfig: NotificationTargetConfig | null
    severityFilter: Severity[]
    enabled: boolean
    // Optional so callers that only want to touch the severity/enabled/secret fields can omit them.
    // When provided, scope is replaced wholesale: empty arrays = "everything".
    rootIds?: string[]
    projectIds?: string[]
}): Promise<void> {
    const db = getDb()
    const existing = getNotificationTargetById(db, input.id)
    if (!existing) throw new Error('notification target not found: ' + input.id)
    const severityFilter = severityFilterSchema.parse(input.severityFilter)
    if (input.replaceConfig !== null) {
        const schema = targetConfigSchemas[existing.kind]
        schema.parse(input.replaceConfig)
        updateNotificationTarget(db, {
            id: input.id,
            config: input.replaceConfig,
            severityFilter,
            enabled: input.enabled
        })
    } else {
        updateNotificationTarget(db, {
            id: input.id,
            severityFilter,
            enabled: input.enabled
        })
    }
    if (input.rootIds !== undefined) {
        const rootIds = rootIdsSchema.parse(input.rootIds)
        validateRootIds(db, rootIds)
        setTargetRoots(db, input.id, rootIds)
    }
    if (input.projectIds !== undefined) {
        const projectIds = projectIdsSchema.parse(input.projectIds)
        validateProjectIds(db, projectIds)
        setTargetProjects(db, input.id, projectIds)
    }
    revalidatePath('/settings/notifications')
}

// Operator-triggered live POST. This is the ONLY notification action that fires a real outbound
// HTTP request (the worker's normal dispatch path is event-driven). This is the
// authorization point: invoking it = the operator consents to the external send.
export async function testSendNotificationTargetAction(
    id: string
): Promise<{ ok: boolean; errorText?: string }> {
    const db = getDb()
    const target = getNotificationTargetById(db, id)
    if (!target) return { ok: false, errorText: 'target not found' }
    const message = {
        title: '[Sentinello] Test send',
        text: 'Sentinello test send — this confirms the target is reachable.',
        markdown: '*Sentinello test send* — this confirms the target is reachable.',
        portalUrl: null as string | null
    }
    const sender = senderFor(target)
    const result = await sender(target, message)
    if (result.ok) return { ok: true }
    return { ok: false, errorText: result.errorText }
}

// Insert placeholder delivery rows for every existing event so the next dispatch tick sends them
// to this target. Opt-in — never invoked automatically on target creation.
export async function sendHistoricalToTargetAction(
    id: string
): Promise<{ inserted: number }> {
    const db = getDb()
    const target = getNotificationTargetById(db, id)
    if (!target) throw new Error('notification target not found: ' + id)
    const inserted = backfillForNewTarget(db, id, Date.now())
    revalidatePath('/settings/notifications')
    return { inserted }
}

// --- Advanced ---

const advancedSchema = z.object({
    parallelism: z.number().int().min(1).max(64),
    watcherEnabled: z.boolean(),
    watcherRoots: z.array(z.string()),
    globalIgnore: z.array(z.string()),
    dryRunNotify: z.boolean(),
    portalBaseUrl: z.string().optional(),
    notificationLocale: z.string().optional()
})

export type AdvancedSettingsInput = z.infer<typeof advancedSchema>

export async function updateAdvancedSettingsAction(input: AdvancedSettingsInput): Promise<void> {
    const parsed = advancedSchema.parse(input)
    const db = getDb()
    setConfigValue(db, 'parallelism', parsed.parallelism)
    setConfigValue(db, 'watcherEnabled', parsed.watcherEnabled)
    setConfigValue(db, 'watcherRoots', parsed.watcherRoots)
    setConfigValue(db, 'globalIgnore', parsed.globalIgnore)
    setConfigValue(db, 'dryRunNotify', parsed.dryRunNotify)
    if (parsed.portalBaseUrl) {
        setConfigValue(db, 'portalBaseUrl', parsed.portalBaseUrl)
    }
    if (isLocale(parsed.notificationLocale)) {
        setConfigValue(db, 'notificationLocale', parsed.notificationLocale)
    }
    revalidatePath('/settings/advanced')
}

// --- Filter defaults ---

const filterDefaultsSchema = z.object({
    depType: z.enum(['all', 'prod', 'dev']),
    minSeverity: z.enum(['', 'critical', 'high', 'moderate', 'low', 'info']),
    sort: z.string().min(1).max(40)
})

export type FilterDefaultsInput = z.infer<typeof filterDefaultsSchema>

export async function updateFilterDefaultsAction(input: FilterDefaultsInput): Promise<void> {
    const parsed = filterDefaultsSchema.parse(input)
    const db = getDb()
    setConfigValue(db, 'filterDefaults', parsed)
    revalidatePath('/settings/defaults')
    revalidatePath('/')
}
