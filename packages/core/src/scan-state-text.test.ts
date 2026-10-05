import { describe, expect, it } from 'vitest'
import type { ScanState, ScanStateReason } from './scan-state'
import {
    SCAN_STATE_SIDE_SHORT,
    describeGroupedReasonLong,
    describeScanReasons,
    groupScanReasons,
    labelScanState,
    scanReasonLabel,
    scanReasonSubject,
    scanStateHeadline
} from './scan-state-text'

const NO_LOCKFILE_EVERYWHERE: ScanStateReason[] = [
    { source: 'npm-audit', ecosystem: null, reasonCode: 'no_lockfile', side: 'project' },
    { source: 'osv', ecosystem: null, reasonCode: 'no_lockfile', side: 'project' },
    { source: null, ecosystem: 'npm', reasonCode: 'no_lockfile', side: 'project' }
]

describe('project cannot be scanned — the shared words', function () {
    it('labels a failure by its reason code and the side-less reason as "has not run yet", in the locale asked', function () {
        expect(scanReasonLabel({ reasonCode: 'no_lockfile' })).toBe('No lockfile')
        expect(scanReasonLabel({ reasonCode: 'no_lockfile' }, 'es')).toBe('Sin lockfile')
        expect(scanReasonLabel({ reasonCode: 'not_yet_run' })).toBe('Has not run yet')
        expect(scanReasonLabel({ reasonCode: 'not_yet_run' }, 'de')).toBe('Noch nicht ausgeführt')
    })

    it('carries every reason with its label, keeping source, ecosystem and side', function () {
        const state: ScanState = { state: 'partial', reasons: [NO_LOCKFILE_EVERYWHERE[0] as ScanStateReason, { source: null, ecosystem: 'npm', reasonCode: 'not_yet_run', side: null }] }
        expect(labelScanState(state)).toEqual({
            state: 'partial',
            reasons: [
                { source: 'npm-audit', ecosystem: null, reasonCode: 'no_lockfile', side: 'project', label: 'No lockfile' },
                { source: null, ecosystem: 'npm', reasonCode: 'not_yet_run', side: null, label: 'Has not run yet' }
            ]
        })
        expect(labelScanState({ state: 'scanned', reasons: [] }, 'fr')).toEqual({ state: 'scanned', reasons: [] })
    })

    it('names a source by its display name and an ecosystem by its id, and an unknown source as stored', function () {
        expect(scanReasonSubject({ source: 'npm-audit', ecosystem: null, reasonCode: 'timeout', side: 'environment' })).toBe('npm audit')
        expect(scanReasonSubject({ source: 'legacy-plugin', ecosystem: null, reasonCode: 'timeout', side: 'environment' })).toBe('legacy-plugin')
        expect(scanReasonSubject({ source: null, ecosystem: 'PyPI', reasonCode: 'not_yet_run', side: null })).toBe('PyPI')
    })

    it('has a headline only for a project that is not fully scanned, or not scanned at all', function () {
        expect(scanStateHeadline('cannot_scan')).toBe('Project cannot be scanned')
        expect(scanStateHeadline('partial')).toBe('Project cannot be fully scanned')
        expect(scanStateHeadline('not_scanned_yet')).toBe('Project not scanned yet')
        expect(scanStateHeadline('scanned')).toBeNull()
    })

    it('folds one reason reported by several sources and ecosystems into one, and keeps different sides apart', function () {
        const reasons: ScanStateReason[] = [
            ...NO_LOCKFILE_EVERYWHERE,
            { source: 'osv', ecosystem: null, reasonCode: 'no_lockfile', side: 'project' },
            { source: 'gemnasium', ecosystem: null, reasonCode: 'gemnasium_db_not_seeded', side: 'environment' }
        ]
        expect(groupScanReasons(reasons)).toEqual([
            { reasonCode: 'no_lockfile', side: 'project', label: 'No lockfile', subjects: ['npm audit', 'OSV', 'npm'] },
            { reasonCode: 'gemnasium_db_not_seeded', side: 'environment', label: 'gemnasium database not downloaded yet', subjects: ['GitLab gemnasium'] }
        ])
    })

    it('says in one line whose fix each failure is, and what has not run yet', function () {
        expect(describeScanReasons(NO_LOCKFILE_EVERYWHERE)).toBe('No lockfile (the project)')
        expect(describeScanReasons([
            { source: 'osv', ecosystem: null, reasonCode: 'osv_db_not_seeded', side: 'environment' },
            { source: null, ecosystem: 'npm', reasonCode: 'not_yet_run', side: null }
        ])).toBe('OSV database not downloaded yet (' + SCAN_STATE_SIDE_SHORT.environment + ') · npm: Has not run yet')
        expect(describeScanReasons([])).toBe('')
    })

    it('spells a reason out for a document, naming what it is about and whose fix it is', function () {
        const [project] = groupScanReasons(NO_LOCKFILE_EVERYWHERE)
        expect(describeGroupedReasonLong(project as ReturnType<typeof groupScanReasons>[number])).toBe("No lockfile — npm audit, OSV, npm — on the project's side: a file in the project stops it from being read, and changing it there is the fix")
        const [environment] = groupScanReasons([{ source: 'npm-audit', ecosystem: null, reasonCode: 'pm_missing', side: 'environment' }])
        expect(describeGroupedReasonLong(environment as ReturnType<typeof groupScanReasons>[number])).toContain("on this Sentinello install's side")
        const [notYet] = groupScanReasons([{ source: null, ecosystem: 'npm', reasonCode: 'not_yet_run', side: null }])
        expect(describeGroupedReasonLong(notYet as ReturnType<typeof groupScanReasons>[number])).toBe("Has not run yet — npm — nobody's fix: nothing has looked yet, and the next scan does")
    })
})
