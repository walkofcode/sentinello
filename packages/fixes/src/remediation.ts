import semver from 'semver'
import {
    daysSince,
    isUnmaintained,
    MAX_REMEDIATION_CHAINS,
    type Alternative,
    type AlternativeOption,
    type AlternativeReason,
    type ChainVerdict,
    type PackageSignals,
    type Remediation,
    type RemediationChain,
    type RemediationHealth
} from '@sentinello/core'
import type { NpmPackageSummary } from '@sentinello/feeds'
import type { LockRoot, NodeGraph } from '@sentinello/scanners'
import { createClosureWalker, effectiveDependencies, REMEDIATION_FETCH_BUDGET, unalias, type ClosureWalker, type ProofTarget, type SummaryAnswer } from './closure'
import type { RegistryClient } from './registry-client'
import { createReplacementDataset, type ReplacementDataset } from './replacements'

// The way out for a finding settled 'none_released': package health, one verdict per dependency path
// (walked through every ancestor, each escape proven over its full closure), curated alternatives
// (closure-checked), and whether only dev tooling reaches the package. Pure: settleProject groups the
// findings into requests and hands back what this computes; the caller persists it.

export type RemediationRequest = { target: ProofTarget; installed: string[] }

export type RemediationContext = {
    graph: NodeGraph | null
    registry: RegistryClient
    checkedAt: number
    dataset?: ReplacementDataset
}

// The guidance for each request, in order, sharing one closure walker (its memo and its fetch budget) and
// one download lookup across all of them — one project scan's worth.
export async function computeRemediations(requests: RemediationRequest[], context: RemediationContext): Promise<Remediation[]> {
    const walker = createClosureWalker(context.registry, { remaining: REMEDIATION_FETCH_BUDGET, exhausted: false })
    const signals = new SignalBook(walker)
    const dataset = context.dataset ?? createReplacementDataset()
    const out: Remediation[] = []
    for (const r of requests) {
        out.push(await buildOne({ target: r.target, installed: r.installed, graph: context.graph, walker, signals, dataset, checkedAt: context.checkedAt }))
    }
    // Download counts are a signal, not a verdict: fetched once for every package any guidance names.
    await signals.fillDownloads(context.registry)
    // Partial: the budget ran out and this guidance has a verdict or an option that more data could settle.
    for (const r of out) r.partial = walker.budget.exhausted && hasOpenQuestion(r)
    return out
}

function hasOpenQuestion(r: Remediation): boolean {
    const unknownChain = r.chains.some(function open(c) { return c.verdict.kind === 'unknown' })
    const unverifiedOption = r.alternatives.some(function open(a) { return a.options.some(function o(opt) { return opt.kind === 'module' && !opt.verified }) })
    return unknownChain || unverifiedOption
}

type BuildOneArgs = {
    target: ProofTarget
    installed: string[]
    graph: NodeGraph | null
    walker: ClosureWalker
    signals: SignalBook
    dataset: ReplacementDataset
    checkedAt: number
}

async function buildOne(args: BuildOneArgs): Promise<Remediation> {
    const health = await healthOf(args)
    const found = args.graph ? findChains(args.graph, args.target.name, args.installed) : null
    const chains: RemediationChain[] = []
    if (found === null || found.chains.length === 0) {
        chains.push({ importer: null, rootKind: null, path: [], verdict: { kind: 'unknown', at: args.target.name, reason: found === null ? 'no lockfile dependency graph' : 'no dependency path to the installed copy found in the lockfile' } })
    } else {
        for (const chain of found.chains) {
            chains.push({ importer: chain.root.importer, rootKind: chain.root.kind, path: chain.nodes.map(display), verdict: await walkChain(chain.nodes, args) })
        }
    }
    const alternatives = await alternativesFor(chains, health, args)
    return {
        v: 1,
        checkedAt: args.checkedAt,
        package: args.target.name,
        health,
        chains,
        moreChains: found ? found.more : 0,
        moreChainsAtLeast: found ? found.moreAtLeast : false,
        alternatives,
        devOnly: found ? found.devOnly : null,
        partial: false
    }
}

function display(node: ChainNode): string {
    return node.name + '@' + node.version
}

async function healthOf(args: BuildOneArgs): Promise<RemediationHealth> {
    const s = await args.signals.of(args.target.name)
    const answer = await summaryOf(args.walker, args.target.name)
    const summary = answer.status === 'ok' ? answer.summary : null
    const deprecated = summary ? deprecationOf(summary, args.installed) : null
    const days = daysSince(s.lastPublishAt, args.checkedAt)
    return args.signals.track({ ...s, deprecated, daysSinceLastPublish: days, unmaintained: isUnmaintained(deprecated, days) })
}

// The notice on an installed version, or failing that on latest.
function deprecationOf(summary: NpmPackageSummary, installed: string[]): string | null {
    for (const v of installed) {
        const notice = summary.versions[v]?.deprecated
        if (notice) return notice
    }
    const latest = summary.latest === null ? undefined : summary.versions[summary.latest]
    return latest?.deprecated ?? null
}

// ---- Chains over the lockfile node graph -----------------------------------------------------------

type ChainNode = { name: string; version: string }
type FoundChain = { root: LockRoot; nodes: ChainNode[] }
// `more` counts the root→vulnerable paths not shown; `moreAtLeast` says it is a lower bound, because the
// graph has a cycle on the way and the enumeration that counted it hit its cap.
type FoundChains = { chains: FoundChain[]; more: number; moreAtLeast: boolean; devOnly: boolean | null }

// How many complete paths are examined, and how many partial ones expanded, while choosing the paths to
// show (peer variants of one path display identically) or counting paths through a cycle.
export type PathLimits = { paths: number; expansions: number }
export const PATH_LIMITS: PathLimits = { paths: 10_000, expansions: 100_000 }

// Up to MAX_REMEDIATION_CHAINS distinct simple root→vulnerable paths, shortest first, with the shortest
// production path always among them when one exists; how many paths are left (every simple path, not only
// the shortest ones); and whether only dev roots reach the vulnerable copies, from complete reachability
// over every node and importer — never from the paths shown. A path ends at the first vulnerable copy.
export function findChains(graph: NodeGraph, target: string, installed: string[], limits: PathLimits = PATH_LIMITS): FoundChains {
    const byId = new Map(graph.nodes.map(function entry(n) { return [n.id, n] as const }))
    const vulnerable = graph.nodes.filter(function hit(n) { return n.name === target && installed.includes(n.version) }).map(function id(n) { return n.id })
    if (vulnerable.length === 0) return { chains: [], more: 0, moreAtLeast: false, devOnly: null }
    const children = new Map<string, string[]>()
    const parents = new Map<string, string[]>()
    for (const e of graph.edges) {
        push(children, e.from, e.to)
        push(parents, e.to, e.from)
    }
    // Distance from each node to the nearest vulnerable copy, walking edges backwards. It is the remaining
    // length of the shortest completion of any path standing on that node, so the walk below can hand out
    // paths in order of their full length.
    const dist = new Map<string, number>()
    let frontier = vulnerable
    for (const id of frontier) dist.set(id, 0)
    for (let d = 1; frontier.length > 0; d++) {
        const next: string[] = []
        for (const id of frontier) {
            for (const parent of parents.get(id) ?? []) {
                if (dist.has(parent)) continue
                dist.set(parent, d)
                next.push(parent)
            }
        }
        frontier = next
    }
    const reaching = graph.roots.filter(function reaches(r) { return dist.has(r.nodeId) })
    if (reaching.length === 0) return { chains: [], more: 0, moreAtLeast: false, devOnly: null }
    const devOnly = reaching.every(function dev(r) { return r.kind === 'dev' })
    const ordered = [...reaching].sort(function shortestFirst(a, b) {
        return (dist.get(a.nodeId) as number) - (dist.get(b.nodeId) as number) || rank(a) - rank(b)
    })

    // Every simple path from `roots` to a vulnerable copy, in order of length (best-first on length so far
    // plus `dist`, which never overestimates). Paths of one length are walked depth-first, roots and
    // children in order, so the first complete path comes after a handful of steps however wide the graph.
    // `visit` returns false to stop. True when every path was visited; false when `visit` stopped it or the
    // expansion cap was reached.
    function walkPaths(roots: LockRoot[], visit: (root: LockRoot, ids: string[]) => boolean): boolean {
        // One stack per total length; a path extended along a shortest edge keeps its length, so it lands
        // back on the stack being read.
        const stacks: { root: LockRoot; ids: string[] }[][] = []
        function add(root: LockRoot, ids: string[]): void {
            const length = ids.length - 1 + (dist.get(ids[ids.length - 1] as string) as number)
            const stack = stacks[length]
            if (stack) stack.push({ root, ids })
            else stacks[length] = [{ root, ids }]
        }
        for (const root of roots) add(root, [root.nodeId])
        let expanded = 0
        for (let length = 0; length < stacks.length; length++) {
            // Paths deferred to this length arrived in discovery order; the first discovered is read first.
            const stack = (stacks[length] ?? []).reverse()
            for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
                const { root, ids } = next
                const last = ids[ids.length - 1] as string
                if (dist.get(last) === 0) {
                    if (!visit(root, ids)) return false
                    continue
                }
                if (++expanded > limits.expansions) return false
                // A node at distance > 0 got there through a child, so it has children.
                // Children that keep this length go on top in reverse, so the first is read next; children
                // deferred to a longer length keep their order.
                const onward = (children.get(last) as string[]).filter(function open(c) { return dist.has(c) && !ids.includes(c) })
                const later = onward.filter(function longer(c) { return (dist.get(c) as number) >= (dist.get(last) as number) })
                const now = onward.filter(function shorter(c) { return (dist.get(c) as number) < (dist.get(last) as number) })
                for (const c of later) add(root, [...ids, c])
                for (const c of now.reverse()) add(root, [...ids, c])
            }
        }
        return true
    }

    // Distinct displayed paths in order; `represents` counts the node paths each one stands for (peer
    // variants of a path display identically, and have the same length, so the walk finishes the length
    // it filled the list at), so "N more" counts only paths not shown.
    function collect(roots: LockRoot[], limit: number): { chain: FoundChain; represents: number }[] {
        const found: { chain: FoundChain; represents: number; key: string }[] = []
        let filledAt: number | null = null
        let examined = 0
        walkPaths(roots, function visit(root, ids) {
            if (filledAt !== null && ids.length > filledAt) return false
            const nodes = ids.map(function toNode(nodeId) { const n = byId.get(nodeId) as { name: string; version: string }; return { name: n.name, version: n.version } })
            const key = root.importer + '|' + root.kind + '|' + nodes.map(display).join('>')
            const same = found.find(function dup(f) { return f.key === key })
            if (same) same.represents++
            else if (filledAt === null) {
                found.push({ chain: { root, nodes }, represents: 1, key })
                if (found.length >= limit) filledAt = ids.length
            }
            return ++examined < limits.paths
        })
        return found
    }
    let shown = collect(ordered, MAX_REMEDIATION_CHAINS)
    // The reader must see a production path when one exists, even if shorter dev paths fill the list.
    const prodRoots = ordered.filter(function prod(r) { return r.kind !== 'dev' })
    if (prodRoots.length > 0 && !shown.some(function isProd(c) { return c.chain.root.kind !== 'dev' })) {
        shown = [...shown.slice(0, MAX_REMEDIATION_CHAINS - 1), ...collect(prodRoots, 1)]
    }
    const represented = shown.reduce(function sum(n, c) { return n + c.represents }, 0)
    const total = countPaths(ordered, dist, children, walkPaths, limits.paths)
    return { chains: shown.map(function chainOf(c) { return c.chain }), more: Math.max(0, total.count - represented), moreAtLeast: !total.exact, devOnly }
}

// The number of simple root→vulnerable paths. Exact by dynamic programming when no cycle lies on the way
// to a vulnerable copy (the usual lockfile); with one, simple paths are counted one by one up to the cap,
// and a count the cap cut short is a lower bound (`exact: false`), never presented as the total.
function countPaths(
    roots: LockRoot[],
    dist: Map<string, number>,
    children: Map<string, string[]>,
    walkPaths: (roots: LockRoot[], visit: (root: LockRoot, ids: string[]) => boolean) => boolean,
    cap: number
): { count: number; exact: boolean } {
    const counts = new Map<string, number>()
    const open = new Set<string>()
    let cyclic = false
    function countFrom(id: string): number {
        const known = counts.get(id)
        if (known !== undefined) return known
        if (dist.get(id) === 0) return 1
        if (open.has(id)) {
            cyclic = true
            return 0
        }
        open.add(id)
        let n = 0
        for (const c of children.get(id) as string[]) {
            if (cyclic) break
            if (dist.has(c)) n = Math.min(Number.MAX_SAFE_INTEGER, n + countFrom(c))
        }
        open.delete(id)
        counts.set(id, n)
        return n
    }
    let count = 0
    for (const r of roots) {
        count = Math.min(Number.MAX_SAFE_INTEGER, count + countFrom(r.nodeId))
        if (cyclic) break
    }
    if (!cyclic) return { count, exact: true }
    let walked = 0
    const exact = walkPaths(roots, function visit() { return ++walked < cap })
    return { count: walked, exact }
}

function rank(root: LockRoot): number {
    return root.kind === 'dev' ? 1 : 0
}

function push(map: Map<string, string[]>, key: string, value: string): void {
    const list = map.get(key)
    if (list) {
        if (!list.includes(value)) list.push(value)
    } else {
        map.set(key, [value])
    }
}

// ---- The verdict walk --------------------------------------------------------------------------------

type Escape = { kind: 'found'; version: string; closureSize: number } | { kind: 'none' } | { kind: 'unknown'; reason: string }

// From the vulnerable package's nearest ancestor up to the direct dependency. One rule at every level: a
// release counts as an escape only when its full closure is proven not to reach the target; a range that
// merely admits an escaping child never counts on its own.
async function walkChain(nodes: ChainNode[], args: BuildOneArgs): Promise<ChainVerdict> {
    if (nodes.length === 1) return { kind: 'direct' }
    const noEscape: string[] = []
    for (let level = nodes.length - 2; level >= 0; level--) {
        const ancestor = nodes[level] as ChainNode
        const escape = await findEscape(ancestor, args)
        if (escape.kind === 'unknown') return { kind: 'unknown', at: ancestor.name, reason: escape.reason }
        if (escape.kind === 'none') {
            noEscape.push(ancestor.name)
            continue
        }
        return admit(nodes, level, escape.version, escape.closureSize, args)
    }
    return { kind: 'noEscape', packages: noEscape }
}

// `nodes[level]` escapes at `version`. Does its parent admit that version? If so, upgrade it; if not, the
// parent must move too — to a release with its own full proof — and the same question climbs a level.
async function admit(nodes: ChainNode[], level: number, version: string, closureSize: number, args: BuildOneArgs): Promise<ChainVerdict> {
    const escaping = nodes[level] as ChainNode
    const proof = { release: escaping.name + '@' + version, closureSize }
    if (level === 0) return { kind: 'upgrade', package: escaping.name, toAtLeast: version, proof }
    const parent = nodes[level - 1] as ChainNode
    const declared = await declaredRange(parent, escaping.name, args.walker)
    if (declared.kind === 'unknown') return { kind: 'unknown', at: parent.name, reason: declared.reason }
    const admits = semver.satisfies(version, unalias(escaping.name, declared.range).range)
    if (admits) return { kind: 'upgrade', package: escaping.name, toAtLeast: version, proof }
    const parentEscape = await findEscape(parent, args)
    if (parentEscape.kind === 'unknown') return { kind: 'unknown', at: parent.name, reason: parentEscape.reason }
    if (parentEscape.kind === 'none') {
        return { kind: 'blocked', escapePackage: escaping.name, escapeVersion: version, blockedBy: parent.name, blockedByLatest: declared.latest, blockedRange: declared.range, proof }
    }
    return admit(nodes, level - 1, parentEscape.version, parentEscape.closureSize, args)
}

// The lowest release above the installed one whose full closure does not reach the target. Releases are
// tried in ascending order; one whose proof is `unknown` before any proven one makes the answer unknown.
async function findEscape(node: ChainNode, args: BuildOneArgs): Promise<Escape> {
    const answer = await summaryOf(args.walker, node.name)
    if (answer.status === 'missing') return { kind: 'unknown', reason: 'no registry data for ' + node.name + ' (' + answer.reason + ')' }
    const installed = semver.valid(node.version)
    if (installed === null) return { kind: 'unknown', reason: 'installed ' + node.name + '@' + node.version + ' is not a release version' }
    const releases = Object.keys(answer.summary.versions)
        .filter(function newer(v) { return semver.valid(v) !== null && semver.gt(v, installed) })
        .sort(semver.compare)
    for (const v of releases) {
        const reach = await args.walker.reaches(node.name, v, args.target)
        if (reach.verdict === 'no') return { kind: 'found', version: v, closureSize: reach.closureSize }
        if (reach.verdict === 'unknown') return { kind: 'unknown', reason: node.name + '@' + v + ': ' + reach.reason }
    }
    return { kind: 'none' }
}

type Declared = { kind: 'known'; range: string; latest: string | null } | { kind: 'unknown'; reason: string }

// The range the installed parent declares for the child, from the registry's record of that release.
async function declaredRange(parent: ChainNode, child: string, walker: ClosureWalker): Promise<Declared> {
    const answer = await summaryOf(walker, parent.name)
    if (answer.status === 'missing') return { kind: 'unknown', reason: 'no registry data for ' + parent.name }
    const range = effectiveDependencies(answer.summary, parent.version)[child]
    if (range === undefined) return { kind: 'unknown', reason: parent.name + '@' + parent.version + ' does not declare ' + child + ' in the registry' }
    if (semver.validRange(unalias(child, range).range) === null) return { kind: 'unknown', reason: parent.name + ' requires ' + child + ' as ' + range + ', which is not a registry range' }
    return { kind: 'known', range, latest: answer.summary.latest }
}

// ---- Alternatives ------------------------------------------------------------------------------------

// For the vulnerable package when it is unmaintained (or a direct dependency), and for every package a
// chain is stuck on. A package with a dataset entry gets its curated options, each module proven over its
// latest release's closure; a chain whose stuck packages have no entry gets "no curated alternative
// known" for the nearest of them, with its own signals.
async function alternativesFor(chains: RemediationChain[], health: RemediationHealth, args: BuildOneArgs): Promise<Alternative[]> {
    const wanted: { name: string; reason: AlternativeReason }[] = []
    if (health.unmaintained) wanted.push({ name: args.target.name, reason: 'unmaintained' })
    for (const chain of chains) {
        const v = chain.verdict
        let stuck: string[] = []
        let reason: AlternativeReason = 'noEscape'
        if (v.kind === 'noEscape') stuck = v.packages
        else if (v.kind === 'blocked') {
            stuck = [v.blockedBy]
            reason = 'blocked'
        } else if (v.kind === 'direct') {
            stuck = [args.target.name]
            reason = 'direct'
        }
        const curated = stuck.filter(function hasEntry(name) { return args.dataset(name) !== null })
        if (curated.length > 0) for (const name of curated) wanted.push({ name, reason })
        else if (stuck.length > 0) wanted.push({ name: stuck[0] as string, reason })
    }
    const out: Alternative[] = []
    const done = new Set<string>()
    for (const w of wanted) {
        if (done.has(w.name)) continue
        done.add(w.name)
        const entry = args.dataset(w.name)
        const options: AlternativeOption[] = []
        for (const r of entry?.replacements ?? []) {
            if (r.kind !== 'module') {
                options.push(r)
                continue
            }
            const option = await moduleOption(r.name, args)
            if (option) options.push(option)
        }
        out.push({ replaces: w.name, reason: w.reason, signals: await args.signals.of(w.name), options, url: entry?.url ?? null })
    }
    return out
}

// A replacement package, offered only when its latest release is proven not to reach the target; listed as
// not verified when the proof could not finish; left out when it reaches the target.
async function moduleOption(name: string, args: BuildOneArgs): Promise<AlternativeOption | null> {
    const answer = await summaryOf(args.walker, name)
    if (answer.status === 'missing' || answer.summary.latest === null) return { kind: 'module', name, version: null, verified: false, proof: null, signals: null }
    const latest = answer.summary.latest
    const signals = await args.signals.of(name)
    const reach = await args.walker.reaches(name, latest, args.target)
    if (reach.verdict === 'yes') return null
    const verified = reach.verdict === 'no'
    return { kind: 'module', name, version: latest, verified, proof: verified ? { release: name + '@' + latest, closureSize: reach.closureSize } : null, signals }
}

// ---- Signals -----------------------------------------------------------------------------------------

// One signals object per package name, shared by every place that shows it, so weekly downloads can be
// filled in once for all of them after the verdicts are built.
class SignalBook {
    private readonly byName = new Map<string, PackageSignals>()
    private readonly copies: PackageSignals[] = []

    constructor(private readonly walker: ClosureWalker) {}

    async of(name: string): Promise<PackageSignals> {
        const known = this.byName.get(name)
        if (known) return known
        const answer = await summaryOf(this.walker, name)
        const summary = answer.status === 'ok' ? answer.summary : null
        const signals: PackageSignals = {
            name,
            latest: summary?.latest ?? null,
            lastPublishAt: summary ? lastPublishOf(summary) : null,
            maintainers: summary?.maintainers ?? 0,
            weeklyDownloads: null
        }
        this.byName.set(name, signals)
        return signals
    }

    // Registers an object that extends a package's signals (the health block) for the download fill.
    track<T extends PackageSignals>(copy: T): T {
        this.copies.push(copy)
        return copy
    }

    async fillDownloads(registry: RegistryClient): Promise<void> {
        const counts = await registry.weeklyDownloads([...this.byName.keys()])
        for (const s of [...this.byName.values(), ...this.copies]) s.weeklyDownloads = counts.get(s.name) ?? null
    }
}

// The walker answers for every name it is asked about.
async function summaryOf(walker: ClosureWalker, name: string): Promise<SummaryAnswer> {
    return (await walker.summaries([name])).get(name) as SummaryAnswer
}

function lastPublishOf(summary: NpmPackageSummary): number | null {
    let last: number | null = null
    for (const meta of Object.values(summary.versions)) {
        if (meta.publishedAt !== null && (last === null || meta.publishedAt > last)) last = meta.publishedAt
    }
    return last
}
