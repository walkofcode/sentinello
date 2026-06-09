import { semverComparator } from './engine/comparators/semver'
import { matchAdvisories } from './engine/matcher'
import type { CanonicalAdvisory } from './engine/types'
import type { ResolvedPackage } from './resolver/types'
import type { RawFinding, ScanContext, ScannerPlugin, ScanResult } from './types'

export const OSV_SCANNER_NAME = 'osv'

// One normalized OSV version range. `fixed` null means open-ended (vulnerable from `introduced` with no
// known fix).
export type OsvRange = {
    introduced: string
    fixed: string | null
}

// The advisory shape the OSV feed hands the scanner. Mirrors the db's OsvAdvisoryRow but is redeclared
// here so the scanners package stays free of a direct @sentinello/db dependency — the worker adapts db
// rows into this shape when it builds the lookup. `versions` is OSV's enumerated affected-version list
// (how malware records pin the compromised builds); `ranges` is the SEMVER form. `malicious` flags the
// MAL- threat class for severity/UI — it no longer drives matching (the engine matches on versions/ranges).
export type OsvAdvisory = {
    advisoryId: string
    aliases: string[]
    ranges: OsvRange[]
    versions: string[]
    severity: string | null
    summary: string | null
    url: string | null
    malicious: boolean
}

// Injected by the worker: given the npm ecosystem and the list of installed package names, return the
// advisories affecting each (keyed by package name). The scanner stays pure — all I/O lives in the lookup
// so it can be backed by the osv.db cache in production and a plain Map in tests.
export type OsvLookup = (packageNames: string[]) => Map<string, OsvAdvisory[]>

export type OsvScannerDeps = {
    lookup: OsvLookup
    // Gate flag: false until the initial OSV seed has completed. When false the scanner returns
    // status='unauditable' reason='osv_db_not_seeded' rather than reporting zero findings.
    isSeeded: () => boolean
}

const NPM_ECOSYSTEM = 'npm'

// Factory-from-function (no classes): the worker binds `lookup`/`isSeeded` to the live osv.db cache and
// registers the returned plugin. OSV is an advisory-FEED source: it normalizes records into
// CanonicalAdvisory and hands them to the shared matching engine — it owns no matching logic itself.
export function createOsvScanner(deps: OsvScannerDeps): ScannerPlugin {
    async function scan(_projectPath: string, ctx: ScanContext): Promise<ScanResult> {
        const startedAt = Date.now()
        if (!deps.isSeeded()) {
            return unauditable('osv_db_not_seeded', 'OSV database has not been downloaded yet', startedAt)
        }
        const graph = ctx.resolvedGraph
        if (!graph) {
            // No resolvable lockfile (yarn/unparseable/absent) — fail open, same posture as the cross-check.
            return unauditable('no_lockfile', 'no resolvable lockfile for OSV', startedAt)
        }
        const findings = matchPackages(graph.packages, deps.lookup)
        return {
            status: 'ok',
            reasonCode: 'ok',
            findings,
            rawJson: JSON.stringify({ source: 'osv', packageCount: graph.packages.length, findingCount: findings.length }),
            errorText: null,
            durationMs: Date.now() - startedAt
        }
    }
    return { name: OSV_SCANNER_NAME, scan }
}

// Looks up the advisories for the resolved packages, normalizes them to CanonicalAdvisory, and runs the
// shared engine. Exported for direct testing without spinning up a scan.
export function matchPackages(packages: ResolvedPackage[], lookup: OsvLookup): RawFinding[] {
    const names = uniqueNames(packages)
    if (names.length === 0) return []
    const byPackageRaw = lookup(names)
    const byPackage = new Map<string, CanonicalAdvisory[]>()
    for (const [name, advisories] of byPackageRaw.entries()) {
        byPackage.set(name, advisories.map(function toCanonical(advisory) {
            return toCanonicalAdvisory(name, advisory)
        }))
    }
    return matchAdvisories(packages, byPackage, semverComparator)
}

function toCanonicalAdvisory(packageName: string, advisory: OsvAdvisory): CanonicalAdvisory {
    return {
        id: advisory.advisoryId,
        source: OSV_SCANNER_NAME,
        aliases: advisory.aliases,
        ecosystem: NPM_ECOSYSTEM,
        packageName,
        affected: {
            ranges: advisory.ranges,
            exactVersions: advisory.versions
        },
        kind: advisory.malicious ? 'malware' : 'vulnerability',
        severity: advisory.severity,
        summary: advisory.summary,
        url: advisory.url,
        withdrawn: null
    }
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
