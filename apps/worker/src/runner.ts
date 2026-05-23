import { resolve } from 'node:path'
import { ulid } from 'ulid'
import type { Finding, Project, Scan } from '@sentinello/core'
import {
    insertScan,
    mergeFindingsForScan,
    getRootById,
    walCheckpoint,
    getConfigValue,
    type DrizzleDb,
    type IncomingFinding,
    type SqliteDb
} from '@sentinello/db'
import type { RawFinding, ScannerPlugin } from '@sentinello/scanners'
import { CONFIG_KEYS } from './config-loader'
import { notifyForCompletedScan } from './notifier'

const SCANNER_TIMEOUT_MS = 90_000

export type RunBatchInput = {
    db: DrizzleDb
    sqlite: SqliteDb
    scanner: ScannerPlugin
    projects: Project[]
    parallelism: number
    abortSignal?: AbortSignal
}

export type ProjectScanOutcome = {
    project: Project
    scan: Scan
    findings: Finding[]
}

export async function runBatch(input: RunBatchInput): Promise<ProjectScanOutcome[]> {
    const outcomes: ProjectScanOutcome[] = []
    const queue = input.projects.slice()
    const workerCount = Math.max(1, Math.min(input.parallelism, queue.length))
    const workers: Promise<void>[] = []
    for (let i = 0; i < workerCount; i++) {
        workers.push(workerLoop(input, queue, outcomes))
    }
    await Promise.all(workers)
    walCheckpoint(input.sqlite)
    return outcomes
}

async function workerLoop(
    input: RunBatchInput,
    queue: Project[],
    outcomes: ProjectScanOutcome[]
): Promise<void> {
    while (true) {
        const project = queue.shift()
        if (!project) return
        if (input.abortSignal && input.abortSignal.aborted) return
        const outcome = await runOneProject(input, project)
        outcomes.push(outcome)
    }
}

async function runOneProject(
    input: RunBatchInput,
    project: Project
): Promise<ProjectScanOutcome> {
    const root = getRootById(input.db, project.rootId)
    if (!root) {
        const outcome = makeErrorOutcome(project, 'project root not found in DB')
        insertScan(input.db, outcome.scan)
        return outcome
    }
    const projectPath = resolve(root.path, project.relPath)
    const startedAt = Date.now()
    let scanResult
    try {
        scanResult = await input.scanner.scan(projectPath, {
            timeoutMs: SCANNER_TIMEOUT_MS,
            useNvm: project.nvmrcVersion !== null,
            abortSignal: input.abortSignal
        })
    } catch (err) {
        const message = err instanceof Error && err.message || String(err)
        const outcome = makeErrorOutcome(project, 'scanner threw: ' + message, startedAt)
        insertScan(input.db, outcome.scan)
        return outcome
    }
    const finishedAt = Date.now()
    const scan: Scan = {
        id: ulid(),
        projectId: project.id,
        startedAt,
        finishedAt,
        scanner: input.scanner.name,
        status: scanResult.status,
        reasonCode: scanResult.reasonCode,
        durationMs: scanResult.durationMs,
        errorText: scanResult.errorText,
        rawJson: scanResult.rawJson
    }
    const incoming: IncomingFinding[] = scanResult.findings.map(function toIncoming(raw: RawFinding): IncomingFinding {
        return {
            projectId: project.id,
            scanner: input.scanner.name,
            advisoryId: raw.advisoryId,
            advisoryTitle: raw.advisoryTitle,
            advisoryUrl: raw.advisoryUrl,
            packageName: raw.packageName,
            installedVersion: raw.installedVersion,
            vulnerableRange: raw.vulnerableRange,
            severity: raw.severity,
            fixAvailable: raw.fixAvailable,
            fixVersion: raw.fixVersion,
            depPath: raw.depPath,
            isProd: raw.isProd,
            isDev: raw.isDev
        }
    })
    // Lifecycle merge: on a successful scan, upsert each finding by identity, refreshing the open
    // episode's last_seen_at + mutable fields, opening new episodes for previously-unseen
    // identities, and closing (resolved_at) episodes that have disappeared. For
    // error/timeout/unauditable scans we record the scan row but leave findings alone so the UI
    // keeps its last-known view and a transient failure never mass-resolves an entire project.
    const merged = input.db.transaction(function mergeLifecycle(tx): Finding[] {
        insertScan(tx, scan)
        if (scan.status !== 'ok') return []
        const result = mergeFindingsForScan(tx, {
            projectId: project.id,
            scanId: scan.id,
            scanFinishedAt: scan.finishedAt,
            incoming
        })
        return result.active
    })
    const outcome: ProjectScanOutcome = { project, scan, findings: merged }
    const dryRun = getConfigValue<boolean>(input.db, CONFIG_KEYS.dryRunNotify) || false
    try {
        await notifyForCompletedScan({ db: input.db, outcome, dryRun })
    } catch (err) {
        const message = err instanceof Error && err.message || String(err)
        console.error('[runner] notifier failed for project ' + project.id + ': ' + message)
    }
    return outcome
}

function makeErrorOutcome(project: Project, errorText: string, startedAt?: number): ProjectScanOutcome {
    const at = Date.now()
    const start = startedAt || at
    const scan: Scan = {
        id: ulid(),
        projectId: project.id,
        startedAt: start,
        finishedAt: at,
        scanner: 'npm-audit',
        status: 'error',
        reasonCode: 'audit_unknown_failure',
        durationMs: at - start,
        errorText,
        rawJson: ''
    }
    return { project, scan, findings: [] }
}
