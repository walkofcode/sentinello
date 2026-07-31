import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb, resolveDbPath, resolveLockPath, walCheckpoint } from './client'

// Path resolution is the single thing tying apps/web and apps/worker to the same file. Both call
// resolveDbPath(); neither computes its own. When it disagrees between the two processes nothing
// errors — each app quietly opens its own private database, the portal writes scan_requests the
// worker never sees, and the symptom is "the Scan button does nothing".
//
// The suites that use openDb all pass an explicit dbPath, so every resolution branch here was cold.
//
// process.cwd is stubbed rather than chdir'd: the pool runs each file in its own process, but chdir
// is still global to it and would leak into whatever vitest does with relative paths afterwards.

let dir: string

beforeEach(async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-client-'))
})

afterEach(async function teardown() {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    await rm(dir, { recursive: true, force: true })
})

function atCwd(path: string): void {
    vi.spyOn(process, 'cwd').mockReturnValue(path)
}

describe('resolveDbPath', function () {
    it('takes an absolute SENTINELLO_DB_PATH verbatim', function () {
        vi.stubEnv('SENTINELLO_DB_PATH', join(dir, 'custom.sqlite'))
        expect(resolveDbPath()).toBe(join(dir, 'custom.sqlite'))
    })

    it('resolves a relative SENTINELLO_DB_PATH against the working directory', function () {
        vi.stubEnv('SENTINELLO_DB_PATH', 'data/other.sqlite')
        atCwd(dir)
        expect(resolveDbPath()).toBe(resolve(dir, 'data/other.sqlite'))
    })

    it('trims surrounding whitespace before deciding', function () {
        vi.stubEnv('SENTINELLO_DB_PATH', '  ' + join(dir, 'padded.sqlite') + '  ')
        expect(resolveDbPath()).toBe(join(dir, 'padded.sqlite'))
    })

    // A blank env var must fall through to the marker walk rather than resolving to the cwd itself.
    // Docker-compose writes SENTINELLO_DB_PATH= with no value when the operator leaves it unset.
    it.each([
        ['empty', ''],
        ['whitespace only', '   ']
    ])('ignores a %s SENTINELLO_DB_PATH and falls back to the marker walk', async function (_label, value) {
        vi.stubEnv('SENTINELLO_DB_PATH', value)
        await writeFile(join(dir, 'pnpm-workspace.yaml'), 'packages: []\n', 'utf8')
        atCwd(dir)
        expect(resolveDbPath()).toBe(join(dir, 'data/sentinello.sqlite'))
    })

    it('finds the marker in the working directory itself', async function () {
        vi.stubEnv('SENTINELLO_DB_PATH', undefined)
        await writeFile(join(dir, 'pnpm-workspace.yaml'), 'packages: []\n', 'utf8')
        atCwd(dir)
        expect(resolveDbPath()).toBe(join(dir, 'data/sentinello.sqlite'))
    })

    // The whole point of the walk: apps/web and apps/worker each run with their own cwd, several
    // levels below the marker, and both have to land on the same file.
    it('walks up several levels to the marker so both apps agree on one file', async function () {
        vi.stubEnv('SENTINELLO_DB_PATH', undefined)
        await writeFile(join(dir, 'pnpm-workspace.yaml'), 'packages: []\n', 'utf8')
        const web = join(dir, 'apps', 'web')
        const worker = join(dir, 'apps', 'worker')
        await mkdir(web, { recursive: true })
        await mkdir(worker, { recursive: true })

        atCwd(web)
        const fromWeb = resolveDbPath()
        atCwd(worker)
        const fromWorker = resolveDbPath()

        expect(fromWeb).toBe(join(dir, 'data/sentinello.sqlite'))
        expect(fromWorker).toBe(fromWeb)
    })

    // Terminates rather than looping forever when dirname() stops changing at the filesystem root.
    // mkdtemp lives under the OS temp dir, which has no pnpm-workspace.yaml above it.
    it('falls back to the working directory when the walk reaches the root without a marker', function () {
        vi.stubEnv('SENTINELLO_DB_PATH', undefined)
        atCwd(dir)
        expect(resolveDbPath()).toBe(join(dir, 'data/sentinello.sqlite'))
    })
})

describe('resolveLockPath', function () {
    // The lock sits beside the database rather than at a fixed path, so two instances pointed at
    // different data directories do not contend — and two pointed at the same one do.
    it('places the lock beside the database it is given', function () {
        expect(resolveLockPath(join(dir, 'data', 'sentinello.sqlite'))).toBe(join(dir, 'data', 'sentinello.worker.lock'))
    })

    it('resolves the database itself when given no argument', async function () {
        vi.stubEnv('SENTINELLO_DB_PATH', undefined)
        await writeFile(join(dir, 'pnpm-workspace.yaml'), 'packages: []\n', 'utf8')
        atCwd(dir)
        expect(resolveLockPath()).toBe(join(dir, 'data', 'sentinello.worker.lock'))
    })
})

describe('openDb', function () {
    it('creates the parent directory when it does not exist yet', function () {
        const nested = join(dir, 'a', 'b', 'c', 'sentinello.sqlite')
        expect(existsSync(join(dir, 'a'))).toBe(false)

        const opened = openDb({ dbPath: nested })
        try {
            expect(existsSync(nested)).toBe(true)
            expect(opened.dbPath).toBe(nested)
        } finally {
            opened.sqlite.close()
        }
    })

    // WAL is what lets the portal read while the worker writes. Both processes open the same file, so
    // this is applied on every open rather than once at creation.
    it('applies the WAL pragma block by default', function () {
        const opened = openDb({ dbPath: join(dir, 'test.sqlite') })
        try {
            expect(String(opened.sqlite.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal')
            expect(opened.sqlite.pragma('synchronous', { simple: true })).toBe(1)
            expect(opened.sqlite.pragma('foreign_keys', { simple: true })).toBe(1)
            expect(opened.sqlite.pragma('busy_timeout', { simple: true })).toBe(5000)
        } finally {
            opened.sqlite.close()
        }
    })

    // Only journal_mode and synchronous can tell the two paths apart, and the pairing above is
    // deliberate: WAL with synchronous=NORMAL is the combination that is durable across a process
    // crash but not a power loss. The other two lines of that pragma block are already better-sqlite3
    // defaults — it opens with foreign_keys ON (unlike bare SQLite, which defaults OFF) and a 5000ms
    // busy timeout — so asserting them cannot distinguish "applied" from "skipped", which is why they
    // are checked above but not here.
    //
    // Uses a fresh file: journal_mode lives in the database header, so reopening an already-WAL file
    // reports WAL whether or not the pragma ran.
    it('skips the pragma block when applyPragmas is false', function () {
        const opened = openDb({ dbPath: join(dir, 'raw.sqlite'), applyPragmas: false })
        try {
            expect(String(opened.sqlite.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('delete')
            expect(opened.sqlite.pragma('synchronous', { simple: true })).toBe(2)
        } finally {
            opened.sqlite.close()
        }
    })

    it('resolves the path itself when given no dbPath', async function () {
        vi.stubEnv('SENTINELLO_DB_PATH', join(dir, 'from-env.sqlite'))
        const opened = openDb()
        try {
            expect(opened.dbPath).toBe(join(dir, 'from-env.sqlite'))
            expect(existsSync(join(dir, 'from-env.sqlite'))).toBe(true)
        } finally {
            opened.sqlite.close()
        }
    })

    // Both handles in OpenDbResult must be the same connection: the worker writes through drizzle and
    // checkpoints through the raw handle, and two connections would checkpoint the wrong WAL.
    // DrizzleDb deliberately does not expose $client (it is typed as the abstract handle so it stays
    // assignable from the tx handle drizzle passes to transaction callbacks), so this writes through
    // one and reads back through the other rather than comparing references.
    it('returns a drizzle handle bound to the same connection', function () {
        const opened = openDb({ dbPath: join(dir, 'test.sqlite') })
        try {
            opened.sqlite.exec('CREATE TABLE probe (id TEXT PRIMARY KEY)')
            opened.db.run(sql`INSERT INTO probe (id) VALUES ('a')`)
            expect(opened.sqlite.prepare('SELECT COUNT(*) AS n FROM probe').get()).toEqual({ n: 1 })
        } finally {
            opened.sqlite.close()
        }
    })
})

describe('walCheckpoint', function () {
    // Called by the worker on shutdown so the -wal sidecar is folded back into the database file
    // rather than left for the next process to recover.
    it('truncates the write-ahead log', function () {
        const opened = openDb({ dbPath: join(dir, 'test.sqlite') })
        try {
            opened.sqlite.exec('CREATE TABLE probe (id TEXT PRIMARY KEY)')
            opened.sqlite.prepare('INSERT INTO probe (id) VALUES (?)').run('a')
            expect(function checkpoint() {
                walCheckpoint(opened.sqlite)
            }).not.toThrow()
            expect(opened.sqlite.prepare('SELECT COUNT(*) AS n FROM probe').get()).toEqual({ n: 1 })
        } finally {
            opened.sqlite.close()
        }
    })
})
