import { DEFAULT_ECOSYSTEM, type EcosystemId } from '@sentinello/core'
import {
    createGemnasiumScanner,
    createOsvScanner,
    detectManifests,
    graphForEcosystem,
    mergeResolvedGraphs,
    npmAuditPlugin,
    reconcileAgainstReported,
    resolveProjectGraphs,
    type DiscoveredProject,
    type RawFinding,
    type ResolvedGraph,
    type ResolverResult,
    type ScannerPlugin
} from '@sentinello/scanners'
import { cacheEcosystemKey, type LoadedCache } from './cache/lookup'
import type { SourceId } from './cache/meta'

// The CLI's scan runner. Structurally this is apps/worker/src/runner.ts with every database and
// notification call removed: same manifest detection, same resolvers, same scanner order, same dedup. That
// symmetry is the point — a CLI run and a portal scan of the same project must produce the same findings,
// which is only true if they drive the scanners identically.

const SCANNER_TIMEOUT_MS = 90_000

// The npm-audit plugin name. The Node toolchain (nvm) is JavaScript-only and confined to this scanner;
// the advisory-feed sources are toolchain-free.
const NPM_AUDIT_SCANNER_NAME = 'npm-audit'

export type ScannerOutcome = {
    scanner: string
    status: string
    reasonCode: string
    errorText: string | null
    durationMs: number
}

export type ProjectScanResult = {
    project: DiscoveredProject
    findings: RawFinding[]
    outcomes: ScannerOutcome[]
}

export type ResolvedProject = {
    project: DiscoveredProject
    results: ResolverResult[]
    merged: ResolvedGraph | null
    npmGraph: ResolvedGraph | null
}

// Resolves every project's dependency graph before any scanning happens. Doing this as a separate pass
// means the advisory cache can be read ONCE for the union of every package across every project, instead
// of re-reading a 6.4 MB file per project.
export async function resolveProjects(projects: readonly DiscoveredProject[]): Promise<ResolvedProject[]> {
    const out: ResolvedProject[] = []
    for (const project of projects) {
        const manifests = await detectManifests(project.absolutePath)
        const results = await resolveProjectGraphs(project.absolutePath, manifests)
        out.push({
            project,
            results,
            merged: mergeResolvedGraphs(results),
            npmGraph: graphForEcosystem(results, DEFAULT_ECOSYSTEM)
        })
    }
    return out
}

// Every distinct package name across every resolved project, which is exactly the set of cache rows worth
// reading. A real tree resolves a few thousand names out of the ~217k in the npm corpus.
export function collectPackageNames(resolved: readonly ResolvedProject[]): string[] {
    const names = new Set<string>()
    for (const entry of resolved) {
        if (!entry.merged) continue
        for (const pkg of entry.merged.packages) names.add(pkg.name)
    }
    return Array.from(names)
}

export type ScanSetup = {
    cacheDir: string
    sources: SourceId[]
    ecosystem: EcosystemId
    includeNpmAudit: boolean
    // Whether each source's cache is genuinely downloaded and current, read from the cache metadata.
    // This must NOT be inferred from whether any rows matched the project being scanned: a project with no
    // dependencies (or simply no vulnerable ones) matches nothing, and inferring from that would report
    // "database not downloaded" about a cache holding 224k advisories — telling the user to fix something
    // that is not broken, and hiding the fact that the project was in fact scanned cleanly.
    seeded: Record<SourceId, boolean>
    abortSignal?: AbortSignal
}

// Builds the ordered scanner list bound to the loaded cache. Order IS the dedup priority: npm-audit is
// authoritative and goes first, then OSV, then gemnasium — identical to the worker's selectScanners.
export function buildScanners(setup: ScanSetup, cache: LoadedCache): ScannerPlugin[] {
    const scanners: ScannerPlugin[] = []
    if (setup.includeNpmAudit) scanners.push(npmAuditPlugin)
    if (setup.sources.includes('osv')) {
        scanners.push(createOsvScanner({
            lookup: function lookup(ecosystem, packageNames) {
                return pick(cache.osv, ecosystem, packageNames, setup.ecosystem)
            },
            isSeeded: function isSeeded(): boolean {
                return setup.seeded.osv
            },
            isEnabled: function isEnabled(ecosystem: string): boolean {
                return ecosystem === setup.ecosystem
            }
        }))
    }
    if (setup.sources.includes('gemnasium')) {
        scanners.push(createGemnasiumScanner({
            lookup: function lookup(ecosystem, packageNames) {
                return pick(cache.gemnasium, ecosystem, packageNames, setup.ecosystem)
            },
            isSeeded: function isSeeded(): boolean {
                return setup.seeded.gemnasium
            },
            isEnabled: function isEnabled(ecosystem: string): boolean {
                return ecosystem === setup.ecosystem
            }
        }))
    }
    return scanners
}

// Narrows the preloaded cache to the names one scanner asked for. The cache was loaded for the union of
// every project's packages, so this is a map filter rather than any I/O.
function pick<T>(
    loaded: Map<string, T[]>,
    ecosystem: string,
    packageNames: string[],
    expected: EcosystemId
): Map<string, T[]> {
    const out = new Map<string, T[]>()
    if (cacheEcosystemKey(ecosystem) !== cacheEcosystemKey(expected)) return out
    for (const name of packageNames) {
        const rows = loaded.get(name)
        if (rows && rows.length > 0) out.set(name, rows)
    }
    return out
}

// Runs every scanner against one project, in order, deduping as it goes. The dedup set accumulates the
// (package -> advisory keys) already reported so a later source drops what an earlier one surfaced.
export async function scanProject(
    setup: ScanSetup,
    resolved: ResolvedProject,
    scanners: readonly ScannerPlugin[]
): Promise<ProjectScanResult> {
    const findings: RawFinding[] = []
    const outcomes: ScannerOutcome[] = []
    const reportedByPackage = new Map<string, Set<string>>()
    const coverage = resolved.results.map(function toCoverage(result) {
        if (result.status === 'ok') return { ecosystem: result.ecosystem, status: result.status }
        return { ecosystem: result.ecosystem, status: result.status, reasonCode: result.reasonCode, details: result.details }
    })
    for (const scanner of scanners) {
        if (setup.abortSignal && setup.abortSignal.aborted) break
        const isNpmAudit = scanner.name === NPM_AUDIT_SCANNER_NAME
        const startedAt = Date.now()
        let result
        try {
            result = await scanner.scan(resolved.project.absolutePath, {
                timeoutMs: SCANNER_TIMEOUT_MS,
                // Only npm-audit touches the Node toolchain, and only when the project pins a version.
                useNvm: isNpmAudit && resolved.project.nvmrcVersion !== null,
                abortSignal: setup.abortSignal,
                resolvedGraph: isNpmAudit ? resolved.npmGraph : resolved.merged,
                coverage: isNpmAudit ? undefined : coverage
            })
        } catch (err) {
            outcomes.push({
                scanner: scanner.name,
                status: 'error',
                reasonCode: 'audit_unknown_failure',
                errorText: err instanceof Error && err.message || String(err),
                durationMs: Date.now() - startedAt
            })
            continue
        }
        outcomes.push({
            scanner: scanner.name,
            status: result.status,
            reasonCode: result.reasonCode,
            errorText: result.errorText,
            durationMs: result.durationMs
        })
        if (result.status !== 'ok') continue
        for (const finding of reconcileAgainstReported(result.findings, reportedByPackage)) {
            findings.push(finding)
        }
    }
    return { project: resolved.project, findings, outcomes }
}
