import { requireComparator, type FixCheck, type FixCheckSource, type FixStatus, type FixUnevaluableReason } from '@sentinello/core'
import {
    evaluableAffected,
    evaluableContains,
    NO_PATCHED_VERSION_SENTINEL,
    type AffectedSet,
    type EvaluableSet,
    type FixEvidence
} from '@sentinello/scanners'
import { comparatorById, formatRanges, highestVersion, type VersionComparator } from '@sentinello/versions'

// What the registry had for the package, as the settlement needs it. `dataAsOf` is when that data was
// fetched — recorded on the finding so its "checked" date never moves when the cache is refreshed later.
// `offline` is a run that was told to make no network request, so the registry was deliberately not asked.
// `unconfirmed` lists stated fix versions whose publication the registry could not confirm either way (Go's
// per-version check failed, or was past its cap): with any of them, "nothing qualifies" is not a fact.
export type RegistryView =
    | { status: 'ok' | 'stale'; published: readonly PublishedVersion[]; dataAsOf: number; unconfirmed?: readonly string[] }
    | { status: 'not_found'; dataAsOf: number }
    | { status: 'error' }
    | { status: 'offline' }

export type FixSettlement = {
    fixStatus: FixStatus
    fixVersion: string | null
    fixAvailable: boolean
    fixCheck: FixCheck
}

export type SettleFixArgs = {
    // The finding's ecosystem: its comparator orders every version here, and every piece of evidence must
    // speak it.
    ecosystem: string
    // Every source's and every installed copy's evidence for one finding identity.
    evidence: readonly FixEvidence[]
    // Null when the registry does not cover the finding's ecosystem yet.
    registry: RegistryView | null
    checkedAt: number
}

// One finding's fix, settled from all of its evidence. The rule itself is pickReleasedFix; this maps its
// tri-state onto the persisted status and writes the snapshot that explains it:
//   released      — the registry has a qualifying version; it is the fix, and the only kind of fixVersion
//                   ever presented as one to install;
//   none_released — the registry answered, every affected set was evaluable, nothing qualifies, and no
//                   stated fix version's publication is unconfirmed;
//   unverified    — anything else. The version shown is only what a source stated, labelled as such.
export function settleFix(args: SettleFixArgs): FixSettlement {
    const sources = sourcesOf(args.evidence)
    const comparator = requireComparator(args.ecosystem)
    const spoken = evidenceComparator(args.evidence)
    if (spoken !== null && spoken.id !== comparator.id) {
        throw new Error('fix evidence for ' + args.ecosystem + ' uses the ' + spoken.id + ' comparator, not ' + comparator.id)
    }
    const statedFixes = args.evidence.flatMap(function statedOf(e) { return e.statedFix === null ? [] : [e.statedFix] })
    const stated = highestVersion(statedFixes, comparator)
    const viaParent = args.evidence.some(function parent(e) { return e.fixViaParent })
    const registry = args.registry

    function unverified(check: Pick<FixCheck, 'registry' | 'packageDataAsOf' | 'unevaluable'>): FixSettlement {
        return {
            fixStatus: 'unverified',
            fixVersion: stated,
            fixAvailable: stated !== null || viaParent,
            fixCheck: { v: 1, checkedAt: args.checkedAt, sources, ...check }
        }
    }

    if (registry === null) return unverified({ registry: 'skipped', packageDataAsOf: null, unevaluable: null })
    if (registry.status === 'offline') return unverified({ registry: 'offline', packageDataAsOf: null, unevaluable: null })
    if (registry.status === 'error') return unverified({ registry: 'error', packageDataAsOf: null, unevaluable: null })
    if (registry.status === 'not_found') return unverified({ registry: 'not_found', packageDataAsOf: registry.dataAsOf, unevaluable: null })

    const installed = [...new Set(args.evidence.flatMap(function installedOf(e) { return e.installed }))]
    const result = pickReleasedFix({ published: registry.published, evidence: args.evidence, installed })
    const check = { v: 1 as const, checkedAt: args.checkedAt, registry: registry.status, packageDataAsOf: registry.dataAsOf, sources }
    if (result.kind === 'released') {
        return { fixStatus: 'released', fixVersion: result.version, fixAvailable: true, fixCheck: { ...check, unevaluable: null } }
    }
    if (result.kind === 'none' && registry.unconfirmed !== undefined && registry.unconfirmed.length > 0) {
        // A stated fix may exist that the registry could not confirm: unknown, and the registry is why.
        return unverified({ registry: 'error', packageDataAsOf: registry.dataAsOf, unevaluable: null })
    }
    if (result.kind === 'none') {
        // A parent-upgrade claim from npm does not survive this: no published version of the package
        // itself is safe, so the way out is dropping or replacing it, not a version.
        return { fixStatus: 'none_released', fixVersion: null, fixAvailable: false, fixCheck: { ...check, unevaluable: null } }
    }
    return unverified({ registry: registry.status, packageDataAsOf: registry.dataAsOf, unevaluable: result.reason })
}

// The affected set as one line of text: enumerated versions as `=X`, then the ranges through the one range
// formatter, so the operators shown are the operators the set holds.
export function affectedSetText(affected: AffectedSet): string {
    const parts = affected.exact.map(function eq(v) { return '=' + v })
    if (affected.ranges.length > 0) parts.push(formatRanges(affected.ranges, { zero: '0' }))
    return parts.join(' || ')
}

// The one comparator every piece of a finding's evidence speaks. A finding's identity includes its
// ecosystem, so evidence in two comparators means the caller grouped two findings into one — a defect to
// surface, not a disagreement to settle. Null only for no evidence at all.
function evidenceComparator(evidence: readonly FixEvidence[]): VersionComparator | null {
    const first = evidence[0]
    if (first === undefined) return null
    for (const e of evidence) {
        if (e.affected.comparator !== first.affected.comparator) {
            throw new Error('fix evidence mixes comparators: ' + first.affected.comparator + ' and ' + e.affected.comparator)
        }
    }
    return comparatorById(first.affected.comparator)
}

// One entry per distinct statement. A second installed copy from the same source is its own entry, because
// its version is part of what the fix was settled against.
function sourcesOf(evidence: readonly FixEvidence[]): FixCheckSource[] {
    const out: FixCheckSource[] = []
    const seen = new Set<string>()
    for (const e of evidence) {
        const sentinel = e.patched !== null && e.patched.trim() === NO_PATCHED_VERSION_SENTINEL
        const patched = e.patched === null || sentinel || e.patched.trim() === '' ? null : e.patched
        const entry: FixCheckSource = {
            source: e.source,
            installed: e.installed,
            affected: affectedSetText(e.affected),
            patched,
            statedFix: e.statedFix,
            noPatchedSentinel: sentinel
        }
        const key = JSON.stringify(entry)
        if (seen.has(key)) continue
        seen.add(key)
        out.push(entry)
    }
    return out
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

export type PickReleasedFixArgs = {
    // The registry's published versions. Prereleases and unparseable strings are ignored — except a Go
    // pseudo-version the advisory itself states, which the registry client only lists once it has
    // confirmed that exact version exists.
    published: readonly PublishedVersion[]
    evidence: readonly FixEvidence[]
    // Every installed copy's version, across all evidence.
    installed: readonly string[]
}

// The lowest version that is published, not a prerelease, not below the highest installed copy, outside
// EVERY evidence's affected set and inside every stated patched set — a non-deprecated one when any
// qualifies, else a deprecated one. `none` only when every input could be evaluated; anything that cannot
// be evaluated is `unknown`, which the caller must never turn into "released" or "no fix released".
//
// Every comparison is the finding's own comparator's (FixEvidence.affected.comparator), so a PyPI fix is
// ordered by PEP 440 and a Go fix by Go's rules — never coerced into semver first.
//
// Which kinds of version may be a fix is the comparator's call too (releaseKind). A tagged prerelease never
// is, in any ecosystem. A Go pseudo-version is when an advisory states it as the fix: some Go modules are
// only ever fixed in a commit, never in a tag, and `/@v/list` omits pseudo-versions by protocol, so one in
// `published` is there because the registry confirmed it (SENTINEL-126). One the advisory did not state is
// still skipped — it is a commit nobody named, not a release.
export function pickReleasedFix(args: PickReleasedFixArgs): ReleasedFixResult {
    const comparator = evidenceComparator(args.evidence)
    if (comparator === null) return { kind: 'unknown', reason: 'no_evidence' }
    const floor = highestInstalled(args.installed, comparator)
    if (floor === null) return { kind: 'unknown', reason: 'installed_unknown' }

    const affected: EvaluableSet[] = []
    const patched: EvaluableSet[] = []
    for (const e of args.evidence) {
        const ev = evaluableAffected(e.affected)
        if (ev === null) return { kind: 'unknown', reason: 'affected_incomplete' }
        affected.push(ev)
        if (e.patchedSet === null) continue
        const range = evaluableAffected(e.patchedSet)
        if (range === null) return { kind: 'unknown', reason: 'patched_unparseable' }
        patched.push(range)
    }
    const stated = statedFixVersions(args.evidence, comparator)

    // Compared in normalized form, so an alternate spelling of an affected version is still affected;
    // returned in the registry's own spelling, which is what an install names.
    let lowest: { version: string; spelled: string } | null = null
    let lowestCurrent: { version: string; spelled: string } | null = null
    for (const p of args.published) {
        const v = comparator.normalize(p.version)
        if (v === null) continue
        const kind = comparator.releaseKind(v)
        if (kind === 'prerelease' || (kind === 'pseudo' && !stated.has(v))) continue
        if (comparator.lt(v, floor)) continue
        if (affected.some(function hits(ev) { return evaluableContains(ev, v) })) continue
        if (!patched.every(function inside(ev) { return evaluableContains(ev, v) })) continue
        const candidate = { version: v, spelled: p.version }
        if (lowest === null || comparator.lt(v, lowest.version)) lowest = candidate
        if (!p.deprecated && (lowestCurrent === null || comparator.lt(v, lowestCurrent.version))) lowestCurrent = candidate
    }
    const chosen = lowestCurrent ?? lowest
    if (chosen === null) return { kind: 'none' }
    return { kind: 'released', version: chosen.spelled }
}

// The highest installed copy, normalized; null when there is none, or one does not parse.
function highestInstalled(installed: readonly string[], comparator: VersionComparator): string | null {
    let floor: string | null = null
    for (const raw of installed) {
        const v = comparator.normalize(raw)
        if (v === null) return null
        if (floor === null || comparator.gt(v, floor)) floor = v
    }
    return floor
}

// Every fix version one source states, as written: its stated fix and every `fixed` bound of its affected set.
function statedOf(e: FixEvidence): string[] {
    const candidates = e.affected.ranges.flatMap(function fixed(r) { return r.fixed ? [r.fixed] : [] })
    if (e.statedFix !== null) candidates.push(e.statedFix)
    return candidates
}

// Every fix version the evidence states, normalized.
function statedFixVersions(evidence: readonly FixEvidence[], comparator: VersionComparator): Set<string> {
    const out = new Set<string>()
    for (const e of evidence) {
        for (const raw of statedOf(e)) {
            const v = comparator.normalize(raw)
            if (v !== null) out.add(v)
        }
    }
    return out
}

// The stated fix versions that could still be the fix — they parse, are not a tagged prerelease, and are
// not below the highest installed copy — as written, one per normalized version. What a registry that does
// not list every version (Go's, which omits pseudo-versions) is asked about one by one. None when no
// installed copy can be read: the picker cannot settle such a finding whatever the registry says.
export function statedFixCandidates(evidence: readonly FixEvidence[], comparator: VersionComparator): string[] {
    const floor = highestInstalled(evidence.flatMap(function installedOf(e) { return e.installed }), comparator)
    if (floor === null) return []
    const out = new Map<string, string>()
    for (const e of evidence) {
        for (const raw of statedOf(e)) {
            const v = comparator.normalize(raw)
            if (v === null || out.has(v) || comparator.releaseKind(v) === 'prerelease' || comparator.lt(v, floor)) continue
            out.set(v, raw)
        }
    }
    return [...out.values()]
}
