import { basename, dirname, relative, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import chokidar from 'chokidar'
import {
    enqueueScanRequest,
    listProjects,
    type DrizzleDb,
    type Root,
    listRoots
} from '@sentinello/db'

// Optional lockfile watcher.
// On any modification of package-lock.json / pnpm-lock.yaml / yarn.lock under a watched root,
// debounce per-file and INSERT a scan_request row. The existing scan-request poller picks it up.
// The watcher MUST NOT call the runner directly — that would bypass the database-as-contract.

// chokidar watches the root directories recursively (chokidar.add(rootPath)). We do NOT pass glob
// patterns to chokidar.watch — globs combined with directory-add behave inconsistently across the
// chokidar v5 dual-strategy implementation and miss legitimate lockfile events. Instead, every add
// and change event is filtered through isLockfilePath() so non-lockfile edits never trigger a scan.
const LOCKFILE_BASENAMES: ReadonlySet<string> = new Set([
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock'
])
const DEFAULT_DEBOUNCE_MS = 5_000

export type WatcherHandle = {
    stop: () => Promise<void>
}

export type StartWatcherInput = {
    db: DrizzleDb
    // Required: absolute paths of roots the operator has explicitly opted into watching.
    // The watcher is opt-in per root; callers must NOT pass an empty array
    // expecting "watch all".
    rootPaths: string[]
    debounceMs?: number
}

export function startLockfileWatcher(input: StartWatcherInput): WatcherHandle {
    const db = input.db
    const debounceMs = input.debounceMs || DEFAULT_DEBOUNCE_MS
    const roots = resolveWatchedRoots(db, input.rootPaths)
    const watchablePaths: string[] = []
    for (const root of roots) {
        if (existsSync(root.path)) watchablePaths.push(root.path)
    }
    if (watchablePaths.length === 0) {
        console.warn('[watcher] no watched roots resolved; watcher inactive')
        return { stop: function stop() { return Promise.resolve() } }
    }
    const watcher = chokidar.watch(watchablePaths, {
        ignored: function isIgnored(p: string): boolean {
            // Always skip vendored / VCS directories; deeper traversal under those is wasted work
            // and produces no useful events for our purposes.
            return /(^|[\\/])(node_modules|\.git)([\\/]|$)/.test(p)
        },
        ignoreInitial: true,
        persistent: true,
        depth: 99
    })
    const debounceTimers = new Map<string, NodeJS.Timeout>()
    watcher.on('change', function onChange(filePath: string) {
        if (!isLockfilePath(filePath)) return
        scheduleEnqueue(db, roots, filePath, debounceTimers, debounceMs)
    })
    watcher.on('add', function onAdd(filePath: string) {
        if (!isLockfilePath(filePath)) return
        scheduleEnqueue(db, roots, filePath, debounceTimers, debounceMs)
    })
    watcher.on('unlink', function onUnlink(filePath: string) {
        if (!isLockfilePath(filePath)) return
        const existing = debounceTimers.get(filePath)
        if (existing) {
            clearTimeout(existing)
            debounceTimers.delete(filePath)
        }
    })
    console.log('[watcher] watching ' + watchablePaths.length + ' root(s) for lockfile changes')
    return {
        stop: async function stop() {
            for (const timer of debounceTimers.values()) clearTimeout(timer)
            debounceTimers.clear()
            await watcher.close()
        }
    }
}

function isLockfilePath(filePath: string): boolean {
    return LOCKFILE_BASENAMES.has(basename(filePath))
}

function resolveWatchedRoots(db: DrizzleDb, requested: string[]): Root[] {
    const allRoots = listRoots(db)
    const wanted = new Set(requested.map(function abs(p) {
        return resolve(p)
    }))
    return allRoots.filter(function inSet(r): boolean {
        return wanted.has(r.path)
    })
}

function scheduleEnqueue(
    db: DrizzleDb,
    roots: Root[],
    filePath: string,
    debounceTimers: Map<string, NodeJS.Timeout>,
    debounceMs: number
): void {
    const existing = debounceTimers.get(filePath)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(function fire() {
        debounceTimers.delete(filePath)
        enqueueForFile(db, roots, filePath)
    }, debounceMs)
    timer.unref()
    debounceTimers.set(filePath, timer)
}

function enqueueForFile(db: DrizzleDb, roots: Root[], filePath: string): void {
    const projectDir = dirname(resolve(filePath))
    const match = findProjectForDir(db, roots, projectDir)
    if (!match) {
        // The lockfile changed in a place not (yet) known as a project. Enqueue a full sweep so
        // discovery picks it up.
        enqueueScanRequest(db, {}, Date.now())
        console.log('[watcher] enqueued full sweep for unknown project at ' + projectDir)
        return
    }
    enqueueScanRequest(db, { projectId: match.projectId }, Date.now())
    console.log('[watcher] enqueued scan for ' + match.name)
}

function findProjectForDir(db: DrizzleDb, roots: Root[], absoluteDir: string): { projectId: string; name: string } | null {
    const projects = listProjects(db)
    for (const project of projects) {
        const root = roots.find(function id(r): boolean {
            return r.id === project.rootId
        })
        if (!root) continue
        const expected = resolve(root.path, project.relPath)
        if (expected === absoluteDir) {
            return { projectId: project.id, name: project.name }
        }
        // Also accept lockfiles sitting in a subdirectory we have not yet promoted to a project;
        // walk up from absoluteDir to see if it's under a known project.
        const rel = relative(expected, absoluteDir)
        if (rel === '' || (rel.length > 0 && !rel.startsWith('..'))) {
            return { projectId: project.id, name: project.name }
        }
    }
    return null
}
