import type { FixTextStyle } from './fix-status'

// The way out of a finding whose package has no fixed version released: what the reader can do instead
// of chasing a version. Computed by the worker from cached registry data and the lockfile's node graph,
// stored on the finding (findings.remediation_json) and rendered the same way everywhere from here.

// A package counts as unmaintained when npm carries a deprecation notice for it, or when nothing has been
// published for this many days or more (six months — the user's threshold, decision D5).
export const UNMAINTAINED_AFTER_DAYS = 183

const DAY_MS = 24 * 60 * 60 * 1000
// The mean Gregorian month, so "months since" agrees with a calendar to within a day.
const DAYS_PER_MONTH = 365.25 / 12

// What a reader weighs a package by: weekly downloads, last release and maintainers.
export type PackageSignals = {
    name: string
    latest: string | null
    // The newest publish time over the package's releases; null when the registry gave none.
    lastPublishAt: number | null
    maintainers: number
    // Null when the count could not be had.
    weeklyDownloads: number | null
}

export type RemediationHealth = PackageSignals & {
    // npm's deprecation notice on the installed version, or failing that on latest; null when neither has one.
    deprecated: string | null
    daysSinceLastPublish: number | null
    unmaintained: boolean
}

// What an escape claim rests on: the release whose full resolved dependency closure was walked, and how
// many packages that closure holds. The vulnerable package is in none of them.
export type ClosureProof = { release: string; closureSize: number }

export type ChainVerdict =
    // A released `package` ≥ `toAtLeast` drops the vulnerable package, and its parent admits it.
    | { kind: 'upgrade'; package: string; toAtLeast: string; proof: ClosureProof }
    // `escapePackage` ≥ `escapeVersion` drops it, but no released `blockedBy` admits that version
    // (`blockedRange` is what the installed `blockedBy` requires; `blockedByLatest` its newest release).
    | { kind: 'blocked'; escapePackage: string; escapeVersion: string; blockedBy: string; blockedByLatest: string | null; blockedRange: string; proof: ClosureProof }
    // No released version of any of these ancestors (nearest first, up to the direct dependency) drops it.
    | { kind: 'noEscape'; packages: string[] }
    // The registry evidence could not settle it at `at` — `reason` names the real cause; nothing at or above it
    // is claimed either way.
    | { kind: 'unknown'; at: string; reason: string }
    // The vulnerable package is itself a direct dependency: the only way out is replacing it.
    | { kind: 'direct' }

export type RemediationRootKind = 'prod' | 'dev' | 'optional'

export type RemediationChain = {
    // The workspace the path starts in ('.' for the project itself); null when there is no lockfile graph.
    importer: string | null
    // How the importer depends on the path's first package; 'dev' marks a path that reaches only dev tooling.
    rootKind: RemediationRootKind | null
    // name@version from the direct dependency down to the vulnerable package.
    path: string[]
    verdict: ChainVerdict
}

export type AlternativeOption =
    // A replacement package. `verified` — its latest release's closure was walked and does not reach the
    // vulnerable package (`proof`); unverified — the walk could not finish, so it is not offered as a way out.
    | { kind: 'module'; name: string; version: string | null; verified: boolean; proof: ClosureProof | null; signals: PackageSignals | null }
    // A platform built-in.
    | { kind: 'native'; id: string; description: string | null; url: string | null }
    // A few lines of code instead of a package.
    | { kind: 'snippet'; id: string; description: string; url: string | null }
    // Drop the package; the platform covers it.
    | { kind: 'removal'; description: string; url: string | null }

export type AlternativeReason = 'unmaintained' | 'direct' | 'noEscape' | 'blocked'

// Curated replacements (the e18e module-replacements dataset) for one package the reader cannot upgrade
// their way out of. An empty `options` list says plainly that no curated alternative is known.
export type Alternative = {
    replaces: string
    reason: AlternativeReason
    signals: PackageSignals | null
    options: AlternativeOption[]
    url: string | null
}

export type Remediation = {
    v: 1
    checkedAt: number
    package: string
    health: RemediationHealth
    // Up to MAX_REMEDIATION_CHAINS paths, shortest first; `moreChains` counts the rest (every simple path,
    // not only the shortest ones). `moreChainsAtLeast`: a cycle on the way made the count a lower bound.
    chains: RemediationChain[]
    moreChains: number
    moreChainsAtLeast: boolean
    alternatives: Alternative[]
    // True only when no production or optional root reaches the vulnerable package at all; null when
    // that could not be determined (no lockfile graph).
    devOnly: boolean | null
}

export const MAX_REMEDIATION_CHAINS = 5

export function daysSince(at: number | null, now: number): number | null {
    if (at === null) return null
    return Math.max(0, Math.floor((now - at) / DAY_MS))
}

export function isUnmaintained(deprecated: string | null, days: number | null): boolean {
    return deprecated !== null || (days !== null && days >= UNMAINTAINED_AFTER_DAYS)
}

// Degrades to null rather than throwing, like parseFixCheck: a corrupt or future-shaped value reads as "no
// way out recorded", which the renderers simply omit. Every field a renderer reads is checked, variant by
// variant, so an accepted value can always be rendered.
export function parseRemediation(json: string | null): Remediation | null {
    if (json === null) return null
    let parsed: unknown
    try {
        parsed = JSON.parse(json)
    } catch {
        return null
    }
    if (!isRemediation(parsed)) return null
    // A row stored while the way out had a fetch cap also carries `partial`. It is read, and dropped:
    // there is no cap any more, so it says nothing about the guidance.
    const current: Remediation & { partial?: unknown } = { ...parsed }
    delete current.partial
    return current
}

function isRemediation(r: unknown): r is Remediation {
    return isRecord(r) && r.v === 1 && isTime(r.checkedAt) && typeof r.package === 'string' && isCount(r.moreChains) &&
        typeof r.moreChainsAtLeast === 'boolean' && (r.devOnly === null || typeof r.devOnly === 'boolean') &&
        isHealth(r.health) && isListOf(r.chains, isChain) && isListOf(r.alternatives, isAlternative)
}

const ROOT_KINDS = new Set<unknown>(['prod', 'dev', 'optional', null])
const ALTERNATIVE_REASONS = new Set<unknown>(['unmaintained', 'direct', 'noEscape', 'blocked'])

function isSignals(s: unknown): s is PackageSignals {
    return isRecord(s) && typeof s.name === 'string' && isOptionalString(s.latest) && (s.lastPublishAt === null || isTime(s.lastPublishAt)) &&
        isCount(s.maintainers) && (s.weeklyDownloads === null || isCount(s.weeklyDownloads))
}

function isHealth(h: unknown): h is RemediationHealth {
    if (!isSignals(h)) return false
    const health = h as Record<string, unknown>
    return isOptionalString(health.deprecated) && (health.daysSinceLastPublish === null || isCount(health.daysSinceLastPublish)) && typeof health.unmaintained === 'boolean'
}

function isProof(p: unknown): p is ClosureProof {
    return isRecord(p) && typeof p.release === 'string' && isCount(p.closureSize)
}

function isVerdict(v: unknown): v is ChainVerdict {
    if (!isRecord(v)) return false
    if (v.kind === 'upgrade') return typeof v.package === 'string' && typeof v.toAtLeast === 'string' && isProof(v.proof)
    if (v.kind === 'blocked') {
        return typeof v.escapePackage === 'string' && typeof v.escapeVersion === 'string' && typeof v.blockedBy === 'string' &&
            isOptionalString(v.blockedByLatest) && typeof v.blockedRange === 'string' && isProof(v.proof)
    }
    if (v.kind === 'noEscape') return isListOf(v.packages, isString)
    if (v.kind === 'unknown') return typeof v.at === 'string' && typeof v.reason === 'string'
    return v.kind === 'direct'
}

function isChain(c: unknown): c is RemediationChain {
    return isRecord(c) && isOptionalString(c.importer) && ROOT_KINDS.has(c.rootKind) && isListOf(c.path, isString) && isVerdict(c.verdict)
}

function isOption(o: unknown): o is AlternativeOption {
    if (!isRecord(o)) return false
    if (o.kind === 'module') {
        return typeof o.name === 'string' && isOptionalString(o.version) && typeof o.verified === 'boolean' &&
            (o.proof === null || isProof(o.proof)) && (o.signals === null || isSignals(o.signals))
    }
    if (o.kind === 'native') return typeof o.id === 'string' && isOptionalString(o.description) && isOptionalString(o.url)
    if (o.kind === 'snippet') return typeof o.id === 'string' && typeof o.description === 'string' && isOptionalString(o.url)
    return o.kind === 'removal' && typeof o.description === 'string' && isOptionalString(o.url)
}

function isAlternative(a: unknown): a is Alternative {
    return isRecord(a) && typeof a.replaces === 'string' && ALTERNATIVE_REASONS.has(a.reason) && (a.signals === null || isSignals(a.signals)) &&
        isListOf(a.options, isOption) && isOptionalString(a.url)
}

function isListOf<T>(value: unknown, item: (v: unknown) => v is T): value is T[] {
    return Array.isArray(value) && value.every(function each(v: unknown) { return item(v) })
}

function isString(value: unknown): value is string {
    return typeof value === 'string'
}

function isOptionalString(value: unknown): value is string | null {
    return value === null || typeof value === 'string'
}

// A non-negative whole number: a count, a size or a number of days.
function isCount(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 0
}

// An epoch-ms instant a Date can print (toISOString throws past ±8.64e15).
function isTime(value: unknown): value is number {
    return typeof value === 'number' && !Number.isNaN(new Date(value).getTime())
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isoDate(at: number): string {
    return new Date(at).toISOString().slice(0, 10)
}

function count(n: number): string {
    return n.toLocaleString('en-US')
}

function plural(n: number, one: string, many: string): string {
    return count(n) + ' ' + (n === 1 ? one : many)
}

// "last release 2024-05-21 · 1 maintainer · 204,706,783 weekly downloads"
export function describeSignals(s: PackageSignals): string {
    const parts: string[] = []
    if (s.latest !== null) parts.push('latest ' + s.latest)
    parts.push(s.lastPublishAt === null ? 'last release unknown' : 'last release ' + isoDate(s.lastPublishAt))
    parts.push(plural(s.maintainers, 'maintainer', 'maintainers'))
    parts.push(s.weeklyDownloads === null ? 'weekly downloads unknown' : plural(s.weeklyDownloads, 'weekly download', 'weekly downloads'))
    return parts.join(' · ')
}

export function describeHealth(h: RemediationHealth, style: FixTextStyle): string {
    const age = h.daysSinceLastPublish === null ? '' : ' (' + Math.floor(h.daysSinceLastPublish / DAYS_PER_MONTH) + ' months ago)'
    const facts = style.code(h.name) + ': last publish ' + (h.lastPublishAt === null ? 'unknown' : isoDate(h.lastPublishAt)) + age +
        ' · ' + plural(h.maintainers, 'maintainer', 'maintainers') + ' · ' +
        (h.weeklyDownloads === null ? 'weekly downloads unknown' : plural(h.weeklyDownloads, 'weekly download', 'weekly downloads'))
    if (h.deprecated !== null) return facts + ' — ' + style.strong('deprecated') + ' ("' + h.deprecated + '") → replace it'
    if (h.unmaintained) return facts + ' — ' + style.strong('unmaintained') + ' (no publish for 6+ months) → replace it'
    return facts + ' — maintained'
}

export function describeVerdict(v: ChainVerdict, target: string, style: FixTextStyle): string {
    if (v.kind === 'upgrade') {
        return 'upgrade ' + style.code(v.package) + ' to ≥ ' + style.code(v.toAtLeast) + ' — its resolved closure (' + plural(v.proof.closureSize, 'package', 'packages') + ') does not reach ' + target
    }
    if (v.kind === 'blocked') {
        const latest = v.blockedByLatest === null ? '' : 'latest ' + v.blockedByLatest + ' '
        return style.code(v.escapePackage) + ' ≥ ' + style.code(v.escapeVersion) + ' drops ' + target + ', but no released ' + style.code(v.blockedBy) +
            ' admits it (' + latest + 'requires ' + style.code(v.blockedRange) + ')'
    }
    if (v.kind === 'noEscape') return 'no released ' + listOr(v.packages.map(style.code)) + ' drops ' + target
    if (v.kind === 'unknown') return 'unknown — not enough registry evidence at ' + style.code(v.at) + ' (' + v.reason + ')'
    return target + ' is a direct dependency — the only way out is to replace it'
}

function listOr(items: string[]): string {
    if (items.length <= 1) return items.join('')
    return items.slice(0, -1).join(', ') + ' or ' + items[items.length - 1]
}

function link(url: string | null): string {
    return url === null ? '' : ' (' + url + ')'
}

export function describeOption(o: AlternativeOption, style: FixTextStyle): string {
    if (o.kind === 'module') {
        const head = style.code(o.name) + (o.version === null ? '' : ' ' + o.version)
        const signals = o.signals === null ? '' : ' — ' + describeSignals(o.signals)
        if (o.verified && o.proof !== null) return head + ' (closure of ' + plural(o.proof.closureSize, 'package', 'packages') + ' checked)' + signals
        return head + ' (not verified — its dependency closure could not be checked)' + signals
    }
    if (o.kind === 'native') return 'built-in ' + style.code(o.id) + (o.description === null ? '' : ': ' + o.description) + link(o.url)
    if (o.kind === 'snippet') return 'inline code: ' + o.description + link(o.url)
    return 'remove it: ' + o.description + link(o.url)
}

export function describeAlternative(a: Alternative, style: FixTextStyle): string {
    const signals = a.signals === null ? '' : ' (' + describeSignals(a.signals) + ')'
    if (a.options.length === 0) return 'no curated alternative known for ' + style.code(a.replaces) + signals
    return 'alternatives to ' + style.code(a.replaces) + signals + ': ' + a.options.map(function one(o) { return describeOption(o, style) }).join('; ')
}

function rootLabel(chain: RemediationChain): string {
    if (chain.rootKind === 'dev') return ' [dev tooling only]'
    if (chain.rootKind === 'optional') return ' [optional]'
    return ''
}

export function describeDevOnly(devOnly: boolean | null, target: string): string {
    if (devOnly === true) return 'Every path to ' + target + ' reaches only dev tooling — still fix it, after the production findings.'
    if (devOnly === false) return 'At least one production path reaches ' + target + '.'
    return 'Whether only dev tooling reaches ' + target + ' could not be determined (no lockfile graph).'
}

// The "Way out" block as lines, without bullets, so each surface can indent them its own way: the
// advisory export nests them under a bullet; the CLI and the notifications use a subset.
export function describeRemediation(r: Remediation, style: FixTextStyle): { health: string; chains: string[]; devOnly: string; alternatives: string[] } {
    const target = style.code(r.package)
    const chains = r.chains.map(function line(c) {
        // The workspace is named when it is not the project itself: the same path in four apps of a
        // monorepo is four paths, and reads as a repeat without it.
        const where = c.importer !== null && c.importer !== '.' ? ' in ' + style.code(c.importer) : ''
        const path = c.path.length > 0 ? style.code(c.path.join(' › ')) + where + rootLabel(c) + ': ' : ''
        return path + describeVerdict(c.verdict, target, style)
    })
    if (r.moreChains > 0) chains.push('and ' + (r.moreChainsAtLeast ? 'at least ' : '') + plural(r.moreChains, 'more path', 'more paths'))
    return {
        health: describeHealth(r.health, style),
        chains,
        devOnly: describeDevOnly(r.devOnly, target),
        alternatives: r.alternatives.map(function line(a) { return describeAlternative(a, style) })
    }
}

// One line for a chat message, without its label: the first thing to do, then how many paths were checked.
export function summarizeRemediation(r: Remediation, style: FixTextStyle): string {
    const target = style.code(r.package)
    const parts: string[] = []
    if (r.health.unmaintained) parts.push(target + ' is ' + (r.health.deprecated !== null ? 'deprecated' : 'unmaintained') + ' → replace it')
    const [first] = r.chains
    if (first) parts.push(describeVerdict(first.verdict, target, style))
    const others = r.chains.length - 1 + r.moreChains
    if (others > 0) parts.push((r.moreChainsAtLeast ? 'at least ' : '') + plural(others, 'more path', 'more paths') + ' in the advisory')
    if (r.devOnly === true) parts.push('dev tooling only')
    return parts.length > 0 ? parts.join('; ') : 'see the advisory'
}
