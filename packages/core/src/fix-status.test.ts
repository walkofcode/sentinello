import { describe, expect, it } from 'vitest'
import {
    describeFix,
    describeFixDisagreement,
    isFixStatus,
    parseFixCheck,
    PLAIN_FIX_STYLE,
    readFixFields,
    type FixCheck,
    type FixFacts
} from './fix-status'

const AT = Date.UTC(2026, 9, 3, 12)
const DATA_AT = Date.UTC(2026, 9, 1, 8)

function check(overrides: Partial<FixCheck> = {}): FixCheck {
    return { v: 1, checkedAt: AT, registry: 'ok', packageDataAsOf: DATA_AT, unevaluable: null, sources: [], ...overrides }
}

function facts(overrides: Partial<FixFacts> = {}): FixFacts {
    return { packageName: 'braces', fixStatus: 'unverified', fixVersion: null, fixAvailable: false, fixCheck: check(), ...overrides }
}

describe('parseFixCheck', function () {
    it('round-trips a snapshot', function () {
        const c = check({ sources: [{ source: 'osv', installed: ['1.0.0'], affected: '<=3.0.3', patched: null, statedFix: null, noPatchedSentinel: false }], unevaluable: 'affected_incomplete' })
        expect(parseFixCheck(JSON.stringify(c))).toEqual(c)
    })

    it.each([
        ['null column', null],
        ['not JSON', '{'],
        ['not an object', '42'],
        ['wrong version', JSON.stringify({ ...check(), v: 2 })],
        ['no checkedAt', JSON.stringify({ ...check(), checkedAt: 'x' })],
        ['unknown registry', JSON.stringify({ ...check(), registry: 'maybe' })],
        ['bad packageDataAsOf', JSON.stringify({ ...check(), packageDataAsOf: 'x' })],
        ['unknown reason', JSON.stringify({ ...check(), unevaluable: 'because' })],
        ['numeric reason', JSON.stringify({ ...check(), unevaluable: 3 })],
        ['sources not a list', JSON.stringify({ ...check(), sources: {} })],
        ['source not an object', JSON.stringify({ ...check(), sources: [null] })],
        ['source without affected', JSON.stringify({ ...check(), sources: [{ source: 'osv', patched: null, statedFix: null, noPatchedSentinel: false }] })],
        ['installed not a list', JSON.stringify({ ...check(), sources: [{ source: 'osv', installed: '1.0.0', affected: '*', patched: null, statedFix: null, noPatchedSentinel: false }] })],
        ['installed not strings', JSON.stringify({ ...check(), sources: [{ source: 'osv', installed: [1], affected: '*', patched: null, statedFix: null, noPatchedSentinel: false }] })],
        ['bad patched', JSON.stringify({ ...check(), sources: [{ source: 'osv', installed: [], affected: '*', patched: 1, statedFix: null, noPatchedSentinel: false }] })],
        ['bad statedFix', JSON.stringify({ ...check(), sources: [{ source: 'osv', installed: ['1.0.0'], affected: '*', patched: null, statedFix: 1, noPatchedSentinel: false }] })],
        ['bad sentinel flag', JSON.stringify({ ...check(), sources: [{ source: 'osv', installed: ['1.0.0'], affected: '*', patched: null, statedFix: null, noPatchedSentinel: 'no' }] })]
    ])('reads %s as no snapshot', function (_label, json) {
        expect(parseFixCheck(json)).toBeNull()
    })
})

describe('readFixFields', function () {
    const json = JSON.stringify(check())

    it('passes a settled row through', function () {
        expect(readFixFields({ fixStatus: 'released', fixVersion: '3.0.4', fixAvailable: true, fixCheckJson: json, remediationJson: null }))
            .toEqual({ fixStatus: 'released', fixVersion: '3.0.4', fixAvailable: true, fixCheck: check(), remediation: null })
    })

    // A way-out exists only for a settled none_released finding: one left on any other row is never read.
    it('reads the way-out of a none_released row only', function () {
        const way = JSON.stringify({ v: 1, checkedAt: 1, package: 'braces', health: { name: 'braces', unmaintained: true }, chains: [], moreChains: 0, alternatives: [], devOnly: null, partial: false })
        expect(readFixFields({ fixStatus: 'none_released', fixVersion: null, fixAvailable: false, fixCheckJson: json, remediationJson: way }).remediation).toMatchObject({ package: 'braces' })
        expect(readFixFields({ fixStatus: 'released', fixVersion: '3.0.4', fixAvailable: true, fixCheckJson: json, remediationJson: way }).remediation).toBeNull()
        expect(readFixFields({ fixStatus: 'none_released', fixVersion: null, fixAvailable: false, fixCheckJson: null, remediationJson: way }).remediation).toBeNull()
    })

    // A row written before settlement existed holds a fix nobody checked — braces 3.0.4 on the live
    // instance. It is withheld, never shown as the advisory's, until a rescan settles it.
    it.each([
        ['no status', { fixStatus: null, fixCheckJson: json }],
        ['an unknown status', { fixStatus: 'maybe', fixCheckJson: json }],
        ['no snapshot', { fixStatus: 'released', fixCheckJson: null }],
        ['released without a version', { fixStatus: 'released', fixCheckJson: json, fixVersion: null }]
    ])('withholds the fix of a row with %s', function (_label, row) {
        expect(readFixFields({ fixVersion: '3.0.4', fixAvailable: true, remediationJson: null, ...row }))
            .toEqual({ fixStatus: 'unverified', fixVersion: null, fixAvailable: false, fixCheck: null, remediation: null })
    })

    it('recognises exactly the three statuses', function () {
        expect(isFixStatus('released') && isFixStatus('none_released') && isFixStatus('unverified')).toBe(true)
        expect(isFixStatus('none')).toBe(false)
        expect(isFixStatus(null)).toBe(false)
    })
})

describe('describeFix', function () {
    it.each([
        ['released', facts({ fixStatus: 'released', fixVersion: '6.16.0', fixAvailable: true }), 'upgrade to 6.16.0'],
        ['released on stale data', facts({ fixStatus: 'released', fixVersion: '6.16.0', fixAvailable: true, fixCheck: check({ registry: 'stale' }) }), 'upgrade to 6.16.0 · cached data from 2026-10-01'],
        ['none released', facts({ fixStatus: 'none_released' }), 'No fixed version released — no published version of braces is outside the vulnerable range (registry checked 2026-10-03)'],
        ['none released on stale data', facts({ fixStatus: 'none_released', fixCheck: check({ registry: 'stale' }) }), 'No fixed version released — no published version of braces is outside the vulnerable range (registry checked 2026-10-03) · cached data from 2026-10-01'],
        ['stale without a data date', facts({ fixStatus: 'released', fixVersion: '1.0.0', fixCheck: check({ registry: 'stale', packageDataAsOf: null }) }), 'upgrade to 1.0.0'],
        ['legacy', facts({ fixCheck: null }), 'fix not re-checked yet — rescan pending'],
        ['stated, registry skipped', facts({ fixVersion: '3.0.4', fixCheck: check({ registry: 'skipped' }) }), 'advisory names 3.0.4 as the fix · not checked against the registry'],
        ['stated, registry down', facts({ fixVersion: '3.0.4', fixCheck: check({ registry: 'error' }) }), 'advisory names 3.0.4 as the fix · not checked against the registry (registry not reachable)'],
        ['none stated, not on registry', facts({ fixCheck: check({ registry: 'not_found' }) }), 'no fix stated by the advisory · not checked against the registry (not on the npm registry)'],
        ['via parent', facts({ fixAvailable: true, fixCheck: check({ registry: 'skipped' }) }), 'npm reports npm audit fix resolves it (no version of this package stated) · not checked against the registry'],
        ['incomplete range', facts({ fixCheck: check({ unevaluable: 'affected_incomplete' }) }), 'no fix stated by the advisory · not checked against the registry (affected range could not be evaluated)'],
        ['unreadable install', facts({ fixCheck: check({ unevaluable: 'installed_unknown' }) }), 'no fix stated by the advisory · not checked against the registry (installed version could not be read)'],
        ['unreadable patch', facts({ fixCheck: check({ unevaluable: 'patched_unparseable' }) }), 'no fix stated by the advisory · not checked against the registry (patched range could not be evaluated)'],
        ['no evidence', facts({ fixCheck: check({ unevaluable: 'no_evidence' }) }), 'no fix stated by the advisory · not checked against the registry (no source evidence to check)'],
        ['incomplete range on stale data', facts({ fixVersion: '3.0.4', fixCheck: check({ registry: 'stale', unevaluable: 'affected_incomplete' }) }), 'advisory names 3.0.4 as the fix · not checked against the registry (affected range could not be evaluated) · cached data from 2026-10-01']
    ])('words %s', function (_label, f, expected) {
        expect(describeFix(f, PLAIN_FIX_STYLE)).toBe(expected)
    })
})

describe('describeFixDisagreement', function () {
    const two = check({
        sources: [
            { source: 'npm-audit', installed: ['1.0.0'], affected: '<1.1.0', patched: null, statedFix: '1.1.0', noPatchedSentinel: false },
            { source: 'osv', installed: ['1.0.0'], affected: '<1.2.0', patched: null, statedFix: '1.2.0', noPatchedSentinel: false }
        ]
    })

    it('is silent for a legacy row and for agreeing sources', function () {
        expect(describeFixDisagreement(facts({ fixCheck: null }), PLAIN_FIX_STYLE)).toBeNull()
        expect(describeFixDisagreement(facts(), PLAIN_FIX_STYLE)).toBeNull()
    })

    it('says the released fix is outside both, or all of them', function () {
        expect(describeFixDisagreement(facts({ fixStatus: 'released', fixVersion: '1.2.0', fixCheck: two }), PLAIN_FIX_STYLE))
            .toBe('sources disagree: npm-audit <1.1.0, osv <1.2.0 — 1.2.0 is outside both')
        const three = check({ sources: [...two.sources, { source: 'gemnasium', installed: ['1.0.0'], affected: '<1.1.5', patched: null, statedFix: null, noPatchedSentinel: false }] })
        expect(describeFixDisagreement(facts({ fixStatus: 'released', fixVersion: '1.2.0', fixCheck: three }), PLAIN_FIX_STYLE))
            .toBe('sources disagree: npm-audit <1.1.0, osv <1.2.0, gemnasium <1.1.5 — 1.2.0 is outside all of them')
    })

    it('only lists the disagreement when there is no released fix', function () {
        expect(describeFixDisagreement(facts({ fixStatus: 'none_released', fixCheck: two }), PLAIN_FIX_STYLE))
            .toBe('sources disagree: npm-audit <1.1.0, osv <1.2.0')
    })
})
