import { Range, satisfies, gte, gt, valid } from 'semver'
import { normalizeSemver } from '@sentinello/versions'

// A fix version is a fact about the package registry, not arithmetic on a range. This module used to turn a
// `<=X` bound into "X+1" and a `>X` bound into "X+1" and report the result as the fix — which is how braces
// 3.0.4 and node-forge 1.4.1 came to be recommended across the fleet although neither was ever published,
// and how qs was sent to a non-existent 6.15.4 while 6.16.0 was out. Two things live here now, and neither
// invents a version:
//
//   - pickStatedFix: the fix a SOURCE states, read only from bounds literally present in its data.
//   - the affected set, which @sentinello/fixes' pickReleasedFix tests registry versions against to find
//     the fix the REGISTRY proves.

// pnpm audit writes this as `patched_versions` to say "no patched version exists". It is a statement, not a
// range: read as a range it would match nothing and so make every candidate unpatched.
export const NO_PATCHED_VERSION_SENTINEL = '<0.0.0'

// Everything a source said that bears on which version fixes a finding. One per reporting source/copy; the
// worker settles a finding against all of them, so the answer does not depend on which source ran first.
export type AffectedSet = {
    // The applicable ranges as a semver range string ('||'-joined), null when the advisory has none
    // (exact-only). '*' for malware with no version data: every version is affected.
    ranges: string | null
    // Enumerated affected versions, kept verbatim. Compared after normalizeSemver, the same normalization
    // the matcher used, so `<1.1.0` plus exact `1.1.0` rejects 1.1.0.
    exact: string[]
    // False when some of the advisory's affected data could not be carried here — a range dropped for this
    // comparator, or one that does not parse. An incomplete set can never prove a version safe.
    complete: boolean
}

export type FixEvidence = {
    source: string
    // Every installed copy this source saw, as written (a comma-joined npm-audit value is split).
    installed: string[]
    affected: AffectedSet
    // The source's patched range, when it states one. NO_PATCHED_VERSION_SENTINEL is provenance only.
    patched: string | null
    statedFix: string | null
    // npm audit says `npm audit fix` resolves the finding through a parent without naming a version of this
    // package. Not a fix version; kept so the finding can still say a fix path exists.
    fixViaParent: boolean
}

export type PickStatedFixArgs = {
    patched: string | null
    recommendation: string | null
    vulnerable: string
    installed: string | null
}

const VERSION_LITERAL_RE = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g

export function isNoPatchedSentinel(input: string): boolean {
    return input.trim() === NO_PATCHED_VERSION_SENTINEL
}

export function parseRangeSafely(input: string | null): Range | null {
    if (!input) return null
    const trimmed = input.trim()
    if (!trimmed || isNoPatchedSentinel(trimmed)) return null
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

// The `>=X` / `=X` lower bound of each AND-conjunction of a patched range (Range.set is OR of ANDs). A `>X`
// bound names no version — the next one is whatever the registry has — so it contributes nothing.
function extractRangeLowerBounds(range: Range): string[] {
    const out: string[] = []
    for (const conjuncts of range.set) {
        let candidate: string | null = null
        for (const c of conjuncts) {
            // The ANY comparator carries version ''; every other comparator in a parsed Range carries a
            // version the parser already validated.
            if (!c.semver.version) continue
            const op = c.operator
            if (op !== '>=' && op !== '=' && op !== '') continue
            if (!candidate || gt(c.semver.version, candidate)) candidate = c.semver.version
        }
        if (candidate) out.push(candidate)
    }
    return out
}

// The `<X` bounds of a vulnerable range: X is the first version past that branch, as the source states it.
// A `<=X` bound says X is still vulnerable and names nothing beyond it.
function extractExclusiveUpperBounds(range: Range): string[] {
    const out: string[] = []
    for (const conjuncts of range.set) {
        for (const c of conjuncts) {
            if (c.operator === '<' && c.semver.version) out.push(c.semver.version)
        }
    }
    return out
}

// node-semver desugars partial versions (`<1.2` becomes `<1.2.0-0`), so a bound read off a parsed Range is
// not always text the source wrote. Only a version spelled out in the source counts as stated.
function literallyIn(text: string, versions: string[]): string[] {
    const literals = new Set(extractLiteralCandidates(text))
    return versions.filter(function stated(v) {
        return literals.has(v)
    })
}

// The installed-version string can be a single version, or a comma-joined list of versions when the same
// package is hoisted at multiple versions (see pickInstalledVersion in npm-audit-parse.ts).
export function splitInstalled(installed: string | null): string[] {
    if (!installed) return []
    return installed.split(/[\s,]+/).filter(function nonEmpty(part) {
        return part.length > 0
    })
}

// The highest parseable installed copy, so no copy is ever told to downgrade.
function pickHighestInstalled(installed: string | null): string | null {
    let highest: string | null = null
    for (const part of splitInstalled(installed)) {
        if (!valid(part)) continue
        if (!highest || gt(part, highest)) highest = part
    }
    return highest
}

// The fix a source STATES — never one derived from a bound. Candidates are only versions written in the
// source's own data: the `>=X`/`=X` lower bounds of the patched range (or the literals of an unparseable
// one), the recommendation's literals, and the `<X` bounds of the vulnerable range. The lowest one that is
// inside the patched range, outside the vulnerable range and not below the installed copy wins. Null when
// the source states nothing usable: "no fix stated" is an answer, a guessed version is not.
export function pickStatedFix(args: PickStatedFixArgs): string | null {
    const patchedText = args.patched ?? ''
    const patchedRange = parseRangeSafely(patchedText)
    const vulnRange = parseRangeSafely(args.vulnerable)
    const installedFloor = pickHighestInstalled(args.installed)

    const candidates = new Set<string>()
    if (patchedRange) {
        for (const v of literallyIn(patchedText, extractRangeLowerBounds(patchedRange))) candidates.add(v)
    } else if (!isNoPatchedSentinel(patchedText)) {
        for (const v of extractLiteralCandidates(patchedText)) candidates.add(v)
    }
    for (const v of extractLiteralCandidates(args.recommendation)) candidates.add(v)
    if (vulnRange) {
        for (const v of literallyIn(args.vulnerable, extractExclusiveUpperBounds(vulnRange))) candidates.add(v)
    }

    let best: string | null = null
    for (const v of candidates) {
        if (patchedRange && !satisfies(v, patchedRange)) continue
        if (vulnRange && satisfies(v, vulnRange)) continue
        if (installedFloor && !gte(v, installedFloor)) continue
        if (!best || gt(best, v)) best = v
    }
    return best
}

// An affected set built from a range string a source handed over verbatim (npm audit's `range`, pnpm's
// `vulnerable_versions`). Empty, unparseable, or the no-patch sentinel in the wrong field: incomplete.
export function affectedSetFromRange(vulnerable: string): AffectedSet {
    const trimmed = vulnerable.trim()
    const parses = trimmed.length > 0 && !isNoPatchedSentinel(trimmed) && parseRangeSafely(trimmed) !== null
    return { ranges: trimmed.length > 0 ? trimmed : null, exact: [], complete: parses }
}

// An affected set ready to test versions against. Null when it cannot be evaluated: incomplete, a range
// that does not parse, or an exact version normalizeSemver cannot read (it might be the very version a
// candidate spells differently).
export type EvaluableAffected = { range: Range | null; exact: Set<string> }

export function evaluableAffected(affected: AffectedSet): EvaluableAffected | null {
    if (!affected.complete) return null
    let range: Range | null = null
    if (affected.ranges !== null) {
        try {
            // includePrerelease: a version inside the bounds is affected whatever its tag, which is how the
            // matcher's own ordering comparison reads the same bounds.
            range = new Range(affected.ranges, { includePrerelease: true })
        } catch {
            return null
        }
    }
    const exact = new Set<string>()
    for (const raw of affected.exact) {
        const v = normalizeSemver(raw)
        if (v === null) return null
        exact.add(v)
    }
    return { range, exact }
}

// Whether a set marks a version affected: true / false, or null when the set — or the version — cannot be
// evaluated (which must never be read as "safe").
export function affectedSetContains(affected: AffectedSet, version: string): boolean | null {
    const ev = evaluableAffected(affected)
    if (ev === null) return null
    const normalized = normalizeSemver(version)
    if (normalized === null) return null
    return evaluableContains(ev, normalized)
}

// `version` must already be normalized the way the exact entries were: `v1.2.1` and `1.2.1+build` are
// the release 1.2.1, and an exact entry of 1.2.1 has to catch both spellings.
export function evaluableContains(ev: EvaluableAffected, version: string): boolean {
    if (ev.exact.has(version)) return true
    return ev.range !== null && ev.range.test(version)
}
