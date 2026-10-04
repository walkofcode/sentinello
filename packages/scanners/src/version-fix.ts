import { Range, satisfies, gte, gt, lt, valid, prerelease } from 'semver'
import { normalizeSemver } from '@sentinello/versions'
import type { FixUnevaluableReason } from '@sentinello/core'

// A fix version is a fact about the package registry, not arithmetic on a range. This module used to turn a
// `<=X` bound into "X+1" and a `>X` bound into "X+1" and report the result as the fix — which is how braces
// 3.0.4 and node-forge 1.4.1 came to be recommended across the fleet although neither was ever published,
// and how qs was sent to a non-existent 6.15.4 while 6.16.0 was out. Two things live here now, and neither
// invents a version:
//
//   - pickStatedFix: the fix a SOURCE states, read only from bounds literally present in its data.
//   - pickReleasedFix: the fix the REGISTRY proves, given the published version list and every source's
//     affected set. Pure; the caller fetches the version list.

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

export type PublishedVersion = {
    version: string
    deprecated: boolean
}

// Declared in core, where the verification snapshot that records it lives.
export type UnknownFixReason = FixUnevaluableReason

export type ReleasedFixResult =
    | { kind: 'released'; version: string }
    | { kind: 'none' }
    | { kind: 'unknown'; reason: UnknownFixReason }

export type PickStatedFixArgs = {
    patched: string | null
    recommendation: string | null
    vulnerable: string
    installed: string | null
}

const VERSION_LITERAL_RE = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g

function isNoPatchedSentinel(input: string): boolean {
    return input.trim() === NO_PATCHED_VERSION_SENTINEL
}

function parseRangeSafely(input: string | null): Range | null {
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
type EvaluableAffected = { range: Range | null; exact: Set<string> }

function evaluable(affected: AffectedSet): EvaluableAffected | null {
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
    const ev = evaluable(affected)
    if (ev === null) return null
    const normalized = normalizeSemver(version)
    if (normalized === null) return null
    return isIn(ev, normalized)
}

// `version` must already be normalized the way the exact entries were: `v1.2.1` and `1.2.1+build` are
// the release 1.2.1, and an exact entry of 1.2.1 has to catch both spellings.
function isIn(ev: EvaluableAffected, version: string): boolean {
    if (ev.exact.has(version)) return true
    return ev.range !== null && ev.range.test(version)
}

export type PickReleasedFixArgs = {
    // The registry's published versions. Prereleases and unparseable strings are ignored.
    published: readonly PublishedVersion[]
    evidence: readonly FixEvidence[]
    // Every installed copy's version, across all evidence.
    installed: readonly string[]
}

// The lowest version that is published, not a prerelease, not below the highest installed copy, outside
// EVERY evidence's affected set and inside every stated patched range — a non-deprecated one when any
// qualifies, else a deprecated one. `none` only when every input could be evaluated; anything that cannot
// be evaluated is `unknown`, which the caller must never turn into "released" or "no fix released".
export function pickReleasedFix(args: PickReleasedFixArgs): ReleasedFixResult {
    if (args.evidence.length === 0) return { kind: 'unknown', reason: 'no_evidence' }
    if (args.installed.length === 0) return { kind: 'unknown', reason: 'installed_unknown' }
    let floor = '0.0.0'
    for (const raw of args.installed) {
        const v = normalizeSemver(raw)
        if (v === null) return { kind: 'unknown', reason: 'installed_unknown' }
        if (gt(v, floor)) floor = v
    }

    const affected: EvaluableAffected[] = []
    const patched: Range[] = []
    for (const e of args.evidence) {
        const ev = evaluable(e.affected)
        if (ev === null) return { kind: 'unknown', reason: 'affected_incomplete' }
        affected.push(ev)
        if (e.patched === null || e.patched.trim() === '' || isNoPatchedSentinel(e.patched)) continue
        const range = parseRangeSafely(e.patched)
        if (range === null) return { kind: 'unknown', reason: 'patched_unparseable' }
        patched.push(range)
    }

    // Compared in normalized form, so an alternate spelling of an affected version is still affected;
    // returned in the registry's own spelling, which is what an install names.
    let lowest: { version: string; spelled: string } | null = null
    let lowestCurrent: { version: string; spelled: string } | null = null
    for (const p of args.published) {
        const v = valid(p.version)
        if (v === null || prerelease(v) !== null) continue
        if (!gte(v, floor)) continue
        if (affected.some(function hits(ev) { return isIn(ev, v) })) continue
        if (!patched.every(function inside(range) { return satisfies(v, range) })) continue
        const candidate = { version: v, spelled: p.version }
        if (lowest === null || lt(v, lowest.version)) lowest = candidate
        if (!p.deprecated && (lowestCurrent === null || lt(v, lowestCurrent.version))) lowestCurrent = candidate
    }
    const chosen = lowestCurrent ?? lowest
    if (chosen === null) return { kind: 'none' }
    return { kind: 'released', version: chosen.spelled }
}
