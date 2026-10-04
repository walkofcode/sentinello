import semver from 'semver'
import type { NpmPackageSummary } from '@sentinello/feeds'
import { affectedSetContains, type AffectedSet } from '@sentinello/scanners'
import type { FetchBudget, RegistryClient, RegistryEntry } from './registry-client'

// The transitive proof behind every escape the way-out guidance claims. A release "drops" the vulnerable
// package only when its whole resolved dependency closure — not its direct dependency list — holds no
// affected copy of it. Two layers, so nothing target-specific is ever cached under a target-independent
// key:
//
//   closureOf(pkg@version) — every package@version an install of that release would bring in, resolved
//                            from registry summaries: each dependency range resolves to the highest
//                            published release satisfying it (what an upgrade installs). dependencies,
//                            optionalDependencies and peerDependencies, optional peers included, are all
//                            followed: an escape that holds only while an optional dependency is absent is
//                            not an escape. Target-independent, so it is memoized per package@version.
//   reaches(pkg@version, target) — 'yes' when any closure node is the target at an affected version (even
//                            in an incomplete closure); 'no' only for a complete closure without one;
//                            'unknown' otherwise, never 'no'. Memoized per (package@version, target
//                            identity), where the identity includes the affected sets: a 'no' for one
//                            advisory says nothing about another.
//
// Every registry read goes through one budget per project scan; over budget, closures come back
// incomplete and the verdicts that needed them 'unknown'.

export type Closure = {
    // package@version keys, the release itself included.
    nodes: string[]
    complete: boolean
    // Why the closure is incomplete; null when complete.
    reason: string | null
    // Dependency names whose version could not be resolved (no summary, or a range nothing satisfies).
    unresolved: string[]
}

// The vulnerable package as one finding sees it: its name and every source's affected set.
export type ProofTarget = { name: string; affected: readonly AffectedSet[] }

export type Reach = { verdict: 'yes' | 'no'; closureSize: number; reason: null } | { verdict: 'unknown'; closureSize: number; reason: string }

export type SummaryAnswer = { status: 'ok'; summary: NpmPackageSummary } | { status: 'missing'; reason: string }

export type ClosureWalker = {
    budget: FetchBudget
    // Loads (once) and returns each package's registry summary, through the budget.
    summaries(names: readonly string[]): Promise<Map<string, SummaryAnswer>>
    closureOf(name: string, version: string): Promise<Closure>
    reaches(name: string, version: string, target: ProofTarget): Promise<Reach>
}

// The fetch budget for one project scan's way-out guidance (closures need more lookups than settlement).
export const REMEDIATION_FETCH_BUDGET = 60

// The walk of one edge set, expanded a level at a time and kept: `closureOf` runs it to the end, while
// `reaches` stops as soon as the target shows up — a 'yes' needs only the path to it, and a release whose
// closure holds the target often also pulls in a large unrelated tree (a peer like eslint) that would
// spend the whole fetch budget for nothing. The state is target-independent; any later call resumes it.
type Expansion = {
    nodes: Map<string, { name: string; version: string }>
    unresolved: Set<string>
    reason: string | null
    frontier: EdgeRequest[]
    step: Promise<void> | null
}

// A release's walk: its own key plus the expansion of its edge set, or a closure already final because the
// release itself cannot be read.
type ReleaseWalk = { key: string; expansion: Expansion } | { key: string; final: Closure }

export function createClosureWalker(registry: RegistryClient, budget: FetchBudget): ClosureWalker {
    // Every summary asked for in this project scan, as the promise of its answer, so two questions in flight
    // at once share one lookup.
    const loaded = new Map<string, Promise<SummaryAnswer>>()
    // Keyed by name#edgeIndex: releases declaring an identical (interned) dependency map share one walk.
    const byEdges = new Map<string, Expansion>()
    const reachMemo = new Map<string, Promise<Reach>>()

    async function summaries(names: readonly string[]): Promise<Map<string, SummaryAnswer>> {
        const wanted = [...new Set(names)].filter(function notLoaded(n) { return !loaded.has(n) })
        if (wanted.length > 0) {
            const lookup = registry.lookup(wanted, { budget })
            for (const name of wanted) {
                loaded.set(name, lookup.then(function answerFor(served) { return toAnswer(served.get(name)) }))
            }
        }
        const out = new Map<string, SummaryAnswer>()
        for (const name of names) out.set(name, await (loaded.get(name) as Promise<SummaryAnswer>))
        return out
    }

    // One breadth-first level: the frontier's summaries are fetched as one batch (in parallel, up to the
    // client's limit), each request resolved, and the newly reached releases' edges become the next
    // frontier. Concurrent callers share the level in progress.
    function expandLevel(state: Expansion): Promise<void> {
        if (state.step) return state.step
        state.step = (async function level(): Promise<void> {
            const requests = state.frontier
            const answers = await summaries(requests.map(function nameOf(r) { return r.name }))
            const next: EdgeRequest[] = []
            for (const request of requests) {
                const answer = answers.get(request.name) as SummaryAnswer
                if (answer.status === 'missing') {
                    state.unresolved.add(request.name)
                    state.reason = state.reason ?? request.name + ': ' + answer.reason
                    continue
                }
                const version = resolveRange(answer.summary, request.range)
                if (version === null) {
                    state.unresolved.add(request.name)
                    state.reason = state.reason ?? request.name + '@' + request.range + ' matches no published release'
                    continue
                }
                const key = request.name + '@' + version
                if (state.nodes.has(key)) continue
                state.nodes.set(key, { name: request.name, version })
                for (const child of edgesOf(answer.summary, version)) next.push(child)
            }
            state.frontier = next
        })().finally(function settled() {
            state.step = null
        })
        return state.step
    }

    async function releaseWalk(name: string, version: string): Promise<ReleaseWalk> {
        const key = name + '@' + version
        const answer = (await summaries([name])).get(name) as SummaryAnswer
        if (answer.status === 'missing') return { key, final: { nodes: [key], complete: false, reason: name + ': ' + answer.reason, unresolved: [name] } }
        const meta = answer.summary.versions[version]
        if (!meta) return { key, final: { nodes: [key], complete: false, reason: key + ' is not a published release', unresolved: [] } }
        const edgeKey = name + '#' + String(meta.edges)
        let expansion = byEdges.get(edgeKey)
        if (!expansion) {
            expansion = { nodes: new Map(), unresolved: new Set(), reason: null, frontier: edgesOf(answer.summary, version), step: null }
            byEdges.set(edgeKey, expansion)
        }
        return { key, expansion }
    }

    function snapshot(walk: { key: string; expansion: Expansion }): Closure {
        const e = walk.expansion
        const nodes = new Set<string>([walk.key, ...e.nodes.keys()])
        return { nodes: [...nodes], complete: e.unresolved.size === 0, reason: e.reason, unresolved: [...e.unresolved] }
    }

    async function closureOf(name: string, version: string): Promise<Closure> {
        const walk = await releaseWalk(name, version)
        if ('final' in walk) return walk.final
        while (walk.expansion.frontier.length > 0) await expandLevel(walk.expansion)
        return snapshot(walk)
    }

    async function reaches(name: string, version: string, target: ProofTarget): Promise<Reach> {
        const key = name + '@' + version + '|' + targetIdentity(target)
        const memo = reachMemo.get(key)
        if (memo) return memo
        const computed = (async function compute(): Promise<Reach> {
            const walk = await releaseWalk(name, version)
            if ('final' in walk) return judge(walk.final, target, true)
            for (;;) {
                const sofar = judge(snapshot(walk), target, walk.expansion.frontier.length === 0)
                if (sofar.verdict === 'yes' || walk.expansion.frontier.length === 0) return sofar
                await expandLevel(walk.expansion)
            }
        })()
        reachMemo.set(key, computed)
        return computed
    }

    return { budget, summaries, closureOf, reaches }
}

// The verdict a closure supports for one target. While the walk is still going (`finished` false) only a
// 'yes' is final; the caller keeps expanding otherwise.
function judge(closure: Closure, target: ProofTarget, finished: boolean): Reach {
    let unreadable = false
    for (const node of closure.nodes) {
        const at = node.lastIndexOf('@')
        if (node.slice(0, at) !== target.name) continue
        const nodeVersion = node.slice(at + 1)
        const hits = target.affected.map(function contains(a) { return affectedSetContains(a, nodeVersion) })
        if (hits.some(function yes(h) { return h === true })) return { verdict: 'yes', closureSize: closure.nodes.length, reason: null }
        if (hits.some(function unknown(h) { return h === null })) unreadable = true
    }
    if (!finished) return { verdict: 'unknown', closureSize: closure.nodes.length, reason: 'walk in progress' }
    if (closure.unresolved.includes(target.name)) {
        return { verdict: 'unknown', closureSize: closure.nodes.length, reason: target.name + '\'s version in the closure could not be resolved' }
    }
    if (unreadable) return { verdict: 'unknown', closureSize: closure.nodes.length, reason: 'the affected range could not be evaluated' }
    // An incomplete closure always says why.
    if (closure.reason !== null) return { verdict: 'unknown', closureSize: closure.nodes.length, reason: closure.reason }
    return { verdict: 'no', closureSize: closure.nodes.length, reason: null }
}

// The canonical identity of a target: its name and every affected set, so two advisories (or two sources'
// affected sets) never share a verdict.
export function targetIdentity(target: ProofTarget): string {
    const sets = target.affected.map(function canonical(a) {
        return JSON.stringify({ ranges: a.ranges, exact: [...a.exact].sort(), complete: a.complete })
    }).sort()
    return target.name + '|' + sets.join('|')
}

function toAnswer(entry: RegistryEntry | undefined): SummaryAnswer {
    if (!entry) return { status: 'missing', reason: 'no registry answer' }
    if (entry.status === 'ok' || entry.status === 'stale') return { status: 'ok', summary: entry.summary }
    if (entry.status === 'not_found') return { status: 'missing', reason: 'not on the npm registry' }
    return { status: 'missing', reason: entry.reason }
}

type EdgeRequest = { name: string; range: string }

// One release's dependency edges as (name, range) requests. An `npm:` alias resolves the real package.
export function edgesOf(summary: NpmPackageSummary, version: string): EdgeRequest[] {
    return Object.entries(effectiveDependencies(summary, version)).map(function request([name, range]) { return unalias(name, range) })
}

// The ranges an install of `name@version` honours, one per dependency name, in npm's precedence: a later
// field replaces a same-name entry of an earlier one — peerDependencies, then dependencies, then
// optionalDependencies (Arborist's load order; npm's docs: "Entries in optionalDependencies will override
// entries of the same name in dependencies"). Every effective edge is followed, optional and peer included.
// Empty for a release the registry has no record of, or one without dependencies.
export function effectiveDependencies(summary: NpmPackageSummary, version: string): Record<string, string> {
    const meta = summary.versions[version]
    const edges = meta && meta.edges !== null ? summary.edges[meta.edges] : undefined
    if (!edges) return {}
    return { ...edges.peerDependencies, ...edges.dependencies, ...edges.optionalDependencies }
}

export function unalias(name: string, range: string): EdgeRequest {
    if (!range.startsWith('npm:')) return { name, range }
    const spec = range.slice(4)
    const at = spec.lastIndexOf('@')
    if (at <= 0) return { name: spec, range: '*' }
    return { name: spec.slice(0, at), range: spec.slice(at + 1) }
}

// What an install of `range` resolves to: the highest published release satisfying it. `latest`, `*` and
// an empty range mean the latest tag. Null for anything not resolvable from the registry (a git or file
// specifier, an unknown tag, a range nothing satisfies).
export function resolveRange(summary: NpmPackageSummary, range: string): string | null {
    const releases = Object.keys(summary.versions)
    const trimmed = range.trim()
    if (trimmed === '' || trimmed === '*' || trimmed === 'latest') {
        if (summary.latest !== null && summary.latest in summary.versions) return summary.latest
        return semver.maxSatisfying(releases, '*')
    }
    if (semver.validRange(trimmed) === null) return null
    return semver.maxSatisfying(releases, trimmed)
}
