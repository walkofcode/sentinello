import { describe, expect, it } from 'vitest'
import type { FixEvidence } from '@sentinello/scanners'
import { affectedSetText, settleFix, type RegistryView } from './settle'

// settleFix maps pickReleasedFix's tri-state onto the persisted status and writes the snapshot that
// explains it. The mapping's job is to keep the three answers apart: only the registry proving a version
// makes it `released`, only the registry proving none makes it `none_released`, and everything else —
// including a registry that could not be asked — stays `unverified` with the stated fix labelled as such.

const AT = Date.UTC(2026, 9, 3)

function evidence(overrides: Partial<FixEvidence> = {}): FixEvidence {
    return {
        source: 'osv',
        installed: ['1.0.0'],
        affected: { ranges: '<1.1.0', exact: [], complete: true },
        patched: null,
        statedFix: '1.1.0',
        fixViaParent: false,
        ...overrides
    }
}

function ok(...versions: string[]): RegistryView {
    return { status: 'ok', published: versions.map(function v(version) { return { version, deprecated: false } }), dataAsOf: AT - 5 }
}

describe('settleFix', function () {
    it('is released when the registry has a qualifying version', function () {
        expect(settleFix({ evidence: [evidence()], registry: ok('1.0.0', '1.1.0'), checkedAt: AT })).toEqual({
            fixStatus: 'released',
            fixVersion: '1.1.0',
            fixAvailable: true,
            fixCheck: {
                v: 1,
                checkedAt: AT,
                registry: 'ok',
                packageDataAsOf: AT - 5,
                unevaluable: null,
                sources: [{ source: 'osv', installed: ['1.0.0'], affected: '<1.1.0', patched: null, statedFix: '1.1.0', noPatchedSentinel: false }]
            }
        })
    })

    // braces: `<=3.0.3`, nothing published above it. npm said a parent upgrade "fixes" it; that claim does
    // not survive a registry that proves no version of braces itself is safe.
    it('is none_released when nothing published qualifies, whatever npm said about a parent', function () {
        const braces = evidence({ installed: ['3.0.3'], affected: { ranges: '<=3.0.3', exact: [], complete: true }, statedFix: null, patched: '<0.0.0', fixViaParent: true })
        const settled = settleFix({ evidence: [braces], registry: ok('3.0.2', '3.0.3'), checkedAt: AT })
        expect(settled).toMatchObject({ fixStatus: 'none_released', fixVersion: null, fixAvailable: false })
        expect(settled.fixCheck.sources[0]).toMatchObject({ noPatchedSentinel: true, patched: null })
    })

    it('records a genuine patched range, and treats a blank one as none', function () {
        const patched = settleFix({ evidence: [evidence({ patched: '>=1.1.0' })], registry: null, checkedAt: AT })
        expect(patched.fixCheck.sources[0]).toMatchObject({ patched: '>=1.1.0', noPatchedSentinel: false })
        const blank = settleFix({ evidence: [evidence({ patched: '  ' })], registry: null, checkedAt: AT })
        expect(blank.fixCheck.sources[0]?.patched).toBeNull()
    })

    it('is unverified with the reason when the evidence cannot be evaluated', function () {
        const incomplete = evidence({ affected: { ranges: '*', exact: [], complete: false } })
        expect(settleFix({ evidence: [incomplete], registry: ok('2.0.0'), checkedAt: AT })).toMatchObject({
            fixStatus: 'unverified',
            fixVersion: '1.1.0',
            fixAvailable: true,
            fixCheck: { registry: 'ok', packageDataAsOf: AT - 5, unevaluable: 'affected_incomplete' }
        })
    })

    it('is unverified, carrying the stated fix, for every registry outcome that is not an answer', function () {
        expect(settleFix({ evidence: [evidence()], registry: null, checkedAt: AT }).fixCheck).toMatchObject({ registry: 'skipped', packageDataAsOf: null })
        expect(settleFix({ evidence: [evidence()], registry: { status: 'offline' }, checkedAt: AT })).toMatchObject({ fixStatus: 'unverified', fixCheck: { registry: 'offline', packageDataAsOf: null } })
        expect(settleFix({ evidence: [evidence()], registry: { status: 'error' }, checkedAt: AT })).toMatchObject({
            fixStatus: 'unverified', fixVersion: '1.1.0', fixCheck: { registry: 'error', packageDataAsOf: null }
        })
        expect(settleFix({ evidence: [evidence()], registry: { status: 'not_found', dataAsOf: 9 }, checkedAt: AT }).fixCheck)
            .toMatchObject({ registry: 'not_found', packageDataAsOf: 9 })
    })

    it('carries the highest stated fix, and a parent-upgrade claim, while unverified', function () {
        const settled = settleFix({
            evidence: [evidence({ statedFix: '1.1.0' }), evidence({ source: 'gemnasium', statedFix: '1.2.0' })],
            registry: null,
            checkedAt: AT
        })
        expect(settled).toMatchObject({ fixVersion: '1.2.0', fixAvailable: true })
        const parentOnly = settleFix({ evidence: [evidence({ statedFix: null, fixViaParent: true })], registry: null, checkedAt: AT })
        expect(parentOnly).toMatchObject({ fixVersion: null, fixAvailable: true })
        const nothing = settleFix({ evidence: [evidence({ statedFix: null })], registry: null, checkedAt: AT })
        expect(nothing).toMatchObject({ fixVersion: null, fixAvailable: false })
    })

    it('lists each distinct statement once, a second installed copy included', function () {
        const settled = settleFix({
            evidence: [evidence(), evidence(), evidence({ installed: ['1.0.5'] }), evidence({ source: 'npm-audit', installed: ['1.0.0'], affected: { ranges: '<1.2.0', exact: [], complete: true }, statedFix: null })],
            registry: ok('1.2.0'),
            checkedAt: AT
        })
        expect(settled.fixCheck.sources.map(function s(e) { return e.source + ' ' + e.installed.join(',') + ' ' + e.affected }))
            .toEqual(['osv 1.0.0 <1.1.0', 'osv 1.0.5 <1.1.0', 'npm-audit 1.0.0 <1.2.0'])
        expect(settled.fixVersion).toBe('1.2.0')
    })

    it('settles stale data as stale, with its data date', function () {
        const stale: RegistryView = { status: 'stale', published: [{ version: '1.1.0', deprecated: false }], dataAsOf: 1 }
        expect(settleFix({ evidence: [evidence()], registry: stale, checkedAt: AT }).fixCheck).toMatchObject({ registry: 'stale', packageDataAsOf: 1 })
    })
})

describe('affectedSetText', function () {
    it('writes exact versions before the ranges', function () {
        expect(affectedSetText({ ranges: '<1.1.0', exact: ['1.1.0'], complete: true })).toBe('=1.1.0 || <1.1.0')
        expect(affectedSetText({ ranges: null, exact: ['1.0.0', '1.0.1'], complete: true })).toBe('=1.0.0 || =1.0.1')
        expect(affectedSetText({ ranges: '*', exact: [], complete: true })).toBe('*')
    })
})
