import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseNpmLock } from './npm-lock'

// Fixtures are written at runtime from specs held here rather than committed: a lockfile on disk in the
// repo would be picked up by our own tooling, and the shapes under test are small enough to read inline.
//
// This parser decides which packages exist to be scanned at all, so the failure that matters is a
// package silently missing from the graph — hence the assertions count and name packages rather than
// just checking the call succeeded.

let dir: string

beforeEach(async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-npm-lock-'))
})

afterEach(async function cleanup() {
    await rm(dir, { recursive: true, force: true })
})

async function writeLock(doc: unknown): Promise<string> {
    const path = join(dir, 'package-lock.json')
    await writeFile(path, JSON.stringify(doc), 'utf8')
    return path
}

async function writeManifest(manifest: unknown): Promise<void> {
    await writeFile(join(dir, 'package.json'), JSON.stringify(manifest), 'utf8')
}

describe('parseNpmLock failure handling', function () {
    // Returning null makes the caller fail open rather than treat an unreadable lockfile as "no deps".
    it('returns null when the lockfile does not exist', async function () {
        expect(await parseNpmLock(dir, join(dir, 'nope.json'))).toBeNull()
    })

    it('returns null on malformed JSON', async function () {
        const path = join(dir, 'package-lock.json')
        await writeFile(path, '{ not json', 'utf8')
        expect(await parseNpmLock(dir, path)).toBeNull()
    })

    it.each(['null', '"a string"', '42'])('returns null for the non-object document %s', async function (raw) {
        const path = join(dir, 'package-lock.json')
        await writeFile(path, raw, 'utf8')
        expect(await parseNpmLock(dir, path)).toBeNull()
    })

    it('returns an empty graph when there are no packages', async function () {
        const graph = await parseNpmLock(dir, await writeLock({ lockfileVersion: 3 }))
        expect(graph?.packages).toEqual([])
    })
})

describe('parseNpmLock package extraction', function () {
    it('reads name and version from each node', async function () {
        const graph = await parseNpmLock(
            dir,
            await writeLock({
                packages: {
                    '': { name: 'root', version: '1.0.0' },
                    'node_modules/lodash': { version: '4.17.20' },
                    'node_modules/express': { version: '4.18.0' }
                }
            })
        )
        expect(graph?.packages.map(function name(p) { return p.name }).sort()).toEqual(['express', 'lodash'])
    })

    // The "" entry is the project itself, not an installed dependency.
    it('skips the root entry', async function () {
        const graph = await parseNpmLock(
            dir,
            await writeLock({ packages: { '': { name: 'root', version: '1.0.0' } } })
        )
        expect(graph?.packages).toEqual([])
    })

    it('skips an entry with no version', async function () {
        const graph = await parseNpmLock(
            dir,
            await writeLock({ packages: { 'node_modules/ghost': { name: 'ghost' } } })
        )
        expect(graph?.packages).toEqual([])
    })

    it('prefers an explicit name over the node path', async function () {
        const graph = await parseNpmLock(
            dir,
            await writeLock({ packages: { 'node_modules/aliased': { name: 'real-name', version: '1.0.0' } } })
        )
        expect(graph?.packages[0]?.name).toBe('real-name')
    })

    it.each([
        ['node_modules/lodash', 'lodash'],
        ['node_modules/@scope/pkg', '@scope/pkg'],
        ['node_modules/a/node_modules/b', 'b'],
        ['node_modules/a/node_modules/@scope/b', '@scope/b'],
        ['packages/app/node_modules/dep', 'dep']
    ] as Array<[string, string]>)('derives %s as %s', async function (nodePath, expected) {
        const graph = await parseNpmLock(dir, await writeLock({ packages: { [nodePath]: { version: '1.0.0' } } }))
        expect(graph?.packages[0]?.name).toBe(expected)
    })

    it('skips a node path with no node_modules segment', async function () {
        const graph = await parseNpmLock(dir, await writeLock({ packages: { 'packages/app': { version: '1.0.0' } } }))
        expect(graph?.packages).toEqual([])
    })

    it('keeps the node path as the dependency path', async function () {
        const graph = await parseNpmLock(
            dir,
            await writeLock({ packages: { 'node_modules/a/node_modules/b': { version: '1.0.0' } } })
        )
        expect(graph?.packages[0]?.depPaths).toEqual(['node_modules/a/node_modules/b'])
    })
})

describe('parseNpmLock scope classification', function () {
    it('treats an unflagged package as prod', async function () {
        const graph = await parseNpmLock(dir, await writeLock({ packages: { 'node_modules/a': { version: '1.0.0' } } }))
        expect(graph?.packages[0]?.scope).toEqual({ isProd: true, isDev: false, isOptional: false })
    })

    it.each(['dev', 'devOptional'] as Array<'dev' | 'devOptional'>)('treats a %s-flagged package as dev', async function (flag) {
        const graph = await parseNpmLock(
            dir,
            await writeLock({ packages: { 'node_modules/a': { version: '1.0.0', [flag]: true } } })
        )
        expect(graph?.packages[0]?.scope.isDev).toBe(true)
        expect(graph?.packages[0]?.scope.isProd).toBe(false)
    })

    it.each(['optional', 'devOptional'] as Array<'optional' | 'devOptional'>)('marks a %s package optional', async function (flag) {
        const graph = await parseNpmLock(
            dir,
            await writeLock({ packages: { 'node_modules/a': { version: '1.0.0', [flag]: true } } })
        )
        expect(graph?.packages[0]?.scope.isOptional).toBe(true)
    })

    // A direct prod dependency must read as prod even when npm flagged the shared node dev.
    it('forces a direct prod dependency back to prod', async function () {
        await writeManifest({ dependencies: { a: '^1.0.0' } })
        const graph = await parseNpmLock(
            dir,
            await writeLock({ packages: { 'node_modules/a': { version: '1.0.0', dev: true } } })
        )
        expect(graph?.packages[0]?.scope.isProd).toBe(true)
    })

    it.each(['optionalDependencies', 'peerDependencies'] as Array<'optionalDependencies' | 'peerDependencies'>)(
        'treats a %s entry as a direct prod dependency',
        async function (field) {
            await writeManifest({ [field]: { a: '^1.0.0' } })
            const graph = await parseNpmLock(
                dir,
                await writeLock({ packages: { 'node_modules/a': { version: '1.0.0', dev: true } } })
            )
            expect(graph?.packages[0]?.scope.isProd).toBe(true)
        }
    )

    it('forces a direct dev dependency to dev', async function () {
        await writeManifest({ devDependencies: { a: '^1.0.0' } })
        const graph = await parseNpmLock(dir, await writeLock({ packages: { 'node_modules/a': { version: '1.0.0' } } }))
        expect(graph?.packages[0]?.scope).toMatchObject({ isProd: false, isDev: true })
    })

    // Listed in both — prod wins, because shipping it is the riskier reading.
    it('lets prod win when a package is both a direct prod and dev dependency', async function () {
        await writeManifest({ dependencies: { a: '^1.0.0' }, devDependencies: { a: '^1.0.0' } })
        const graph = await parseNpmLock(
            dir,
            await writeLock({ packages: { 'node_modules/a': { version: '1.0.0', dev: true } } })
        )
        expect(graph?.packages[0]?.scope.isProd).toBe(true)
    })

    it('falls back to lockfile flags when there is no package.json', async function () {
        const graph = await parseNpmLock(
            dir,
            await writeLock({ packages: { 'node_modules/a': { version: '1.0.0', dev: true } } })
        )
        expect(graph?.packages[0]?.scope.isDev).toBe(true)
    })

    it('falls back to lockfile flags when package.json is unparseable', async function () {
        await writeFile(join(dir, 'package.json'), '{ broken', 'utf8')
        const graph = await parseNpmLock(
            dir,
            await writeLock({ packages: { 'node_modules/a': { version: '1.0.0', dev: true } } })
        )
        expect(graph?.packages[0]?.scope.isDev).toBe(true)
    })
})

describe('parseNpmLock graph wiring', function () {
    it('returns a graph whose classify reflects the parsed scopes', async function () {
        const graph = await parseNpmLock(
            dir,
            await writeLock({
                packages: {
                    'node_modules/a': { version: '1.0.0', dev: true },
                    'node_modules/b': { version: '2.0.0' }
                }
            })
        )
        expect(graph?.classify('a', '1.0.0')).toMatchObject({ isDev: true, isProd: false })
        expect(graph?.classify('b', '2.0.0')).toMatchObject({ isProd: true })
    })

    it('keeps two hoisted copies of one package as separate entries', async function () {
        const graph = await parseNpmLock(
            dir,
            await writeLock({
                packages: {
                    'node_modules/a': { version: '1.0.0' },
                    'node_modules/b/node_modules/a': { version: '2.0.0' }
                }
            })
        )
        expect(graph?.byName('a').map(function v(p) { return p.version }).sort()).toEqual(['1.0.0', '2.0.0'])
    })
})
