import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import type { AffectedSet } from '@sentinello/scanners'
import { createClosureWalker, edgesOf, resolveRange, targetIdentity, unalias, type ProofTarget } from './closure'
import { fakeRegistry, fakeSummary, type FakePackage } from './registry-fake.fixture'

// The transitive proof is what every "upgrade X" and every offered alternative rests on: a wrong 'no' sends
// the reader to a release that still installs the vulnerable package. So the cases here are the ways a
// direct-dependency check would be fooled — a helper in between, an optional or peer edge, a cycle — and
// the ways evidence can run out, which must read 'unknown', never 'no'.

function affected(ranges: string): AffectedSet {
    return { ranges, exact: [], complete: true }
}

const BRACES: ProofTarget = { name: 'braces', affected: [affected('<=3.0.3')] }
function deps(prefix: string, count: number): Record<string, string> {
    return Object.fromEntries(Array.from({ length: count }, function dep(_x, i) { return [prefix + i, '1.0.0'] }))
}

const FORGE: ProofTarget = { name: 'node-forge', affected: [affected('<=1.4.0')] }

type Packument = { name: string; 'dist-tags': Record<string, string>; versions: Record<string, { version: string; deprecated?: string }> }
const pickManifest = createRequire(import.meta.url)('npm-pick-manifest') as (packument: Packument, wanted: string) => { version: string }

// The version npm installs for `spec`, null where it refuses the specifier or finds nothing.
function npmPick(packument: Packument, spec: string): string | null {
    try {
        return pickManifest(packument, spec).version
    } catch {
        return null
    }
}

function walker(table: Record<string, FakePackage>, unavailable: string[] = []) {
    const registry = fakeRegistry(table, { unavailable })
    return { registry, walker: createClosureWalker(registry) }
}

describe('reaches — the closure, not the direct dependencies', function () {
    it('finds the target through a helper the release does not name directly (a candidate rejected)', async function () {
        const { walker: w } = walker({
            candidate: { releases: { '1.0.0': { dependencies: { helper: '^1.0.0' } } } },
            helper: { releases: { '1.0.0': {}, '1.2.0': { dependencies: { braces: '^3.0.0' } } } },
            braces: { releases: { '3.0.3': {} } }
        })
        expect(await w.reaches('candidate', '1.0.0', BRACES)).toEqual({ verdict: 'yes', closureSize: 3, reason: null })
    })

    it('rejects an escape that holds only without its optional dependency or its peer', async function () {
        const { walker: w } = walker({
            viaOptional: { releases: { '2.0.0': { optionalDependencies: { braces: '3.0.3' } } } },
            viaPeer: { releases: { '2.0.0': { peerDependencies: { braces: '>=3' } } } },
            braces: { releases: { '3.0.3': {} } }
        })
        expect((await w.reaches('viaOptional', '2.0.0', BRACES)).verdict).toBe('yes')
        expect((await w.reaches('viaPeer', '2.0.0', BRACES)).verdict).toBe('yes')
    })

    // Issue 018: npm installs one edge per name — optionalDependencies over dependencies over peerDependencies.
    it('follows only the effective range when a name is declared in more than one field', async function () {
        const helper: FakePackage = { releases: { '1.0.0': { dependencies: { braces: '3.0.3' } }, '2.0.0': {} } }
        const { walker: w } = walker({
            optionalWins: { releases: { '1.0.0': { dependencies: { helper: '1.0.0' }, optionalDependencies: { helper: '2.0.0' } } } },
            optionalReaches: { releases: { '1.0.0': { dependencies: { helper: '2.0.0' }, optionalDependencies: { helper: '1.0.0' } } } },
            dependencyWinsOverPeer: { releases: { '1.0.0': { peerDependencies: { helper: '1.0.0' }, dependencies: { helper: '2.0.0' } } } },
            helper,
            braces: { releases: { '3.0.3': {} } }
        })
        expect(await w.reaches('optionalWins', '1.0.0', BRACES)).toEqual({ verdict: 'no', closureSize: 2, reason: null })
        expect((await w.reaches('optionalReaches', '1.0.0', BRACES)).verdict).toBe('yes')
        expect((await w.reaches('dependencyWinsOverPeer', '1.0.0', BRACES)).verdict).toBe('no')
    })

    it('resolves a range latest is outside of to the highest release in it, and proves a clean closure', async function () {
        const { walker: w } = walker({
            chokidar: { releases: { '4.0.0': { dependencies: { readdirp: '^4.0.1' } } } },
            readdirp: { releases: { '4.0.1': {}, '4.1.2': {}, '5.0.0': { dependencies: { braces: '3.0.3' } } } },
            braces: { releases: { '3.0.3': {} } }
        })
        expect(await w.reaches('chokidar', '4.0.0', BRACES)).toEqual({ verdict: 'no', closureSize: 2, reason: null })
        expect((await w.closureOf('chokidar', '4.0.0')).nodes).toEqual(['chokidar@4.0.0', 'readdirp@4.1.2'])
    })

    it('is cycle-safe', async function () {
        const { walker: w } = walker({
            a: { releases: { '1.0.0': { dependencies: { b: '1.0.0' } } } },
            b: { releases: { '1.0.0': { dependencies: { a: '1.0.0', c: '1.0.0' } } } },
            c: { releases: { '1.0.0': { dependencies: { b: '1.0.0' } } } }
        })
        const closure = await w.closureOf('a', '1.0.0')
        expect(closure.nodes.sort()).toEqual(['a@1.0.0', 'b@1.0.0', 'c@1.0.0'])
        expect(closure.complete).toBe(true)
        expect((await w.reaches('a', '1.0.0', BRACES)).verdict).toBe('no')
    })

    it('follows an npm: alias to the real package', async function () {
        const { walker: w } = walker({
            a: { releases: { '1.0.0': { dependencies: { 'braces-alias': 'npm:braces@^3.0.0' } } } },
            braces: { releases: { '3.0.3': {} } }
        })
        expect((await w.reaches('a', '1.0.0', BRACES)).verdict).toBe('yes')
    })
})

describe('reaches — when the evidence runs out it is unknown, never no', function () {
    it.each([
        ['a dependency not on the registry', { a: { releases: { '1.0.0': { dependencies: { gone: '^1.0.0' } } } } }, 'gone: not on the npm registry'],
        ['a range no release satisfies', { a: { releases: { '1.0.0': { dependencies: { b: '^9.0.0' } } } }, b: { releases: { '1.0.0': {} } } }, 'b@^9.0.0 matches no published release'],
        ['a git dependency', { a: { releases: { '1.0.0': { dependencies: { b: 'github:x/b' } } } }, b: { releases: { '1.0.0': {} } } }, 'b@github:x/b matches no published release']
    ])('%s', async function (_label, table, reason) {
        const { walker: w } = walker(table as Record<string, FakePackage>)
        expect(await w.reaches('a', '1.0.0', BRACES)).toMatchObject({ verdict: 'unknown', reason })
    })

    it('a release that is not published, and a package the registry does not answer for', async function () {
        const { walker: w } = walker({ a: { releases: { '1.0.0': {} } } }, ['down'])
        expect(await w.reaches('a', '2.0.0', BRACES)).toMatchObject({ verdict: 'unknown', reason: 'a@2.0.0 is not a published release' })
        expect(await w.reaches('down', '1.0.0', BRACES)).toMatchObject({ verdict: 'unknown', reason: 'down: HTTP 503' })
    })

    it('a lookup that does not answer for a package', async function () {
        const silent = createClosureWalker({ lookup: async function none() { return new Map() }, weeklyDownloads: async function none() { return new Map() } })
        expect(await silent.reaches('a', '1.0.0', BRACES)).toMatchObject({ verdict: 'unknown', reason: 'a: no registry answer' })
    })

    it('the target itself unresolvable', async function () {
        const { walker: w } = walker({ a: { releases: { '1.0.0': { dependencies: { braces: '^9.0.0' } } } }, braces: { releases: { '3.0.3': {} } } })
        expect(await w.reaches('a', '1.0.0', BRACES)).toMatchObject({ verdict: 'unknown', reason: "braces's version in the closure could not be resolved" })
    })

    it('an affected set that cannot be evaluated', async function () {
        const { walker: w } = walker({ a: { releases: { '1.0.0': { dependencies: { braces: '3.0.3' } } } }, braces: { releases: { '3.0.3': {} } } })
        const broken: ProofTarget = { name: 'braces', affected: [{ ranges: '<=3.0.3', exact: [], complete: false }] }
        expect(await w.reaches('a', '1.0.0', broken)).toMatchObject({ verdict: 'unknown', reason: 'the affected range could not be evaluated' })
    })

    it('yes even in an incomplete closure, once the target is found', async function () {
        const { walker: w } = walker({ a: { releases: { '1.0.0': { dependencies: { braces: '3.0.3', gone: '1' } } } }, braces: { releases: { '3.0.3': {} } } })
        expect((await w.reaches('a', '1.0.0', BRACES)).verdict).toBe('yes')
    })

    // There is no lookup cap (the old one was 60 packages per project scan): a closure far wider than that
    // is walked to its end and settles 'no', reading every package once.
    it('a closure of 150 packages, three levels deep, is walked to the end', async function () {
        const table: Record<string, FakePackage> = { a: { releases: { '1.0.0': { dependencies: deps('m', 50) } } } }
        for (let i = 0; i < 50; i++) table['m' + i] = { releases: { '1.0.0': { dependencies: { ['n' + i]: '1.0.0', ['o' + i]: '1.0.0' } } } }
        for (let i = 0; i < 50; i++) {
            table['n' + i] = { releases: { '1.0.0': {} } }
            table['o' + i] = { releases: { '1.0.0': {} } }
        }
        const { registry, walker: w } = walker(table)
        expect(await w.reaches('a', '1.0.0', BRACES)).toEqual({ verdict: 'no', closureSize: 151, reason: null })
        expect(registry.lookups).toHaveLength(151)
        expect(new Set(registry.lookups).size).toBe(151)
    })
})

// A dependency range only a prerelease satisfies resolves the way npm resolves it. Before prereleases were
// kept, every jest chain on the scratch fleet read "gensync@^1.0.0-beta.2 matches no published release".
describe('prereleases in the closure', function () {
    const table: Record<string, FakePackage> = {
        jest: { releases: { '30.0.0': { dependencies: { gensync: '^1.0.0-beta.2' } } } },
        gensync: { latest: '1.0.0-beta.2', releases: {}, prereleases: { '1.0.0-beta.1': {}, '1.0.0-beta.2': { dependencies: { braces: '^3.0.0' } } } },
        braces: { releases: { '3.0.3': {}, '3.0.4': {} }, prereleases: { '3.1.0-rc.1': {} } },
        plain: { releases: { '1.0.0': { dependencies: { gensync: '^1.0.0' } } } }
    }

    it('walks through a prerelease a range names, to the vulnerable package behind it', async function () {
        const { walker: w } = walker(table)
        expect(await w.reaches('jest', '30.0.0', BRACES)).toEqual({ verdict: 'no', closureSize: 3, reason: null })
        expect((await w.closureOf('jest', '30.0.0')).nodes.sort()).toEqual(['braces@3.0.4', 'gensync@1.0.0-beta.2', 'jest@30.0.0'])
    })

    it('never resolves an ordinary range to a prerelease', function () {
        expect(resolveRange(fakeSummary('braces', table.braces as FakePackage), '^3.0.0')).toBe('3.0.4')
        expect(resolveRange(fakeSummary('gensync', table.gensync as FakePackage), '^1.0.0')).toBeNull()
    })

    it('says a range nothing satisfies when only a prerelease of another version exists', async function () {
        const { walker: w } = walker(table)
        expect(await w.reaches('plain', '1.0.0', BRACES)).toMatchObject({ verdict: 'unknown', reason: 'gensync@^1.0.0 matches no published release' })
    })

    it('reads a prerelease release walk: its own edges, and none for an unknown version', async function () {
        const { walker: w } = walker(table)
        expect((await w.closureOf('gensync', '1.0.0-beta.2')).nodes.sort()).toEqual(['braces@3.0.4', 'gensync@1.0.0-beta.2'])
        expect((await w.closureOf('gensync', '1.0.0-beta.1')).nodes).toEqual(['gensync@1.0.0-beta.1'])
        expect(await w.closureOf('gensync', '1.0.0-beta.9')).toMatchObject({ complete: false, reason: 'gensync@1.0.0-beta.9 is not a published release' })
    })
})

// Noah's counterexample (issue 001): a verdict is about one target and one affected-evidence identity.
describe('regression: two targets, both orders', function () {
    const table: Record<string, FakePackage> = {
        candidate: { releases: { '2.0.0': { dependencies: { 'node-forge': '1.4.0' } } } },
        'node-forge': { releases: { '1.4.0': {} } }
    }

    it('braces then node-forge', async function () {
        const { walker: w } = walker(table)
        expect((await w.reaches('candidate', '2.0.0', BRACES)).verdict).toBe('no')
        expect((await w.reaches('candidate', '2.0.0', FORGE)).verdict).toBe('yes')
    })

    it('node-forge then braces', async function () {
        const { walker: w } = walker(table)
        expect((await w.reaches('candidate', '2.0.0', FORGE)).verdict).toBe('yes')
        expect((await w.reaches('candidate', '2.0.0', BRACES)).verdict).toBe('no')
    })

    it('two braces advisories with different affected sets each get their own answer', async function () {
        const { walker: w } = walker({ candidate: { releases: { '2.0.0': { dependencies: { braces: '3.0.3' } } } }, braces: { releases: { '3.0.3': {} } } })
        expect((await w.reaches('candidate', '2.0.0', { name: 'braces', affected: [affected('<3.0.0')] })).verdict).toBe('no')
        expect((await w.reaches('candidate', '2.0.0', BRACES)).verdict).toBe('yes')
        expect(targetIdentity({ name: 'braces', affected: [affected('<3.0.0')] })).not.toBe(targetIdentity(BRACES))
    })
})

describe('a yes stops the walk; a no needs all of it', function () {
    const table: Record<string, FakePackage> = {
        plugin: { releases: { '1.0.0': { dependencies: { glob: '1' }, peerDependencies: { lint: '1' } } } },
        glob: { releases: { '1.0.0': { dependencies: { braces: '3.0.3' } } } },
        braces: { releases: { '3.0.3': {} } },
        lint: { releases: { '1.0.0': { dependencies: { deep: '1' } } } },
        deep: { releases: { '1.0.0': { dependencies: { deeper: '1' } } } },
        deeper: { releases: { '1.0.0': {} } }
    }

    it('answers yes without fetching the unrelated tree past the level where the target appears', async function () {
        const { registry, walker: w } = walker(table)
        expect((await w.reaches('plugin', '1.0.0', BRACES)).verdict).toBe('yes')
        expect(registry.lookups).not.toContain('deeper')
        // The walk resumes where it stopped when the whole closure is needed.
        expect((await w.closureOf('plugin', '1.0.0')).nodes.sort()).toEqual(['braces@3.0.3', 'deep@1.0.0', 'deeper@1.0.0', 'glob@1.0.0', 'lint@1.0.0', 'plugin@1.0.0'])
        expect(registry.lookups.filter(function d(n) { return n === 'deep' })).toHaveLength(1)
    })

    it('shares a level in progress between concurrent questions', async function () {
        const { registry, walker: w } = walker(table)
        const [a, b] = await Promise.all([w.reaches('plugin', '1.0.0', BRACES), w.reaches('plugin', '1.0.0', FORGE)])
        expect(a.verdict).toBe('yes')
        expect(b.verdict).toBe('no')
        expect(new Set(registry.lookups).size).toBe(registry.lookups.length)
    })

    it('returns the root alone for a release it cannot read', async function () {
        const { walker: w } = walker({ a: { releases: { '1.0.0': {} } } })
        expect(await w.closureOf('a', '2.0.0')).toEqual({ nodes: ['a@2.0.0'], complete: false, reason: 'a@2.0.0 is not a published release', unresolved: [] })
    })
})

describe('memoization', function () {
    it('fetches each package once and shares the walk of identical dependency maps across releases', async function () {
        const { registry, walker: w } = walker({
            a: { releases: { '1.0.0': { dependencies: { b: '1' } }, '1.1.0': { dependencies: { b: '1' } } } },
            b: { releases: { '1.0.0': {} } }
        })
        await w.reaches('a', '1.0.0', BRACES)
        await w.reaches('a', '1.1.0', BRACES)
        await w.reaches('a', '1.1.0', BRACES)
        await w.closureOf('a', '1.1.0')
        expect(registry.lookups).toEqual(['a', 'b'])
        expect((await w.closureOf('a', '1.1.0')).nodes).toEqual(['a@1.1.0', 'b@1.0.0'])
    })
})

describe('helpers', function () {
    const summary = fakeSummary('p', { latest: '2.0.0', releases: { '1.0.0': {}, '1.5.0': {}, '2.0.0': {}, '3.0.0': {} } })

    // npm prefers the `latest` tag whenever the range accepts it (>=1 → 2.0.0, not 3.0.0); an exact version is
    // only itself; a dist-tag other than latest is not recorded; a git specifier is not a registry range.
    it.each([
        ['', '2.0.0'], ['*', '2.0.0'], ['latest', '2.0.0'], ['^1.0.0', '1.5.0'], ['>=1', '2.0.0'], ['>=2.5', '3.0.0'], ['^9', null],
        ['1.5.0', '1.5.0'], ['=v1.5.0', '1.5.0'], ['1.4.0', null], ['github:x/y', null], ['next', null], ['>=3.0.0 || insiders', '3.0.0']
    ])('resolves %j to %s', function (range, expected) {
        expect(resolveRange(summary, range)).toBe(expected)
    })

    it('falls back to the highest release when latest is not published, and has nothing for a missing latest tag', function () {
        expect(resolveRange({ ...summary, latest: '4.0.0-rc.1' }, '*')).toBe('3.0.0')
        expect(resolveRange({ ...summary, latest: null }, '*')).toBe('3.0.0')
        expect(resolveRange({ ...summary, latest: null }, 'latest')).toBeNull()
    })

    it('passes over deprecated releases while a non-deprecated one satisfies the range', function () {
        const deprecated = fakeSummary('p', { latest: '2.0.0', releases: { '1.0.0': {}, '1.5.0': { deprecated: 'broken' }, '2.0.0': { deprecated: 'broken' } } })
        expect(resolveRange(deprecated, '*')).toBe('1.0.0')
        expect(resolveRange(deprecated, '^1.0.0')).toBe('1.0.0')
        expect(resolveRange(deprecated, '>=1.5.0')).toBe('2.0.0')
        expect(resolveRange(deprecated, 'latest')).toBe('2.0.0')
    })

    it('answers nothing for "*" when there is no release at all, and skips a version key semver cannot read', function () {
        const empty = fakeSummary('p', { latest: null, releases: {}, prereleases: { '1.0.0-rc.1': {} } })
        expect(resolveRange(empty, '*')).toBeNull()
        expect(resolveRange(fakeSummary('p', { latest: null, releases: { junk: {}, '1.0.0': {} } }), '>=0')).toBe('1.0.0')
    })

    it('remembers an answer per summary and range', function () {
        const fresh = fakeSummary('p', { releases: { '1.0.0': {} } })
        expect(resolveRange(fresh, ' ^1 ')).toBe('1.0.0')
        delete (fresh.versions as Record<string, unknown>)['1.0.0']
        expect(resolveRange(fresh, '^1')).toBe('1.0.0')
    })

    // The parsed, sorted, memoized resolver must answer exactly what npm answers: npm-pick-manifest (the
    // version npm 11 bundles), given a packument holding the same versions, deprecations and latest tag. Swept
    // over a grammar cross-product of operators, bounds and prerelease tags — strict, loose (`>= 1.0.0`,
    // `v1.2`, `1.2.3beta`) and loose unions with a tag (`>=3.0.0 || insiders`) — against version lists
    // mixing releases and prereleases around each bound, under several `latest` tags and deprecations.
    // Thousands of oracle comparisons: about a second alone, past 5 s once under the coverage run
    // (5.6 s, M4), so it carries its own timeout rather than the default.
    it('agrees with npm-pick-manifest over a generated sweep of specifiers', function () {
        const releases = ['0.9.0', '1.0.0', '1.0.1', '1.2.0', '1.2.3', '2.0.0', '2.1.0', '3.0.0']
        const prereleases = ['1.0.0-alpha', '1.0.0-beta.2', '1.2.3-rc.1', '2.0.0-0', '2.1.0-beta', '3.1.0-canary.4', '4.0.0-rc.1']
        const bounds = ['1.0.0', '1.2.3', '2.0.0', '1.0.0-beta.2', '1.2.3-rc.0', '2.0.0-0', '3.1.0-canary.1', '4.0.0-rc.1', '1', '1.2', '2.x', 'v1.2', '1.2.3beta', '=2.0.0']
        const operators = ['', '^', '~', '>=', '>', '<', '<=', '=', '>= ', '~ ']
        const specs = ['', '*', 'x', 'latest', 'next', 'insiders', 'github:x/y', 'file:../p', 'https://example.com/p.tgz', ' ^1 ']
        for (const op of operators) for (const bound of bounds) specs.push(op + bound, op + bound + ' || insiders')
        for (const lo of bounds) for (const hi of bounds) specs.push('>=' + lo + ' <' + hi, lo + ' - ' + hi, '^' + lo + ' || ~' + hi)
        const scenarios: { latest: string | null; deprecated: string[] }[] = [
            { latest: '3.0.0', deprecated: [] },
            { latest: '2.0.0', deprecated: [] },
            { latest: '4.0.0-rc.1', deprecated: [] },
            { latest: null, deprecated: [] },
            { latest: '2.1.0', deprecated: ['2.1.0', '1.2.3', '3.0.0'] }
        ]
        let checked = 0
        let resolvedByNpm = 0
        for (const scenario of scenarios) {
            const table: FakePackage = {
                latest: scenario.latest,
                releases: Object.fromEntries(releases.map(function r(v) { return [v, scenario.deprecated.includes(v) ? { deprecated: 'do not use' } : {}] })),
                prereleases: Object.fromEntries(prereleases.map(function r(v) { return [v, {}] }))
            }
            const packument: Packument = {
                name: 'p',
                'dist-tags': scenario.latest === null ? {} : { latest: scenario.latest },
                versions: Object.fromEntries([...releases, ...prereleases].map(function m(v) { return [v, scenario.deprecated.includes(v) ? { version: v, deprecated: 'do not use' } : { version: v }] }))
            }
            const summary = fakeSummary('p', table)
            for (const spec of specs) {
                const expected = npmPick(packument, spec)
                expect([scenario.latest, spec, resolveRange(summary, spec)]).toEqual([scenario.latest, spec, expected])
                checked++
                if (expected !== null) resolvedByNpm++
            }
        }
        expect(checked).toBeGreaterThan(3000)
        expect(resolvedByNpm).toBeGreaterThan(1000)
    }, 30_000)

    it('unaliases npm: specifiers', function () {
        expect(unalias('x', '^1.0.0')).toEqual({ name: 'x', range: '^1.0.0' })
        expect(unalias('x', 'npm:@scope/real@^2.0.0')).toEqual({ name: '@scope/real', range: '^2.0.0' })
        expect(unalias('x', 'npm:real')).toEqual({ name: 'real', range: '*' })
    })

    it('reads no edges from an unknown release or a dangling edge index', function () {
        expect(edgesOf(summary, '9.9.9')).toEqual([])
        expect(edgesOf({ ...summary, versions: { '1.0.0': { publishedAt: null, deprecated: null, edges: 7 } } }, '1.0.0')).toEqual([])
    })
})
