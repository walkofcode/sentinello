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
    // Scanners to run against each project, IN ORDER. Each scanner writes its own scan row + lifecycle
    // merge, scoped to its own `name` so they never resolve each other's findings. Order matters for
    // dedup: a later scanner's findings are suppressed when an earlier scanner already reported the
    // same advisory (by id or alias) for the same package — so put the authoritative source first.
    scanners: ScannerPlugin[]
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
        const projectOutcomes = await runProjectScanners(input, project)
        for (const outcome of projectOutcomes) outcomes.push(outcome)
    }
}

// Runs every scanner against one project, in order, and returns one outcome per scanner. The dedup set
// accumulates the (package → advisory keys) reported by earlier scanners so a later scanner (OSV) drops
// findings the authoritative scanner (npm-audit) already surfaced.
async function runProjectScanners(input: RunBatchInput, project: Project): Promise<ProjectScanOutcome[]> {
    const root = getRootById(input.db, project.rootId)
    if (!root) {
        const outcome = makeErrorOutcome(project, 'project root not found in DB')
        insertScan(input.db, outcome.scan)
        return [outcome]
    }
    const projectPath = resolve(root.path, project.relPath)
    const outcomes: ProjectScanOutcome[] = []
    // package name → set of advisory keys (lower-cased ids + aliases) already reported this run.
    const reportedByPackage = new Map<string, Set<string>>()
    for (const scanner of input.scanners) {
        if (input.abortSignal && input.abortSignal.aborted) break
        const outcome = await runOneScanner(input, project, projectPath, scanner, reportedByPackage)
        outcomes.push(outcome)
    }
    return outcomes
}

async function runOneScanner(
    input: RunBatchInput,
    project: Project,
    projectPath: string,
    scanner: ScannerPlugin,
    reportedByPackage: Map<string, Set<string>>
): Promise<ProjectScanOutcome> {
    const startedAt = Date.now()
    let scanResult
    try {
        scanResult = await scanner.scan(projectPath, {
            timeoutMs: SCANNER_TIMEOUT_MS,
            useNvm: project.nvmrcVersion !== null,
            abortSignal: input.abortSignal
        })
    } catch (err) {
        const message = err instanceof Error && err.message || String(err)
        const outcome = makeErrorOutcome(project, 'scanner threw: ' + message, startedAt, scanner.name)
        insertScan(input.db, outcome.scan)
        return outcome
    }
    const finishedAt = Date.now()
    const scan: Scan = {
        id: ulid(),
        projectId: project.id,
        startedAt,
        finishedAt,
        scanner: scanner.name,
        status: scanResult.status,
        reasonCode: scanResult.reasonCode,
        durationMs: scanResult.durationMs,
        errorText: scanResult.errorText,
        rawJson: scanResult.rawJson
    }
    const deduped = suppressDuplicates(scanResult.findings, reportedByPackage)
    const incoming: IncomingFinding[] = deduped.map(function toIncoming(raw: RawFinding): IncomingFinding {
        return {
            projectId: project.id,
            scanner: scanner.name,
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
    // identities, and closing (resolved_at) episodes that have disappeared. Scoped to this scanner so
    // a second scanner's pass never resolves the first scanner's findings. For error/timeout/unauditable
    // scans we record the scan row but leave findings alone so the UI keeps its last-known view and a
    // transient failure never mass-resolves an entire project.
    const merged = input.db.transaction(function mergeLifecycle(tx): Finding[] {
        insertScan(tx, scan)
        if (scan.status !== 'ok') return []
        const result = mergeFindingsForScan(tx, {
            projectId: project.id,
            scanner: scanner.name,
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

// Drops findings whose advisory is already represented (by id or any alias) for the same package by an
// earlier scanner in this run, then records the surviving findings' keys so subsequent scanners dedup
// against them too. npm-audit and OSV both carry GHSA ids, so without this every shared advisory would
// appear twice — once per scanner. Keys are lower-cased so GHSA/CVE casing never defeats the match.
function suppressDuplicates(
    findings: RawFinding[],
    reportedByPackage: Map<string, Set<string>>
): RawFinding[] {
    const kept: RawFinding[] = []
    for (const finding of findings) {
        const existing = reportedByPackage.get(finding.packageName)
        const keys = advisoryKeys(finding)
        const isDup = existing ? keys.some(function seen(k) { return existing.has(k) }) : false
        if (isDup) continue
        kept.push(finding)
        const set = existing || new Set<string>()
        for (const k of keys) set.add(k)
        reportedByPackage.set(finding.packageName, set)
    }
    return kept
}

function advisoryKeys(finding: RawFinding): string[] {
    const keys = [finding.advisoryId.toLowerCase()]
    if (finding.aliases) {
        for (const alias of finding.aliases) keys.push(alias.toLowerCase())
    }
    return keys
}

function makeErrorOutcome(project: Project, errorText: string, startedAt?: number, scanner = 'npm-audit'): ProjectScanOutcome {
    const at = Date.now()
    const start = startedAt || at
    const scan: Scan = {
        id: ulid(),
        projectId: project.id,
        startedAt: start,
        finishedAt: at,
        scanner,
        status: 'error',
        reasonCode: 'audit_unknown_failure',
        durationMs: at - start,
        errorText,
        rawJson: ''
    }
    return { project, scan, findings: [] }
}
