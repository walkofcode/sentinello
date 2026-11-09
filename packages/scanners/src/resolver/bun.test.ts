import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseBunLock, parseJsonc } from './bun'
import type { ResolverResult } from './types'

// A frozen lockfile in the shape Bun 1.2 writes: trailing commas, a nested copy, a workspace, a dev-only tree.
const LOCK = `{
  "lockfileVersion": 1,
  // Bun promises room for comments, and a URL's slashes are not one.
  "workspaces": {
    "": {
      "name": "app",
      "dependencies": { "express": "^4.0.0", "@acme/shared": "workspace:*", "alias-name": "npm:real-name@1.0.0", },
      "devDependencies": { "vitest": "^5.0.0", },
      "optionalDependencies": { "fsevents": "^2.0.0", },
      "peerDependencies": { "react": "^19.0.0", },
    },
    "packages/shared": {
      "name": "@acme/shared",
      "version": "1.0.0",
      "dependencies": { "semver": "^7.0.0", },
    },
  },
  "packages": {
    "@acme/shared": ["@acme/shared@workspace:packages/shared"],
    "@acme/shared/semver": ["semver@7.6.0", "", {}, "sha512-a"],
    "alias-name": ["real-name@1.0.0", "https://registry.npmjs.org/", {}, "sha512-b"],
    "express": ["express@4.17.1", "", { "dependencies": { "semver": "^6.0.0", "qs": "^6.0.0" }, "optionalPeers": ["absent"], "peerDependencies": { "absent": "*" } }, "sha512-c"],
    "express/semver": ["semver@6.3.1", "", {}, "sha512-d"],
    "fsevents": ["fsevents@2.3.3", "", { "os": "darwin" }, "sha512-e"],
    "qs": ["qs@6.11.0", "", { "optionalDependencies": { "side": "^1.0.0" } }, "sha512-f"],
    "react": ["react@19.0.0", "", {}, "sha512-g"],
    "side": ["side@1.0.0", "", {}, "sha512-h"],
    "semver": ["semver@5.7.2", "", {}, "sha512-i"],
    "vitest": ["vitest@5.0.0", "", { "dependencies": { "semver": "^5.0.0" } }, "sha512-j"],
  },
}
`

let dir: string

beforeEach(async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-bun-'))
})

afterEach(async function cleanup() {
    await rm(dir, { recursive: true, force: true })
})

async function parse(text: string): Promise<ResolverResult> {
    const path = join(dir, 'bun.lock')
    await writeFile(path, text, 'utf8')
    return await parseBunLock(path, 'bun.lock')
}

function graphOf(result: ResolverResult) {
    if (result.status === 'unauditable') throw new Error('did not resolve: ' + result.details.join())
    return result.graph
}

describe('parseBunLock', function () {
    it('reads every installed package under its real name, and no workspace as one', async function () {
        const result = await parse(LOCK)
        expect(result.status).toBe('ok')
        expect(graphOf(result).packages.map(function id(p) { return p.name + '@' + p.version }).sort()).toEqual([
            'express@4.17.1', 'fsevents@2.3.3', 'qs@6.11.0', 'react@19.0.0', 'real-name@1.0.0', 'semver@5.7.2', 'semver@6.3.1', 'semver@7.6.0', 'side@1.0.0', 'vitest@5.0.0'
        ])
    })

    it('classifies by reachability: a nested copy is its own, and a dev-only tree stays dev', async function () {
        const graph = graphOf(await parse(LOCK))
        expect(graph.classify('semver', '6.3.1')).toMatchObject({ isProd: true, isDev: false })
        expect(graph.classify('semver', '5.7.2')).toMatchObject({ isProd: false, isDev: true })
        expect(graph.classify('semver', '7.6.0')).toMatchObject({ isProd: true, isDev: false })
        expect(graph.classify('fsevents', '2.3.3')).toMatchObject({ isProd: true, isOptional: true })
    })

    it('resolves a dependency to the nearest copy, and a chain reads name@version from its root', async function () {
        const graph = graphOf(await parse(LOCK))
        expect(graph.byName('semver').find(function six(p) { return p.version === '6.3.1' })?.depPaths).toEqual(['express@4.17.1', 'semver@6.3.1'])
        expect(graph.byName('side')[0]?.depPaths).toEqual(['express@4.17.1', 'qs@6.11.0', 'side@1.0.0'])
        expect(graph.nodeGraph?.roots).toContainEqual({ importer: 'packages/shared', nodeId: '@acme/shared/semver', kind: 'prod' })
        expect(graph.nodeGraph?.edges).toContainEqual({ from: 'qs', to: 'side', kind: 'optional' })
    })

    it('cannot audit what no advisory database covers, says which, and still follows its edges', async function () {
        const result = await parse(JSON.stringify({
            workspaces: { '': { dependencies: { gitdep: '1', localdep: '1', tar: '1' } } },
            packages: {
                gitdep: ['gitdep@github:owner/repo#abc', { dependencies: { qs: '^6' } }, 'owner-repo-abc'],
                localdep: ['localdep@file:../localdep', {}],
                tar: ['tar@https://example.test/tar.tgz', {}],
                qs: ['qs@6.11.0', '', {}, 'sha512-f'],
                broken: ['no-version-here'],
                alsoBroken: 42
            }
        }))
        expect(result).toMatchObject({ status: 'partial', reasonCode: 'partial_dependency_graph' })
        if (result.status !== 'partial') throw new Error('expected partial')
        expect(result.details[0]).toBe('5 packages from git, local path or URL sources cannot be audited: alsoBroken, broken, gitdep@github:owner/repo#abc, localdep@file:../localdep, tar@https://example.test/tar.tgz')
        expect(result.graph.packages.map(function name(p) { return p.name })).toEqual(['qs'])
        expect(result.graph.classify('qs', '6.11.0').isProd).toBe(true)
    })

    it('reads an entry with an empty version as unreadable, not as a package', async function () {
        const result = await parse(JSON.stringify({ packages: { x: ['x@'] } }))
        expect(result.status).toBe('partial')
    })

    it('fails open on a lock it cannot read, and reads an empty one as nothing installed', async function () {
        expect(await parse('{ not json')).toMatchObject({ status: 'unauditable', reasonCode: 'unsupported_lockfile', details: ['could not read bun.lock'] })
        expect(await parseBunLock(join(dir, 'gone.lock'), 'gone.lock')).toMatchObject({ status: 'unauditable', reasonCode: 'unsupported_lockfile' })
        expect(graphOf(await parse('[]')).packages).toEqual([])
    })

    it('reads a workspace with no name, and metadata absent altogether', async function () {
        const graph = graphOf(await parse(JSON.stringify({ workspaces: { '': { dependencies: { qs: '1' } }, broken: null }, packages: { qs: ['qs@6.11.0'] } })))
        expect(graph.packages.map(function name(p) { return p.version })).toEqual(['6.11.0'])
        expect(graph.classify('qs', '6.11.0').isProd).toBe(true)
    })

    it('walks a scoped parent key apart from its scoped child', async function () {
        const graph = graphOf(await parse(JSON.stringify({
            workspaces: { '': { dependencies: { '@a/parent': '1' } } },
            packages: {
                '@a/parent': ['@a/parent@1.0.0', '', { dependencies: { '@b/child': '1' } }],
                '@a/parent/@b/child': ['@b/child@2.0.0', '', {}],
                '@b/child': ['@b/child@1.0.0', '', {}],
                '@dangling': ['@dangling@1.0.0', '', {}]
            }
        })))
        expect(graph.byName('@b/child').find(function nested(p) { return p.version === '2.0.0' })?.depPaths).toEqual(['@a/parent@1.0.0', '@b/child@2.0.0'])
    })
})

describe('parseJsonc', function () {
    it('drops comments and trailing commas outside strings, and leaves strings alone', function () {
        expect(parseJsonc('{ /* block */ "url": "https://x//y", "a": [1, 2, ], "esc": "q\\"//,]", } // end')).toEqual({ url: 'https://x//y', a: [1, 2], esc: 'q"//,]' })
    })

    it('throws on what is still not JSON: an unclosed string, or an unclosed comment hiding the rest', function () {
        expect(function open() { return parseJsonc('{ "a": "unclosed') }).toThrow()
        expect(function comment() { return parseJsonc('{ "a": 1 /* never closed') }).toThrow()
    })
})
