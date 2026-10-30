import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The path in discovery.ts that a real filesystem cannot reach, which is why it is here rather than in
// discovery.test.ts, where every other case runs against a real temp tree with nothing stubbed: isFile's
// catch needs statSync to throw after existsSync has already said yes, which is a time-of-check/time-of-use
// race against a tree the walker does not own.

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

const { discoverProjectsInTree } = await import('./discovery')
const { ECOSYSTEMS } = await import('@sentinello/core')

let dir: string

beforeEach(async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-discovery-mocked-'))
    nodeFs.statSyncThrows = false
})

afterEach(async function teardown() {
    nodeFs.statSyncThrows = false
    await rm(dir, { recursive: true, force: true })
})

describe('a path that vanishes mid-walk', function () {
    // discovery walks read-only mounts it does not control, so a directory can disappear between
    // existsSync saying yes and statSync being asked about it. The scan of every OTHER project under the
    // same root must survive that — a crash here loses the whole run over one unlucky race.
    it('treats a path that disappears between the check and the stat as not a file', async function () {
        await mkdir(join(dir, 'app'), { recursive: true })
        await writeFile(join(dir, 'app', 'package.json'), '{}', 'utf8')
        await writeFile(join(dir, 'app', 'Gemfile.lock'), '', 'utf8')
        nodeFs.statSyncThrows = true

        const projects = discoverProjectsInTree({ rootPath: dir, maxDepth: 4, excludes: [], ecosystems: ECOSYSTEMS })

        // No throw, and nothing invented: no manifest could be confirmed, so no project is claimed.
        expect(projects).toEqual([])
    })
})
