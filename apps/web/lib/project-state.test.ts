import { describe, expect, it } from 'vitest'
import { LOCALES, SOURCE_UNAVAILABLE_REASON_CODES, reasonCodeLabel } from '@sentinello/core'
import type { ProjectCatalogRow, ProjectScanState } from '@sentinello/db'
import { isProjectHealthy, problemScanStates, scanStateLabel } from './project-state'

function state(overrides: Partial<ProjectScanState> = {}): ProjectScanState {
    return { source: 'npm-audit', finishedAt: 1, status: 'ok', reasonCode: 'ok', errorText: null, ...overrides }
}

function row(scanStates: ProjectScanState[]): ProjectCatalogRow {
    return { scanStates } as ProjectCatalogRow
}

describe('problemScanStates', function () {
    it('keeps only the sources that could not answer', function () {
        const bad = state({ source: 'osv', status: 'unauditable', reasonCode: 'osv_db_not_seeded' })
        expect(problemScanStates(row([state(), bad]))).toEqual([bad])
    })

    it('is empty when every source succeeded, so a clean project shows no badge at all', function () {
        expect(problemScanStates(row([state(), state({ source: 'osv' })]))).toEqual([])
    })
})

describe('isProjectHealthy', function () {
    it('is healthy when every source said ok and nothing was found', function () {
        expect(isProjectHealthy(row([state(), state({ source: 'osv' })]), 0)).toBe(true)
    })

    // The bug the single-latest-scan version hid: OSV won the race, reported ok, and the project was
    // filtered out of the dashboard while npm audit had actually failed on it.
    it('is not healthy when one source failed and another succeeded', function () {
        expect(isProjectHealthy(row([state({ status: 'error' }), state({ source: 'osv' })]), 0)).toBe(false)
    })

    it('is not healthy with findings, however well the scan went', function () {
        expect(isProjectHealthy(row([state()]), 3)).toBe(false)
    })

    // `every` is vacuously true on an empty array, so without the length check a project nothing has
    // ever scanned would report healthy — unexamined is not clean.
    it('is not healthy when nothing has ever scanned the project', function () {
        expect(isProjectHealthy(row([]), 0)).toBe(false)
    })
})

describe('scanStateLabel', function () {
    it('names the source for a reason that could have come from any of them', function () {
        expect(scanStateLabel(state({ source: 'osv', status: 'unauditable', reasonCode: 'no_lockfile' }), 'en'))
            .toBe('OSV · ' + reasonCodeLabel('no_lockfile', 'en'))
    })

    it('leaves the source off a reason whose own label already names it', function () {
        const label = scanStateLabel(state({ source: 'osv', status: 'unauditable', reasonCode: 'osv_db_not_seeded' }), 'en')
        expect(label).toBe('OSV database not downloaded yet')
        expect(label).not.toContain('OSV · ')
    })

    it('names the source when the reason code is missing entirely', function () {
        expect(scanStateLabel(state({ source: 'gemnasium', status: 'error', reasonCode: null }), 'en'))
            .toBe('gemnasium · ' + reasonCodeLabel(null, 'en'))
    })

    it('follows the requested locale', function () {
        expect(scanStateLabel(state({ source: 'osv', status: 'unauditable', reasonCode: 'osv_db_not_seeded' }), 'de'))
            .toBe(reasonCodeLabel('osv_db_not_seeded', 'de'))
    })

    // The prefix is dropped for these four on the strength of their labels naming their own source. If a
    // code is ever added to that list whose label does not, this fails rather than the badge quietly
    // losing the attribution — which on a multi-source install is the only thing telling them apart.
    it.each(SOURCE_UNAVAILABLE_REASON_CODES)('%s names its own source in every locale', function (code) {
        const source = code.startsWith('osv') ? 'osv' : 'gemnasium'
        for (const locale of LOCALES) {
            expect(reasonCodeLabel(code, locale).toLowerCase()).toContain(source)
        }
    })
})
