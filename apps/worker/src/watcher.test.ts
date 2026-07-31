import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listRecentScanRequests, projectId as makeProjectId, upsertRoot } from '@sentinello/db'
import {
    PKG_JSON,
    T0,
    closeWorkerTestDb,
    makeTree,
    openWorkerTestDb,
    seedProject,
    type WorkerTestDb
} from './worker-test-db.fixture'

// The lockfile watcher's one hard rule is stated in its own header: it MUST NOT call the runner. Every
// event it decides to act on becomes a scan_requests row and nothing else, so the database stays the
// contract between "something changed on disk" and "something got scanned". A watcher that reached for
// runBatch directly would scan outside the poller's claim/heartbeat/terminal-status bookkeeping, and
// nothing in the portal would ever know a scan was running.
//
// The other rules are about not being a nuisance: only real lockfiles count (an editor writing any file
// under a root must not trigger a scan), writes coalesce within a debounce window (a package manager
// rewrites a lockfile several times during one install), and a lockfile that lands somewhere not yet
// known as a project falls back to a full sweep so discovery can pick it up.
//
// chokidar is stubbed because a real inotify watch is a race, not an assertion — the double hands back
// the registered handlers so a test can deliver an event synchronously. The paths handed to it, the
// ignore predicate it was configured with, and everything downstream of an event are all real.

const chokidar = vi.hoisted(function makeChokidarDouble() {
    type Watch = {
        paths: string[]
        options: { ignored?: (p: string) => boolean; ignoreInitial?: boolean; depth?: number }
        handlers: Map<string, (p: string) => void>
        closed: boolean
    }
    const watches: Watch[] = []
    return {
        watches,
        reset: function reset() { watches.length = 0 },
        watch: function watch(paths: string[], options: Watch['options']) {
            const entry: Watch = { paths, options, handlers: new Map(), closed: false }
            watches.push(entry)
            return {
                on: function on(event: string, handler: (p: string) => void) {
                    entry.handlers.set(event, handler)
                },
                close: async function close() { entry.closed = true }
            }
        }
    }
})

vi.mock('chokidar', function mockChokidar() {
    return { default: { watch: chokidar.watch } }
})

const { startLockfileWatcher } = await import('./watcher')

const DEBOUNCE = 1_000

let handle: WorkerTestDb
let rootPath: string

function activeWatch() {
    return chokidar.watches[chokidar.watches.length - 1]!
}

function emit(event: string, filePath: string): void {
    activeWatch().handlers.get(event)?.(filePath)
}

function requests() {
    return listRecentScanRequests(handle.db)
}

function logLines(): string[] {
    return vi.mocked(console.log).mock.calls.map(function first(c) { return String(c[0]) })
}

beforeEach(async function setup() {
    chokidar.reset()
    vi.useFakeTimers()
    handle = await openWorkerTestDb('worker-watcher')
    rootPath = await makeTree(handle.dir, 'code', { 'web/package.json': PKG_JSON })
    upsertRoot(handle.db, { id: 'root-1', path: rootPath, label: null, createdAt: T0 })
    seedProject(handle.db, { id: makeProjectId('root-1', 'web'), relPath: 'web', name: 'web' })
    vi.spyOn(console, 'log').mockImplementation(function silence() {})
    vi.spyOn(console, 'warn').mockImplementation(function silence() {})
})

afterEach(async function teardown() {
    vi.useRealTimers()
    vi.restoreAllMocks()
    await closeWorkerTestDb(handle)
})

describe('resolving which roots to watch', function () {
    it('watches a root the operator opted into', function () {
        startLockfileWatcher({ db: handle.db, rootPaths: [rootPath], debounceMs: DEBOUNCE })
        expect(activeWatch().paths).toEqual([rootPath])
    })

    it('resolves a relative opt-in path before matching it against the registered roots', function () {
        startLockfileWatcher({ db: handle.db, rootPaths: [rootPath + '/../code'], debounceMs: DEBOUNCE })
        expect(activeWatch().paths).toEqual([rootPath])
    })

    // Opting into a path that is not a registered root must not silently widen to "watch everything".
    it('ignores an opt-in path that matches no registered root', function () {
        startLockfileWatcher({ db: handle.db, rootPaths: ['/somewhere/else'], debounceMs: DEBOUNCE })
        expect(chokidar.watches).toHaveLength(0)
    })

    it('goes inactive rather than watching every root when nothing resolves', function () {
        startLockfileWatcher({ db: handle.db, rootPaths: [], debounceMs: DEBOUNCE })
        expect(chokidar.watches).toHaveLength(0)
        expect(vi.mocked(console.warn).mock.calls.map(function f(c) { return String(c[0]) })).toContain(
            '[watcher] no watched roots resolved; watcher inactive'
        )
    })

    it('returns a handle whose stop() resolves even when inactive', async function () {
        const watcher = startLockfileWatcher({ db: handle.db, rootPaths: [], debounceMs: DEBOUNCE })
        await expect(watcher.stop()).resolves.toBeUndefined()
    })

    // A root registered in the database but not currently mounted would make chokidar throw.
    it('skips a registered root whose path does not exist on disk', async function () {
        const missing = join(handle.dir, 'unmounted')
        upsertRoot(handle.db, { id: 'root-2', path: missing, label: null, createdAt: T0 })
        startLockfileWatcher({ db: handle.db, rootPaths: [rootPath, missing], debounceMs: DEBOUNCE })
        expect(activeWatch().paths).toEqual([rootPath])
    })

    it('watches several opted-in roots at once', async function () {
        const other = await makeTree(handle.dir, 'other', { 'tool/package.json': PKG_JSON })
        upsertRoot(handle.db, { id: 'root-2', path: other, label: null, createdAt: T0 })
        startLockfileWatcher({ db: handle.db, rootPaths: [rootPath, other], debounceMs: DEBOUNCE })
        expect(activeWatch().paths).toEqual([rootPath, other])
    })

    it('logs how many roots it took on', function () {
        startLockfileWatcher({ db: handle.db, rootPaths: [rootPath], debounceMs: DEBOUNCE })
        expect(logLines()).toContain('[watcher] watching 1 root(s) for lockfile changes')
    })
})

describe('chokidar configuration', function () {
    beforeEach(function start() {
        startLockfileWatcher({ db: handle.db, rootPaths: [rootPath], debounceMs: DEBOUNCE })
    })

    // Descending into node_modules would produce thousands of useless events — every dependency ships
    // its own lockfiles and manifests.
    it('never descends into node_modules or .git', function () {
        const ignored = activeWatch().options.ignored!
        expect(ignored('/repo/node_modules/left-pad/package-lock.json')).toBe(true)
        expect(ignored('/repo/.git/index')).toBe(true)
        expect(ignored('/repo/web/package-lock.json')).toBe(false)
    })

    it('matches those directories at any depth and at the path root', function () {
        const ignored = activeWatch().options.ignored!
        expect(ignored('node_modules')).toBe(true)
        expect(ignored('/a/b/node_modules')).toBe(true)
        expect(ignored('/a/node_modules/b/c')).toBe(true)
    })

    // A directory merely NAMED like one of them is a legitimate project directory.
    it('does not ignore a directory whose name merely contains node_modules', function () {
        const ignored = activeWatch().options.ignored!
        expect(ignored('/repo/my_node_modules_backup/package-lock.json')).toBe(false)
    })

    // Without this, every existing lockfile would fire on boot and enqueue a scan per project.
    it('ignores the initial scan and watches deeply', function () {
        expect(activeWatch().options.ignoreInitial).toBe(true)
        expect(activeWatch().options.depth).toBe(99)
    })
})

describe('which events count', function () {
    beforeEach(function start() {
        startLockfileWatcher({ db: handle.db, rootPaths: [rootPath], debounceMs: DEBOUNCE })
    })

    it('enqueues a scan when a lockfile changes', function () {
        emit('change', join(rootPath, 'web', 'package-lock.json'))
        vi.advanceTimersByTime(DEBOUNCE)
        expect(requests()).toHaveLength(1)
    })

    it('enqueues a scan when a lockfile is created', function () {
        emit('add', join(rootPath, 'web', 'pnpm-lock.yaml'))
        vi.advanceTimersByTime(DEBOUNCE)
        expect(requests()).toHaveLength(1)
    })

    it('recognizes every supported lockfile name', function () {
        for (const name of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']) {
            emit('change', join(rootPath, 'web', name))
        }
        vi.advanceTimersByTime(DEBOUNCE)
        expect(requests()).toHaveLength(3)
    })

    // The watcher subscribes to every add/change under the root, so this filter is the only thing
    // standing between an editor autosave and a full scan.
    it('ignores a file that is not a lockfile', function () {
        emit('change', join(rootPath, 'web', 'index.ts'))
        emit('add', join(rootPath, 'web', 'package.json'))
        vi.advanceTimersByTime(DEBOUNCE)
        expect(requests()).toEqual([])
    })

    it('ignores a file whose name merely ends with a lockfile name', function () {
        emit('change', join(rootPath, 'web', 'old-package-lock.json'))
        vi.advanceTimersByTime(DEBOUNCE)
        expect(requests()).toEqual([])
    })
})

describe('debouncing', function () {
    beforeEach(function start() {
        startLockfileWatcher({ db: handle.db, rootPaths: [rootPath], debounceMs: DEBOUNCE })
    })

    it('does not enqueue until the debounce window elapses', function () {
        emit('change', join(rootPath, 'web', 'package-lock.json'))
        vi.advanceTimersByTime(DEBOUNCE - 1)
        expect(requests()).toEqual([])
        vi.advanceTimersByTime(1)
        expect(requests()).toHaveLength(1)
    })

    // A single `npm install` rewrites the lockfile several times. One install should mean one scan.
    it('coalesces repeated writes to the same file into one scan', function () {
        const lock = join(rootPath, 'web', 'package-lock.json')
        emit('change', lock)
        vi.advanceTimersByTime(500)
        emit('change', lock)
        vi.advanceTimersByTime(500)
        emit('change', lock)
        vi.advanceTimersByTime(DEBOUNCE)
        expect(requests()).toHaveLength(1)
    })

    it('debounces each file independently', async function () {
        await makeTree(rootPath, 'api', { 'package.json': PKG_JSON })
        seedProject(handle.db, { id: makeProjectId('root-1', 'api'), relPath: 'api', name: 'api' })
        emit('change', join(rootPath, 'web', 'package-lock.json'))
        emit('change', join(rootPath, 'api', 'package-lock.json'))
        vi.advanceTimersByTime(DEBOUNCE)
        expect(requests()).toHaveLength(2)
    })

    // A lockfile deleted mid-install (pnpm does this) should not produce a scan for a file that no
    // longer exists.
    it('cancels a pending scan when the lockfile is deleted first', function () {
        const lock = join(rootPath, 'web', 'package-lock.json')
        emit('change', lock)
        emit('unlink', lock)
        vi.advanceTimersByTime(DEBOUNCE)
        expect(requests()).toEqual([])
    })

    it('ignores an unlink for a file it was not tracking', function () {
        emit('unlink', join(rootPath, 'web', 'package-lock.json'))
        emit('unlink', join(rootPath, 'web', 'index.ts'))
        vi.advanceTimersByTime(DEBOUNCE)
        expect(requests()).toEqual([])
    })

    it('applies the default debounce when none is given', function () {
        chokidar.reset()
        startLockfileWatcher({ db: handle.db, rootPaths: [rootPath] })
        emit('change', join(rootPath, 'web', 'package-lock.json'))
        vi.advanceTimersByTime(4_999)
        expect(requests()).toEqual([])
        vi.advanceTimersByTime(1)
        expect(requests()).toHaveLength(1)
    })
})

describe('what gets enqueued', function () {
    beforeEach(function start() {
        startLockfileWatcher({ db: handle.db, rootPaths: [rootPath], debounceMs: DEBOUNCE })
    })

    it('targets the project the lockfile belongs to', function () {
        emit('change', join(rootPath, 'web', 'package-lock.json'))
        vi.advanceTimersByTime(DEBOUNCE)
        expect(requests()[0]).toMatchObject({ projectId: makeProjectId('root-1', 'web'), rootId: null })
    })

    it('names the project it enqueued for', function () {
        emit('change', join(rootPath, 'web', 'package-lock.json'))
        vi.advanceTimersByTime(DEBOUNCE)
        expect(logLines()).toContain('[watcher] enqueued scan for web')
    })

    // A lockfile in a subdirectory of a known project (a workspace package, say) belongs to that project.
    it('attributes a lockfile below a known project to that project', function () {
        emit('change', join(rootPath, 'web', 'packages', 'ui', 'package-lock.json'))
        vi.advanceTimersByTime(DEBOUNCE)
        expect(requests()[0]).toMatchObject({ projectId: makeProjectId('root-1', 'web') })
    })

    // The interesting case: a project that does not exist in the database yet. Enqueueing a full sweep
    // rather than dropping the event is what lets a brand-new project get scanned without waiting for
    // the next scheduled discovery pass.
    it('falls back to a full sweep for a lockfile in an unknown directory', function () {
        emit('change', join(rootPath, 'brand-new', 'package-lock.json'))
        vi.advanceTimersByTime(DEBOUNCE)
        expect(requests()[0]).toMatchObject({ projectId: null, rootId: null })
        expect(logLines().some(function m(l) { return l.includes('enqueued full sweep for unknown project') })).toBe(true)
    })

    it('falls back to a full sweep when the lockfile sits above every known project', function () {
        emit('change', join(rootPath, 'package-lock.json'))
        vi.advanceTimersByTime(DEBOUNCE)
        expect(requests()[0]).toMatchObject({ projectId: null })
    })

    // A project whose root was not opted into is not this watcher's business, even though listProjects
    // returns it — findProjectForDir skips projects whose root is absent from the watched set.
    it('ignores a project under a root that was not opted into', async function () {
        const other = await makeTree(handle.dir, 'other', { 'tool/package.json': PKG_JSON })
        upsertRoot(handle.db, { id: 'root-2', path: other, label: null, createdAt: T0 })
        seedProject(handle.db, {
            id: makeProjectId('root-2', 'tool'),
            rootId: 'root-2',
            relPath: 'tool',
            name: 'tool'
        })
        emit('change', join(other, 'tool', 'package-lock.json'))
        vi.advanceTimersByTime(DEBOUNCE)
        expect(requests()[0]).toMatchObject({ projectId: null })
    })
})

describe('stopping', function () {
    it('closes the underlying watcher', async function () {
        const watcher = startLockfileWatcher({ db: handle.db, rootPaths: [rootPath], debounceMs: DEBOUNCE })
        await watcher.stop()
        expect(activeWatch().closed).toBe(true)
    })

    // Otherwise a debounce timer armed just before shutdown would fire against a closed database.
    it('cancels pending debounce timers so no scan is enqueued after stop', async function () {
        const watcher = startLockfileWatcher({ db: handle.db, rootPaths: [rootPath], debounceMs: DEBOUNCE })
        emit('change', join(rootPath, 'web', 'package-lock.json'))
        await watcher.stop()
        vi.advanceTimersByTime(DEBOUNCE * 2)
        expect(requests()).toEqual([])
    })
})
