import {
    claimNextPendingRequest,
    getConfigValue,
    getProjectById,
    getRootById,
    listRoots,
    markScanRequestDone,
    markScanRequestFailed,
    pingScanRequestHeartbeat,
    listProjects,
    listProjectsByRoot,
    type DrizzleDb,
    type SqliteDb
} from '@sentinello/db'
import { npmAuditPlugin } from '@sentinello/scanners'
import {
    CONFIG_KEYS,
    DEFAULT_GLOBAL_IGNORE,
    DEFAULT_PARALLELISM
} from './config-loader'
import { discoverProjects } from './discovery'
import { runBatch } from './runner'
import type { WorkerRuntime } from './runtime'

const POLL_INTERVAL_MS = 5_000
const HEARTBEAT_INTERVAL_MS = 5_000

export type PollerHandles = {
    stop(): void
}

export type StartPollerInput = {
    db: DrizzleDb
    sqlite: SqliteDb
    runtime: WorkerRuntime
    intervalMs?: number
}

export function startScanRequestPoller(input: StartPollerInput): PollerHandles {
    const interval = input.intervalMs || POLL_INTERVAL_MS
    let stopped = false
    const handle = setInterval(function tick() {
        if (stopped) return
        const work = pollOnce(input).catch(function onError(err: unknown) {
            const message = err instanceof Error && err.message || String(err)
            console.error('[scan-request-poller] tick failed: ' + message)
        })
        input.runtime.track(work)
    }, interval)
    handle.unref()
    return {
        stop() {
            stopped = true
            clearInterval(handle)
        }
    }
}

export async function pollOnce(input: StartPollerInput): Promise<void> {
    const claimedAt = Date.now()
    const claimed = claimNextPendingRequest(input.db, claimedAt)
    if (!claimed) return
    // Liveness ping. Keeps scan_requests.heartbeat_at fresh so the web UI knows this row is
    // still being worked on, and so a future worker startup (post-crash) can distinguish
    // in-flight rows from orphaned ones.
    const heartbeat = setInterval(function tick() {
        try {
            pingScanRequestHeartbeat(input.db, claimed.id, Date.now())
        } catch (err) {
            const message = err instanceof Error && err.message || String(err)
            console.error('[scan-request-poller] heartbeat ping failed for ' + claimed.id + ': ' + message)
        }
    }, HEARTBEAT_INTERVAL_MS)
    heartbeat.unref()
    try {
        if (claimed.projectId) {
            await runSingleProject(input, claimed.projectId, claimed.id)
        } else if (claimed.rootId) {
            await runRootSweep(input, claimed.rootId, claimed.id)
        } else {
            await runFullSweep(input, claimed.id)
        }
        markScanRequestDone(input.db, claimed.id, Date.now())
    } catch (err) {
        const message = err instanceof Error && err.message || String(err)
        console.error('[scan-request-poller] request ' + claimed.id + ' failed: ' + message)
        markScanRequestFailed(input.db, claimed.id, Date.now())
    } finally {
        clearInterval(heartbeat)
    }
}

async function runSingleProject(input: StartPollerInput, projectId: string, requestId: string): Promise<void> {
    const startedAt = Date.now()
    const project = getProjectById(input.db, projectId)
    if (!project) {
        throw new Error('project not found: ' + projectId)
    }
    console.log('[scan-request-poller] single-project scan started (request=' + requestId + ', project=' + projectId + ')')
    const parallelism = (getConfigValue<number>(input.db, CONFIG_KEYS.parallelism)) || DEFAULT_PARALLELISM
    await runBatch({
        db: input.db,
        sqlite: input.sqlite,
        scanner: npmAuditPlugin,
        projects: [project],
        parallelism,
        abortSignal: input.runtime.abortController.signal
    })
    console.log('[scan-request-poller] single-project scan finished (request=' + requestId + ', project=' + projectId + ', ' + formatDurationMs(Date.now() - startedAt) + ')')
}

async function runFullSweep(input: StartPollerInput, requestId: string): Promise<void> {
    const startedAt = Date.now()
    const at = startedAt
    const roots = listRoots(input.db)
    const globalIgnore = (getConfigValue<string[]>(input.db, CONFIG_KEYS.globalIgnore)) || DEFAULT_GLOBAL_IGNORE
    discoverProjects({ db: input.db, roots, globalIgnore, at })
    const projects = listProjects(input.db)
    console.log('[scan-request-poller] full sweep started (request=' + requestId + ', ' + projects.length + ' project' + (projects.length === 1 ? '' : 's') + ')')
    if (projects.length === 0) {
        console.log('[scan-request-poller] full sweep finished (request=' + requestId + ', 0 projects, ' + formatDurationMs(Date.now() - startedAt) + ')')
        return
    }
    const parallelism = (getConfigValue<number>(input.db, CONFIG_KEYS.parallelism)) || DEFAULT_PARALLELISM
    await runBatch({
        db: input.db,
        sqlite: input.sqlite,
        scanner: npmAuditPlugin,
        projects,
        parallelism,
        abortSignal: input.runtime.abortController.signal
    })
    console.log('[scan-request-poller] full sweep finished (request=' + requestId + ', ' + projects.length + ' project' + (projects.length === 1 ? '' : 's') + ', ' + formatDurationMs(Date.now() - startedAt) + ')')
}

async function runRootSweep(input: StartPollerInput, rootId: string, requestId: string): Promise<void> {
    const startedAt = Date.now()
    const at = startedAt
    const root = getRootById(input.db, rootId)
    if (!root) {
        throw new Error('root not found: ' + rootId)
    }
    const globalIgnore = (getConfigValue<string[]>(input.db, CONFIG_KEYS.globalIgnore)) || DEFAULT_GLOBAL_IGNORE
    discoverProjects({ db: input.db, roots: [root], globalIgnore, at })
    const projects = listProjectsByRoot(input.db, rootId)
    console.log('[scan-request-poller] root sweep started (request=' + requestId + ', root=' + rootId + ', ' + projects.length + ' project' + (projects.length === 1 ? '' : 's') + ')')
    if (projects.length === 0) {
        console.log('[scan-request-poller] root sweep finished (request=' + requestId + ', root=' + rootId + ', 0 projects, ' + formatDurationMs(Date.now() - startedAt) + ')')
        return
    }
    const parallelism = (getConfigValue<number>(input.db, CONFIG_KEYS.parallelism)) || DEFAULT_PARALLELISM
    await runBatch({
        db: input.db,
        sqlite: input.sqlite,
        scanner: npmAuditPlugin,
        projects,
        parallelism,
        abortSignal: input.runtime.abortController.signal
    })
    console.log('[scan-request-poller] root sweep finished (request=' + requestId + ', root=' + rootId + ', ' + projects.length + ' project' + (projects.length === 1 ? '' : 's') + ', ' + formatDurationMs(Date.now() - startedAt) + ')')
}

function formatDurationMs(ms: number): string {
    if (ms < 1000) return ms + 'ms'
    return (ms / 1000).toFixed(2) + 's'
}
