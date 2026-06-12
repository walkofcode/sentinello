import { comparatorForEcosystem } from './engine/comparators'
import { matchAdvisories } from './engine/matcher'
import type { CanonicalAdvisory } from './engine/types'
import type { ResolvedPackage } from './resolver/types'
import type { RawFinding, ScanContext, ScannerPlugin, ScanResult } from './types'

export const GEMNASIUM_SCANNER_NAME = 'gemnasium'

// One normalized gemnasium version range. `fixed` null means open-ended (vulnerable from `introduced`
// with no known fix).
export type GemnasiumRange = {
    introduced: string
    fixed: string | null
}

// The advisory shape the gemnasium cache hands the scanner. Mirrors the db's GemnasiumAdvisoryRow but is
// redeclared here so the scanners package stays free of a direct @sentinello/db dependency — the worker
// adapts db rows into this shape when it builds the lookup. gemnasium carries no malware/withdrawn class,
// so unlike OSV there is no `malicious` flag and `versions` is normally empty (gemnasium uses ranges).
export type GemnasiumAdvisory = {
    advisoryId: string
    aliases: string[]
    ranges: GemnasiumRange[]
    versions: string[]
    severity: string | null
    summary: string | null
    url: string | null
}

// Injected by the worker: given an ecosystem (the registry EcosystemId, e.g. 'npm' | 'PyPI' | 'Go' |
// 'crates.io') and the installed package names, return the advisories affecting each in THAT ecosystem
// (keyed by package name). The scanner stays pure — all I/O lives in the lookup so it can be backed by the
// gemnasium.db cache in production and a plain Map in tests. gemnasium-db covers many ecosystems, so this
// is ecosystem-parameterized exactly like the OSV lookup.
export type GemnasiumLookup = (ecosystem: string, packageNames: string[]) => Map<string, GemnasiumAdvisory[]>

export type GemnasiumScannerDeps = {
    lookup: GemnasiumLookup
    // Gate flag: false until the initial gemnasium seed has completed. The gemnasium cache is a SINGLE
    // multi-ecosystem download (one seed flag covers every ecosystem), so unlike OSV this gate is global,
    // not per-ecosystem. When false the scanner returns status='unauditable' reason='gemnasium_db_not_seeded'
    // rather than reporting zero findings.
    isSeeded: () => boolean
    // Per-ecosystem enabled gate: the operator's live (gemnasium, ecosystem) cell flag. The configuration
    // unit is a (source, ecosystem) cell, so a disabled cell must never produce findings even though the
    // single gemnasium cache is seeded for all ecosystems. Checked before matching each ecosystem's packages.
    isEnabled: (ecosystem: string) => boolean
}

// Factory-from-function (no classes): the worker binds `lookup`/`isSeeded` to the live gemnasium.db cache
// and registers the returned plugin. gemnasium is an advisory-FEED source: it normalizes records into
// CanonicalAdvisory and hands them to the shared matching engine — it owns no matching logic itself.
export function createGemnasiumScanner(deps: GemnasiumScannerDeps): ScannerPlugin {
    async function scan(_projectPath: string, ctx: ScanContext): Promise<ScanResult> {
        const startedAt = Date.now()
        if (!deps.isSeeded()) {
            return unauditable('gemnasium_db_not_seeded', 'gemnasium database has not been downloaded yet', startedAt)
        }
        const graph = ctx.resolvedGraph
        if (!graph) {
            // No resolvable lockfile (yarn/unparseable/absent) — fail open, same posture as OSV.
            return unauditable('no_lockfile', 'no resolvable lockfile for gemnasium', startedAt)
        }
        // The injected lookup is backed by the gemnasium.db cache, so a corrupt/locked/removed cache throws
        // here. Catch it so the failure is recorded under gemnasium's own reason code rather than the
        // runner's generic npm/audit fallback (audit_unknown_failure), which would mislabel the source.
        let findings: RawFinding[]
        try {
            findings = matchPackages(graph.packages, deps.lookup, deps.isEnabled)
        } catch (err) {
            const message = err instanceof Error && err.message || String(err)
            return {
                status: 'error',
                reasonCode: 'gemnasium_db_unavailable',
                findings: [],
                rawJson: '',
                errorText: message,
                durationMs: Date.now() - startedAt
            }
        }
        return {
            status: 'ok',
            reasonCode: 'ok',
            findings,
            rawJson: JSON.stringify({ source: 'gemnasium', packageCount: graph.packages.length, findingCount: findings.length, coverage: ctx.coverage ?? [] }),
            errorText: null,
            durationMs: Date.now() - startedAt
        }
    }
    return { name: GEMNASIUM_SCANNER_NAME, scan }
}

// Looks up the advisories for the resolved packages, normalizes them to CanonicalAdvisory, and runs the
// shared engine — once per ecosystem present in the graph, each with its own comparator (npm/Go/Rust use
// semver, Python uses PEP 440). An ecosystem is skipped when its (gemnasium, ecosystem) cell is disabled
// (isEnabled) or has no comparator yet — never mis-matched, never matched for a cell the operator turned
// off. Unlike OSV, gemnasium ranges carry no `range.type`, so NO acceptedRangeTypes filter is passed (every
// range is evaluated); the comparator's `normalize` still safely yields null for any version string it
// can't read. Exported for direct testing without spinning up a scan.
export function matchPackages(
    packages: ResolvedPackage[],
    lookup: GemnasiumLookup,
    isEnabled?: (ecosystem: string) => boolean
): RawFinding[] {
    const findings: RawFinding[] = []
    for (const [ecosystem, pkgs] of groupByEcosystem(packages).entries()) {
        if (isEnabled && !isEnabled(ecosystem)) continue
        const comparator = comparatorForEcosystem(ecosystem)
        if (!comparator) continue
        const names = uniqueNames(pkgs)
        if (names.length === 0) continue
        const byPackageRaw = lookup(ecosystem, names)
        const byPackage = new Map<string, CanonicalAdvisory[]>()
        for (const [name, advisories] of byPackageRaw.entries()) {
            byPackage.set(name, advisories.map(function toCanonical(advisory) {
                return toCanonicalAdvisory(name, ecosystem, advisory)
            }))
        }
        for (const finding of matchAdvisories(pkgs, byPackage, comparator)) findings.push(finding)
    }
    return findings
}

function toCanonicalAdvisory(packageName: string, ecosystem: string, advisory: GemnasiumAdvisory): CanonicalAdvisory {
    return {
        id: advisory.advisoryId,
        source: GEMNASIUM_SCANNER_NAME,
        aliases: advisory.aliases,
        ecosystem,
        packageName,
        affected: {
            ranges: advisory.ranges,
            exactVersions: advisory.versions
        },
        kind: 'vulnerability',
        severity: advisory.severity,
        summary: advisory.summary,
        url: advisory.url,
        withdrawn: null
    }
}

function groupByEcosystem(packages: ResolvedPackage[]): Map<string, ResolvedPackage[]> {
    const byEco = new Map<string, ResolvedPackage[]>()
    for (const pkg of packages) {
        const list = byEco.get(pkg.ecosystem)
        if (list) list.push(pkg)
        else byEco.set(pkg.ecosystem, [pkg])
    }
    return byEco
}

function uniqueNames(packages: ResolvedPackage[]): string[] {
    const set = new Set<string>()
    for (const pkg of packages) set.add(pkg.name)
    return Array.from(set)
}

function unauditable(reasonCode: ScanResult['reasonCode'], message: string, startedAt: number): ScanResult {
    return {
        status: 'unauditable',
        reasonCode,
        findings: [],
        rawJson: '',
        errorText: message,
        durationMs: Date.now() - startedAt
    }
}
