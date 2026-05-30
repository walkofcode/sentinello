import { coerce, gte, lt, valid } from 'semver'
import type { Severity } from '@sentinello/core'
import { detectLockfile } from './npm-audit'
import { parseResolvedPackages, type ResolvedPackage } from './resolved-packages'
import type { RawFinding, ScanContext, ScannerPlugin, ScanResult } from './types'
import { pickSafeFixVersion } from './version-fix'

export const OSV_SCANNER_NAME = 'osv'

// One normalized OSV version range. `fixed` null means open-ended (vulnerable from `introduced` with
// no known fix) — also how every malicious-package record is represented.
export type OsvRange = {
    introduced: string
    fixed: string | null
}

// The advisory shape the scanner matches against. Mirrors the db's OsvAdvisoryRow but is redeclared
// here so the scanners package stays free of a direct @sentinello/db dependency — the worker adapts
// db rows into this shape when it builds the lookup.
export type OsvAdvisory = {
    advisoryId: string
    aliases: string[]
    ranges: OsvRange[]
    severity: string | null
    summary: string | null
    url: string | null
    malicious: boolean
}

// Injected by the worker: given the npm ecosystem and the list of installed package names, return the
// advisories affecting each (keyed by package name). The scanner stays pure — all I/O lives in the
// lookup so it can be backed by the osv.db cache in production and a plain Map in tests.
export type OsvLookup = (packageNames: string[]) => Map<string, OsvAdvisory[]>

export type OsvScannerDeps = {
    lookup: OsvLookup
    // Gate flag: false until the initial OSV seed has completed. When false the scanner returns
    // status='unauditable' reason='osv_db_not_seeded' rather than reporting zero findings.
    isSeeded: () => boolean
}

// Factory-from-function (no classes): the worker binds `lookup`/`isSeeded` to the live osv.db cache and
// registers the returned plugin. `name` matches OSV_SCANNER_NAME so per-scanner finding merge lines up.
export function createOsvScanner(deps: OsvScannerDeps): ScannerPlugin {
    async function scan(projectPath: string, _ctx: ScanContext): Promise<ScanResult> {
        const startedAt = Date.now()
        if (!deps.isSeeded()) {
            return unauditable('osv_db_not_seeded', 'OSV database has not been downloaded yet', startedAt)
        }
        const lockfile = await detectLockfile(projectPath)
        if (!lockfile) {
            return unauditable('no_lockfile', 'no lockfile found', startedAt)
        }
        const resolved = await parseResolvedPackages(projectPath, lockfile)
        if (resolved.packages === null) {
            // yarn.lock (or an unparseable lock) — fail open, same posture as the cross-check.
            return unauditable('no_lockfile', 'lockfile kind not parseable for OSV (' + lockfile.kind + ')', startedAt)
        }
        const findings = matchPackages(resolved.packages, deps.lookup)
        return {
            status: 'ok',
            reasonCode: 'ok',
            findings,
            rawJson: JSON.stringify({ source: 'osv', packageCount: resolved.packages.length, findingCount: findings.length }),
            errorText: null,
            durationMs: Date.now() - startedAt
        }
    }
    return { name: OSV_SCANNER_NAME, scan }
}

// Core matcher, exported for direct unit testing without spinning up a scan. For each resolved package,
// look up its advisories and keep the ones whose ranges contain the installed version. Deduplicates by
// advisoryId per package so a record listing the same package twice yields one finding.
export function matchPackages(packages: ResolvedPackage[], lookup: OsvLookup): RawFinding[] {
    const names = uniqueNames(packages)
    if (names.length === 0) return []
    const byPackage = lookup(names)
    const findings: RawFinding[] = []
    for (const pkg of packages) {
        const advisories = byPackage.get(pkg.name)
        if (!advisories || advisories.length === 0) continue
        const seen = new Set<string>()
        for (const advisory of advisories) {
            if (seen.has(advisory.advisoryId)) continue
            const finding = matchOne(pkg, advisory)
            if (finding) {
                seen.add(advisory.advisoryId)
                findings.push(finding)
            }
        }
    }
    return findings
}

function matchOne(pkg: ResolvedPackage, advisory: OsvAdvisory): RawFinding | null {
    const installed = normalize(pkg.version)
    // Malicious packages are flagged by presence: the whole package is bad, no version math needed.
    // If we can't normalize the installed version we still report a malicious package (better a noisy
    // critical than a silently-dropped supply-chain hit).
    if (advisory.malicious) {
        return buildFinding(pkg, advisory, 'critical', null)
    }
    if (!installed) return null
    const hit = rangeContains(advisory.ranges, installed)
    if (!hit.vulnerable) return null
    const severity = mapSeverity(advisory.severity)
    const fixVersion = pickSafeFixVersion({
        patched: null,
        recommendation: hit.firstFixed,
        vulnerable: '',
        installed: pkg.version
    })
    return buildFinding(pkg, advisory, severity, fixVersion)
}

function buildFinding(
    pkg: ResolvedPackage,
    advisory: OsvAdvisory,
    severity: Severity,
    fixVersion: string | null
): RawFinding {
    return {
        advisoryId: advisory.advisoryId,
        advisoryTitle: advisory.summary,
        advisoryUrl: advisory.url,
        packageName: pkg.name,
        installedVersion: pkg.version,
        vulnerableRange: rangesToDisplay(advisory.ranges, advisory.malicious),
        severity,
        fixAvailable: fixVersion !== null,
        fixVersion,
        depPath: pkg.depPath,
        isProd: pkg.isProd,
        isDev: pkg.isDev,
        aliases: advisory.aliases
    }
}

type RangeHit = {
    vulnerable: boolean
    // The first `fixed` boundary at or above the installed version, used as the fix target.
    firstFixed: string | null
}

// An OSV affected range is a sequence of introduced/fixed events. The installed version is vulnerable
// when it sits in [introduced, fixed) for any range entry. We treat each {introduced, fixed} pair as a
// half-open interval; a null `fixed` means "vulnerable to the latest" (no fix boundary).
function rangeContains(ranges: OsvRange[], installed: string): RangeHit {
    let vulnerable = false
    let firstFixed: string | null = null
    for (const range of ranges) {
        const introduced = range.introduced === '0' ? '0.0.0' : normalize(range.introduced)
        const fixed = range.fixed ? normalize(range.fixed) : null
        if (introduced === null) continue
        const atOrAboveIntroduced = gte(installed, introduced)
        if (!atOrAboveIntroduced) continue
        if (fixed === null) {
            vulnerable = true
            continue
        }
        if (lt(installed, fixed)) {
            vulnerable = true
            if (firstFixed === null || lt(fixed, firstFixed)) {
                firstFixed = fixed
            }
        }
    }
    return { vulnerable, firstFixed }
}

function rangesToDisplay(ranges: OsvRange[], malicious: boolean): string {
    if (malicious) return '*'
    const parts: string[] = []
    for (const range of ranges) {
        const lo = range.introduced === '0' ? '0' : range.introduced
        if (range.fixed) {
            parts.push('>=' + lo + ' <' + range.fixed)
        } else {
            parts.push('>=' + lo)
        }
    }
    return parts.join(' || ')
}

// OSV/GHSA severity buckets are upper-case (CRITICAL/HIGH/MODERATE/LOW). Map to our lower-case union;
// anything unknown or absent falls back to 'moderate' so a real advisory is never silently downgraded
// to the lowest bucket.
function mapSeverity(severity: string | null): Severity {
    if (!severity) return 'moderate'
    const s = severity.trim().toLowerCase()
    if (s === 'critical') return 'critical'
    if (s === 'high') return 'high'
    if (s === 'moderate' || s === 'medium') return 'moderate'
    if (s === 'low') return 'low'
    if (s === 'info' || s === 'none') return 'info'
    return 'moderate'
}

function normalize(raw: string): string | null {
    const strict = valid(raw)
    if (strict !== null) return strict
    const coerced = coerce(raw)
    return coerced === null ? null : coerced.version
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
