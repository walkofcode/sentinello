import { describe, expect, it } from 'vitest'
import { versionSetFromSemverRange, type FixEvidence } from '@sentinello/scanners'
import { comparatorById } from '@sentinello/versions'
import { affectedSetText, settleFix, statedFixCandidates, type RegistryView } from './settle'

// settleFix maps pickReleasedFix's tri-state onto the persisted status and writes the snapshot that
// explains it. The mapping's job is to keep the three answers apart: only the registry proving a version
// makes it `released`, only the registry proving none makes it `none_released`, and everything else —
// including a registry that could not be asked — stays `unverified` with the stated fix labelled as such.

const AT = Date.UTC(2026, 9, 3)

function evidence(overrides: Partial<FixEvidence> = {}): FixEvidence {
    return {
        source: 'osv',
        installed: ['1.0.0'],
        affected: versionSetFromSemverRange('<1.1.0'),
        patched: null,
        patchedSet: null,
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
        expect(settleFix({ ecosystem: 'npm', evidence: [evidence()], registry: ok('1.0.0', '1.1.0'), checkedAt: AT })).toEqual({
            fixStatus: 'released',
            fixVersion: '1.1.0',
            fixAvailable: true,
            fixCheck: {
                v: 1,
                checkedAt: AT,
                registry: 'ok',
                packageDataAsOf: AT - 5,
                unevaluable: null,
                sources: [{ source: 'osv', installed: ['1.0.0'], affected: '>=0 <1.1.0', patched: null, statedFix: '1.1.0', noPatchedSentinel: false }]
            }
        })
    })

    // braces: `<=3.0.3`, nothing published above it. npm said a parent upgrade "fixes" it; that claim does
    // not survive a registry that proves no version of braces itself is safe.
    it('is none_released when nothing published qualifies, whatever npm said about a parent', function () {
        const braces = evidence({ installed: ['3.0.3'], affected: versionSetFromSemverRange('<=3.0.3'), statedFix: null, patched: '<0.0.0', fixViaParent: true })
        const settled = settleFix({ ecosystem: 'npm', evidence: [braces], registry: ok('3.0.2', '3.0.3'), checkedAt: AT })
        expect(settled).toMatchObject({ fixStatus: 'none_released', fixVersion: null, fixAvailable: false })
        expect(settled.fixCheck.sources[0]).toMatchObject({ noPatchedSentinel: true, patched: null })
    })

    it('records a genuine patched range, and treats a blank one as none', function () {
        const patched = settleFix({ ecosystem: 'npm', evidence: [evidence({ patched: '>=1.1.0' })], registry: null, checkedAt: AT })
        expect(patched.fixCheck.sources[0]).toMatchObject({ patched: '>=1.1.0', noPatchedSentinel: false })
        const blank = settleFix({ ecosystem: 'npm', evidence: [evidence({ patched: '  ' })], registry: null, checkedAt: AT })
        expect(blank.fixCheck.sources[0]?.patched).toBeNull()
    })

    it('is unverified with the reason when the evidence cannot be evaluated', function () {
        const incomplete = evidence({ affected: { ...versionSetFromSemverRange('*'), complete: false } })
        expect(settleFix({ ecosystem: 'npm', evidence: [incomplete], registry: ok('2.0.0'), checkedAt: AT })).toMatchObject({
            fixStatus: 'unverified',
            fixVersion: '1.1.0',
            fixAvailable: true,
            fixCheck: { registry: 'ok', packageDataAsOf: AT - 5, unevaluable: 'affected_incomplete' }
        })
    })

    it('is unverified, carrying the stated fix, for every registry outcome that is not an answer', function () {
        expect(settleFix({ ecosystem: 'npm', evidence: [evidence()], registry: null, checkedAt: AT }).fixCheck).toMatchObject({ registry: 'skipped', packageDataAsOf: null })
        expect(settleFix({ ecosystem: 'npm', evidence: [evidence()], registry: { status: 'offline' }, checkedAt: AT })).toMatchObject({ fixStatus: 'unverified', fixCheck: { registry: 'offline', packageDataAsOf: null } })
        expect(settleFix({ ecosystem: 'npm', evidence: [evidence()], registry: { status: 'error' }, checkedAt: AT })).toMatchObject({
            fixStatus: 'unverified', fixVersion: '1.1.0', fixCheck: { registry: 'error', packageDataAsOf: null }
        })
        expect(settleFix({ ecosystem: 'npm', evidence: [evidence()], registry: { status: 'not_found', dataAsOf: 9 }, checkedAt: AT }).fixCheck)
            .toMatchObject({ registry: 'not_found', packageDataAsOf: 9 })
    })

    it('carries the highest stated fix, and a parent-upgrade claim, while unverified', function () {
        const settled = settleFix({
            ecosystem: 'npm',
            evidence: [evidence({ statedFix: '1.1.0' }), evidence({ source: 'gemnasium', statedFix: '1.2.0' })],
            registry: null,
            checkedAt: AT
        })
        expect(settled).toMatchObject({ fixVersion: '1.2.0', fixAvailable: true })
        const parentOnly = settleFix({ ecosystem: 'npm', evidence: [evidence({ statedFix: null, fixViaParent: true })], registry: null, checkedAt: AT })
        expect(parentOnly).toMatchObject({ fixVersion: null, fixAvailable: true })
        const nothing = settleFix({ ecosystem: 'npm', evidence: [evidence({ statedFix: null })], registry: null, checkedAt: AT })
        expect(nothing).toMatchObject({ fixVersion: null, fixAvailable: false })
    })

    it('lists each distinct statement once, a second installed copy included', function () {
        const settled = settleFix({
            ecosystem: 'npm',
            evidence: [evidence(), evidence(), evidence({ installed: ['1.0.5'] }), evidence({ source: 'npm-audit', installed: ['1.0.0'], affected: versionSetFromSemverRange('<1.2.0'), statedFix: null })],
            registry: ok('1.2.0'),
            checkedAt: AT
        })
        expect(settled.fixCheck.sources.map(function s(e) { return e.source + ' ' + e.installed.join(',') + ' ' + e.affected }))
            .toEqual(['osv 1.0.0 >=0 <1.1.0', 'osv 1.0.5 >=0 <1.1.0', 'npm-audit 1.0.0 >=0 <1.2.0'])
        expect(settled.fixVersion).toBe('1.2.0')
    })

    it('settles stale data as stale, with its data date', function () {
        const stale: RegistryView = { status: 'stale', published: [{ version: '1.1.0', deprecated: false }], dataAsOf: 1 }
        expect(settleFix({ ecosystem: 'npm', evidence: [evidence()], registry: stale, checkedAt: AT }).fixCheck).toMatchObject({ registry: 'stale', packageDataAsOf: 1 })
    })
})

describe('settleFix — the finding\'s comparator', function () {
    // Go fixed only in a commit: the list has no tag above the installed copy, and the advisory states a
    // pseudo-version (SENTINEL-126).
    const PSEUDO = '0.0.0-20200622213623-75b288015ac9'
    const goEvidence = evidence({
        installed: ['0.0.0-20200101000000-aaaaaaaaaaaa'],
        affected: { comparator: 'go', ranges: [{ introduced: '0', fixed: PSEUDO, lastAffected: null }], exact: [], complete: true },
        statedFix: PSEUDO
    })

    it('orders a Go fix by Go\'s rules, admitting the stated pseudo-version once the registry confirms it', function () {
        const view: RegistryView = { status: 'ok', published: [{ version: 'v' + PSEUDO, deprecated: false }], dataAsOf: 3 }
        expect(settleFix({ ecosystem: 'Go', evidence: [goEvidence], registry: view, checkedAt: AT })).toMatchObject({ fixStatus: 'released', fixVersion: 'v' + PSEUDO })
    })

    it('is none_released only when no stated fix is unconfirmed — an unconfirmed one makes it unknown, blamed on the registry', function () {
        const empty: RegistryView = { status: 'ok', published: [], dataAsOf: 3 }
        expect(settleFix({ ecosystem: 'Go', evidence: [goEvidence], registry: empty, checkedAt: AT })).toMatchObject({ fixStatus: 'none_released' })
        expect(settleFix({ ecosystem: 'Go', evidence: [goEvidence], registry: { ...empty, unconfirmed: [] }, checkedAt: AT })).toMatchObject({ fixStatus: 'none_released' })
        expect(settleFix({ ecosystem: 'Go', evidence: [goEvidence], registry: { ...empty, unconfirmed: ['v' + PSEUDO] }, checkedAt: AT })).toMatchObject({
            fixStatus: 'unverified',
            fixVersion: PSEUDO,
            fixCheck: { registry: 'error', packageDataAsOf: 3, unevaluable: null }
        })
    })

    // A released version is a fact even while a lower stated one is unconfirmed: upgrading to it is safe.
    it('keeps a released fix whatever else is unconfirmed', function () {
        const view: RegistryView = { status: 'ok', published: [{ version: 'v1.0.0', deprecated: false }], dataAsOf: 3, unconfirmed: ['v' + PSEUDO] }
        expect(settleFix({ ecosystem: 'Go', evidence: [goEvidence], registry: view, checkedAt: AT })).toMatchObject({ fixStatus: 'released', fixVersion: 'v1.0.0' })
    })

    it('refuses evidence in another comparator than its finding\'s ecosystem, and an ecosystem nobody knows', function () {
        expect(function mixed() { settleFix({ ecosystem: 'PyPI', evidence: [evidence()], registry: null, checkedAt: AT }) }).toThrow('fix evidence for PyPI uses the semver comparator, not pep440')
        expect(function unknown() { settleFix({ ecosystem: 'Hex', evidence: [], registry: null, checkedAt: AT }) }).toThrow('unknown ecosystem')
        expect(settleFix({ ecosystem: 'crates.io', evidence: [evidence()], registry: ok('1.1.0'), checkedAt: AT })).toMatchObject({ fixStatus: 'released' })
    })
})

describe('statedFixCandidates', function () {
    const semver = comparatorById('semver')

    it('keeps each stated fix at or above the installed copy once, as written, and drops prereleases and junk', function () {
        const e = [
            evidence({ installed: ['1.0.0'], affected: versionSetFromSemverRange('<1.1.0 || >=2.0.0 <2.0.1'), statedFix: '1.1.0' }),
            evidence({ installed: ['1.0.5'], affected: versionSetFromSemverRange('<0.9.0'), statedFix: 'v1.1.0' }),
            evidence({ statedFix: '3.0.0-rc.1' }),
            evidence({ statedFix: 'not a version' })
        ]
        expect(statedFixCandidates(e, semver)).toEqual(['1.1.0', '2.0.1'])
    })

    it('has nothing to offer when an installed copy cannot be read, or there is none', function () {
        expect(statedFixCandidates([evidence({ installed: ['junk'] })], semver)).toEqual([])
        expect(statedFixCandidates([], semver)).toEqual([])
    })
})

describe('affectedSetText', function () {
    it('writes exact versions before the ranges', function () {
        expect(affectedSetText({ ...versionSetFromSemverRange('<1.1.0'), exact: ['1.1.0'] })).toBe('=1.1.0 || >=0 <1.1.0')
        expect(affectedSetText({ comparator: 'semver', ranges: [], exact: ['1.0.0', '1.0.1'], complete: true })).toBe('=1.0.0 || =1.0.1')
        expect(affectedSetText(versionSetFromSemverRange('*'))).toBe('>=0')
    })

    // The text is rendered from the set, whatever comparator it is in, through the one range formatter.
    it('renders a non-npm set with the operators it holds', function () {
        const pypi = { comparator: 'pep440' as const, ranges: [{ introduced: '4.2', fixed: '4.2.11', lastAffected: null }, { introduced: '5.0a1', introducedExclusive: true, fixed: null, lastAffected: '5.0.2' }], exact: [], complete: true }
        expect(affectedSetText(pypi)).toBe('>=4.2 <4.2.11 || >5.0a1 <=5.0.2')
    })
})
