import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getConfigValue, setConfigValue } from '@sentinello/db'
import { LEGACY_SOURCE_CONFIG_KEYS, STABLE_ECOSYSTEMS, sourceStatusKey, type SourceStatus } from '@sentinello/core'
import { closePortalTestDb, openPortalTestDb, T0, HOUR, type PortalTestDb } from './portal-test-db.fixture'
import { readSourceCellStatus } from './source-status'
import { isRefreshPending } from './source-refresh'

// The Settings → Sources matrix reads each cache-backed cell's sync status. Gemnasium is one download for
// every language and the worker writes its one status under the npm cell's key, so a Python, Go, Rust or
// Ruby gemnasium cell has no key of its own: reading one showed "never refreshed" after a successful sync,
// and a Refresh click on it never finished (SENTINEL-142).

function status(overrides: Partial<SourceStatus> = {}): SourceStatus {
    return { seedComplete: true, normalizerVersion: 8, recordCount: 1200, refreshedAt: T0, syncStartedAt: null, lastError: null, ...overrides }
}

let handle: PortalTestDb

beforeEach(async function setup() {
    handle = await openPortalTestDb('portal-source-status')
})

afterEach(async function teardown() {
    await closePortalTestDb(handle)
})

describe('readSourceCellStatus', function () {
    it('reads gemnasium\'s one status for every language row', function () {
        const written = status()
        setConfigValue(handle.db, sourceStatusKey('gemnasium', 'npm'), written)
        for (const eco of STABLE_ECOSYSTEMS) {
            expect(readSourceCellStatus(handle.db, 'gemnasium', eco.id)).toEqual(written)
        }
        // The key the page used to read for a non-npm row holds nothing.
        expect(getConfigValue(handle.db, sourceStatusKey('gemnasium', 'PyPI'))).toBeNull()
    })

    it('reads each OSV language from its own status', function () {
        setConfigValue(handle.db, sourceStatusKey('osv', 'PyPI'), status({ recordCount: 7 }))
        expect(readSourceCellStatus(handle.db, 'osv', 'PyPI')?.recordCount).toBe(7)
        expect(readSourceCellStatus(handle.db, 'osv', 'RubyGems')).toBeNull()
    })

    it('falls back to the legacy flat key for the npm row only, until the worker migrates it', function () {
        setConfigValue(handle.db, LEGACY_SOURCE_CONFIG_KEYS.osvStatus, status({ recordCount: 3 }))
        setConfigValue(handle.db, LEGACY_SOURCE_CONFIG_KEYS.gemnasiumStatus, status({ recordCount: 4 }))
        expect(readSourceCellStatus(handle.db, 'osv', 'npm')?.recordCount).toBe(3)
        expect(readSourceCellStatus(handle.db, 'gemnasium', 'npm')?.recordCount).toBe(4)
        expect(readSourceCellStatus(handle.db, 'osv', 'Go')).toBeNull()
    })

    it('has no status for a source that keeps no cache', function () {
        expect(readSourceCellStatus(handle.db, 'npm-audit', 'npm')).toBeNull()
    })
})

describe('isRefreshPending', function () {
    it('finishes a gemnasium Ruby refresh once the shared status moves on', function () {
        setConfigValue(handle.db, sourceStatusKey('gemnasium', 'npm'), status())
        const clicked = readSourceCellStatus(handle.db, 'gemnasium', 'RubyGems')
        const baseline = { refreshedAt: clicked?.refreshedAt ?? null, lastError: clicked?.lastError ?? null }
        expect(isRefreshPending(clicked, baseline)).toBe(true)
        setConfigValue(handle.db, sourceStatusKey('gemnasium', 'npm'), status({ refreshedAt: T0 + HOUR }))
        expect(isRefreshPending(readSourceCellStatus(handle.db, 'gemnasium', 'RubyGems'), baseline)).toBe(false)
    })

    it('is pending while the worker has stamped a sync, and finishes on a new error too', function () {
        expect(isRefreshPending(status({ syncStartedAt: T0 }), null)).toBe(true)
        expect(isRefreshPending(status(), null)).toBe(false)
        const baseline = { refreshedAt: T0, lastError: null }
        expect(isRefreshPending(status({ lastError: 'download failed' }), baseline)).toBe(false)
        expect(isRefreshPending(null, { refreshedAt: null, lastError: null })).toBe(true)
    })
})
