import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    getConfigValue,
    listRoots,
    openDb,
    runMigrations,
    upsertProject,
    upsertRoot,
    rootId,
    type DrizzleDb,
    type SqliteDb
} from '@sentinello/db'
import {
    CONFIG_KEYS,
    discoverDockerRoots,
    intervalHoursToCron,
    loadConfigFile,
    pruneDockerRoots,
    seedFromConfig,
    type SentinelloConfig
} from './config-loader'

// Three separable concerns live in this file, and each has a way of going quietly wrong.
//
// loadConfigFile picks the first of three candidate filenames and validates with zod — a malformed
// config must fail loudly at boot rather than half-applying.
//
// seedFromConfig runs on FIRST BOOT ONLY. If that guard broke, every worker restart would overwrite
// whatever the operator had since changed in the portal, which is a silent settings rollback.
//
// The docker root functions add and remove roots based on what is mounted under /roots, and removal
// cascades to every project, scan and finding underneath. The scope limit is what stops that cascade
// reaching a root the operator added by hand that merely happens to be missing right now.
//
// node:fs is partially mocked: existsSync/readdirSync default to the real implementations so
// loadConfigFile still reads real temp files, and only the docker cases override them.

vi.mock('node:fs', async function mockFs(importOriginal) {
    const actual = await importOriginal<typeof import('node:fs')>()
    return {
        ...actual,
        existsSync: vi.fn(actual.existsSync),
        readdirSync: vi.fn(actual.readdirSync)
    }
})

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'db', 'drizzle')

const T0 = Date.UTC(2026, 0, 1)

let db: DrizzleDb
let sqlite: SqliteDb
let dir: string

// Makes the module believe it is inside a container with the given directories mounted at /roots.
function pretendDocker(mountNames: string[] | null): void {
    vi.mocked(existsSync).mockImplementation(function fakeExists(p) {
        const path = String(p)
        if (path === '/.dockerenv') return true
        if (path === '/roots') return mountNames !== null
        return false
    })
    vi.mocked(readdirSync).mockImplementation(function fakeReaddir() {
        return (mountNames || []).map(function toDirent(name) {
            return { name, isDirectory: () => !name.endsWith('.txt') }
        }) as unknown as ReturnType<typeof readdirSync>
    })
}

function writeConfig(filename: string, contents: string): void {
    writeFileSync(join(dir, filename), contents, 'utf8')
}

beforeEach(async function setup() {
    vi.restoreAllMocks()
    dir = await mkdtemp(join(tmpdir(), 'sentinello-worker-config-'))
    const opened = openDb({ dbPath: join(dir, 'test.sqlite') })
    db = opened.db
    sqlite = opened.sqlite
    runMigrations(db, { migrationsFolder: MIGRATIONS })
})

afterEach(async function teardown() {
    vi.restoreAllMocks()
    sqlite.close()
    await rm(dir, { recursive: true, force: true })
})

describe('loadConfigFile', function () {
    it('returns null when no config file is present', function () {
        expect(loadConfigFile(dir)).toBeNull()
    })

    it('reads a YAML config', function () {
        writeConfig('sentinello.config.yaml', 'parallelism: 8\nwatcherEnabled: true\n')
        expect(loadConfigFile(dir)).toEqual({ parallelism: 8, watcherEnabled: true })
    })

    it('reads a .yml config', function () {
        writeConfig('sentinello.config.yml', 'parallelism: 2\n')
        expect(loadConfigFile(dir)?.parallelism).toBe(2)
    })

    it('reads a JSON config', function () {
        writeConfig('sentinello.config.json', '{"parallelism": 3}')
        expect(loadConfigFile(dir)?.parallelism).toBe(3)
    })

    // Candidate order is fixed, so an operator with two files present gets a predictable answer
    // rather than one that depends on directory listing order.
    it('prefers .yaml over .yml and .json', function () {
        writeConfig('sentinello.config.yaml', 'parallelism: 1\n')
        writeConfig('sentinello.config.yml', 'parallelism: 2\n')
        writeConfig('sentinello.config.json', '{"parallelism": 3}')
        expect(loadConfigFile(dir)?.parallelism).toBe(1)
    })

    it('reads roots with optional labels', function () {
        writeConfig('sentinello.config.yaml', 'roots:\n  - path: /srv/a\n    label: Alpha\n  - path: /srv/b\n')
        expect(loadConfigFile(dir)?.roots).toEqual([
            { path: '/srv/a', label: 'Alpha' },
            { path: '/srv/b' }
        ])
    })

    it('reads a full schedule', function () {
        writeConfig('sentinello.config.yaml', 'schedule:\n  intervalHours: 6\n  startHour: 2\n  timezone: America/Argentina/Buenos_Aires\n')
        expect(loadConfigFile(dir)?.schedule).toEqual({
            intervalHours: 6,
            startHour: 2,
            timezone: 'America/Argentina/Buenos_Aires'
        })
    })

    // A bad config must stop the boot rather than silently applying half of itself.
    it('throws on an interval that is not one of the allowed values', function () {
        writeConfig('sentinello.config.yaml', 'schedule:\n  intervalHours: 5\n')
        expect(function load() { loadConfigFile(dir) }).toThrow()
    })

    it('throws on a startHour outside 0-23', function () {
        writeConfig('sentinello.config.yaml', 'schedule:\n  intervalHours: 6\n  startHour: 24\n')
        expect(function load() { loadConfigFile(dir) }).toThrow()
    })

    it('throws on a non-positive parallelism', function () {
        writeConfig('sentinello.config.yaml', 'parallelism: 0\n')
        expect(function load() { loadConfigFile(dir) }).toThrow()
    })

    it('throws on a root with an empty path', function () {
        writeConfig('sentinello.config.yaml', 'roots:\n  - path: ""\n')
        expect(function load() { loadConfigFile(dir) }).toThrow()
    })

    it('throws on malformed JSON', function () {
        writeConfig('sentinello.config.json', '{not json')
        expect(function load() { loadConfigFile(dir) }).toThrow()
    })
})

describe('seedFromConfig — the first-boot guard', function () {
    // The guard that stops a restart from reverting the operator's portal edits.
    it('does nothing at all once the database already has a root', function () {
        upsertRoot(db, { id: 'existing', path: '/already/here', label: 'Set in portal', createdAt: T0 })
        seedFromConfig(db, { roots: [{ path: '/srv/new' }], parallelism: 99 }, T0)

        expect(listRoots(db)).toHaveLength(1)
        expect(listRoots(db)[0]?.path).toBe('/already/here')
        expect(getConfigValue(db, CONFIG_KEYS.parallelism)).toBeNull()
    })

    it('seeds roots on a first boot', function () {
        seedFromConfig(db, { roots: [{ path: '/srv/a', label: 'Alpha' }, { path: '/srv/b' }] }, T0)
        const roots = listRoots(db)
        expect(roots).toHaveLength(2)
        expect(roots.find(function a(r) { return r.path === '/srv/a' })?.label).toBe('Alpha')
        expect(roots.find(function b(r) { return r.path === '/srv/b' })?.label).toBeNull()
    })

    it('stores root paths as absolute', function () {
        seedFromConfig(db, { roots: [{ path: 'relative/dir' }] }, T0)
        expect(listRoots(db)[0]?.path).toBe(resolve('relative/dir'))
    })

    it('derives the root id from the absolute path', function () {
        seedFromConfig(db, { roots: [{ path: '/srv/a' }] }, T0)
        expect(listRoots(db)[0]?.id).toBe(rootId('/srv/a'))
    })

    it('stamps the supplied timestamp', function () {
        seedFromConfig(db, { roots: [{ path: '/srv/a' }] }, T0)
        expect(listRoots(db)[0]?.createdAt).toBe(T0)
    })
})

describe('seedFromConfig — settings', function () {
    function seed(config: SentinelloConfig): void {
        seedFromConfig(db, config, T0)
    }

    it('defaults an omitted startHour to 0 rather than leaving it undefined', function () {
        seed({ schedule: { intervalHours: 6 } })
        expect(getConfigValue(db, CONFIG_KEYS.schedule)).toEqual({
            intervalHours: 6,
            startHour: 0,
            timezone: undefined
        })
    })

    it('keeps an explicit startHour and timezone', function () {
        seed({ schedule: { intervalHours: 12, startHour: 9, timezone: 'UTC' } })
        expect(getConfigValue(db, CONFIG_KEYS.schedule)).toEqual({
            intervalHours: 12,
            startHour: 9,
            timezone: 'UTC'
        })
    })

    it('seeds parallelism, ignore list and portal url', function () {
        seed({ parallelism: 8, globalIgnore: ['vendor'], portalBaseUrl: 'https://portal.example.test' })
        expect(getConfigValue(db, CONFIG_KEYS.parallelism)).toBe(8)
        expect(getConfigValue(db, CONFIG_KEYS.globalIgnore)).toEqual(['vendor'])
        expect(getConfigValue(db, CONFIG_KEYS.portalBaseUrl)).toBe('https://portal.example.test')
    })

    // The scan-retention window drives an irreversible delete, so seeding it from the config file has
    // to actually land — a silently dropped key would leave the worker on the 90-day default while the
    // operator believed their file had set something else.
    it('seeds the scan retention window', function () {
        seed({ scanRetentionDays: 30 })
        expect(getConfigValue(db, CONFIG_KEYS.scanRetentionDays)).toBe(30)
    })

    it('leaves the retention window unset when the config file omits it', function () {
        seed({ parallelism: 8 })
        expect(getConfigValue(db, CONFIG_KEYS.scanRetentionDays)).toBeNull()
    })

    // An explicitly empty ignore list is a real instruction, distinct from omitting the key.
    it('seeds an empty ignore list rather than treating it as absent', function () {
        seed({ globalIgnore: [] })
        expect(getConfigValue(db, CONFIG_KEYS.globalIgnore)).toEqual([])
    })

    it('seeds watcherEnabled false rather than treating it as absent', function () {
        seed({ watcherEnabled: false })
        expect(getConfigValue(db, CONFIG_KEYS.watcherEnabled)).toBe(false)
    })

    // The watcher is opt-in per root: an empty array means "watch nothing", NOT "watch all".
    it('seeds an empty watcherRoots list as a real instruction', function () {
        seed({ watcherRoots: [] })
        expect(getConfigValue(db, CONFIG_KEYS.watcherRoots)).toEqual([])
    })

    it('stores watcher roots as absolute paths', function () {
        seed({ watcherRoots: ['relative/dir'] })
        expect(getConfigValue(db, CONFIG_KEYS.watcherRoots)).toEqual([resolve('relative/dir')])
    })

    it('leaves untouched keys unset', function () {
        seed({ parallelism: 8 })
        expect(getConfigValue(db, CONFIG_KEYS.globalIgnore)).toBeNull()
        expect(getConfigValue(db, CONFIG_KEYS.schedule)).toBeNull()
    })

    it('does nothing for an empty config', function () {
        seed({})
        expect(listRoots(db)).toEqual([])
        expect(getConfigValue(db, CONFIG_KEYS.parallelism)).toBeNull()
    })
})

describe('discoverDockerRoots', function () {
    it('does nothing outside a container', function () {
        vi.mocked(existsSync).mockReturnValue(false)
        discoverDockerRoots(db, T0)
        expect(listRoots(db)).toEqual([])
    })

    it('does nothing when /roots is not mounted', function () {
        pretendDocker(null)
        discoverDockerRoots(db, T0)
        expect(listRoots(db)).toEqual([])
    })

    it('registers each mounted directory as a root labelled by its name', function () {
        pretendDocker(['alpha', 'beta'])
        discoverDockerRoots(db, T0)
        const roots = listRoots(db)
        expect(roots.map(function p(r) { return r.path }).sort()).toEqual(['/roots/alpha', '/roots/beta'])
        expect(roots.find(function a(r) { return r.path === '/roots/alpha' })?.label).toBe('alpha')
    })

    it('ignores files and dot-directories', function () {
        pretendDocker(['alpha', '.hidden', 'notes.txt'])
        discoverDockerRoots(db, T0)
        expect(listRoots(db).map(function p(r) { return r.path })).toEqual(['/roots/alpha'])
    })

    // Re-registering would overwrite the label an operator set in the portal.
    it('leaves an already-registered root untouched', function () {
        upsertRoot(db, { id: rootId('/roots/alpha'), path: '/roots/alpha', label: 'Renamed by operator', createdAt: T0 })
        pretendDocker(['alpha'])
        discoverDockerRoots(db, T0 + 1000)
        const roots = listRoots(db)
        expect(roots).toHaveLength(1)
        expect(roots[0]?.label).toBe('Renamed by operator')
        expect(roots[0]?.createdAt).toBe(T0)
    })

    it('is a no-op when /roots is empty', function () {
        pretendDocker([])
        discoverDockerRoots(db, T0)
        expect(listRoots(db)).toEqual([])
    })
})

describe('pruneDockerRoots', function () {
    it('reports nothing removed outside a container', function () {
        vi.mocked(existsSync).mockReturnValue(false)
        upsertRoot(db, { id: 'r', path: '/roots/gone', label: null, createdAt: T0 })
        expect(pruneDockerRoots(db)).toEqual({ removed: 0 })
        expect(listRoots(db)).toHaveLength(1)
    })

    it('reports nothing removed when /roots is not mounted', function () {
        pretendDocker(null)
        upsertRoot(db, { id: 'r', path: '/roots/gone', label: null, createdAt: T0 })
        expect(pruneDockerRoots(db)).toEqual({ removed: 0 })
        expect(listRoots(db)).toHaveLength(1)
    })

    it('removes a root whose mount went away', function () {
        upsertRoot(db, { id: rootId('/roots/alpha'), path: '/roots/alpha', label: null, createdAt: T0 })
        upsertRoot(db, { id: rootId('/roots/beta'), path: '/roots/beta', label: null, createdAt: T0 })
        pretendDocker(['alpha'])
        expect(pruneDockerRoots(db)).toEqual({ removed: 1 })
        expect(listRoots(db).map(function p(r) { return r.path })).toEqual(['/roots/alpha'])
    })

    // The scope limit is the safety property: a root the operator added by hand, pointing anywhere
    // other than /roots, must survive even though it is not in the mounted set.
    it('never touches a root outside /roots', function () {
        upsertRoot(db, { id: 'manual', path: '/srv/manually-added', label: null, createdAt: T0 })
        upsertRoot(db, { id: 'lookalike', path: '/rootsomething/else', label: null, createdAt: T0 })
        pretendDocker([])
        expect(pruneDockerRoots(db)).toEqual({ removed: 0 })
        expect(listRoots(db)).toHaveLength(2)
    })

    it('removes everything under a pruned root', function () {
        upsertRoot(db, { id: rootId('/roots/alpha'), path: '/roots/alpha', label: null, createdAt: T0 })
        upsertProject(db, {
            id: 'project-1',
            rootId: rootId('/roots/alpha'),
            relPath: 'app',
            name: 'app',
            alias: null,
            packageManager: 'npm',
            nvmrcVersion: null,
            gitBranch: null,
            ecosystems: ['npm'],
            muted: false,
            tags: [],
            createdAt: T0,
            updatedAt: T0
        })
        pretendDocker([])
        expect(pruneDockerRoots(db)).toEqual({ removed: 1 })
        expect(listRoots(db)).toEqual([])
    })

    it('removes several stale roots at once', function () {
        for (const name of ['a', 'b', 'c']) {
            upsertRoot(db, { id: rootId('/roots/' + name), path: '/roots/' + name, label: null, createdAt: T0 })
        }
        pretendDocker(['b'])
        expect(pruneDockerRoots(db)).toEqual({ removed: 2 })
        expect(listRoots(db).map(function p(r) { return r.path })).toEqual(['/roots/b'])
    })

    // The mounted set is built from DIRECTORIES that are not dot-entries, mirroring discoverDockerRoots
    // exactly. Both filters matter here in a way they do not there: discoverDockerRoots merely declines
    // to CREATE a root for a stray file or a `.DS_Store`, while this function reads the same set as
    // "everything still mounted" — so a filter dropped here does not add a root, it stops one from
    // being recognised and hard-deletes it along with every project, scan and finding underneath.
    it('treats a plain file and a dot-entry as not mounted', function () {
        upsertRoot(db, { id: rootId('/roots/notes.txt'), path: '/roots/notes.txt', label: null, createdAt: T0 })
        upsertRoot(db, { id: rootId('/roots/.hidden'), path: '/roots/.hidden', label: null, createdAt: T0 })
        upsertRoot(db, { id: rootId('/roots/alpha'), path: '/roots/alpha', label: null, createdAt: T0 })
        pretendDocker(['alpha', 'notes.txt', '.hidden'])
        expect(pruneDockerRoots(db)).toEqual({ removed: 2 })
        expect(listRoots(db).map(function p(r) { return r.path })).toEqual(['/roots/alpha'])
    })
})

describe('intervalHoursToCron', function () {
    // Hourly ignores the anchor — there is no hour to anchor to.
    it('fires every hour for a 1-hour interval regardless of anchor', function () {
        expect(intervalHoursToCron(1)).toBe('0 * * * *')
        expect(intervalHoursToCron(1, 17)).toBe('0 * * * *')
    })

    // Listing the exact hours is what makes the cadence begin at the operator's chosen time of day
    // rather than at midnight.
    it('anchors the cadence to the chosen hour', function () {
        expect(intervalHoursToCron(6, 2)).toBe('0 2,8,14,20 * * *')
        expect(intervalHoursToCron(24, 9)).toBe('0 9 * * *')
        expect(intervalHoursToCron(12, 3)).toBe('0 3,15 * * *')
        expect(intervalHoursToCron(3, 1)).toBe('0 1,4,7,10,13,16,19,22 * * *')
    })

    it('defaults the anchor to midnight', function () {
        expect(intervalHoursToCron(6)).toBe('0 0,6,12,18 * * *')
        expect(intervalHoursToCron(24)).toBe('0 0 * * *')
    })

    it('does not wrap past the end of the day', function () {
        expect(intervalHoursToCron(6, 20)).toBe('0 20 * * *')
        expect(intervalHoursToCron(12, 23)).toBe('0 23 * * *')
    })

    // A bad anchor must still yield a valid cron expression; the scheduler cannot recover from a
    // malformed one.
    it('clamps an out-of-range anchor', function () {
        expect(intervalHoursToCron(24, -5)).toBe('0 0 * * *')
        expect(intervalHoursToCron(24, 99)).toBe('0 23 * * *')
    })

    it('truncates a fractional anchor', function () {
        expect(intervalHoursToCron(24, 9.7)).toBe('0 9 * * *')
    })

    it('falls back to midnight for a non-finite anchor', function () {
        expect(intervalHoursToCron(24, Number.NaN)).toBe('0 0 * * *')
        expect(intervalHoursToCron(24, Number.POSITIVE_INFINITY)).toBe('0 0 * * *')
    })
})
