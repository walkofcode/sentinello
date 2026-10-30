import {
    DEFAULT_ECOSYSTEM,
    ECOSYSTEMS,
    projectScanState,
    type EcosystemId,
    type FindingInstallation,
    type Remediation,
    type ScanState
} from '@sentinello/core'
import {
    createGemnasiumScanner,
    createOsvScanner,
    graphForEcosystem,
    mergeResolvedGraphs,
    npmAuditPlugin,
    reconcileAgainstReported,
    resolveProjectGraphs,
    splitInstalled,
    type DetectedManifest,
    type DiscoveredProject,
    type EcosystemCoverage,
    type FixEvidence,
    type RawFinding,
    type ReportedAdvisory,
    type ResolvedGraph,
    type ResolverResult,
    type ScannerPlugin
} from '@sentinello/scanners'
import { fixEvidenceKey, settleProject, type FixSettlement, type RegistryClients } from '@sentinello/fixes'
import { join } from 'node:path'
import { cacheEcosystemKey, type FeedCell, type LoadedCache } from './cache/lookup'
import type { SourceId } from './cache/meta'

// The CLI's scan runner. Structurally this is apps/worker/src/runner.ts with every database and
// notification call removed: same manifest detection, same resolvers, same scanner order, the same run of
// each source once per (source, ecosystem) cell the project has, same dedup. That symmetry is the point — a
// CLI run and a portal scan of the same project must produce the same findings, which is only true if they
// drive the scanners identically.

const SCANNER_TIMEOUT_MS = 90_000

// The npm-audit plugin name. The Node toolchain (nvm) is JavaScript-only and confined to this scanner;
// the advisory-feed sources are toolchain-free.
const NPM_AUDIT_SCANNER_NAME = 'npm-audit'

export type ScannerOutcome = {
    scanner: string
    // The ecosystem of the cell this run of the scanner answered for.
    ecosystem: EcosystemId
    status: string
    reasonCode: string
    errorText: string | null
    durationMs: number
}

export type ProjectScanResult = {
    project: DiscoveredProject
    findings: RawFinding[]
    outcomes: ScannerOutcome[]
    // Each surviving finding's fix, settled from every source's evidence against its own ecosystem's
    // registry by the same settleProject the worker calls — `unverified`, marked offline, under --offline.
    fixes: Map<RawFinding, FixSettlement>
    // The way out for each finding settled 'none_released'. Empty when it could not be computed.
    remediations: Map<RawFinding, Remediation>
    // Where each finding was installed: what the matcher recorded, or for npm-audit's findings, which carry
    // none, the copies of the npm graph at the installed versions it reported.
    installations: Map<RawFinding, FindingInstallation[]>
    // Why the way out could not be computed, or null. The fixes stand regardless.
    wayOutError: string | null
    // Whether the project could be scanned: the same projectScanState the portal reads, over this run's own
    // source cells.
    scanState: ScanState
}

// One manifest the project owns, with what the resolver made of it. `manifestPath` is relative to the
// project (ProjectManifest.path), the name coverage and installations carry.
export type ResolvedManifest = {
    manifestPath: string
    result: ResolverResult
}

export type ResolvedProject = {
    project: DiscoveredProject
    // One per manifest the project owns, in the project's manifest order: its own directory's first, then
    // the sub-manifests discovery assigned to it (ios/Gemfile.lock).
    manifests: ResolvedManifest[]
    npmGraph: ResolvedGraph | null
}

// Resolves every project's dependency graph before any scanning happens. Doing this as a separate pass
// means the advisory cache can be read ONCE for the union of every package across every project, instead
// of re-reading a multi-megabyte file per project.
//
// The manifests are the ones discovery assigned to the project, as the worker reads them, not a fresh look
// at the project's own directory: a sub-manifest (an Expo app's ios/Gemfile.lock) belongs to its project.
export async function resolveProjects(projects: readonly DiscoveredProject[]): Promise<ResolvedProject[]> {
    const out: ResolvedProject[] = []
    for (const project of projects) {
        const detected = project.manifests.map(function toDetected(m): DetectedManifest {
            return { kind: m.kind, ecosystem: m.ecosystem, absolutePath: join(project.absolutePath, m.path) }
        })
        const results = await resolveProjectGraphs(project.absolutePath, detected)
        out.push({
            project,
            manifests: results.map(function pair(result, i): ResolvedManifest {
                return { manifestPath: project.manifests[i]!.path, result }
            }),
            npmGraph: graphForEcosystem(results, DEFAULT_ECOSYSTEM)
        })
    }
    return out
}

// Every ecosystem the discovered projects hold, in registry order. Discovery only looks for the stable
// ecosystems' manifests, so this is the stable ecosystems the tree actually contains.
export function detectedEcosystems(projects: readonly DiscoveredProject[]): EcosystemId[] {
    const present = new Set<string>()
    for (const project of projects) {
        for (const ecosystem of project.ecosystems) present.add(ecosystem)
    }
    return ECOSYSTEMS.filter(function inTree(eco) { return present.has(eco.id) }).map(function id(eco) { return eco.id })
}

// Every distinct package name per ecosystem across every resolved project, which is exactly the set of cache
// rows worth reading. A real tree resolves a few thousand names out of the ~217k in the npm corpus.
export function collectPackageNames(resolved: readonly ResolvedProject[]): Map<EcosystemId, string[]> {
    const names = new Map<EcosystemId, Set<string>>()
    for (const entry of resolved) {
        for (const { result } of entry.manifests) {
            if (result.status === 'unauditable') continue
            for (const pkg of result.graph.packages) {
                const ecosystem = result.ecosystem as EcosystemId
                const set = names.get(ecosystem)
                if (set) set.add(pkg.name)
                else names.set(ecosystem, new Set([pkg.name]))
            }
        }
    }
    const out = new Map<EcosystemId, string[]>()
    for (const [ecosystem, set] of names) out.set(ecosystem, Array.from(set))
    return out
}

export type ScanSetup = {
    cacheDir: string
    // The feed cells the run audits: each requested feed source for each ecosystem the tree holds, less a
    // cell whose feed is switched off and was never seeded (run.ts enabledCells).
    cells: FeedCell[]
    includeNpmAudit: boolean
    // The cells whose cache is genuinely downloaded and current, read from the cache metadata.
    // This must NOT be inferred from whether any rows matched the project being scanned: a project with no
    // dependencies (or simply no vulnerable ones) matches nothing, and inferring from that would report
    // "database not downloaded" about a cache holding 224k advisories — telling the user to fix something
    // that is not broken, and hiding the fact that the project was in fact scanned cleanly.
    seeded: FeedCell[]
    // The run's instant, stamped on every finding's fix snapshot as its settlement time, so one run's
    // findings all say the same thing about when they were settled.
    settledAt: number
    // One client per ecosystem's registry for the whole run, so a package is fetched at most once across
    // every project (as the worker's batch clients are). Null under --offline: no request is made at all.
    registry: RegistryClients | null
    abortSignal?: AbortSignal
}

function hasCell(cells: readonly FeedCell[], source: string, ecosystem: string): boolean {
    return cells.some(function matches(cell) { return cell.source === source && cell.ecosystem === ecosystem })
}

// Whether a scanner runs for one of the project's ecosystems: npm-audit for npm alone, and only when the run
// includes it; a feed source for each cell the run audits.
export function cellRuns(setup: Pick<ScanSetup, 'cells' | 'includeNpmAudit'>, scanner: string, ecosystem: string): boolean {
    if (scanner === NPM_AUDIT_SCANNER_NAME) return setup.includeNpmAudit && ecosystem === DEFAULT_ECOSYSTEM
    return hasCell(setup.cells, scanner, ecosystem)
}

function runsSource(setup: Pick<ScanSetup, 'cells'>, source: SourceId): boolean {
    return setup.cells.some(function of(cell) { return cell.source === source })
}

// Builds the ordered scanner list bound to the loaded cache. Order IS the dedup priority: npm-audit is
// authoritative and goes first, then OSV, then gemnasium — identical to the worker's selectScanners.
export function buildScanners(setup: ScanSetup, cache: LoadedCache): ScannerPlugin[] {
    const scanners: ScannerPlugin[] = []
    if (setup.includeNpmAudit) scanners.push(npmAuditPlugin)
    if (runsSource(setup, 'osv')) {
        scanners.push(createOsvScanner({
            lookup: function lookup(ecosystem, packageNames) {
                return pick(cache.get(cacheEcosystemKey(ecosystem))?.osv, packageNames)
            },
            isSeeded: function isSeeded(ecosystem: string): boolean {
                return hasCell(setup.seeded, 'osv', ecosystem)
            },
            isEnabled: function isEnabled(ecosystem: string): boolean {
                return hasCell(setup.cells, 'osv', ecosystem)
            }
        }))
    }
    if (runsSource(setup, 'gemnasium')) {
        // The scanner's seed gate takes no ecosystem: the portal's gemnasium cache is one database for every
        // ecosystem. The CLI keeps one file per ecosystem, seeded as each first appears in a scanned tree, so
        // each cell's run goes to a scanner gated on that cell, and an unseeded one answers exactly as the
        // scanner answers for an unseeded cache.
        const deps = {
            lookup: function lookup(ecosystem: string, packageNames: string[]) {
                return pick(cache.get(cacheEcosystemKey(ecosystem))?.gemnasium, packageNames)
            },
            isEnabled: function isEnabled(ecosystem: string): boolean {
                return hasCell(setup.cells, 'gemnasium', ecosystem)
            },
            // Always ready: the cache was stamped (or not) before the scan, and a one-shot report with no
            // complete OSV evidence reports gemnasium unstamped under a warning instead of refusing it.
            // Only the portal, whose findings persist across scans, has to wait for the evidence.
            withdrawalEvidenceReady: function withdrawalEvidenceReady(): boolean {
                return true
            }
        }
        const seeded = createGemnasiumScanner({ ...deps, isSeeded: function isSeeded(): boolean { return true } })
        const unseeded = createGemnasiumScanner({ ...deps, isSeeded: function isSeeded(): boolean { return false } })
        scanners.push({
            name: seeded.name,
            scan: function scan(projectPath, ctx) {
                const current = ctx.ecosystem !== undefined && hasCell(setup.seeded, 'gemnasium', ctx.ecosystem)
                return (current ? seeded : unseeded).scan(projectPath, ctx)
            }
        })
    }
    return scanners
}

// Narrows one ecosystem's preloaded rows to the names one scanner asked for. The cache was loaded for the
// union of every project's packages, so this is a map filter rather than any I/O. An ecosystem the run loaded
// nothing for (`rows` undefined) answers nothing: each ecosystem's rows are their own map, so npm advisories
// can never be matched against Python versions.
export function pick<T>(rows: ReadonlyMap<string, T[]> | undefined, packageNames: string[]): Map<string, T[]> {
    const out = new Map<string, T[]>()
    if (!rows) return out
    for (const name of packageNames) {
        const list = rows.get(name)
        if (list && list.length > 0) out.set(name, list)
    }
    return out
}

// The ecosystems a project holds, in registry order — the order the worker runs a source's cells in.
export function projectEcosystems(resolved: Pick<ResolvedProject, 'manifests'>): EcosystemId[] {
    const present = new Set<string>(resolved.manifests.map(function ecosystem(m) { return m.result.ecosystem }))
    return ECOSYSTEMS.filter(function inProject(eco) { return present.has(eco.id) }).map(function id(eco) { return eco.id })
}

function toCoverage({ manifestPath, result }: ResolvedManifest): EcosystemCoverage {
    if (result.status === 'ok') return { ecosystem: result.ecosystem, manifestPath, status: 'ok' }
    return { ecosystem: result.ecosystem, manifestPath, status: result.status, reasonCode: result.reasonCode, details: result.details }
}

// Runs every scanner against one project, in order, once per (scanner, ecosystem) cell the run audits for
// it, deduping as it goes — runProjectScanners' loop. A feed source gets only the cell's ecosystem's graph
// and coverage, npm-audit the npm graph. The dedup set accumulates the (package -> advisory keys) already
// reported so a later source drops what an earlier one surfaced; its keys are ecosystem-scoped, so a PyPI
// `requests` never collapses into an npm `requests` sharing an alias.
export async function scanProject(
    setup: ScanSetup,
    resolved: ResolvedProject,
    scanners: readonly ScannerPlugin[]
): Promise<ProjectScanResult> {
    const findings: RawFinding[] = []
    const outcomes: ScannerOutcome[] = []
    const reportedByPackage = new Map<string, Map<string, ReportedAdvisory>>()
    const ecosystems = projectEcosystems(resolved)
    for (const scanner of scanners) {
        for (const ecosystem of ecosystems) {
            if (setup.abortSignal && setup.abortSignal.aborted) break
            if (!cellRuns(setup, scanner.name, ecosystem)) continue
            const isNpmAudit = scanner.name === NPM_AUDIT_SCANNER_NAME
            const cell = resolved.manifests.filter(function of(m) { return m.result.ecosystem === ecosystem })
            const startedAt = Date.now()
            let result
            try {
                result = await scanner.scan(resolved.project.absolutePath, {
                    timeoutMs: SCANNER_TIMEOUT_MS,
                    ecosystem,
                    // Only npm-audit touches the Node toolchain, and only when the project pins a version.
                    useNvm: isNpmAudit && resolved.project.nvmrcVersion !== null,
                    abortSignal: setup.abortSignal,
                    resolvedGraph: isNpmAudit ? resolved.npmGraph : mergeResolvedGraphs(cell.map(function result(m) { return m.result })),
                    coverage: isNpmAudit ? undefined : cell.map(toCoverage)
                })
            } catch (err) {
                outcomes.push({
                    scanner: scanner.name,
                    ecosystem,
                    status: 'error',
                    reasonCode: 'audit_unknown_failure',
                    errorText: err instanceof Error && err.message || String(err),
                    durationMs: Date.now() - startedAt
                })
                continue
            }
            outcomes.push({
                scanner: scanner.name,
                ecosystem,
                status: result.status,
                reasonCode: result.reasonCode,
                errorText: result.errorText,
                durationMs: result.durationMs
            })
            if (result.status !== 'ok') continue
            // Corroborations are attached to the surviving finding in place and its severity re-graded to
            // the worst any source gave, so the report and the --fail-on gate both see the cautious value
            // without the CLI needing anywhere to store it.
            for (const finding of reconcileAgainstReported(result.findings, reportedByPackage, scanner.name).kept) {
                findings.push(finding)
            }
        }
    }
    // Settlement waits for every source, as in the worker: the fix has to clear every source's affected set
    // and every installed copy. A survivor is registered under each of its identity keys, so the same
    // ReportedAdvisory is visited more than once; settleProject settles each identity once.
    const survivors = new Map<RawFinding, ReportedAdvisory>()
    const evidence = new Map<string, FixEvidence[]>()
    for (const byKey of reportedByPackage.values()) {
        for (const reported of byKey.values()) {
            survivors.set(reported.finding, reported)
            evidence.set(fixEvidenceKey(reported), reported.evidence)
        }
    }
    const settled = await settleProject({
        findings: [...survivors.values()],
        evidence,
        graph: resolved.npmGraph,
        registry: setup.registry,
        checkedAt: setup.settledAt
    })
    const fixes = new Map<RawFinding, FixSettlement>()
    const remediations = new Map<RawFinding, Remediation>()
    const installations = new Map<RawFinding, FindingInstallation[]>()
    for (const [finding, reported] of survivors) {
        const key = fixEvidenceKey(reported)
        // settleProject settles every identity it is given.
        fixes.set(finding, settled.settlements.get(key) as FixSettlement)
        const remediation = settled.remediations.get(key)
        if (remediation) remediations.set(finding, remediation)
        installations.set(finding, installationsFor(finding, resolved.npmGraph))
    }
    return {
        project: resolved.project,
        findings,
        outcomes,
        fixes,
        remediations,
        installations,
        wayOutError: settled.wayOutError,
        scanState: cliScanState(setup, resolved, scanners, outcomes)
    }
}

// Where each copy of a package a finding names was installed — the worker's installationsFor. The matcher
// records it for the feed sources; npm-audit reports a package and its installed versions only, so they are
// found in the npm graph, and with no npm graph to look in there are none to name.
export function installationsFor(raw: RawFinding, graph: ResolvedGraph | null): FindingInstallation[] {
    if (raw.installations) return raw.installations
    if (graph === null) return []
    const versions = splitInstalled(raw.installedVersion)
    const out: FindingInstallation[] = []
    for (const pkg of graph.byName(raw.packageName)) {
        if (!versions.includes(pkg.version)) continue
        if (out.some(function same(i) { return i.manifestPath === pkg.manifestPath && i.version === pkg.version })) continue
        out.push({ manifestPath: pkg.manifestPath, version: pkg.version })
    }
    return out
}

// The run's expected cells are the scanners it built, for each of the project's ecosystems the run audits
// with them; an ecosystem the project holds that no cell answers for (`--source npm-audit` on a Python
// project, or a feed switched off and never seeded) reads as no source enabled, never as clean. A scanner the
// run never reached (aborted) has no outcome and reads as not yet run.
export function cliScanState(
    setup: Pick<ScanSetup, 'cells' | 'includeNpmAudit'>,
    resolved: Pick<ResolvedProject, 'manifests'>,
    scanners: readonly Pick<ScannerPlugin, 'name'>[],
    outcomes: readonly ScannerOutcome[]
): ScanState {
    const ecosystems = projectEcosystems(resolved)
    const expectedCells: { source: string; ecosystem: string }[] = []
    for (const scanner of scanners) {
        for (const ecosystem of ecosystems) {
            if (cellRuns(setup, scanner.name, ecosystem)) expectedCells.push({ source: scanner.name, ecosystem })
        }
    }
    return projectScanState({
        expectedCells,
        latestScans: outcomes.map(function latest(o) { return { source: o.scanner, ecosystem: o.ecosystem, status: o.status, reasonCode: o.reasonCode, finishedAt: 0 } }),
        detectedEcosystems: ecosystems,
        sourceDisabled: ecosystems
            .filter(function unanswered(ecosystem) { return !expectedCells.some(function answers(cell) { return cell.ecosystem === ecosystem }) })
            .map(function subject(id) { return { kind: 'ecosystem' as const, id } }),
        coverage: resolved.manifests.map(function covered({ result }) {
            return { ecosystem: result.ecosystem, status: result.status, reasonCode: result.status === 'ok' ? null : result.reasonCode }
        })
    })
}
