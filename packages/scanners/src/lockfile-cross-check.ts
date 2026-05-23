import { satisfies, validRange, valid, coerce } from 'semver'
import type { RawFinding } from './types'

// Result of cross-checking audit findings against the lockfile-resolved installed versions.
// `droppedAdvisoryIds` is bounded by `kept.length + droppedCount === input.length`; truncation
// for log-readability happens at the call site.
export type CrossCheckResult = {
    kept: RawFinding[]
    droppedCount: number
    droppedAdvisoryIds: string[]
}

// Filters audit findings by semver-checking each finding's lockfile-resolved installedVersion
// against the advisory's vulnerableRange. Drops a finding only when EVERY candidate installed
// version is definitively outside the vulnerable range — i.e. the package manager's override
// (or resolution, or lockfile drift) actually moved the install to a safe version, and the audit
// tool's advisory match was a false positive against the declared spec.
//
// Fail-open semantics: any uncertainty (empty installedVersion / vulnerableRange, unparseable
// range, non-semver candidate version) keeps the finding. We never silently swallow a finding
// we can't reason about.
//
// Multi-install handling: npm hoisting can leave duplicate copies of the same package at
// different versions; RawFinding.installedVersion joins them with ", ". If ANY copy is in the
// vulnerable range, the finding is kept — there's a bad version on disk somewhere.
export function filterFindingsByLockfileResolution(findings: RawFinding[]): CrossCheckResult {
    const kept: RawFinding[] = []
    const droppedAdvisoryIds: string[] = []
    for (const finding of findings) {
        if (shouldKeep(finding)) {
            kept.push(finding)
        } else {
            droppedAdvisoryIds.push(finding.advisoryId)
        }
    }
    return { kept, droppedCount: droppedAdvisoryIds.length, droppedAdvisoryIds }
}

function shouldKeep(finding: RawFinding): boolean {
    const installed = finding.installedVersion.trim()
    const range = finding.vulnerableRange.trim()
    // No signal to filter on — keep.
    if (!installed || !range) return true
    // Range unparseable — keep (we cannot prove the install is outside it).
    if (validRange(range) === null) return true
    const candidates = installed.split(/,\s*/).map(function trim(s) { return s.trim() }).filter(Boolean)
    if (candidates.length === 0) return true
    for (const candidate of candidates) {
        const cleaned = normalizeVersion(candidate)
        // Non-semver candidate (git URL, file:, workspace:, garbage) — keep, can't reason about it.
        if (cleaned === null) return true
        // Any single in-range copy on disk means the vulnerability is real — keep.
        if (satisfies(cleaned, range, { includePrerelease: true })) return true
    }
    // Every candidate is a valid semver AND none satisfy the vulnerable range — drop.
    return false
}

// Accepts strict semver as-is; otherwise tries coerce ('v1.2.3', '1.2', '1' → '1.x.x').
// Returns null when the input is not coercible to a valid semver (git URLs, file: specs, etc.).
function normalizeVersion(raw: string): string | null {
    const strict = valid(raw)
    if (strict !== null) return strict
    const coerced = coerce(raw)
    if (coerced === null) return null
    return coerced.version
}
