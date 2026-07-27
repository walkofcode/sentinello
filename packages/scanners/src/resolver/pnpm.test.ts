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
