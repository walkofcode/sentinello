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
import { DEFAULT_ECOSYSTEM, type Mute, type MuteScope } from '@sentinello/core'
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
            description:
                'QUEUES a scan — it does not perform one. Returns a request id immediately; the worker picks the job up shortly afterwards and results only become visible on a LATER list_scans / list_findings call, so do not read findings straight back and conclude nothing changed. Scope it with exactly one of projectId or rootId; passing neither requests a full sweep of everything. If a scan covering the same ground is already running the request is deduplicated and comes back with skipped: true — that is success, not an error, and the in-flight scan will produce the results.',
            inputSchema: {
                projectId: z
                    .string()
                    .min(1)
                    .optional()
                    .describe('Scan just this project (from list_projects). Mutually exclusive with rootId.'),
                rootId: z
                    .string()
                    .min(1)
                    .optional()
                    .describe('Scan every project under this root (from list_roots). Mutually exclusive with projectId.')
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
            description:
                "Hides a finding from the dashboard and from the advisory export by recording an accepted-risk decision. This is a HUMAN's judgement call, not a remediation step — muting to reach a clean board instead of fixing the vulnerability defeats the purpose of the tool, so do not mute on your own initiative. Use scope=finding (requires source, advisoryId, packageName) for one vulnerability, or scope=project to silence an entire project. Muting one (source, ecosystem) cell never silences the same package in another ecosystem, nor the same advisory reported by a different source — mute each identity you mean to. Reversible with unmute; list_mutes shows what is currently in force.",
            inputSchema: {
                scope: z
                    .enum(['project', 'finding'])
                    .describe(
                        "'finding' mutes one vulnerability identity and needs source + advisoryId + packageName; 'project' mutes every finding on a project and needs only projectId."
                    ),
                projectId: z
                    .string()
                    .min(1)
                    .nullable()
                    .optional()
                    .describe(
                        'Project the mute applies to. Required for scope=project. For scope=finding, omit it to mute that identity across EVERY project.'
                    ),
                source: z
                    .string()
                    .min(1)
                    .nullable()
                    .optional()
                    .describe(
                        "Which source reported the finding — 'npm-audit', 'osv' or 'gemnasium' — taken from the finding's `source` field in list_findings. Required for scope=finding."
                    ),
                scanner: z
                    .string()
                    .min(1)
                    .nullable()
                    .optional()
                    .describe('DEPRECATED alias for `source`, kept so older clients keep working. Pass `source` instead.'),
                ecosystem: z.string().min(1).nullable().optional().describe("EcosystemId of the finding ('npm', 'PyPI', 'Go', 'crates.io'); defaults to 'npm'"),
                advisoryId: z
                    .string()
                    .min(1)
                    .nullable()
                    .optional()
                    .describe(
                        "The finding's advisoryId exactly as list_findings reports it for that source — the ids differ between sources for the same CVE. Required for scope=finding."
                    ),
                packageName: z
                    .string()
                    .min(1)
                    .nullable()
                    .optional()
                    .describe('Name of the vulnerable package, as list_findings reports it. Required for scope=finding.'),
                reason: z
                    .string()
                    .min(1)
                    .describe(
                        'Why this risk is being accepted. Stored permanently and shown in the portal beside the muted finding, so write the actual justification a reviewer would need months from now — not a placeholder.'
                    ),
                expiresAt: z.number().int().nullable().optional().describe('Unix ms timestamp when the mute expires; null = permanent')
            }
        },
        async function handler({ scope, projectId, source, scanner, ecosystem, advisoryId, packageName, reason, expiresAt }) {
            // `source` is the durable finding identity persisted into mutes.scanner; accept the legacy
            // `scanner` param name as an alias so older MCP clients keep working.
            const sourceIdentity = source || scanner || null
            if (scope === 'finding' && (!sourceIdentity || !advisoryId || !packageName)) {
                return { isError: true, content: [{ type: 'text', text: 'scope=finding requires source, advisoryId, and packageName' }] }
            }
            const db = getDb()
            const mute: Mute = {
                id: ulid(),
                scope: scope as MuteScope,
                projectId: projectId || null,
                scanner: scope === 'project' ? null : sourceIdentity,
                // Target the requested (source, ecosystem) cell; default to npm when the caller omits it.
                ecosystem: scope === 'project' ? null : (ecosystem || DEFAULT_ECOSYSTEM),
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
            description:
                'Deletes a mute, so whatever it was hiding becomes visible on the dashboard and in the advisory export again. Get the id from list_mutes. Note that unmuting reverses a human\'s accepted-risk decision — do not do it to "clean up" while remediating unless you were asked to.',
            inputSchema: { muteId: z.string().min(1).describe('Id of the mute to delete, as returned by list_mutes (a ULID).') }
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
            description:
                'Sets a display name for a project, overriding the one derived from its directory. Affects how the project is labelled in the portal and in advisory documents; it does not change the projectId or any path.',
            inputSchema: {
                projectId: z.string().min(1).describe('Project id, as returned by list_projects (a 26-char hex string)'),
                alias: z
                    .string()
                    .describe('The display name to use. Pass an empty string to clear the alias and fall back to the auto-derived name.')
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
            description:
                'REPLACES a project\'s tags with the list you pass — it does not add to them. To add or remove one tag, read the current set from get_project first and send the full modified list, or you will silently delete the tags you omitted. Passing an empty array clears all tags.',
            inputSchema: {
                projectId: z.string().min(1).describe('Project id, as returned by list_projects (a 26-char hex string)'),
                tags: z
                    .array(z.string())
                    .describe(
                        'The complete tag set this project should end up with. Existing tags not present here are removed. Blank entries are dropped and surrounding whitespace trimmed.'
                    )
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
