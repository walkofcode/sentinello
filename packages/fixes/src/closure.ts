import semver from 'semver'
import type { NpmPackageSummary, NpmVersionSummary } from '@sentinello/feeds'
import { affectedSetContains, type AffectedSet } from '@sentinello/scanners'
import type { RegistryClient, RegistryEntry } from './registry-client'

// The transitive proof behind every escape the way-out guidance claims. A release "drops" the vulnerable
// package only when its whole resolved dependency closure — not its direct dependency list — holds no
// affected copy of it. Two layers, so nothing target-specific is ever cached under a target-independent
// key:
//
//   closureOf(pkg@version) — every package@version an install of that release would bring in, resolved
//                            from registry summaries: each dependency range resolves to the version
//                            npm would pick for it (resolveRange; what an upgrade installs). dependencies,
//                            optionalDependencies and peerDependencies, optional peers included, are all
//                            followed: an escape that holds only while an optional dependency is absent is
//                            not an escape. Target-independent, so it is memoized per package@version.
//   reaches(pkg@version, target) — 'yes' when any closure node is the target at an affected version (even
//                            in an incomplete closure); 'no' only for a complete closure without one;
//                            'unknown' otherwise, never 'no'. Memoized per (package@version, target
//                            identity), where the identity includes the affected sets: a 'no' for one
//                            advisory says nothing about another.
//
// There is no cap on how many packages a walk reads: a closure is walked to its end, and an 'unknown' only
// ever comes from a real cause — a registry error, a package not on the registry, a range nothing
// satisfies, a dist-tag, a git or file specifier — which its reason names.

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
    // Loads (once) and returns each package's registry summary.
    summaries(names: readonly string[]): Promise<Map<string, SummaryAnswer>>
    closureOf(name: string, version: string): Promise<Closure>
    reaches(name: string, version: string, target: ProofTarget): Promise<Reach>
}

// The walk of one edge set, expanded a level at a time and kept: `closureOf` runs it to the end, while
// `reaches` stops as soon as the target shows up — a 'yes' needs only the path to it, and a release whose
// closure holds the target often also pulls in a large unrelated tree (a peer like eslint) that would
// cost a level of fetches for nothing. The state is target-independent; any later call resumes it.
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

export function createClosureWalker(registry: RegistryClient): ClosureWalker {
    // Every summary asked for in this project scan, as the promise of its answer, so two questions in flight
    // at once share one lookup.
    const loaded = new Map<string, Promise<SummaryAnswer>>()
    // Keyed by name#edgeIndex: releases declaring an identical (interned) dependency map share one walk.
    const byEdges = new Map<string, Expansion>()
    const reachMemo = new Map<string, Promise<Reach>>()

    async function summaries(names: readonly string[]): Promise<Map<string, SummaryAnswer>> {
        const wanted = [...new Set(names)].filter(function notLoaded(n) { return !loaded.has(n) })
        if (wanted.length > 0) {
            const lookup = registry.lookup(wanted)
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
        const edges = edgeIndexOf(answer.summary, version)
        if (edges === undefined) return { key, final: { nodes: [key], complete: false, reason: key + ' is not a published release', unresolved: [] } }
        const edgeKey = name + '#' + String(edges)
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

    return { summaries, closureOf, reaches }
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
    const index = edgeIndexOf(summary, version)
    const edges = index === undefined || index === null ? undefined : summary.edges[index]
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

// A version's index into the summary's edge sets — null when it declares none — for a release or a
// prerelease alike; undefined when the registry has no such version.
function edgeIndexOf(summary: NpmPackageSummary, version: string): number | null | undefined {
    const release = summary.versions[version]
    if (release) return release.edges
    return Object.hasOwn(summary.prereleases, version) ? summary.prereleases[version] : undefined
}

// How npm reads a registry dependency specifier (npm-package-arg's fromRegistry, which parses loosely): an
// exact version, a range, or a dist-tag. `>=3.0.0 || insiders` is a range to npm — loose parsing reads it as
// `>=3.0.0` — so it is one here. Null for what npm would not send to the registry as a version at all: a git,
// file or URL specifier (an `npm:` alias is unaliased before it gets here). '' means npm's default, the
// `latest` tag's range path ('*').
export type RegistrySpec = { type: 'version'; version: string } | { type: 'range'; range: semver.Range } | { type: 'tag'; tag: string }

export function registrySpec(spec: string): RegistrySpec | null {
    const trimmed = spec.trim()
    const version = semver.valid(trimmed, LOOSE)
    if (version !== null) return { type: 'version', version }
    if (semver.validRange(trimmed, LOOSE) !== null) return { type: 'range', range: new semver.Range(trimmed, LOOSE) }
    return encodeURIComponent(trimmed) === trimmed ? { type: 'tag', tag: trimmed } : null
}

const LOOSE = { loose: true }

// What an install of `range` resolves to, as npm-pick-manifest picks it from the summary: an exact version
// only itself; a dist-tag its version (only `latest` is recorded); a range the `latest` release when it
// satisfies the range and is not deprecated, otherwise the highest satisfying version, a non-deprecated one
// first. Prereleases are candidates under semver's own rule — only for a range that names a prerelease of
// the same major.minor.patch (gensync@^1.0.0-beta.2) — so an ordinary range still resolves to a release.
// Not modelled: npm's preference for a release whose `engines` accept the running node (the summary keeps no
// `engines`) and a prerelease's deprecation (prereleases keep only their edges). Null for anything not
// resolvable from the registry (a git or file specifier, a tag other than `latest`, a range nothing
// satisfies).
//
// A walk resolves the same few ranges against the same summaries thousands of times, over release lists
// thousands long (next: 2,369 releases and more canaries), so each summary's versions are parsed and sorted
// once and each answer is remembered per summary. Measured on the scratch fleet: re-parsing every version on
// every call was 48 of truqo's 74 post-scan seconds.
export function resolveRange(summary: NpmPackageSummary, range: string): string | null {
    const trimmed = range.trim()
    let answers = resolved.get(summary)
    if (!answers) {
        answers = new Map()
        resolved.set(summary, answers)
    }
    const known = answers.get(trimmed)
    if (known !== undefined) return known
    const answer = resolveUncached(summary, trimmed)
    answers.set(trimmed, answer)
    return answer
}

type Candidate = { key: string; version: semver.SemVer; deprecated: boolean }
type Candidates = { releases: Candidate[]; all: Candidate[] }

const resolved = new WeakMap<NpmPackageSummary, Map<string, string | null>>()
const candidates = new WeakMap<NpmPackageSummary, Candidates>()

function resolveUncached(summary: NpmPackageSummary, trimmed: string): string | null {
    const spec = registrySpec(trimmed === '' ? '*' : trimmed)
    if (spec === null) return null
    if (spec.type === 'version') return isPublished(summary, spec.version) ? spec.version : null
    if (spec.type === 'tag') return spec.tag === 'latest' && summary.latest !== null && isPublished(summary, summary.latest) ? summary.latest : null
    const latest = summary.latest
    // npm takes `latest` for '*' without testing it (a prerelease `latest` included), and for any other range
    // when the range accepts it.
    if (latest !== null && isPublished(summary, latest) && !isDeprecated(summary, latest) &&
        (spec.range.raw === '*' || spec.range.test(latest))) return latest
    const pool = namesPrerelease(spec.range) ? candidatesOf(summary).all : candidatesOf(summary).releases
    let deprecated: string | null = null
    for (const c of pool) {
        if (!spec.range.test(c.version)) continue
        if (!c.deprecated) return c.key
        deprecated = deprecated ?? c.key
    }
    return deprecated
}

function isPublished(summary: NpmPackageSummary, version: string): boolean {
    return Object.hasOwn(summary.versions, version) || Object.hasOwn(summary.prereleases, version)
}

// Only a release's deprecation is recorded; a prerelease reads as not deprecated.
function isDeprecated(summary: NpmPackageSummary, version: string): boolean {
    return Object.hasOwn(summary.versions, version) && (summary.versions[version] as NpmVersionSummary).deprecated !== null
}

// Whether any comparator of the range carries a prerelease tag: without one, semver never lets a prerelease
// satisfy it, so only releases need testing.
function namesPrerelease(range: semver.Range): boolean {
    return range.set.some(function anySet(comparators) {
        return comparators.some(function tagged(c) { return c.semver instanceof semver.SemVer && c.semver.prerelease.length > 0 })
    })
}

// The summary's versions parsed once, newest first: the first one a range accepts is the highest.
function candidatesOf(summary: NpmPackageSummary): Candidates {
    const cached = candidates.get(summary)
    if (cached) return cached
    // Parsed loosely, as the ranges are, so semver tests each one as it is instead of re-parsing it.
    function parse(keys: string[]): Candidate[] {
        return keys.flatMap(function toCandidate(key) {
            const version = semver.parse(key, LOOSE)
            return version === null ? [] : [{ key, version, deprecated: isDeprecated(summary, key) }]
        })
    }
    function newestFirst(a: Candidate, b: Candidate): number {
        return b.version.compare(a.version)
    }
    const releases = parse(Object.keys(summary.versions)).sort(newestFirst)
    const all = [...releases, ...parse(Object.keys(summary.prereleases))].sort(newestFirst)
    const built = { releases, all }
    candidates.set(summary, built)
    return built
}
