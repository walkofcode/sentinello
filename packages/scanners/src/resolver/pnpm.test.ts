import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parsePnpmLock } from './pnpm'

// Two very different code paths behind one entry point. pnpm v9 dropped the per-package `dev:` flag, so
// prod/dev is only derivable by walking `importers` → `snapshots` by reachability; v6 and earlier carry
// the flag directly. Both are exercised, because a reachability bug in the v9 path would mis-scope every
// transitive dependency at once — and prod/dev scope is what the operator filters findings by.

let dir: string

beforeEach(async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-pnpm-'))
})

afterEach(async function cleanup() {
    await rm(dir, { recursive: true, force: true })
})

async function write(text: string): Promise<string> {
    const path = join(dir, 'pnpm-lock.yaml')
    await writeFile(path, text, 'utf8')
    return path
}

const V9 = `lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      express:
        version: 4.18.0
    devDependencies:
      vitest:
        version: 1.0.0

snapshots:
  express@4.18.0:
    dependencies:
      cookie: 0.5.0
  cookie@0.5.0: {}
  vitest@1.0.0:
    dependencies:
      chai: 4.0.0
  chai@4.0.0: {}
`

describe('parsePnpmLock failure handling', function () {
    it('returns null when the lockfile does not exist', async function () {
        expect(await parsePnpmLock(join(dir, 'nope.yaml'))).toBeNull()
    })

    it('returns null on malformed yaml', async function () {
        expect(await parsePnpmLock(await write('a:\n  - b\n : : :\n'))).toBeNull()
    })

    it.each(['null', '"a string"', '42'])('returns null for the non-object document %s', async function (raw) {
        expect(await parsePnpmLock(await write(raw))).toBeNull()
    })
})

describe('parsePnpmLock v9', function () {
    it('enumerates every package in the snapshots map', async function () {
        const graph = await parsePnpmLock(await write(V9))
        expect(graph?.packages.map(function name(p) { return p.name }).sort()).toEqual([
            'chai',
            'cookie',
            'express',
            'vitest'
        ])
    })

    it('marks a direct production dependency prod', async function () {
        const graph = await parsePnpmLock(await write(V9))
        expect(graph?.classify('express', '4.18.0')).toMatchObject({ isProd: true, isDev: false })
    })

    // The reachability walk is the whole point of the v9 path: cookie is only reachable through express.
    it('marks a transitive production dependency prod', async function () {
        const graph = await parsePnpmLock(await write(V9))
        expect(graph?.classify('cookie', '0.5.0')).toMatchObject({ isProd: true, isDev: false })
    })

    it('marks a direct dev dependency dev', async function () {
        const graph = await parsePnpmLock(await write(V9))
        expect(graph?.classify('vitest', '1.0.0')).toMatchObject({ isProd: false, isDev: true })
    })

    it('marks a transitive dev dependency dev', async function () {
        const graph = await parsePnpmLock(await write(V9))
        expect(graph?.classify('chai', '4.0.0')).toMatchObject({ isProd: false, isDev: true })
    })

    // A package reachable from both roots is genuinely both, and the flags are independent booleans.
    it('marks a package reachable from prod and dev roots as both', async function () {
        const text = `lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      a:
        version: 1.0.0
    devDependencies:
      b:
        version: 1.0.0

snapshots:
  a@1.0.0:
    dependencies:
      shared: 1.0.0
  b@1.0.0:
    dependencies:
      shared: 1.0.0
  shared@1.0.0: {}
`
        const graph = await parsePnpmLock(await write(text))
        expect(graph?.classify('shared', '1.0.0')).toMatchObject({ isProd: true, isDev: true })
    })

    it('treats optionalDependencies of an importer as production roots', async function () {
        const text = `lockfileVersion: '9.0'

importers:
  .:
    optionalDependencies:
      fsevents:
        version: 2.3.0

snapshots:
  fsevents@2.3.0: {}
`
        const graph = await parsePnpmLock(await write(text))
        expect(graph?.classify('fsevents', '2.3.0')).toMatchObject({ isProd: true })
    })

    it('marks a snapshot flagged optional as optional', async function () {
        const text = `lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      a:
        version: 1.0.0

snapshots:
  a@1.0.0:
    optional: true
`
        const graph = await parsePnpmLock(await write(text))
        expect(graph?.byName('a')[0]?.scope.isOptional).toBe(true)
    })

    // A `link:` value points at another workspace package, not a registry one; that workspace has its
    // own importer entry, so following the link would double count rather than discover anything.
    it('skips a link: workspace reference', async function () {
        const text = `lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      sibling:
        version: link:../sibling
      a:
        version: 1.0.0

snapshots:
  a@1.0.0: {}
`
        const graph = await parsePnpmLock(await write(text))
        expect(graph?.packages.map(function name(p) { return p.name })).toEqual(['a'])
    })

    // Peer variants key the same name@version several times; they are one installed package.
    it('collapses peer variants of one package into a single entry', async function () {
        const text = `lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      a:
        version: 1.0.0

snapshots:
  a@1.0.0: {}
  a@1.0.0(react@18.0.0): {}
`
        const graph = await parsePnpmLock(await write(text))
        expect(graph?.byName('a')).toHaveLength(1)
        expect(graph?.byName('a')[0]?.depPaths).toHaveLength(2)
    })

    // Collapsing peer variants unions their scope, and optionality is the one field that unions the
    // other way: a package is only optional if EVERY variant is. One required variant makes the whole
    // row required, because a build that needs it will fail without it.
    it('treats a collapsed package as required when any variant is required', async function () {
        const text = `lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      a:
        version: 1.0.0

snapshots:
  a@1.0.0: {}
  a@1.0.0(react@18.0.0):
    optional: true
`
        const graph = await parsePnpmLock(await write(text))
        expect(graph?.byName('a')).toHaveLength(1)
        expect(graph?.byName('a')[0]?.scope.isOptional).toBe(false)
    })

    // A key with a name and no version cannot be matched against anything, so it contributes no
    // package rather than one at version "" — which would look clean against every advisory.
    it('skips a snapshot key with an empty version', async function () {
        const text = `lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      a:
        version: 1.0.0

snapshots:
  'a@': {}
  a@1.0.0: {}
`
        const graph = await parsePnpmLock(await write(text))
        expect(graph?.packages).toHaveLength(1)
        expect(graph?.packages[0]?.version).toBe('1.0.0')
    })

    // A v9 lock with no importers block at all: nothing is reachable, so every snapshot is present
    // but attributed to neither prod nor dev rather than defaulting to prod.
    it('reads a lock with no importers block', async function () {
        const text = `lockfileVersion: '9.0'

snapshots:
  a@1.0.0: {}
`
        const graph = await parsePnpmLock(await write(text))
        expect(graph?.byName('a')).toHaveLength(1)
        expect(graph?.byName('a')[0]?.scope).toMatchObject({ isProd: false, isDev: false })
    })

    it('handles a scoped package key', async function () {
        const text = `lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      '@babel/core':
        version: 7.0.0

snapshots:
  '@babel/core@7.0.0': {}
`
        const graph = await parsePnpmLock(await write(text))
        expect(graph?.packages[0]?.name).toBe('@babel/core')
        expect(graph?.packages[0]?.version).toBe('7.0.0')
    })

    it('reads several workspace importers', async function () {
        const text = `lockfileVersion: '9.0'

importers:
  packages/a:
    dependencies:
      x:
        version: 1.0.0
  packages/b:
    devDependencies:
      y:
        version: 1.0.0

snapshots:
  x@1.0.0: {}
  y@1.0.0: {}
`
        const graph = await parsePnpmLock(await write(text))
        expect(graph?.classify('x', '1.0.0')).toMatchObject({ isProd: true })
        expect(graph?.classify('y', '1.0.0')).toMatchObject({ isDev: true })
    })

    // Neither prod- nor dev-reachable (an orphaned snapshot) still lands as prod via makeGraph's
    // fail-open default, so the finding stays visible rather than disappearing.
    it('does not hide a snapshot that is unreachable from any root', async function () {
        const text = `lockfileVersion: '9.0'

importers:
  .: {}

snapshots:
  orphan@1.0.0: {}
`
        const graph = await parsePnpmLock(await write(text))
        expect(graph?.packages.map(function name(p) { return p.name })).toEqual(['orphan'])
        expect(graph?.classify('orphan', '1.0.0')).toMatchObject({ isProd: true })
    })
})

describe('parsePnpmLock legacy', function () {
    const LEGACY = `lockfileVersion: 5.4

packages:
  /express@4.18.0:
    resolution: {integrity: sha512-x}
  /vitest@1.0.0:
    dev: true
    resolution: {integrity: sha512-y}
  /fsevents@2.3.0:
    optional: true
    resolution: {integrity: sha512-z}
`

    it('reads packages keyed by /name@version', async function () {
        const graph = await parsePnpmLock(await write(LEGACY))
        expect(graph?.packages.map(function name(p) { return p.name }).sort()).toEqual([
            'express',
            'fsevents',
            'vitest'
        ])
    })

    it('trusts the per-package dev flag', async function () {
        const graph = await parsePnpmLock(await write(LEGACY))
        expect(graph?.classify('vitest', '1.0.0')).toMatchObject({ isProd: false, isDev: true })
        expect(graph?.classify('express', '4.18.0')).toMatchObject({ isProd: true, isDev: false })
    })

    it('trusts the per-package optional flag', async function () {
        const graph = await parsePnpmLock(await write(LEGACY))
        expect(graph?.byName('fsevents')[0]?.scope.isOptional).toBe(true)
    })

    it('prefers an explicit version field over the key', async function () {
        const text = 'packages:\n  /a@1.0.0:\n    version: 2.0.0\n'
        const graph = await parsePnpmLock(await write(text))
        expect(graph?.packages[0]?.version).toBe('2.0.0')
    })

    it('skips an unparseable key', async function () {
        const text = 'packages:\n  bogus:\n    dev: false\n  /a@1.0.0:\n    dev: false\n'
        const graph = await parsePnpmLock(await write(text))
        expect(graph?.packages.map(function name(p) { return p.name })).toEqual(['a'])
    })

    it('returns an empty graph when there are no packages', async function () {
        const graph = await parsePnpmLock(await write('lockfileVersion: 5.4\n'))
        expect(graph?.packages).toEqual([])
    })
})

describe('parsePnpmLock v9 — the shapes a real workspace produces', function () {
    // Every case below changes prod/dev scope, which is what the portal's default filter and the
    // notification env scope both read. A mis-scoped transitive is silent: the finding is still
    // recorded, it just stops appearing in the view the operator actually looks at.

    it('counts optionalDependencies of an importer as production roots', async function () {
        const graph = await parsePnpmLock(await write(`lockfileVersion: '9.0'

importers:
  .:
    optionalDependencies:
      fsevents:
        version: 2.3.3

snapshots:
  fsevents@2.3.3: {}
`))
        expect(graph?.classify('fsevents', '2.3.3')).toMatchObject({ isProd: true, isDev: false })
    })

    // A `link:` value points at another workspace package rather than a registry one. That workspace
    // has its own importer entry, so its dependencies are already counted — chasing the link would
    // double-count, and treating `link:../ui` as a version would look for a snapshot that does not exist.
    it('skips link: roots rather than chasing them', async function () {
        const graph = await parsePnpmLock(await write(`lockfileVersion: '9.0'

importers:
  apps/web:
    dependencies:
      '@repo/ui':
        version: link:../../packages/ui
      express:
        version: 4.18.0
  packages/ui:
    dependencies:
      lodash:
        version: 4.17.21

snapshots:
  express@4.18.0: {}
  lodash@4.17.21: {}
`))
        // Both are prod, but lodash gets there via its own importer, not via the link.
        expect(graph?.classify('express', '4.18.0')).toMatchObject({ isProd: true })
        expect(graph?.classify('lodash', '4.17.21')).toMatchObject({ isProd: true })
    })

    it('follows optionalDependencies of a snapshot when walking reachability', async function () {
        const graph = await parsePnpmLock(await write(`lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      parent:
        version: 1.0.0

snapshots:
  parent@1.0.0:
    optionalDependencies:
      opt-child: 2.0.0
  opt-child@2.0.0: {}
`))
        expect(graph?.classify('opt-child', '2.0.0')).toMatchObject({ isProd: true })
    })

    it('marks a snapshot flagged optional as optional', async function () {
        const graph = await parsePnpmLock(await write(`lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      fsevents:
        version: 2.3.3

snapshots:
  fsevents@2.3.3:
    optional: true
`))
        expect(graph?.classify('fsevents', '2.3.3')).toMatchObject({ isOptional: true })
    })

    // Peer variants: pnpm keys the same name@version several times with different peer suffixes.
    // They collapse to one row whose scope is the UNION — a package reachable from prod through one
    // variant and dev through another is both, and reporting only the last-seen variant's scope
    // would drop it from the prod view.
    it('collapses peer variants and unions their scope', async function () {
        const graph = await parsePnpmLock(await write(`lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      prod-parent:
        version: 1.0.0
    devDependencies:
      dev-parent:
        version: 1.0.0

snapshots:
  prod-parent@1.0.0:
    dependencies:
      shared: 3.0.0(react@18.0.0)
  dev-parent@1.0.0:
    dependencies:
      shared: 3.0.0(react@19.0.0)
  shared@3.0.0(react@18.0.0): {}
  shared@3.0.0(react@19.0.0): {}
`))
        const scope = graph?.classify('shared', '3.0.0')
        expect(scope).toMatchObject({ isProd: true, isDev: true })
        expect(graph?.packages.filter(function s(p) { return p.name === 'shared' })).toHaveLength(1)
    })

    // isOptional is the intersection, not the union: a package reachable as non-optional anywhere is
    // genuinely installed, so one non-optional variant clears the flag for the collapsed row.
    it('clears the optional flag when any variant is not optional', async function () {
        const graph = await parsePnpmLock(await write(`lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      parent:
        version: 1.0.0

snapshots:
  parent@1.0.0:
    dependencies:
      shared: 3.0.0(react@18.0.0)
      other: 1.0.0
  other@1.0.0:
    dependencies:
      shared: 3.0.0(react@19.0.0)
  shared@3.0.0(react@18.0.0):
    optional: true
  shared@3.0.0(react@19.0.0): {}
`))
        expect(graph?.classify('shared', '3.0.0')).toMatchObject({ isOptional: false })
    })

    it('records a dep path per peer variant', async function () {
        const graph = await parsePnpmLock(await write(`lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      parent:
        version: 1.0.0

snapshots:
  parent@1.0.0:
    dependencies:
      shared: 3.0.0(react@18.0.0)
      other: 1.0.0
  other@1.0.0:
    dependencies:
      shared: 3.0.0(react@19.0.0)
  shared@3.0.0(react@18.0.0): {}
  shared@3.0.0(react@19.0.0): {}
`))
        const shared = graph?.packages.find(function s(p) { return p.name === 'shared' })
        expect(shared?.depPaths).toHaveLength(2)
    })

    // A package present in the lockfile but reachable from no importer gets neither scope on its row.
    //
    // Note the divergence from classify(), which is deliberate and easy to misread as a bug: makeGraph
    // fails OPEN, so classify() reports isProd: true for a row that is neither prod nor dev, on the
    // grounds that a finding should never be hidden by a scoping gap. The row is where the resolver's
    // actual answer lives, so that is what is asserted here.
    it('leaves an unreachable snapshot out of both scopes on its row', async function () {
        const graph = await parsePnpmLock(await write(`lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      express:
        version: 4.18.0

snapshots:
  express@4.18.0: {}
  orphan@9.9.9: {}
`))
        const orphan = graph?.packages.find(function o(p) { return p.name === 'orphan' })
        expect(orphan?.scope).toMatchObject({ isProd: false, isDev: false })
        // Fail-open at the classify() layer, not at the resolver's.
        expect(graph?.classify('orphan', '9.9.9')).toMatchObject({ isProd: true })
    })

    it.each([
        ['a non-object importer', 'importers:\n  .: null\n'],
        ['an importer with no dependency blocks', 'importers:\n  .: {}\n'],
        ['a dependency with no version', 'importers:\n  .:\n    dependencies:\n      broken: {}\n'],
        ['a dependency whose version is not a string', 'importers:\n  .:\n    dependencies:\n      broken:\n        version: 42\n']
    ])('tolerates %s', async function (_label, importers) {
        const graph = await parsePnpmLock(await write(`lockfileVersion: '9.0'

${importers}
snapshots:
  express@4.18.0: {}
`))
        // The lockfile still parses and still enumerates its packages — a malformed importer costs
        // reachability for that importer, not the whole graph.
        expect(graph).not.toBeNull()
        expect(graph?.packages.map(function n(p) { return p.name })).toEqual(['express'])
        expect(graph?.packages[0]?.scope).toMatchObject({ isProd: false, isDev: false })
    })

    it.each([
        ['a null snapshot', 'snapshots:\n  express@4.18.0: null\n'],
        ['a snapshot with a non-object dependency block', 'snapshots:\n  express@4.18.0:\n    dependencies: null\n'],
        ['a snapshot dependency with an empty version', 'snapshots:\n  express@4.18.0:\n    dependencies:\n      broken: ""\n']
    ])('tolerates %s', async function (_label, snapshots) {
        const graph = await parsePnpmLock(await write(`lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      express:
        version: 4.18.0

${snapshots}`))
        expect(graph?.classify('express', '4.18.0')).toMatchObject({ isProd: true })
    })

    // No snapshots block at all: fall back to enumerating the legacy packages map so a hybrid or
    // truncated lockfile still yields the installed set rather than an empty graph.
    it('falls back to the packages map when there are no snapshots', async function () {
        const graph = await parsePnpmLock(await write(`lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      express:
        version: 4.18.0

packages:
  express@4.18.0:
    resolution: {integrity: sha512-abc}
`))
        expect(graph?.packages.map(function n(p) { return p.name })).toContain('express')
    })

    it('skips a snapshot key that cannot be parsed into a name and version', async function () {
        const graph = await parsePnpmLock(await write(`lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      express:
        version: 4.18.0

snapshots:
  express@4.18.0: {}
  'not-a-valid-key': {}
`))
        expect(graph?.packages.map(function n(p) { return p.name })).toEqual(['express'])
    })
})

describe('parsePnpmLock legacy — the per-entry flags', function () {
    // v6 and earlier carry dev/optional on each entry rather than requiring a reachability walk, so
    // the failure mode is different: the flags are read directly and a misread mis-scopes exactly one
    // package rather than a whole subtree.
    async function legacy(packages: string): Promise<Awaited<ReturnType<typeof parsePnpmLock>>> {
        return parsePnpmLock(await write(`lockfileVersion: 6.0\n\npackages:\n${packages}`))
    }

    it('treats an entry with no dev flag as production', async function () {
        const graph = await legacy(`  /express@4.18.0:\n    resolution: {integrity: sha512-abc}\n`)
        expect(graph?.classify('express', '4.18.0')).toMatchObject({ isProd: true, isDev: false })
    })

    it('treats dev: true as dev only', async function () {
        const graph = await legacy(`  /vitest@1.0.0:\n    resolution: {integrity: sha512-abc}\n    dev: true\n`)
        expect(graph?.classify('vitest', '1.0.0')).toMatchObject({ isProd: false, isDev: true })
    })

    it('reads the optional flag', async function () {
        const graph = await legacy(`  /fsevents@2.3.3:\n    resolution: {integrity: sha512-abc}\n    optional: true\n`)
        expect(graph?.classify('fsevents', '2.3.3')).toMatchObject({ isOptional: true })
    })

    // An explicit version field wins over the one embedded in the key — pnpm writes it for entries
    // whose key carries a registry URL or an alias rather than a plain version.
    it('prefers an explicit version field over the key', async function () {
        const graph = await legacy(`  /express@4.18.0:\n    resolution: {integrity: sha512-abc}\n    version: 4.18.2\n`)
        expect(graph?.packages.find(function e(p) { return p.name === 'express' })?.version).toBe('4.18.2')
    })

    it.each([
        ['a null entry', `  /express@4.18.0: null\n`],
        ['an unparseable key', `  'garbage':\n    resolution: {integrity: sha512-abc}\n`]
    ])('skips %s', async function (_label, packages) {
        const graph = await legacy(packages as string)
        expect(graph?.packages).toEqual([])
    })
})
