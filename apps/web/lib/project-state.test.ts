import { describe, expect, it } from 'vitest'
import type { ScanState } from '@sentinello/core'
import type { ProjectCatalogRow } from '@sentinello/db'
import { isProjectHealthy, scanStateBadge, scanStateReasonsText } from './project-state'

function row(scanState: ScanState): ProjectCatalogRow {
    return { scanState } as ProjectCatalogRow
}

const SCANNED: ScanState = { state: 'scanned', reasons: [] }
const CANNOT: ScanState = {
    state: 'cannot_scan',
    reasons: [
        { source: 'npm-audit', ecosystem: null, reasonCode: 'no_lockfile', side: 'project' },
        { source: null, ecosystem: 'npm', reasonCode: 'no_lockfile', side: 'project' }
    ]
}
const PARTIAL: ScanState = {
    state: 'partial',
    reasons: [
        { source: 'osv', ecosystem: null, reasonCode: 'osv_db_not_seeded', side: 'environment' },
        { source: null, ecosystem: 'npm', reasonCode: 'not_yet_run', side: null }
    ]
}
const SIDES = { project: 'the project', environment: 'this install' }

describe('isProjectHealthy', function () {
    it('is healthy only when the project was fully scanned and nothing was found', function () {
        expect(isProjectHealthy(row(SCANNED), 0)).toBe(true)
        expect(isProjectHealthy(row(SCANNED), 3)).toBe(false)
    })

    // Zero findings because nothing could look is not clean: a project that cannot be scanned is never
    // hidden as healthy.
    it('is not healthy when the project cannot be scanned, cannot be fully scanned, or was never scanned', function () {
        expect(isProjectHealthy(row(CANNOT), 0)).toBe(false)
        expect(isProjectHealthy(row(PARTIAL), 0)).toBe(false)
        expect(isProjectHealthy(row({ state: 'not_scanned_yet', reasons: [] }), 0)).toBe(false)
    })
})

describe('the State column — cannot be scanned', function () {
    it('names each state but a fully scanned one', function () {
        expect(scanStateBadge(CANNOT)).toBe('cannotScan')
        expect(scanStateBadge(PARTIAL)).toBe('partial')
        expect(scanStateBadge({ state: 'not_scanned_yet', reasons: [] })).toBe('notScannedYet')
        expect(scanStateBadge(SCANNED)).toBeNull()
    })

    it('lists the reasons once each, with whose side they are on, in the reader locale', function () {
        expect(scanStateReasonsText(CANNOT, 'en', SIDES)).toBe('No lockfile (the project)')
        expect(scanStateReasonsText(PARTIAL, 'en', SIDES)).toBe('OSV database not downloaded yet (this install) · npm: Has not run yet')
        expect(scanStateReasonsText(CANNOT, 'es', { project: 'el proyecto', environment: 'esta instalación' })).toBe('Sin lockfile (el proyecto)')
    })
})
