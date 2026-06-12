import { acceptedRangeTypesForEcosystem, comparatorForEcosystem } from './engine/comparators'
import { matchAdvisories } from './engine/matcher'
import type { CanonicalAdvisory } from './engine/types'
import type { ResolvedPackage } from './resolver/types'
import type { RawFinding, ScanContext, ScannerPlugin, ScanResult } from './types'

export const OSV_SCANNER_NAME = 'osv'

// One normalized OSV version range. `fixed` null means there is no clean fix boundary; `lastAffected` (when
// set) is then an inclusive upper bound (OSV `last_affected`), and when both are null the range is
// open-ended. `type` is the OSV `range.type` ('SEMVER' | 'ECOSYSTEM' | 'GIT'), carried so non-SEMVER
// ecosystems (PyPI/Go/Rust) keep their semantics; the ecosystem's comparator interprets the version strings.
export type OsvRange = {
    type: string
    introduced: string
    fixed: string | null
    lastAffected: string | null
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

// Injected by the worker: given an ecosystem (the canonical OSV id, e.g. 'npm' | 'PyPI' | 'Go' |
// 'crates.io') and the installed package names, return the advisories affecting each in THAT ecosystem
// (keyed by package name). The scanner stays pure — all I/O lives in the lookup so it can be backed by the
// osv.db cache in production and a plain Map in tests.
export type OsvLookup = (ecosystem: string, packageNames: string[]) => Map<string, OsvAdvisory[]>

export type OsvScannerDeps = {
    lookup: OsvLookup
    // Per-ecosystem seed gate: false until the OSV export for that ecosystem has been seeded. When a
    // project's ecosystem is not seeded the scanner skips it; when NO present (and enabled) ecosystem is
    // seeded it returns status='unauditable' reason='osv_db_not_seeded' rather than reporting zero findings.
    isSeeded: (ecosystem: string) => boolean
    // Per-ecosystem enabled gate: the operator's live (osv, ecosystem) cell flag. The configuration unit is
    // a (source, ecosystem) cell, so a disabled cell must never produce findings — even if it was seeded
    // earlier and a sibling OSV cell keeps the runtime running. Checked BEFORE seed/lookup so a disabled-yet-
    // seeded ecosystem is skipped entirely. Disabling a cell hides its findings on read (active-cell
    // filtering); this stops the scanner persisting/notifying new findings for it in the first place.
    isEnabled: (ecosystem: string) => boolean
}

// Factory-from-function (no classes): the worker binds `lookup`/`isSeeded` to the live osv.db cache and
// registers the returned plugin. OSV is an advisory-FEED source: it normalizes records into
// CanonicalAdvisory and hands them to the shared matching engine — it owns no matching logic itself. The
// graph may span several ecosystems (one polyglot project); each is matched against its own ecosystem's
// advisory rows with its own comparator.
export function createOsvScanner(deps: OsvScannerDeps): ScannerPlugin {
    async function scan(_projectPath: string, ctx: ScanContext): Promise<ScanResult> {
        const startedAt = Date.now()
        const graph = ctx.resolvedGraph
        if (!graph) {
            // No resolvable lockfile (yarn/unparseable/absent) — fail open, same posture as the cross-check.
            return unauditable('no_lockfile', 'no resolvable lockfile for OSV', startedAt)
        }
        // Only ecosystems whose (osv, ecosystem) cell is enabled are auditable by this source; a disabled
        // cell contributes nothing (the "not auditable because no source enabled" disclosure is Phase 5).
        const ecosystems = distinctEcosystems(graph.packages).filter(deps.isEnabled)
        // If the project has enabled ecosystems but none of them is seeded, we can't responsibly claim
        // zero findings — surface "not downloaded yet" exactly as the npm-only path did.
        if (ecosystems.length > 0 && !ecosystems.some(deps.isSeeded)) {
            return unauditable('osv_db_not_seeded', 'OSV database has not been downloaded yet', startedAt)
        }
        const findings = matchPackages(graph.packages, deps.lookup, deps.isSeeded, deps.isEnabled)
        return {
            status: 'ok',
            reasonCode: 'ok',
            findings,
            // Record per-ecosystem resolver coverage alongside the counts so partial/unauditable Python/Go
            // coverage is captured in the persisted scan (Phase 5 surfaces it in the UI).
            rawJson: JSON.stringify({ source: 'osv', packageCount: graph.packages.length, findingCount: findings.length, coverage: ctx.coverage ?? [] }),
            errorText: null,
            durationMs: Date.now() - startedAt
        }
    }
    return { name: OSV_SCANNER_NAME, scan }
}

// Looks up the advisories for the resolved packages, normalizes them to CanonicalAdvisory, and runs the
// shared engine — once per ecosystem present in the graph, each with its own comparator. An ecosystem is
// skipped when its (osv, ecosystem) cell is disabled (isEnabled), when it is not seeded (isSeeded), or when
// it has no comparator implemented yet — never matched with the wrong version semantics and never matched
// for a cell the operator turned off. Exported for direct testing.
export function matchPackages(
    packages: ResolvedPackage[],
    lookup: OsvLookup,
    isSeeded?: (ecosystem: string) => boolean,
    isEnabled?: (ecosystem: string) => boolean
): RawFinding[] {
    const findings: RawFinding[] = []
    for (const [ecosystem, pkgs] of groupByEcosystem(packages).entries()) {
        if (isEnabled && !isEnabled(ecosystem)) continue
        if (isSeeded && !isSeeded(ecosystem)) continue
        const comparator = comparatorForEcosystem(ecosystem)
        if (!comparator) continue
        // The OSV range types this ecosystem's comparator may evaluate. Non-null whenever `comparator` is
        // (both come from the same registry entry); the `?? []` is a defensive "match no ranges" guard for a
        // comparator that ever ships without a declared accepted-types entry — never fall back to all-types.
        const acceptedRangeTypes = acceptedRangeTypesForEcosystem(ecosystem) ?? []
        const names = uniqueNames(pkgs)
        if (names.length === 0) continue
        const byPackageRaw = lookup(ecosystem, names)
        const byPackage = new Map<string, CanonicalAdvisory[]>()
        for (const [name, advisories] of byPackageRaw.entries()) {
            byPackage.set(name, advisories.map(function toCanonical(advisory) {
                return toCanonicalAdvisory(name, ecosystem, advisory)
            }))
        }
        for (const finding of matchAdvisories(pkgs, byPackage, comparator, acceptedRangeTypes)) findings.push(finding)
    }
    return findings
}

function toCanonicalAdvisory(packageName: string, ecosystem: string, advisory: OsvAdvisory): CanonicalAdvisory {
    return {
        id: advisory.advisoryId,
        source: OSV_SCANNER_NAME,
        aliases: advisory.aliases,
        ecosystem,
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

function groupByEcosystem(packages: ResolvedPackage[]): Map<string, ResolvedPackage[]> {
    const byEco = new Map<string, ResolvedPackage[]>()
    for (const pkg of packages) {
        const list = byEco.get(pkg.ecosystem)
        if (list) {
            list.push(pkg)
        } else {
            byEco.set(pkg.ecosystem, [pkg])
        }
    }
    return byEco
}

function distinctEcosystems(packages: ResolvedPackage[]): string[] {
    const set = new Set<string>()
    for (const pkg of packages) set.add(pkg.ecosystem)
    return Array.from(set)
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
