import { describe, expect, it } from 'vitest'
import type { Remediation } from '@sentinello/core'
import type { LockRootKind, NodeGraph } from '@sentinello/scanners'
import { computeRemediations, findChains } from './remediation'
import { fakeRegistry, type FakePackage, type FakeRelease } from './registry-fake.fixture'
import type { ReplacementDataset } from './replacements'

// The way out is advice an agent acts on, so every claim in it has to be proven or labelled. These cases
// are the user's two real chains (fast-glob → micromatch → braces, nodemon → chokidar → braces), Noah's
// sibling-path counterexample as a named regression, and the graph shapes that decide which paths are
// shown and whether a finding is dev-only.

const DAY = 24 * 60 * 60 * 1000
const CHECKED_AT = Date.UTC(2026, 9, 3)
const BRACES_PUBLISHED = Date.UTC(2024, 4, 21)
const BRACES_TARGET = { name: 'braces', affected: [{ ranges: '<=3.0.3', exact: [], complete: true }] }

// A node graph from `parent > child` lines and roots, nodes named by name@version ids.
function graph(spec: { edges?: string[]; roots: [string, LockRootKind, string?][] }): NodeGraph {
    const ids = new Set<string>()
    const edges = (spec.edges ?? []).map(function edge(line) {
        const [from, to] = line.split(' > ') as [string, string]
        ids.add(from)
        ids.add(to)
        return { from, to, kind: 'prod' as const }
    })
    const roots = spec.roots.map(function root([nodeId, kind, importer]) {
        ids.add(nodeId)
        return { importer: importer ?? '.', nodeId, kind }
    })
    const nodes = [...ids].map(function node(id) {
        const bare = id.replace(/\(.*$/, '')
        const at = bare.lastIndexOf('@')
        return { id, name: bare.slice(0, at), version: bare.slice(at + 1) }
    })
    return { nodes, edges, roots }
}

const BRACES: FakePackage = { latest: '3.0.3', maintainers: 2, releases: { '3.0.2': { publishedAt: BRACES_PUBLISHED - 100 * DAY, dependencies: { 'fill-range': '^7.0.1' } }, '3.0.3': { publishedAt: BRACES_PUBLISHED, dependencies: { 'fill-range': '^7.1.1' } } } }

async function remediate(table: Record<string, FakePackage>, g: NodeGraph | null, options: { dataset?: ReplacementDataset; installed?: string[]; downloads?: Record<string, number> } = {}): Promise<Remediation> {
    const registry = fakeRegistry(table, { downloads: options.downloads })
    const [r] = await computeRemediations([{ target: BRACES_TARGET, installed: options.installed ?? ['3.0.3'] }], { graph: g, registry, checkedAt: CHECKED_AT, dataset: options.dataset })
    return r as Remediation
}

const NO_DATASET: ReplacementDataset = function none() { return null }

describe('the fast-glob path: the walk continues past micromatch, and tinyglobby is offered with its proof', function () {
    const table: Record<string, FakePackage> = {
        braces: BRACES,
        '@next/eslint-plugin-next': { latest: '16.3.8', releases: { '16.3.7': { dependencies: { 'fast-glob': '3.3.1' } }, '16.3.8': { dependencies: { 'fast-glob': '3.3.1' } } } },
        'fast-glob': { releases: { '3.3.1': { dependencies: { micromatch: '^4.0.4' } }, '3.3.2': { dependencies: { micromatch: '^4.0.4' } }, '3.3.3': { dependencies: { micromatch: '^4.0.8' } } } },
        micromatch: { releases: { '4.0.8': { dependencies: { braces: '^3.0.3', picomatch: '^2.3.1' } } } },
        picomatch: { latest: '4.0.3', releases: { '2.3.1': {}, '4.0.3': {} } },
        tinyglobby: { latest: '0.2.15', maintainers: 1, releases: { '0.2.15': { dependencies: { fdir: '^6.5.0', picomatch: '^4.0.3' } } } },
        fdir: { releases: { '6.5.0': { peerDependencies: { picomatch: '^3 || ^4' } } } },
        zeptomatch: { releases: { '2.0.0': { dependencies: { grammex: '^3.1.11' } } } },
        grammex: { releases: { '3.1.11': {} } }
    }
    const g = graph({ roots: [['@next/eslint-plugin-next@16.3.8', 'dev']], edges: ['@next/eslint-plugin-next@16.3.8 > fast-glob@3.3.1', 'fast-glob@3.3.1 > micromatch@4.0.8', 'micromatch@4.0.8 > braces@3.0.3'] })

    it('says no released micromatch, fast-glob or @next/eslint-plugin-next drops braces', async function () {
        const r = await remediate(table, g, { downloads: { tinyglobby: 50_000_000, braces: 204_706_783 } })
        expect(r.chains).toEqual([{
            importer: '.', rootKind: 'dev', path: ['@next/eslint-plugin-next@16.3.8', 'fast-glob@3.3.1', 'micromatch@4.0.8', 'braces@3.0.3'],
            verdict: { kind: 'noEscape', packages: ['micromatch', 'fast-glob', '@next/eslint-plugin-next'] }
        }])
        expect(r.devOnly).toBe(true)
        expect(r).not.toHaveProperty('partial')
        expect(r.health).toMatchObject({ name: 'braces', latest: '3.0.3', lastPublishAt: BRACES_PUBLISHED, maintainers: 2, weeklyDownloads: 204_706_783, deprecated: null, unmaintained: true })
        expect(r.health.daysSinceLastPublish).toBe(865)
        const fastGlob = r.alternatives.find(function fg(a) { return a.replaces === 'fast-glob' })
        expect(fastGlob).toMatchObject({ reason: 'noEscape', url: 'https://e18e.dev/docs/replacements/fast-glob' })
        expect(fastGlob?.options).toEqual([{
            kind: 'module', name: 'tinyglobby', version: '0.2.15', verified: true, proof: { release: 'tinyglobby@0.2.15', closureSize: 3 },
            signals: { name: 'tinyglobby', latest: '0.2.15', lastPublishAt: Date.UTC(2026, 0, 1), maintainers: 1, weeklyDownloads: 50_000_000 }
        }])
        // module-replacements 3.4.0 also curates micromatch; its options are offered too, each proven.
        const micromatch = r.alternatives.find(function mm(a) { return a.replaces === 'micromatch' })
        expect(micromatch?.options.map(function kind(o) { return o.kind === 'module' ? o.name + ':' + String(o.verified) : o.kind })).toEqual(['native', 'picomatch:true', 'zeptomatch:true'])
        // braces itself is unmaintained, and nothing is curated for it.
        expect(r.alternatives[0]).toMatchObject({ replaces: 'braces', reason: 'unmaintained', options: [] })
    })

    it('offers no alternative for an ancestor without a dataset entry, but says so for the nearest stuck one', async function () {
        const r = await remediate(table, g, { dataset: NO_DATASET })
        expect(r.alternatives.map(function a(x) { return x.replaces + ':' + x.reason + ':' + x.options.length })).toEqual(['braces:unmaintained:0', 'micromatch:noEscape:0'])
    })
})

describe('the nodemon path', function () {
    const base: Record<string, FakePackage> = {
        braces: BRACES,
        nodemon: { latest: '3.1.14', releases: { '3.1.13': { dependencies: { chokidar: '^3.5.2' } }, '3.1.14': { dependencies: { chokidar: '^3.5.2' } } } },
        chokidar: { releases: { '3.6.0': { dependencies: { braces: '~3.0.2' } }, '4.0.0': { dependencies: { readdirp: '^4.0.1' } }, '4.0.1': { dependencies: { readdirp: '^4.0.1' } } } },
        readdirp: { releases: { '4.0.1': {} } }
    }
    const g = graph({ roots: [['nodemon@3.1.14', 'dev']], edges: ['nodemon@3.1.14 > chokidar@3.6.0', 'chokidar@3.6.0 > braces@3.0.3'] })

    it('is blocked: chokidar ≥ 4.0.0 drops braces, but no released nodemon admits it', async function () {
        const r = await remediate(base, g, { dataset: NO_DATASET })
        expect(r.chains[0]?.verdict).toEqual({ kind: 'blocked', escapePackage: 'chokidar', escapeVersion: '4.0.0', blockedBy: 'nodemon', blockedByLatest: '3.1.14', blockedRange: '^3.5.2', proof: { release: 'chokidar@4.0.0', closureSize: 2 } })
        expect(r.alternatives.find(function n(a) { return a.replaces === 'nodemon' })).toMatchObject({ reason: 'blocked', options: [], signals: { name: 'nodemon', latest: '3.1.14' } })
    })

    it('upgrades nodemon once a release admits chokidar 4 and its whole closure is braces-free (nodemon-escape)', async function () {
        const escaped = { ...base, nodemon: { latest: '3.2.0', releases: { ...base.nodemon?.releases, '3.2.0': { dependencies: { chokidar: '^4.0.0' } } } } }
        const r = await remediate(escaped, g, { dataset: NO_DATASET })
        expect(r.chains[0]?.verdict).toEqual({ kind: 'upgrade', package: 'nodemon', toAtLeast: '3.2.0', proof: { release: 'nodemon@3.2.0', closureSize: 3 } })
    })
})

// Noah's counterexample (issue 001): a parent release that admits the escaping child but still reaches the
// target through a sibling is not an escape.
describe('regression: sibling path through a parent release', function () {
    const v: FakePackage = { releases: { '1.0.0': {} } }
    const target = { name: 'v', affected: [{ ranges: '<=1.0.0', exact: [], complete: true }] }
    const g = graph({ roots: [['p@1.0.0', 'prod']], edges: ['p@1.0.0 > a@1.0.0', 'a@1.0.0 > v@1.0.0'] })
    const base: Record<string, FakePackage> = {
        v,
        a: { releases: { '1.0.0': { dependencies: { v: '1.0.0' } }, '2.0.0': {} } },
        p: { releases: { '1.0.0': { dependencies: { a: '1.0.0' } }, '2.0.0': { dependencies: { a: '^2.0.0', helper: '^1.0.0' } } } },
        helper: { releases: { '1.0.0': { dependencies: { v: '1.0.0' } } } }
    }

    async function walk(table: Record<string, FakePackage>) {
        const [r] = await computeRemediations([{ target, installed: ['1.0.0'] }], { graph: g, registry: fakeRegistry(table), checkedAt: CHECKED_AT, dataset: NO_DATASET })
        return r?.chains[0]?.verdict
    }

    it('never recommends P2, whose proof is yes: blocked', async function () {
        expect(await walk(base)).toEqual({ kind: 'blocked', escapePackage: 'a', escapeVersion: '2.0.0', blockedBy: 'p', blockedByLatest: '2.0.0', blockedRange: '1.0.0', proof: { release: 'a@2.0.0', closureSize: 1 } })
    })

    it('recommends P3 when it admits A2 and drops the helper, carrying its own proof', async function () {
        const table = { ...base, p: { releases: { ...base.p?.releases, '3.0.0': { dependencies: { a: '^2.0.0' } } } } }
        expect(await walk(table)).toEqual({ kind: 'upgrade', package: 'p', toAtLeast: '3.0.0', proof: { release: 'p@3.0.0', closureSize: 2 } })
    })

    it('is unknown when P3 needs a helper the registry has no data for', async function () {
        const table = { ...base, p: { releases: { ...base.p?.releases, '3.0.0': { dependencies: { a: '^2.0.0', helper2: '^1.0.0' } } } } }
        expect(await walk(table)).toEqual({ kind: 'unknown', at: 'p', reason: 'p@3.0.0: helper2: not on the npm registry' })
    })
})

describe('the walk, level by level', function () {
    const v: FakePackage = { releases: { '1.0.0': {} } }
    const target = { name: 'v', affected: [{ ranges: '<=1.0.0', exact: [], complete: true }] }
    const g = graph({ roots: [['p@1.0.0', 'prod']], edges: ['p@1.0.0 > a@1.0.0', 'a@1.0.0 > v@1.0.0'] })

    async function walk(table: Record<string, FakePackage>, chainGraph: NodeGraph = g) {
        const [r] = await computeRemediations([{ target, installed: ['1.0.0'] }], { graph: chainGraph, registry: fakeRegistry(table), checkedAt: CHECKED_AT, dataset: NO_DATASET })
        return r?.chains[0]?.verdict
    }

    it('upgrades the ancestor when its parent already admits the escape', async function () {
        expect(await walk({ v, a: { releases: { '1.0.0': { dependencies: { v: '1' } }, '1.5.0': {} } }, p: { releases: { '1.0.0': { dependencies: { a: '^1.0.0' } } } } }))
            .toEqual({ kind: 'upgrade', package: 'a', toAtLeast: '1.5.0', proof: { release: 'a@1.5.0', closureSize: 1 } })
    })

    it('climbs past a stuck ancestor to a parent release that drops it', async function () {
        expect(await walk({ v, a: { releases: { '1.0.0': { dependencies: { v: '1' } } } }, p: { releases: { '1.0.0': { dependencies: { a: '1' } }, '2.0.0': {} } } }))
            .toEqual({ kind: 'upgrade', package: 'p', toAtLeast: '2.0.0', proof: { release: 'p@2.0.0', closureSize: 1 } })
    })

    it('is direct when the vulnerable package is itself a root', async function () {
        expect(await walk({ v }, graph({ roots: [['v@1.0.0', 'prod']] }))).toEqual({ kind: 'direct' })
    })

    it.each([
        ['the ancestor is not on the registry', { v }, { kind: 'unknown', at: 'a', reason: 'no registry data for a (not on the npm registry)' }],
        ['the ancestor\'s next release cannot be proven', { v, a: { releases: { '1.0.0': {}, '2.0.0': { dependencies: { gone: '1' } } } } }, { kind: 'unknown', at: 'a', reason: 'a@2.0.0: gone: not on the npm registry' }],
        ['the parent is not on the registry', { v, a: { releases: { '1.0.0': {}, '2.0.0': {} } } }, { kind: 'unknown', at: 'p', reason: 'no registry data for p' }],
        ['the parent does not declare the child', { v, a: { releases: { '1.0.0': {}, '2.0.0': {} } }, p: { releases: { '1.0.0': {} } } }, { kind: 'unknown', at: 'p', reason: 'p@1.0.0 does not declare a in the registry' }],
        ['the parent requires the child from git', { v, a: { releases: { '1.0.0': {}, '2.0.0': {} } }, p: { releases: { '1.0.0': { dependencies: { a: 'github:x/a' } } } } }, { kind: 'unknown', at: 'p', reason: 'p requires a as github:x/a, which is not a registry range' }],
        ['the parent requires the child by a dist-tag', { v, a: { releases: { '1.0.0': {}, '2.0.0': {} } }, p: { releases: { '1.0.0': { dependencies: { a: 'next' } } } } }, { kind: 'unknown', at: 'p', reason: 'p requires a as next, a dist-tag, not a version range' }],
        ['the parent\'s next release cannot be proven', { v, a: { releases: { '1.0.0': {}, '2.0.0': {} } }, p: { releases: { '1.0.0': { dependencies: { a: '1.0.0' } }, '2.0.0': { dependencies: { gone: '1' } } } } }, { kind: 'unknown', at: 'p', reason: 'p@2.0.0: gone: not on the npm registry' }]
    ] as const)('is unknown when %s', async function (_label, table, expected) {
        expect(await walk(table as unknown as Record<string, FakePackage>)).toEqual(expected)
    })

    it('is unknown when an installed version is not a release', async function () {
        expect(await walk({ v, a: { releases: { '1.0.0': {} } } }, graph({ roots: [['p@1.0.0', 'prod']], edges: ['p@1.0.0 > a@abc', 'a@abc > v@1.0.0'] })))
            .toEqual({ kind: 'unknown', at: 'a', reason: 'installed a@abc is not a release version' })
    })

    it.each([['optionalDependencies'], ['peerDependencies']] as const)('reads the parent\'s range from %s too', async function (field) {
        expect(await walk({ v, a: { releases: { '1.0.0': { dependencies: { v: '1' } }, '1.5.0': {} } }, p: { releases: { '1.0.0': { [field]: { a: '^1.0.0' } } } } }))
            .toMatchObject({ kind: 'upgrade', package: 'a', toAtLeast: '1.5.0' })
    })

    // Issue 018: the parent admits the escape by its effective range — optionalDependencies over dependencies.
    it('judges admission by the range npm honours when the parent declares the child twice', async function () {
        const a: FakePackage = { releases: { '1.0.0': { dependencies: { v: '1' } }, '2.0.0': {} } }
        // The overridden dependencies range admits a@2; the effective optional pin does not.
        expect(await walk({ v, a, p: { releases: { '1.0.0': { dependencies: { a: '^2.0.0' }, optionalDependencies: { a: '1.0.0' } } } } }))
            .toMatchObject({ kind: 'blocked', escapePackage: 'a', escapeVersion: '2.0.0', blockedBy: 'p', blockedRange: '1.0.0' })
        // Reversed: the effective optional range admits a@2.
        expect(await walk({ v, a, p: { releases: { '1.0.0': { dependencies: { a: '1.0.0' }, optionalDependencies: { a: '^2.0.0' } } } } }))
            .toMatchObject({ kind: 'upgrade', package: 'a', toAtLeast: '2.0.0' })
    })

    it('admits by an exact version the parent pins', async function () {
        expect(await walk({ v, a: { releases: { '1.0.0': { dependencies: { v: '1' } }, '1.5.0': {} } }, p: { releases: { '1.0.0': { dependencies: { a: '=v1.5.0' } } } } }))
            .toMatchObject({ kind: 'upgrade', package: 'a', toAtLeast: '1.5.0' })
    })

    // Issue 032: npm reads `>=3.0.0 || insiders` loosely, as `>=3.0.0` — tailwindcss-animate@1.0.7 declares it,
    // and chattonic-homepage, gestor-waba and risen reach braces through it. The parent admits tailwindcss@4.
    it('admits by a range npm reads loosely (tailwindcss-animate → tailwindcss@>=3.0.0 || insiders)', async function () {
        const chain = graph({ roots: [['tailwindcss-animate@1.0.7', 'prod']], edges: ['tailwindcss-animate@1.0.7 > tailwindcss@3.0.0', 'tailwindcss@3.0.0 > v@1.0.0'] })
        expect(await walk({
            v,
            tailwindcss: { releases: { '3.0.0': { dependencies: { v: '1.0.0' } }, '4.0.0': {} } },
            'tailwindcss-animate': { releases: { '1.0.7': { peerDependencies: { tailwindcss: '>=3.0.0 || insiders' } } } }
        }, chain)).toEqual({ kind: 'upgrade', package: 'tailwindcss', toAtLeast: '4.0.0', proof: { release: 'tailwindcss@4.0.0', closureSize: 1 } })
    })

    it('follows an aliased declaration', async function () {
        expect(await walk({ v, a: { releases: { '1.0.0': { dependencies: { v: '1' } }, '1.5.0': {} } }, p: { releases: { '1.0.0': { dependencies: { a: 'npm:a@^1.0.0' } } } } }))
            .toMatchObject({ kind: 'upgrade', package: 'a', toAtLeast: '1.5.0' })
    })
})

describe('paths and dev-only, from the whole graph', function () {
    it('calls a finding dev-only only when no production root reaches it, and always shows a production path', function () {
        const roots: [string, LockRootKind][] = [['d1@1.0.0', 'dev'], ['d2@1.0.0', 'dev'], ['d3@1.0.0', 'dev'], ['d4@1.0.0', 'dev'], ['d5@1.0.0', 'dev'], ['d6@1.0.0', 'dev'], ['p@1.0.0', 'prod']]
        const edges = ['d1@1.0.0 > braces@3.0.3', 'd2@1.0.0 > braces@3.0.3', 'd3@1.0.0 > braces@3.0.3', 'd4@1.0.0 > braces@3.0.3', 'd5@1.0.0 > braces@3.0.3', 'd6@1.0.0 > braces@3.0.3', 'p@1.0.0 > q@1.0.0', 'q@1.0.0 > braces@3.0.3']
        const found = findChains(graph({ roots, edges }), 'braces', ['3.0.3'])
        expect(found.devOnly).toBe(false)
        expect(found.chains.map(function p(c) { return c.root.kind + ':' + c.nodes.map(function n(x) { return x.name }).join('>') })).toEqual([
            'dev:d1>braces', 'dev:d2>braces', 'dev:d3>braces', 'dev:d4>braces', 'prod:p>q>braces'
        ])
        expect(found.more).toBe(2)
        expect(findChains(graph({ roots: roots.slice(0, 6), edges }), 'braces', ['3.0.3']).devOnly).toBe(true)
    })

    it('keeps importers apart, and counts an optional root as production', function () {
        const found = findChains(graph({ roots: [['a@1.0.0', 'dev', 'packages/web'], ['a@1.0.0', 'optional', 'packages/api']], edges: ['a@1.0.0 > braces@3.0.3'] }), 'braces', ['3.0.3'])
        expect(found.chains.map(function i(c) { return c.root.importer + ':' + c.root.kind })).toEqual(['packages/api:optional', 'packages/web:dev'])
        expect(found.devOnly).toBe(false)
    })

    it('reaches only the installed copy the advisory names: a nested vulnerable copy under a hoisted safe one', function () {
        const g: NodeGraph = {
            nodes: [
                { id: 'node_modules/app', name: 'app', version: '1.0.0' },
                { id: 'node_modules/braces', name: 'braces', version: '3.0.4' },
                { id: 'node_modules/chokidar', name: 'chokidar', version: '3.6.0' },
                { id: 'node_modules/chokidar/node_modules/braces', name: 'braces', version: '3.0.3' }
            ],
            edges: [
                { from: 'node_modules/app', to: 'node_modules/braces', kind: 'prod' },
                { from: 'node_modules/chokidar', to: 'node_modules/chokidar/node_modules/braces', kind: 'prod' }
            ],
            roots: [{ importer: '.', nodeId: 'node_modules/app', kind: 'prod' }, { importer: '.', nodeId: 'node_modules/chokidar', kind: 'dev' }]
        }
        const found = findChains(g, 'braces', ['3.0.3'])
        expect(found.chains.map(function p(c) { return c.nodes.map(function n(x) { return x.name + '@' + x.version }).join('>') })).toEqual(['chokidar@3.6.0>braces@3.0.3'])
        expect(found.devOnly).toBe(true)
    })

    it('shows peer variants of one path once, ignores a repeated edge, and is cycle-safe', function () {
        const found = findChains(graph({
            roots: [['r@1.0.0', 'prod']],
            edges: ['r@1.0.0 > a@1.0.0(x@1)', 'r@1.0.0 > a@1.0.0(x@2)', 'r@1.0.0 > a@1.0.0(x@2)', 'r@1.0.0 > b@1.0.0', 'b@1.0.0 > a@1.0.0(x@2)', 'a@1.0.0(x@1) > braces@3.0.3', 'a@1.0.0(x@2) > braces@3.0.3', 'braces@3.0.3 > r@1.0.0']
        }), 'braces', ['3.0.3'])
        // Both variants are shown by the one displayed path; the longer path through b is a path of its own.
        expect(found.chains.map(function p(c) { return c.nodes.map(function n(x) { return x.name }).join('>') })).toEqual(['r>a>braces', 'r>b>a>braces'])
        expect(found.more).toBe(0)
        expect(found.moreAtLeast).toBe(false)
    })

    // Issue 016: every simple path counts, not only the shortest ones per root.
    it('shows a longer path from the same root after the shorter one, and counts longer paths it does not show', function () {
        const unequal = findChains(graph({ roots: [['root@1.0.0', 'prod']], edges: ['root@1.0.0 > braces@3.0.3', 'root@1.0.0 > a@1.0.0', 'a@1.0.0 > b@1.0.0', 'b@1.0.0 > braces@3.0.3'] }), 'braces', ['3.0.3'])
        expect(unequal.chains.map(function p(c) { return c.nodes.map(function n(x) { return x.name }).join('>') })).toEqual(['root>braces', 'root>a>b>braces'])
        expect(unequal.more).toBe(0)
        // Six paths: one short, five through a diamond ladder; five shown, the longest left over and counted.
        const ladder = findChains(graph({
            roots: [['r@1.0.0', 'prod']],
            edges: ['r@1.0.0 > braces@3.0.3', 'r@1.0.0 > x1@1.0.0', 'r@1.0.0 > y1@1.0.0', 'x1@1.0.0 > m@1.0.0', 'y1@1.0.0 > m@1.0.0', 'm@1.0.0 > x2@1.0.0', 'm@1.0.0 > y2@1.0.0', 'm@1.0.0 > z@1.0.0', 'z@1.0.0 > w@1.0.0', 'x2@1.0.0 > braces@3.0.3', 'y2@1.0.0 > braces@3.0.3', 'w@1.0.0 > braces@3.0.3']
        }), 'braces', ['3.0.3'])
        const lengths = ladder.chains.map(function len(c) { return c.nodes.length })
        expect(lengths).toEqual([...lengths].sort(function asc(a, b) { return a - b }))
        expect(lengths[0]).toBe(2)
        expect(ladder.chains).toHaveLength(5)
        expect(ladder.more).toBe(2)
        expect(ladder.moreAtLeast).toBe(false)
    })

    it('counts the simple paths through a cycle one by one, exactly when they fit the cap', function () {
        // a and b depend on each other, and both reach braces: r>a>braces, r>a>b>braces, r>b>braces, r>b>a>braces.
        const found = findChains(graph({
            roots: [['r@1.0.0', 'prod']],
            edges: ['r@1.0.0 > a@1.0.0', 'r@1.0.0 > b@1.0.0', 'a@1.0.0 > b@1.0.0', 'b@1.0.0 > a@1.0.0', 'a@1.0.0 > braces@3.0.3', 'b@1.0.0 > braces@3.0.3']
        }), 'braces', ['3.0.3'])
        expect(found.chains.map(function p(c) { return c.nodes.map(function n(x) { return x.name }).join('>') })).toEqual(['r>a>braces', 'r>b>braces', 'r>a>b>braces', 'r>b>a>braces'])
        expect(found.more).toBe(0)
        expect(found.moreAtLeast).toBe(false)
    })

    it('counts past a dependency that leads nowhere near the target', function () {
        const found = findChains(graph({ roots: [['r@1.0.0', 'prod']], edges: ['r@1.0.0 > a@1.0.0', 'a@1.0.0 > x@1.0.0', 'a@1.0.0 > braces@3.0.3', 'r@1.0.0 > b@1.0.0', 'b@1.0.0 > braces@3.0.3'] }), 'braces', ['3.0.3'])
        expect(found.chains).toHaveLength(2)
        expect(found.more).toBe(0)
    })

    it('stops at the expansion cap, and then calls the remainder a lower bound', function () {
        const edges = ['r@1.0.0 > a@1.0.0', 'r@1.0.0 > b@1.0.0', 'a@1.0.0 > b@1.0.0', 'b@1.0.0 > a@1.0.0', 'a@1.0.0 > braces@3.0.3', 'b@1.0.0 > braces@3.0.3']
        const found = findChains(graph({ roots: [['r@1.0.0', 'prod']], edges }), 'braces', ['3.0.3'], { paths: 10_000, expansions: 3 })
        expect(found.chains.length).toBeGreaterThan(0)
        expect(found.moreAtLeast).toBe(true)
    })

    it('says "at least" when a cycle makes the paths too many to count', function () {
        // A 16-rung ladder of cycles between two columns: 2^16+ simple paths, past the enumeration cap.
        const edges: string[] = ['r@1.0.0 > a0@1.0.0', 'r@1.0.0 > b0@1.0.0']
        for (let i = 0; i < 16; i++) edges.push(`a${i}@1.0.0 > a${i + 1}@1.0.0`, `a${i}@1.0.0 > b${i + 1}@1.0.0`, `b${i}@1.0.0 > a${i + 1}@1.0.0`, `b${i}@1.0.0 > b${i + 1}@1.0.0`, `a${i}@1.0.0 > b${i}@1.0.0`, `b${i}@1.0.0 > a${i}@1.0.0`)
        edges.push('a16@1.0.0 > braces@3.0.3', 'b16@1.0.0 > braces@3.0.3')
        const found = findChains(graph({ roots: [['r@1.0.0', 'prod']], edges }), 'braces', ['3.0.3'])
        expect(found.chains).toHaveLength(5)
        expect(found.moreAtLeast).toBe(true)
        expect(found.more).toBeGreaterThan(0)
    })

    it('has no paths and no dev-only answer when nothing in the graph is the installed copy, or nothing reaches it', function () {
        expect(findChains(graph({ roots: [['a@1.0.0', 'prod']] }), 'braces', ['3.0.3'])).toEqual({ chains: [], more: 0, moreAtLeast: false, devOnly: null })
        expect(findChains(graph({ roots: [['a@1.0.0', 'prod']], edges: ['x@1.0.0 > braces@3.0.3'] }), 'braces', ['3.0.3'])).toEqual({ chains: [], more: 0, moreAtLeast: false, devOnly: null })
    })

    it('says the paths are unknown without a lockfile graph, or without a path to the copy', async function () {
        const none = await remediate({ braces: BRACES }, null, { dataset: NO_DATASET })
        expect(none.chains).toEqual([{ importer: null, rootKind: null, path: [], verdict: { kind: 'unknown', at: 'braces', reason: 'no lockfile dependency graph' } }])
        expect(none.devOnly).toBeNull()
        const orphan = await remediate({ braces: BRACES }, graph({ roots: [['a@1.0.0', 'prod']] }), { dataset: NO_DATASET })
        expect(orphan.chains[0]?.verdict).toEqual({ kind: 'unknown', at: 'braces', reason: 'no dependency path to the installed copy found in the lockfile' })
    })
})

describe('health', function () {
    it.each([
        [182, false],
        [183, true]
    ])('is unmaintained at %i days only from 183 on', async function (days, unmaintained) {
        const pkg: FakePackage = { releases: { '3.0.3': { publishedAt: CHECKED_AT - days * DAY } } }
        const r = await remediate({ braces: pkg }, graph({ roots: [['braces@3.0.3', 'prod']] }), { dataset: NO_DATASET })
        expect(r.health).toMatchObject({ daysSinceLastPublish: days, unmaintained })
        // A direct dependency is always offered its replacements, unmaintained or not.
        expect(r.alternatives[0]?.reason).toBe(unmaintained ? 'unmaintained' : 'direct')
    })

    it('counts a deprecation notice on the installed version, or on latest, even for a fresh release', async function () {
        const installed: FakePackage = { releases: { '3.0.3': { publishedAt: CHECKED_AT - DAY, deprecated: 'gone' } } }
        expect((await remediate({ braces: installed }, null, { dataset: NO_DATASET })).health).toMatchObject({ deprecated: 'gone', unmaintained: true })
        const latest: FakePackage = { latest: '3.0.4', releases: { '3.0.3': { publishedAt: CHECKED_AT - DAY }, '3.0.4': { publishedAt: CHECKED_AT - DAY, deprecated: 'moved' } } }
        expect((await remediate({ braces: latest }, null, { dataset: NO_DATASET })).health).toMatchObject({ deprecated: 'moved', unmaintained: true })
        const neither: FakePackage = { latest: '9.9.9', releases: { '3.0.3': { publishedAt: CHECKED_AT - DAY } } }
        expect((await remediate({ braces: neither }, null, { dataset: NO_DATASET })).health).toMatchObject({ deprecated: null, unmaintained: false })
        const untagged: FakePackage = { latest: null, releases: { '3.0.3': { publishedAt: CHECKED_AT - DAY } } }
        expect((await remediate({ braces: untagged }, null, { dataset: NO_DATASET })).health).toMatchObject({ latest: null, deprecated: null, unmaintained: false })
    })

    it('says nothing it does not know when the registry has no data for the package', async function () {
        const r = await remediate({}, null, { dataset: NO_DATASET })
        expect(r.health).toEqual({ name: 'braces', latest: null, lastPublishAt: null, maintainers: 0, weeklyDownloads: null, deprecated: null, daysSinceLastPublish: null, unmaintained: false })
    })
})

describe('alternatives from the dataset', function () {
    const dataset: ReplacementDataset = function curated(name) {
        if (name !== 'braces') return null
        return {
            replaces: 'braces', url: null, replacements: [
                { kind: 'module', name: 'clean' },
                { kind: 'module', name: 'dirty' },
                { kind: 'module', name: 'unprovable' },
                { kind: 'module', name: 'unpublished' },
                { kind: 'module', name: 'untagged' },
                { kind: 'snippet', id: 's', description: 'inline it', url: null },
                { kind: 'removal', description: 'drop it', url: 'https://e18e.dev/x' }
            ]
        }
    }

    it('offers a proven module, lists an unprovable one as not verified, and leaves out one that reaches the target', async function () {
        const r = await remediate({
            braces: BRACES,
            clean: { releases: { '1.0.0': {} } },
            dirty: { releases: { '1.0.0': { dependencies: { braces: '3.0.3' } } } },
            unprovable: { releases: { '1.0.0': { dependencies: { gone: '1' } } } },
            untagged: { latest: null, releases: { '1.0.0': {} } }
        }, graph({ roots: [['braces@3.0.3', 'prod']] }), { dataset })
        expect(r.alternatives).toHaveLength(1)
        expect(r.alternatives[0]?.options.map(function o(x) { return x.kind === 'module' ? x.name + ':' + String(x.verified) : x.kind })).toEqual([
            'clean:true', 'unprovable:false', 'unpublished:false', 'untagged:false', 'snippet', 'removal'
        ])
        expect(r.alternatives[0]?.options[2]).toEqual({ kind: 'module', name: 'unpublished', version: null, verified: false, proof: null, signals: null })
    })
})

// The way out used to stop after 60 registry lookups per project scan and mark itself partial. There is no
// cap now: a candidate release with a wide dependency tree, and an alternative with one, are both proven.
describe('no lookup cap', function () {
    function wideTree(name: string, release: FakeRelease): Record<string, FakePackage> {
        const table: Record<string, FakePackage> = { braces: BRACES, [name]: { releases: { '1.0.0': release } } }
        for (let i = 0; i < 70; i++) table['d' + i] = { releases: { '1.0.0': {} } }
        return table
    }
    const SEVENTY = Object.fromEntries(Array.from({ length: 70 }, function dep(_x, i) { return ['d' + i, '1.0.0'] }))

    it('proves an upgrade whose release brings in 70 packages', async function () {
        const table = wideTree('p', { dependencies: { braces: '3.0.3' } })
        table.p = { releases: { ...table.p?.releases, '2.0.0': { dependencies: SEVENTY } } }
        const r = await remediate(table, graph({ roots: [['p@1.0.0', 'prod']], edges: ['p@1.0.0 > braces@3.0.3'] }), { dataset: NO_DATASET })
        expect(r.chains[0]?.verdict).toMatchObject({ kind: 'upgrade', package: 'p', toAtLeast: '2.0.0', proof: { release: 'p@2.0.0', closureSize: 71 } })
    })

    it('verifies an alternative whose closure is 70 packages wide', async function () {
        const table = wideTree('wide', { dependencies: SEVENTY })
        const dataset: ReplacementDataset = function curated(name) { return name === 'braces' ? { replaces: 'braces', url: null, replacements: [{ kind: 'module', name: 'wide' }] } : null }
        const r = await remediate(table, graph({ roots: [['braces@3.0.3', 'prod']] }), { dataset })
        expect(r.alternatives[0]?.options[0]).toMatchObject({ kind: 'module', name: 'wide', verified: true, proof: { release: 'wide@1.0.0', closureSize: 71 } })
    })
})
