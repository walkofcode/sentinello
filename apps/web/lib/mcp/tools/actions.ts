import { z } from 'zod'
import { ulid } from 'ulid'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
    deleteMute,
    enqueueScanRequest,
    getProjectById,
    insertMute,
    isAnyScanInFlight,
    isScanInFlightForProject,
    isScanInFlightForRoot,
    setProjectAlias,
    setProjectTags
} from '@sentinello/db'
import type { Mute, MuteScope } from '@sentinello/core'
import { getDb } from '@/lib/db'

// Mirrors apps/web/lib/actions/*. We do NOT call those server-action functions directly — they
// invoke `revalidatePath` which only works inside a Next.js render request. MCP requests go
// through the route handler, where revalidate isn't meaningful (the next portal render will
// re-query the DB anyway). So we call the same DB helpers, intentionally skipping revalidation.
export function registerActionTools(server: McpServer): void {
    server.registerTool(
        'request_scan',
        {
            title: 'Request a scan',
            description: 'Enqueues a scan request. Exactly one of projectId or rootId may be set; with neither, requests a full sweep. Dedupes against in-flight scans (returns skipped: true in that case).',
            inputSchema: {
                projectId: z.string().min(1).optional(),
                rootId: z.string().min(1).optional()
            }
        },
        async function handler({ projectId, rootId }) {
            if (projectId && rootId) {
                return { isError: true, content: [{ type: 'text', text: 'projectId and rootId are mutually exclusive' }] }
            }
            const db = getDb()
            const now = Date.now()
            if (projectId) {
                const project = getProjectById(db, projectId)
                if (!project) {
                    return { isError: true, content: [{ type: 'text', text: 'Project not found: ' + projectId }] }
                }
                if (isScanInFlightForProject(db, projectId, project.rootId, now)) {
                    return {
                        content: [{ type: 'text', text: 'skipped: scan already in flight for this project' }],
                        structuredContent: { skipped: true, reason: 'scan_in_flight' }
                    }
                }
                const req = enqueueScanRequest(db, { projectId }, now)
                return {
                    content: [{ type: 'text', text: 'Enqueued scan request ' + req.id + ' for project ' + projectId }],
                    structuredContent: { skipped: false, request: req }
                }
            }
            if (rootId) {
                if (isScanInFlightForRoot(db, rootId, now)) {
                    return {
                        content: [{ type: 'text', text: 'skipped: scan already in flight for this root' }],
                        structuredContent: { skipped: true, reason: 'scan_in_flight' }
                    }
                }
                const req = enqueueScanRequest(db, { rootId }, now)
                return {
                    content: [{ type: 'text', text: 'Enqueued scan request ' + req.id + ' for root ' + rootId }],
                    structuredContent: { skipped: false, request: req }
                }
            }
            if (isAnyScanInFlight(db, now)) {
                return {
                    content: [{ type: 'text', text: 'skipped: a scan is already in flight' }],
                    structuredContent: { skipped: true, reason: 'scan_in_flight' }
                }
            }
            const req = enqueueScanRequest(db, {}, now)
            return {
                content: [{ type: 'text', text: 'Enqueued full-sweep scan request ' + req.id }],
                structuredContent: { skipped: false, request: req }
            }
        }
    )

    server.registerTool(
        'mute_finding',
        {
            title: 'Mute a finding (or all findings on a project)',
            description: 'Creates a mute. Use scope=project to mute every finding for a project; scope=finding requires scanner, advisoryId, and packageName.',
            inputSchema: {
                scope: z.enum(['project', 'finding']),
                projectId: z.string().min(1).nullable().optional(),
                scanner: z.string().min(1).nullable().optional(),
                advisoryId: z.string().min(1).nullable().optional(),
                packageName: z.string().min(1).nullable().optional(),
                reason: z.string().min(1),
                expiresAt: z.number().int().nullable().optional().describe('Unix ms timestamp when the mute expires; null = permanent')
            }
        },
        async function handler({ scope, projectId, scanner, advisoryId, packageName, reason, expiresAt }) {
            if (scope === 'finding' && (!scanner || !advisoryId || !packageName)) {
                return { isError: true, content: [{ type: 'text', text: 'scope=finding requires scanner, advisoryId, and packageName' }] }
            }
            const db = getDb()
            const mute: Mute = {
                id: ulid(),
                scope: scope as MuteScope,
                projectId: projectId || null,
                scanner: scope === 'project' ? null : scanner || null,
                advisoryId: scope === 'project' ? null : advisoryId || null,
                packageName: scope === 'project' ? null : packageName || null,
                reason: reason.trim(),
                author: process.env.ME_NAME || 'mcp',
                createdAt: Date.now(),
                expiresAt: expiresAt || null
            }
            insertMute(db, mute)
            return {
                content: [{ type: 'text', text: 'Created mute ' + mute.id }],
                structuredContent: { mute }
            }
        }
    )

    server.registerTool(
        'unmute',
        {
            title: 'Remove a mute',
            description: 'Deletes a mute by id.',
            inputSchema: { muteId: z.string().min(1) }
        },
        async function handler({ muteId }) {
            deleteMute(getDb(), muteId)
            return {
                content: [{ type: 'text', text: 'Deleted mute ' + muteId }],
                structuredContent: { deleted: muteId }
            }
        }
    )

    server.registerTool(
        'set_project_alias',
        {
            title: 'Set project alias',
            description: 'Sets a human-friendly alias for a project (overrides the auto-derived name). Empty string clears the alias.',
            inputSchema: {
                projectId: z.string().min(1),
                alias: z.string()
            }
        },
        async function handler({ projectId, alias }) {
            const db = getDb()
            const project = getProjectById(db, projectId)
            if (!project) {
                return { isError: true, content: [{ type: 'text', text: 'Project not found: ' + projectId }] }
            }
            const trimmed = alias.trim()
            setProjectAlias(db, projectId, trimmed.length > 0 ? trimmed : null, Date.now())
            return {
                content: [{ type: 'text', text: 'Updated alias for project ' + projectId }],
                structuredContent: { projectId, alias: trimmed.length > 0 ? trimmed : null }
            }
        }
    )

    server.registerTool(
        'set_project_tags',
        {
            title: 'Set project tags',
            description: 'Replaces the project tag set with the given list.',
            inputSchema: {
                projectId: z.string().min(1),
                tags: z.array(z.string())
            }
        },
        async function handler({ projectId, tags }) {
            const db = getDb()
            const project = getProjectById(db, projectId)
            if (!project) {
                return { isError: true, content: [{ type: 'text', text: 'Project not found: ' + projectId }] }
            }
            const clean = tags.map(function trim(s) { return s.trim() }).filter(function nonEmpty(s) { return s.length > 0 })
            setProjectTags(db, projectId, clean, Date.now())
            return {
                content: [{ type: 'text', text: 'Updated tags for project ' + projectId }],
                structuredContent: { projectId, tags: clean }
            }
        }
    )
}
