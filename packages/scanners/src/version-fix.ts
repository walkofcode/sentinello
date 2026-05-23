import { Range, satisfies, gte, gt, valid, coerce } from 'semver'

export type PickSafeFixVersionArgs = {
    patched: string | null
    recommendation: string | null
    vulnerable: string
    installed: string | null
}

const VERSION_LITERAL_RE = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g

function parseRangeSafely(input: string | null): Range | null {
    if (!input) return null
    const trimmed = input.trim()
    if (!trimmed) return null
    // pnpm audit uses '<0.0.0' as a sentinel for "no fix available"
    if (trimmed === '<0.0.0') return null
    try {
        return new Range(trimmed, { includePrerelease: false })
    } catch {
        return null
    }
}

function extractLiteralCandidates(input: string | null): string[] {
    if (!input) return []
    const matches = input.match(VERSION_LITERAL_RE)
    if (!matches) return []
    const out: string[] = []
    for (const m of matches) {
        if (valid(m)) out.push(m)
    }
    return out
}

function bumpPatch(v: string): string | null {
    const sv = coerce(v)
    if (!sv) return null
    return sv.major + '.' + sv.minor + '.' + (sv.patch + 1)
}

// For a parsed semver Range, return the lower-bound version of each AND-conjunction
// (Range.set is OR of ANDs). For '>=X' or '=X' the bound is X; for '>X' we bump the
// patch by one as an approximation of "the next allowed version".
function extractRangeLowerBounds(range: Range): string[] {
    const out: string[] = []
    for (const conjuncts of range.set) {
        let candidate: string | null = null
        for (const c of conjuncts) {
            if (!c.semver || !c.semver.version) continue
            const v = c.semver.version
            if (!valid(v)) continue
            const op = c.operator
            if (op === '>=' || op === '=' || op === '') {
                if (!candidate || gt(v, candidate)) candidate = v
            } else if (op === '>') {
                const inc = bumpPatch(v)
                if (inc && (!candidate || gt(inc, candidate))) candidate = inc
            }
        }
        if (candidate) out.push(candidate)
    }
    return out
}

// For a parsed VULNERABLE semver Range, derive candidate fix versions: for each '<X'
// comparator X itself is the smallest version above the bound; for '<=X' we bump the
// patch by one. These candidates are still validated against the full vulnerable range
// in the main filter, so spurious values get rejected.
function extractRangeUpperBoundsBeyond(range: Range): string[] {
    const out: string[] = []
    for (const conjuncts of range.set) {
        for (const c of conjuncts) {
            if (!c.semver || !c.semver.version) continue
            const v = c.semver.version
            if (!valid(v)) continue
            const op = c.operator
            if (op === '<') {
                out.push(v)
            } else if (op === '<=') {
                const inc = bumpPatch(v)
                if (inc) out.push(inc)
            }
        }
    }
    return out
}

// The installed-version string can be a single version, or a comma-joined list of
// versions when the same package is hoisted at multiple versions (see pickInstalledVersion
// in npm-audit.ts). Use the highest as the floor so we never suggest a downgrade for
// any of the installed copies.
function pickHighestInstalled(installed: string | null): string | null {
    if (!installed) return null
    const parts = installed.split(/[\s,]+/)
    let highest: string | null = null
    for (const raw of parts) {
        const part = raw.trim()
        if (!part) continue
        if (!valid(part)) continue
        if (!highest || gt(part, highest)) highest = part
    }
    return highest
}

// Pick the lowest version that:
//   1. satisfies `patched` (if parseable)
//   2. does NOT satisfy `vulnerable` (if parseable)
//   3. is >= `installed` (if known)
// Returns null when no candidate meets all three constraints — better to suggest
// nothing than suggest a version that is still vulnerable or is a downgrade.
export function pickSafeFixVersion(args: PickSafeFixVersionArgs): string | null {
    const patchedRange = parseRangeSafely(args.patched)
    const vulnRange = parseRangeSafely(args.vulnerable)
    const installedFloor = pickHighestInstalled(args.installed)

    const candidates = new Set<string>()
    if (patchedRange) {
        for (const v of extractRangeLowerBounds(patchedRange)) candidates.add(v)
    } else {
        for (const v of extractLiteralCandidates(args.patched)) candidates.add(v)
    }
    for (const v of extractLiteralCandidates(args.recommendation)) candidates.add(v)
    // The upper bound of the vulnerable range is often the actual fix. For '<X' that's
    // X itself; for '<=X' that's X+1 patch. We also throw raw literals from the
    // vulnerable string into the pool as a fallback for unparseable ranges — the main
    // filter rejects anything still inside the vulnerable range.
    if (vulnRange) {
        for (const v of extractRangeUpperBoundsBeyond(vulnRange)) candidates.add(v)
    }
    for (const v of extractLiteralCandidates(args.vulnerable)) candidates.add(v)

    if (candidates.size === 0) return null

    let best: string | null = null
    for (const v of candidates) {
        if (patchedRange && !satisfies(v, patchedRange)) continue
        if (vulnRange && satisfies(v, vulnRange)) continue
        if (installedFloor && !gte(v, installedFloor)) continue
        if (!best || gt(best, v)) best = v
    }
    return best
}
