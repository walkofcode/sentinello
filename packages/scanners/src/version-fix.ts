import { Range, satisfies, gte, gt, valid, compare as semverCompare, type Comparator } from 'semver'
import { comparatorById, isZeroVersion, normalizeBound, versionInRange, type ComparatorId, type VersionComparator, type VersionRange } from '@sentinello/versions'

// A fix version is a fact about the package registry, not arithmetic on a range. This module used to turn a
// `<=X` bound into "X+1" and a `>X` bound into "X+1" and report the result as the fix — which is how braces
// 3.0.4 and node-forge 1.4.1 came to be recommended across the fleet although neither was ever published,
// and how qs was sent to a non-existent 6.15.4 while 6.16.0 was out. Two things live here now, and neither
// invents a version:
//
//   - pickStatedFix: the fix a SOURCE states, read only from bounds literally present in its data.
//   - the affected set, which @sentinello/fixes' pickReleasedFix tests registry versions against to find
//     the fix the REGISTRY proves.
//
// Both sides of that test speak the finding's OWN comparator. The affected set used to be a node-semver
// range string, which every non-npm ecosystem had to be squeezed into first — so a PEP 440 `4.2` became
// semver 4.2.0, a Go pseudo-version lost its place beside the tags, and a Django 4.2 advisory came to
// recommend 3.2.x. node-semver now appears only where npm audit itself speaks it: its own range strings.

// pnpm audit writes this as `patched_versions` to say "no patched version exists". It is a statement, not a
// range: read as a range it would match nothing and so make every candidate unpatched.
export const NO_PATCHED_VERSION_SENTINEL = '<0.0.0'

// A set of versions — an advisory's affected set, or a source's patched set — in the comparator of the
// ecosystem it is about. A version is in the set when it equals an `exact` entry or falls inside a range.
export type VersionSet = {
    comparator: ComparatorId
    // The intervals, with every bound's inclusivity as the source stated it. Empty for an exact-only set.
    // Malware with no version data is the single open range from the bottom: every version is affected.
    ranges: VersionRange[]
    // Enumerated versions, kept verbatim and compared after the comparator normalizes them, the same
    // normalization the matcher used, so `<1.1.0` plus exact `1.1.0` rejects 1.1.0.
    exact: string[]
    // False when some of the source's data could not be carried here — a range dropped for this
    // comparator, a bound it cannot read, a range string that does not parse. An incomplete set can never
    // prove a version safe.
    complete: boolean
}

// Everything a source said that bears on which version fixes a finding. One per reporting source/copy; the
// worker settles a finding against all of them, so the answer does not depend on which source ran first.
export type AffectedSet = VersionSet

export type FixEvidence = {
    source: string
    // Every installed copy this source saw, as written (a comma-joined npm-audit value is split).
    installed: string[]
    affected: AffectedSet
    // The source's patched range as it wrote it, when it states one. NO_PATCHED_VERSION_SENTINEL is
    // provenance only. Kept as text because it is shown as the source's own statement.
    patched: string | null
    // The same range as a set the fix must fall inside; null when the source states none (or states the
    // sentinel). An unreadable one is an incomplete set, which leaves the fix unknown.
    patchedSet: VersionSet | null
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

// A version set built from a node-semver range string a source handed over verbatim — npm audit's `range`
// and `patched_versions`, pnpm's `vulnerable_versions`. node-semver is the specification of that syntax, so
// it parses the string and each of its comparator sets becomes one interval. Empty, unparseable, or the
// no-patch sentinel in the wrong field: incomplete.
export function versionSetFromSemverRange(text: string): VersionSet {
    const trimmed = text.trim()
    const range = trimmed.length === 0 || isNoPatchedSentinel(trimmed) ? null : parseRangeSafely(trimmed)
    if (range === null) return { comparator: 'semver', ranges: [], exact: [], complete: false }
    const ranges: VersionRange[] = []
    const exact: string[] = []
    for (const conjunction of range.set) {
        const interval = intervalOf(conjunction)
        if (interval === null) continue
        if (typeof interval === 'string') exact.push(interval)
        else ranges.push(interval)
    }
    return { comparator: 'semver', ranges, exact, complete: true }
}

// The patched set a source's patched range text states, or null when it states none: no text, blank, or
// the no-patch sentinel (which says "no patched version exists" and is provenance only).
export function patchedVersionSet(patched: string | null): VersionSet | null {
    if (patched === null || patched.trim() === '' || isNoPatchedSentinel(patched)) return null
    return versionSetFromSemverRange(patched)
}

type Bound = { version: string; strict: boolean }

// One comparator set (an AND of comparators) as the interval it selects: a range, an exact version when it
// pins one, or null when it selects nothing. Several lower bounds intersect to the highest and several upper
// bounds to the lowest; at a tie the strict one is the tighter.
function intervalOf(conjunction: readonly Comparator[]): VersionRange | string | null {
    let lower: Bound | null = null
    let upper: Bound | null = null
    let pinned: string | null = null
    for (const c of conjunction) {
        // The ANY comparator (`*`, `x`, an empty range) carries version '' and constrains nothing.
        const version = c.semver.version
        if (!version) continue
        const op = c.operator
        if (op === '' || op === '=') {
            if (pinned !== null && pinned !== version) return null
            pinned = version
        } else if (op === '>' || op === '>=') {
            const bound = { version, strict: op === '>' }
            if (lower === null || tighterLower(bound, lower)) lower = bound
        } else {
            const bound = { version, strict: op === '<' }
            if (upper === null || tighterUpper(bound, upper)) upper = bound
        }
    }
    if (pinned !== null) return withinBounds(pinned, lower, upper) ? pinned : null
    const range: VersionRange = {
        introduced: lower === null ? '0' : lower.version,
        fixed: upper !== null && upper.strict ? upper.version : null,
        lastAffected: upper !== null && !upper.strict ? upper.version : null
    }
    if (lower !== null && lower.strict) range.introducedExclusive = true
    return range
}

function tighterLower(candidate: Bound, current: Bound): boolean {
    const order = semverCompare(candidate.version, current.version)
    return order > 0 || (order === 0 && candidate.strict)
}

function tighterUpper(candidate: Bound, current: Bound): boolean {
    const order = semverCompare(candidate.version, current.version)
    return order < 0 || (order === 0 && candidate.strict)
}

function withinBounds(version: string, lower: Bound | null, upper: Bound | null): boolean {
    if (lower !== null) {
        const order = semverCompare(version, lower.version)
        if (order < 0 || (order === 0 && lower.strict)) return false
    }
    if (upper !== null) {
        const order = semverCompare(version, upper.version)
        if (order > 0 || (order === 0 && upper.strict)) return false
    }
    return true
}

// Whether the comparator can read every bound of every range. An inclusive zero lower bound is the bottom
// of the version space, which versionInRange never compares against, so it needs no reading.
export function rangesReadable(ranges: readonly VersionRange[], comparator: VersionComparator): boolean {
    return ranges.every(function readable(range) {
        const bottom = range.introducedExclusive !== true && isZeroVersion(range.introduced)
        if (!bottom && normalizeBound(range.introduced, comparator) === null) return false
        const upper = range.fixed ?? range.lastAffected ?? null
        return upper === null || comparator.normalize(upper) !== null
    })
}

// A version set ready to test versions against. Null when it cannot be evaluated: incomplete, a bound the
// comparator cannot read, or an exact version it cannot read (it might be the very version a candidate
// spells differently).
export type EvaluableSet = { comparator: VersionComparator; ranges: readonly VersionRange[]; exact: Set<string> }
export type EvaluableAffected = EvaluableSet

export function evaluableAffected(set: VersionSet): EvaluableSet | null {
    if (!set.complete) return null
    const comparator = comparatorById(set.comparator)
    if (!rangesReadable(set.ranges, comparator)) return null
    const exact = new Set<string>()
    for (const raw of set.exact) {
        const v = comparator.normalize(raw)
        if (v === null) return null
        exact.add(v)
    }
    return { comparator, ranges: set.ranges, exact }
}

// Whether a set holds a version: true / false, or null when the set — or the version — cannot be evaluated
// (which must never be read as "safe").
export function affectedSetContains(set: VersionSet, version: string): boolean | null {
    const ev = evaluableAffected(set)
    if (ev === null) return null
    const normalized = ev.comparator.normalize(version)
    if (normalized === null) return null
    return evaluableContains(ev, normalized)
}

// `version` must already be normalized by the set's comparator, the way the exact entries were: `v1.2.1`
// and `1.2.1+build` are the release 1.2.1, and an exact entry of 1.2.1 has to catch both spellings.
export function evaluableContains(ev: EvaluableSet, version: string): boolean {
    if (ev.exact.has(version)) return true
    return ev.ranges.some(function contains(range) {
        return versionInRange(version, range, ev.comparator)
    })
}
