import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openOsvDb, resolveOsvDbPath } from './osv-client'

// The OSV advisory cache is a SECOND SQLite file (osv.db) sitting beside the primary
// sentinello.sqlite, and nothing but this module decides where it goes. A disagreement here fails
// exactly the way resolveDbPath's does — silently: the worker seeds advisories into one osv.db while
// the scanner opens another, finds an empty cache, and reports every project clean.
//
// This module had no test file of its own. Every suite that touches the OSV cache passes an explicit
// path, so both resolution fallbacks and the parent-directory mkdir were never executed.
//
// process.cwd is stubbed rather than chdir'd: the pool runs each file in its own process, but chdir
// is still global to it and would leak into whatever vitest does with relative paths afterwards.

let dir: string

beforeEach(async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-osv-client-'))
})

afterEach(async function teardown() {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    await rm(dir, { recursive: true, force: true })
})

describe('resolveOsvDbPath', function () {
    it('resolves SENTINELLO_OSV_DB_PATH against the working directory', function () {
        vi.stubEnv('SENTINELLO_OSV_DB_PATH', 'data/custom-osv.db')
        vi.spyOn(process, 'cwd').mockReturnValue(dir)
        expect(resolveOsvDbPath()).toBe(resolve(dir, 'data/custom-osv.db'))
    })

    // A blank env var must fall through to the default rather than being trimmed to '' and resolved
    // against the working directory, which would hand back the working DIRECTORY as the database path.
    it('ignores a whitespace-only SENTINELLO_OSV_DB_PATH', function () {
        vi.stubEnv('SENTINELLO_OSV_DB_PATH', '   ')
        vi.stubEnv('SENTINELLO_DB_PATH', join(dir, 'sentinello.sqlite'))
        expect(resolveOsvDbPath()).toBe(join(dir, 'osv.db'))
    })

    // The sibling rule is the whole contract: wherever the primary database lands, osv.db lands next
    // to it. Both processes derive it this way instead of each computing its own data directory.
    it('defaults to osv.db beside the primary database', function () {
        vi.stubEnv('SENTINELLO_OSV_DB_PATH', undefined)
        vi.stubEnv('SENTINELLO_DB_PATH', join(dir, 'nested', 'sentinello.sqlite'))
        expect(resolveOsvDbPath()).toBe(join(dir, 'nested', 'osv.db'))
    })
})

describe('openOsvDb', function () {
    // First boot has no data directory at all. If the mkdir were dropped, better-sqlite3 would throw
    // on open and the worker would die before arming cron rather than seeding an empty cache.
    it('creates the parent directory when it is missing', function () {
        const path = join(dir, 'made', 'up', 'osv.db')
        expect(existsSync(join(dir, 'made', 'up'))).toBe(false)
        const opened = openOsvDb(path)
        try {
            expect(opened.dbPath).toBe(path)
            expect(existsSync(path)).toBe(true)
        } finally {
            opened.sqlite.close()
        }
    })
})
