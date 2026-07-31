import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openGemnasiumDb, resolveGemnasiumDbPath } from './gemnasium-client'

// The gemnasium advisory cache is a THIRD SQLite file (gemnasium.db) beside sentinello.sqlite and
// osv.db, and nothing but this module decides where it goes. The failure mode is the one osv-client.ts
// already carries a suite for, and it is silent: the worker seeds advisories into one gemnasium.db
// while the scanner opens another, finds an empty cache, and reports every project clean.
//
// This file is the sibling osv-client.test.ts was written for in wave 11 and is a near-copy of it on
// purpose — the two modules implement the same sibling-of-the-primary-DB rule, so they should be
// pinned by the same assertions rather than each being trusted to have got it right independently.
//
// process.cwd is stubbed rather than chdir'd: the pool runs each test file in its own process, but
// chdir is still global to it and would leak into whatever vitest does with relative paths afterwards.

let dir: string

beforeEach(async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-gemnasium-client-'))
})

afterEach(async function teardown() {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    await rm(dir, { recursive: true, force: true })
})

describe('resolveGemnasiumDbPath', function () {
    it('resolves SENTINELLO_GEMNASIUM_DB_PATH against the working directory', function () {
        vi.stubEnv('SENTINELLO_GEMNASIUM_DB_PATH', 'data/custom-gemnasium.db')
        vi.spyOn(process, 'cwd').mockReturnValue(dir)
        expect(resolveGemnasiumDbPath()).toBe(resolve(dir, 'data/custom-gemnasium.db'))
    })

    // A blank env var must fall through to the default rather than being trimmed to '' and resolved
    // against the working directory, which would hand back the working DIRECTORY as the database path.
    it('ignores a whitespace-only SENTINELLO_GEMNASIUM_DB_PATH', function () {
        vi.stubEnv('SENTINELLO_GEMNASIUM_DB_PATH', '   ')
        vi.stubEnv('SENTINELLO_DB_PATH', join(dir, 'sentinello.sqlite'))
        expect(resolveGemnasiumDbPath()).toBe(join(dir, 'gemnasium.db'))
    })

    // The sibling rule is the whole contract: wherever the primary database lands, gemnasium.db lands
    // next to it. Both processes derive it this way instead of each computing its own data directory.
    it('defaults to gemnasium.db beside the primary database', function () {
        vi.stubEnv('SENTINELLO_GEMNASIUM_DB_PATH', undefined)
        vi.stubEnv('SENTINELLO_DB_PATH', join(dir, 'nested', 'sentinello.sqlite'))
        expect(resolveGemnasiumDbPath()).toBe(join(dir, 'nested', 'gemnasium.db'))
    })
})

describe('openGemnasiumDb', function () {
    // First boot has no data directory at all. If the mkdir were dropped, better-sqlite3 would throw
    // on open and the worker would die before arming cron rather than seeding an empty cache.
    it('creates the parent directory when it is missing', function () {
        const path = join(dir, 'made', 'up', 'gemnasium.db')
        expect(existsSync(join(dir, 'made', 'up'))).toBe(false)
        const opened = openGemnasiumDb(path)
        try {
            expect(opened.dbPath).toBe(path)
            expect(existsSync(path)).toBe(true)
        } finally {
            opened.sqlite.close()
        }
    })

    // The no-argument form is what the worker and the scanner both call, so the fallback to
    // resolveGemnasiumDbPath is the branch that actually decides whether they agree on one file.
    it('falls back to the resolved path when none is given', function () {
        vi.stubEnv('SENTINELLO_GEMNASIUM_DB_PATH', undefined)
        vi.stubEnv('SENTINELLO_DB_PATH', join(dir, 'sentinello.sqlite'))
        const opened = openGemnasiumDb()
        try {
            expect(opened.dbPath).toBe(join(dir, 'gemnasium.db'))
        } finally {
            opened.sqlite.close()
        }
    })
})
