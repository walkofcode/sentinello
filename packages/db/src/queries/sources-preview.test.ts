import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sourceEnabledKey } from '@sentinello/core'
import { openDb } from '../client'
import type { DrizzleDb, SqliteDb } from '../client'
import { runMigrations } from '../migrate'
import { setConfigValue } from './config'
import { getActiveSourceCells, getRunnableSourceCells, getSourceEnabled } from './sources'

// Withdrawing an ecosystem to 'preview' must stop it running without hiding what it already found. Since 3.8
// every ecosystem is stable, so this file withdraws Python by hand to keep the availability gate proven for
// the next ecosystem that is offered in preview.
vi.mock('@sentinello/core', async function withdrawPython(importOriginal) {
    const core = await importOriginal<typeof import('@sentinello/core')>()
    return {
        ...core,
        isEcosystemStable: function isEcosystemStable(id: string) { return id !== 'PyPI' && core.isEcosystemStable(id) }
    }
})

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle')

let db: DrizzleDb
let sqlite: SqliteDb
let dir: string

beforeEach(async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-sources-preview-'))
    const opened = openDb({ dbPath: join(dir, 'test.sqlite') })
    db = opened.db
    sqlite = opened.sqlite
    runMigrations(db, { migrationsFolder: MIGRATIONS })
})

afterEach(async function teardown() {
    sqlite.close()
    await rm(dir, { recursive: true, force: true })
})

describe('a preview ecosystem', function () {
    // A preview ecosystem cannot be switched on, and a stored key saying otherwise is not honoured — an
    // ecosystem withdrawn because its matching reports clean for the wrong reasons must not come back
    // through a config value left behind by an earlier build.
    it('is refused however the config reads', function () {
        setConfigValue(db, sourceEnabledKey('osv', 'PyPI'), true)
        expect(getSourceEnabled(db, 'osv', 'PyPI')).toBe(false)
    })

    it('drops out of the runnable cells but stays in the visibility set', function () {
        setConfigValue(db, sourceEnabledKey('osv', 'PyPI'), true)
        expect(getActiveSourceCells(db)).toContainEqual({ source: 'osv', ecosystem: 'PyPI' })
        expect(getRunnableSourceCells(db)).not.toContainEqual({ source: 'osv', ecosystem: 'PyPI' })
    })

    // The whole point. An operator upgrading from a build that offered Python keeps that config key;
    // if it counted as remaining coverage, the invariant would wave through disabling the last cell
    // that can actually scan.
    it('leaves no runnable cell when only preview cells remain, so the invariant still bites', function () {
        setConfigValue(db, sourceEnabledKey('osv', 'PyPI'), true)
        setConfigValue(db, sourceEnabledKey('npm-audit', 'npm'), false)
        expect(getActiveSourceCells(db)).not.toEqual([])
        expect(getRunnableSourceCells(db)).toEqual([])
    })
})
