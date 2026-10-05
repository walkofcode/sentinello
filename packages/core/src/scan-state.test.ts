import { describe, expect, it } from 'vitest'
import { LOCALES, REASON_CODE_VALUES } from './types'
import {
    NOT_YET_RUN_LABELS,
    REASON_SIDE,
    failureReasonCode,
    notRecheckedBecause,
    projectScanState,
    reasonSide,
    type LatestSourceScan,
    type ScanStateCoverage
} from './scan-state'

const AT = Date.UTC(2026, 9, 4)

function ok(source: string): LatestSourceScan {
    return { source, status: 'ok', reasonCode: 'ok', finishedAt: AT }
}

function failed(source: string, reasonCode: string | null, status = 'unauditable'): LatestSourceScan {
    return { source, status, reasonCode, finishedAt: AT }
}

function coverage(ecosystem: string, status: ScanStateCoverage['status'], reasonCode: string | null = null): ScanStateCoverage {
    return { ecosystem, status, reasonCode }
}

describe('scan state — the side map', function () {
    // Every failure code is classified: a new ReasonCode that nobody placed fails here (and to compile).
    it('classifies every reason code but ok', function () {
        const failures = REASON_CODE_VALUES.filter(function notOk(code) { return code !== 'ok' })
        expect(Object.keys(REASON_SIDE).sort()).toEqual(failures.slice().sort())
    })

    it.each([
        ['no_lockfile', 'project'],
        ['unsupported_lockfile', 'project'],
        ['yarn_v1_unsupported', 'project'],
        ['unknown_pm', 'project'],
        ['ambiguous_dependency_spec', 'project'],
        ['partial_dependency_graph', 'project'],
        ['pm_missing', 'environment'],
        ['nvm_missing', 'environment'],
        ['osv_db_not_seeded', 'environment'],
        ['timeout', 'environment'],
        ['audit_unknown_failure', 'environment']
    ])('puts %s on the %s side', function (code, side) {
        expect(reasonSide(code)).toBe(side)
    })

    // A failure whose code was lost or not understood still counts, as an unknown failure of this install.
    it.each([[null], ['ok'], ['made_up']])('reads %s as an unknown failure', function (code) {
        expect(failureReasonCode(code)).toBe('audit_unknown_failure')
        expect(reasonSide(code)).toBe('environment')
    })

    it('labels the side-less reason in every locale', function () {
        for (const locale of LOCALES) expect(NOT_YET_RUN_LABELS[locale]).toBeTruthy()
    })
})

describe('scan state — projectScanState', function () {
    it('is scanned when every expected source answered and coverage is ok', function () {
        expect(projectScanState({ expectedSources: ['npm-audit', 'osv'], latestScans: [ok('npm-audit'), ok('osv')], detectedEcosystems: ['npm'], coverage: [coverage('npm', 'ok')] }))
            .toEqual({ state: 'scanned', reasons: [] })
    })

    // A scan written before every scan recorded coverage (pre-M4 npm-audit summaries) says nothing about
    // whether the dependencies could be read: unknown, never complete. The source answered, so the project is
    // partial — the next sweep records coverage and clears it.
    it('is partial, never scanned, when the latest scan recorded no coverage', function () {
        expect(projectScanState({ expectedSources: ['npm-audit'], latestScans: [ok('npm-audit')], detectedEcosystems: ['npm'], coverage: null })).toEqual({
            state: 'partial',
            reasons: [{ source: null, ecosystem: 'npm', reasonCode: 'not_yet_run', side: null }]
        })
    })

    it('is partial when a detected ecosystem has no coverage entry', function () {
        expect(projectScanState({ expectedSources: ['osv'], latestScans: [ok('osv')], detectedEcosystems: ['npm', 'PyPI'], coverage: [coverage('npm', 'ok')] })).toEqual({
            state: 'partial',
            reasons: [{ source: null, ecosystem: 'PyPI', reasonCode: 'not_yet_run', side: null }]
        })
    })

    it('is scanned once the latest scan recorded ok coverage for every detected ecosystem', function () {
        expect(projectScanState({ expectedSources: ['osv'], latestScans: [ok('osv')], detectedEcosystems: ['npm', 'PyPI'], coverage: [coverage('npm', 'ok'), coverage('PyPI', 'ok')] }))
            .toEqual({ state: 'scanned', reasons: [] })
    })

    it('is scanned with no detected ecosystem to cover', function () {
        expect(projectScanState({ expectedSources: ['npm-audit'], latestScans: [ok('npm-audit')], detectedEcosystems: [], coverage: null }).state).toBe('scanned')
    })

    // No scan history at all: the existing "never scanned", never "All clear", never "cannot be scanned".
    it('is not scanned yet when no expected source has a scan', function () {
        expect(projectScanState({ expectedSources: ['npm-audit'], latestScans: [], detectedEcosystems: [], coverage: [] })).toEqual({ state: 'not_scanned_yet', reasons: [] })
    })

    it('is not scanned yet when nothing is expected', function () {
        expect(projectScanState({ expectedSources: [], latestScans: [failed('osv', 'osv_db_not_seeded')], detectedEcosystems: [], coverage: [] })).toEqual({ state: 'not_scanned_yet', reasons: [] })
    })

    // A newly enabled source has no scan row yet: the project is not "scanned" by it.
    it('is partial when an expected source has not run yet, never scanned', function () {
        expect(projectScanState({ expectedSources: ['npm-audit', 'osv'], latestScans: [ok('npm-audit')], detectedEcosystems: [], coverage: [coverage('npm', 'ok')] })).toEqual({
            state: 'partial',
            reasons: [{ source: 'osv', ecosystem: null, reasonCode: 'not_yet_run', side: null }]
        })
    })

    // A source no longer expected (disabled, or its ecosystem withdrawn) does not count, failed or not.
    it('ignores the scan of a source that is not expected', function () {
        expect(projectScanState({ expectedSources: ['npm-audit'], latestScans: [ok('npm-audit'), failed('osv', 'osv_db_not_seeded')], detectedEcosystems: [], coverage: [] }))
            .toEqual({ state: 'scanned', reasons: [] })
    })

    it('is partial when one source answered and another failed', function () {
        expect(projectScanState({ expectedSources: ['npm-audit', 'osv'], latestScans: [ok('npm-audit'), failed('osv', 'osv_db_not_seeded')], detectedEcosystems: [], coverage: [] })).toEqual({
            state: 'partial',
            reasons: [{ source: 'osv', ecosystem: null, reasonCode: 'osv_db_not_seeded', side: 'environment' }]
        })
    })

    it('is partial when the sources answered but an ecosystem could not be fully read', function () {
        expect(projectScanState({ expectedSources: ['osv'], latestScans: [ok('osv')], detectedEcosystems: [], coverage: [coverage('npm', 'ok'), coverage('PyPI', 'partial', 'partial_dependency_graph')] })).toEqual({
            state: 'partial',
            reasons: [{ source: null, ecosystem: 'PyPI', reasonCode: 'partial_dependency_graph', side: 'project' }]
        })
    })

    it('cannot scan when no expected source answered', function () {
        expect(projectScanState({
            expectedSources: ['npm-audit', 'osv'],
            latestScans: [failed('npm-audit', 'no_lockfile'), failed('osv', 'no_lockfile')],
            detectedEcosystems: [], coverage: [coverage('npm', 'unauditable', 'no_lockfile')]
        })).toEqual({
            state: 'cannot_scan',
            reasons: [
                { source: 'npm-audit', ecosystem: null, reasonCode: 'no_lockfile', side: 'project' },
                { source: 'osv', ecosystem: null, reasonCode: 'no_lockfile', side: 'project' },
                { source: null, ecosystem: 'npm', reasonCode: 'no_lockfile', side: 'project' }
            ]
        })
    })

    it('cannot scan when one source failed and the other has not run yet', function () {
        expect(projectScanState({ expectedSources: ['npm-audit', 'osv'], latestScans: [failed('npm-audit', 'pm_missing')], detectedEcosystems: [], coverage: [] })).toEqual({
            state: 'cannot_scan',
            reasons: [
                { source: 'npm-audit', ecosystem: null, reasonCode: 'pm_missing', side: 'environment' },
                { source: 'osv', ecosystem: null, reasonCode: 'not_yet_run', side: null }
            ]
        })
    })

    it('reads an unrecognised failure code as an unknown failure', function () {
        expect(projectScanState({ expectedSources: ['npm-audit'], latestScans: [failed('npm-audit', null, 'error')], detectedEcosystems: [], coverage: [coverage('npm', 'unauditable', null)] }).reasons).toEqual([
            { source: 'npm-audit', ecosystem: null, reasonCode: 'audit_unknown_failure', side: 'environment' },
            { source: null, ecosystem: 'npm', reasonCode: 'audit_unknown_failure', side: 'environment' }
        ])
    })
})

describe('scan state — notRecheckedBecause', function () {
    it('is null without a context, without a scan, or after an ok scan', function () {
        expect(notRecheckedBecause(null)).toBeNull()
        expect(notRecheckedBecause({ latestStatus: null, latestReasonCode: null, lastOkScanAt: null, projectState: 'not_scanned_yet' })).toBeNull()
        expect(notRecheckedBecause({ latestStatus: 'ok', latestReasonCode: 'ok', lastOkScanAt: AT, projectState: 'scanned' })).toBeNull()
    })

    it('names the failure, its side, the project state and the last ok scan', function () {
        expect(notRecheckedBecause({ latestStatus: 'unauditable', latestReasonCode: 'no_lockfile', lastOkScanAt: AT, projectState: 'cannot_scan' }))
            .toEqual({ reasonCode: 'no_lockfile', side: 'project', projectState: 'cannot_scan', lastOkScanAt: AT })
    })
})
