import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The two paths in discovery.ts that a real filesystem cannot reach, each for a different reason, and
// both needing a module mock — which is why they are here rather than in discovery.test.ts, where every
// other case runs against a real temp tree with nothing stubbed.
//
//  - detectEcosystems' non-npm arm is correct, general code that STABLE_ECOSYSTEMS currently forecloses:
//    npm is the only entry at status 'stable' (packages/core/src/ecosystems.ts), so the loop body for
//    every other ecosystem is dead until one is promoted. Promoting one must not be the moment this is
//    first exercised.
//  - isFile's catch needs statSync to throw after existsSync has already said yes, which is a
//    time-of-check/time-of-use race against a tree the walker does not own.

const core = vi.hoisted(function makeCoreDouble() {
    return { stableEcosystems: null as unknown[] | null }
})

vi.mock('@sentinello/core', async function mockCore(importOriginal) {
    const actual = await importOriginal<typeof import('@sentinello/core')>()
    return {
        ...actual,
        get STABLE_ECOSYSTEMS() {
            return core.stableEcosystems ?? actual.STABLE_ECOSYSTEMS
        }
    }
})

const nodeFs = vi.hoisted(function makeFsDouble() {
    return { statSyncThrows: false }
})

vi.mock('node:fs', async function mockNodeFs(importOriginal) {
    const actual = await importOriginal<typeof import('node:fs')>()
    return {
        ...actual,
        statSync: function statSync(path: Parameters<typeof actual.statSync>[0]) {
            if (nodeFs.statSyncThrows) throw new Error('ENOENT: vanished between the check and the stat')
            return actual.statSync(path)
        }
    }
})

const { detectEcosystems, discoverProjectsInTree } = await import('./discovery')
const { ECOSYSTEMS } = await import('@sentinello/core')

let dir: string

beforeEach(async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-discovery-mocked-'))
    core.stableEcosystems = null
    nodeFs.statSyncThrows = false
})

afterEach(async function teardown() {
    core.stableEcosystems = null
    nodeFs.statSyncThrows = false
    await rm(dir, { recursive: true, force: true })
})

describe('detectEcosystems beyond npm', function () {
    // The REAL PyPI definition, promoted to 'stable'. Using the registry entry rather than a hand-built
    // one is the point: it pins that detection is driven by that entry's resolverKinds, so promoting an
    // ecosystem for real needs no change here.
    function withPyPiStable(): void {
        const pypi = ECOSYSTEMS.find(function isPyPi(eco) { return eco.id === 'PyPI' })
        if (!pypi) throw new Error('the PyPI registry entry has been removed')
        const npm = ECOSYSTEMS.find(function isNpm(eco) { return eco.id === 'npm' })
        if (!npm) throw new Error('the npm registry entry has been removed')
        core.stableEcosystems = [npm, { ...pypi, status: 'stable' }]
    }

    it('detects a non-npm ecosystem from any of its resolver kinds', async function () {
        withPyPiStable()
        await writeFile(join(dir, 'package.json'), '{}', 'utf8')
        await writeFile(join(dir, 'requirements.txt'), 'flask==2.0.0\n', 'utf8')

        expect(detectEcosystems(dir)).toEqual(['npm', 'PyPI'])
    })

    // The loop breaks on the first kind it finds, so a project carrying several Python manifests is
    // still ONE PyPI entry rather than four.
    it('reports a non-npm ecosystem once however many of its manifests are present', async function () {
        withPyPiStable()
        await writeFile(join(dir, 'requirements.txt'), '', 'utf8')
        await writeFile(join(dir, 'poetry.lock'), '', 'utf8')
        await writeFile(join(dir, 'uv.lock'), '', 'utf8')

        expect(detectEcosystems(dir)).toEqual(['PyPI'])
    })

    it('reports nothing for a directory holding none of that ecosystem manifests', async function () {
        withPyPiStable()
        await writeFile(join(dir, 'README.md'), '', 'utf8')

        expect(detectEcosystems(dir)).toEqual([])
    })
})

describe('a path that vanishes mid-walk', function () {
    // discovery walks read-only mounts it does not control, so a directory can disappear between
    // existsSync saying yes and statSync being asked about it. The scan of every OTHER project under the
    // same root must survive that — a crash here loses the whole run over one unlucky race.
    it('treats a path that disappears between the check and the stat as not a file', async function () {
        await mkdir(join(dir, 'app'), { recursive: true })
        await writeFile(join(dir, 'app', 'package.json'), '{}', 'utf8')
        nodeFs.statSyncThrows = true

        const projects = discoverProjectsInTree({ rootPath: dir, maxDepth: 4, excludes: [] })

        // No throw, and nothing invented: the manifest could not be confirmed, so no project is claimed.
        expect(projects).toEqual([])
    })
})
