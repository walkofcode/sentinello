import type { FixCheck, FixCheckSource, FixStatus } from '@sentinello/core'
import { highestVersion } from '@sentinello/versions'
import { NO_PATCHED_VERSION_SENTINEL, pickReleasedFix, type AffectedSet, type FixEvidence, type PublishedVersion } from './version-fix'

// What the registry had for the package, as the settlement needs it. `dataAsOf` is when that data was
// fetched — recorded on the finding so its "checked" date never moves when the cache is refreshed later.
export type RegistryView =
    | { status: 'ok' | 'stale'; published: readonly PublishedVersion[]; dataAsOf: number }
    | { status: 'not_found'; dataAsOf: number }
    | { status: 'error' }

export type FixSettlement = {
    fixStatus: FixStatus
    fixVersion: string | null
    fixAvailable: boolean
    fixCheck: FixCheck
}

export type SettleFixArgs = {
    // Every source's and every installed copy's evidence for one finding identity.
    evidence: readonly FixEvidence[]
    // Null when the registry was not asked: an ecosystem it does not cover yet, or a caller (the CLI)
    // that never asks it.
    registry: RegistryView | null
    checkedAt: number
}

// One finding's fix, settled from all of its evidence. The rule itself is pickReleasedFix; this maps its
// tri-state onto the persisted status and writes the snapshot that explains it:
//   released      — the registry has a qualifying version; it is the fix, and the only kind of fixVersion
//                   ever presented as one to install;
//   none_released — the registry answered, every affected set was evaluable, and nothing qualifies;
//   unverified    — anything else. The version shown is only what a source stated, labelled as such.
export function settleFix(args: SettleFixArgs): FixSettlement {
    const sources = sourcesOf(args.evidence)
    const stated = highestVersion(args.evidence.flatMap(function statedOf(e) { return e.statedFix === null ? [] : [e.statedFix] }))
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
    if (registry.status === 'error') return unverified({ registry: 'error', packageDataAsOf: null, unevaluable: null })
    if (registry.status === 'not_found') return unverified({ registry: 'not_found', packageDataAsOf: registry.dataAsOf, unevaluable: null })

    const installed = [...new Set(args.evidence.flatMap(function installedOf(e) { return e.installed }))]
    const result = pickReleasedFix({ published: registry.published, evidence: args.evidence, installed })
    const check = { v: 1 as const, checkedAt: args.checkedAt, registry: registry.status, packageDataAsOf: registry.dataAsOf, sources }
    if (result.kind === 'released') {
        return { fixStatus: 'released', fixVersion: result.version, fixAvailable: true, fixCheck: { ...check, unevaluable: null } }
    }
    if (result.kind === 'none') {
        // A parent-upgrade claim from npm does not survive this: no published version of the package
        // itself is safe, so the way out is dropping or replacing it, not a version.
        return { fixStatus: 'none_released', fixVersion: null, fixAvailable: false, fixCheck: { ...check, unevaluable: null } }
    }
    return unverified({ registry: registry.status, packageDataAsOf: registry.dataAsOf, unevaluable: result.reason })
}

// The affected set as one line of text: enumerated versions as `=X`, then the ranges.
export function affectedSetText(affected: AffectedSet): string {
    const parts = affected.exact.map(function eq(v) { return '=' + v })
    if (affected.ranges !== null) parts.push(affected.ranges)
    return parts.join(' || ')
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
