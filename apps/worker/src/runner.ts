import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { DEFAULT_ECOSYSTEM, type Finding, type Project, type Scan } from '@sentinello/core'
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
import {
    detectManifests,
    graphForEcosystem,
    mergeResolvedGraphs,
    reconcileAgainstReported,
    resolveProjectGraphs,
    type EcosystemCoverage,
    type RawFinding,
    type ResolvedGraph,
    type ResolverResult,
    type ScannerPlugin
} from '@sentinello/scanners'
import { CONFIG_KEYS } from './config-loader'
import { notifyForCompletedScan } from './notifier'

const SCANNER_TIMEOUT_MS = 90_000

// The npm-audit scanner plugin name. nvm/Node tooling and the JavaScript-only resolved graph are confined
// to this scanner; every other (advisory-feed) source is toolchain-free and answers across ecosystems.
const NPM_AUDIT_SCANNER_NAME = 'npm-audit'

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
    // Resolve EVERY detected ecosystem's graph ONCE per project (Phase 4 — one project spans JS + Python +
    // Go + Rust). Each resolver result is classified ok/partial/unauditable so coverage is honest. The
    // advisory-feed sources (OSV, gemnasium) answer for all ecosystems, so they get the merged graph and
    // group by ecosystem internally; npm-audit gets only the JavaScript graph and is the sole scanner that
    // touches the Node toolchain (nvm). Each scanner still resolves/merges findings scoped to its own name.
    const manifests = await detectManifests(projectPath)
    const resolverResults = await resolveProjectGraphs(projectPath, manifests)
    const mergedGraph = mergeResolvedGraphs(resolverResults)
    const npmGraph = graphForEcosystem(resolverResults, 'npm')
    const coverage = resolverResults.map(toCoverage)
    const outcomes: ProjectScanOutcome[] = []
    // (ecosystem|package) → set of advisory keys (lower-cased ids + aliases) already reported this run.
    // The key is the ECOSYSTEM-SCOPED package identity (findingPackageIdentity), never the bare name: a
    // polyglot feed scan carries npm + PyPI + Go + crates packages together, so dedup must not collapse a
    // PyPI `requests` into an npm `requests` that shares a CVE/GHSA alias. Keep it ecosystem-scoped.
    const reportedByPackage = new Map<string, Set<string>>()
    for (const scanner of input.scanners) {
        if (input.abortSignal && input.abortSignal.aborted) break
        const isNpmAudit = scanner.name === NPM_AUDIT_SCANNER_NAME
        const graphForScanner = isNpmAudit ? npmGraph : mergedGraph
        const coverageForScanner = isNpmAudit ? undefined : coverage
        const outcome = await runOneScanner(input, project, projectPath, scanner, reportedByPackage, graphForScanner, coverageForScanner)
        outcomes.push(outcome)
    }
    return outcomes
}

// Flatten a classified ResolverResult into the compact per-ecosystem coverage the feed scanners record.
function toCoverage(result: ResolverResult): EcosystemCoverage {
    if (result.status === 'ok') return { ecosystem: result.ecosystem, status: 'ok' }
    return { ecosystem: result.ecosystem, status: result.status, reasonCode: result.reasonCode, details: result.details }
}

async function runOneScanner(
    input: RunBatchInput,
    project: Project,
    projectPath: string,
    scanner: ScannerPlugin,
    reportedByPackage: Map<string, Set<string>>,
    resolvedGraph: ResolvedGraph | null,
    coverage: EcosystemCoverage[] | undefined
): Promise<ProjectScanOutcome> {
    const startedAt = Date.now()
    // nvm/Node tooling is JavaScript-only: only the npm-audit scanner ever invokes it. Feed sources are
    // toolchain-free, so a project's .nvmrc must not make them try to switch Node versions.
    const useNvm = scanner.name === NPM_AUDIT_SCANNER_NAME && project.nvmrcVersion !== null
    let scanResult
    try {
        scanResult = await scanner.scan(projectPath, {
            timeoutMs: SCANNER_TIMEOUT_MS,
            useNvm,
            abortSignal: input.abortSignal,
            resolvedGraph,
            coverage
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
        // For today's sources source === scanner name; ecosystem is npm (the only ecosystem scanned until
        // the polyglot resolvers land in Phases 3–4, when a scanner run is split per (source, ecosystem)).
        source: scanner.name,
        ecosystem: DEFAULT_ECOSYSTEM,
        status: scanResult.status,
        reasonCode: scanResult.reasonCode,
        durationMs: scanResult.durationMs,
        errorText: scanResult.errorText,
        rawJson: scanResult.rawJson
    }
    const deduped = reconcileAgainstReported(scanResult.findings, reportedByPackage)
    const incoming: IncomingFinding[] = deduped.map(function toIncoming(raw: RawFinding): IncomingFinding {
        return {
            projectId: project.id,
            scanner: scanner.name,
            source: scanner.name,
            // The matcher engine stamps the package's real ecosystem; npm-audit findings have none, so
            // they default to the npm ecosystem.
            ecosystem: raw.ecosystem ?? DEFAULT_ECOSYSTEM,
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

function makeErrorOutcome(project: Project, errorText: string, startedAt?: number, scanner = 'npm-audit'): ProjectScanOutcome {
    const at = Date.now()
    const start = startedAt || at
    const scan: Scan = {
        id: ulid(),
        projectId: project.id,
        startedAt: start,
        finishedAt: at,
        scanner,
        source: scanner,
        ecosystem: DEFAULT_ECOSYSTEM,
        status: 'error',
        reasonCode: 'audit_unknown_failure',
        durationMs: at - start,
        errorText,
        rawJson: ''
    }
    return { project, scan, findings: [] }
}
