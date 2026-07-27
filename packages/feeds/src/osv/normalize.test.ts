import { describe, expect, it } from 'vitest'
import { normalizeOsvRecord } from './normalize'

function record(overrides: Record<string, unknown> = {}) {
    return {
        id: 'GHSA-1',
        affected: [
            {
                package: { name: 'lodash', ecosystem: 'npm' },
                ranges: [{ type: 'SEMVER', events: [{ introduced: '4.0.0' }, { fixed: '4.17.21' }] }]
            }
        ],
        ...overrides
    }
}

describe('normalizeOsvRecord — record gating', function () {
    it('rejects anything that is not an object with an id and an affected array', function () {
        expect(normalizeOsvRecord(null, 'npm')).toEqual([])
        expect(normalizeOsvRecord('nope', 'npm')).toEqual([])
        expect(normalizeOsvRecord({}, 'npm')).toEqual([])
        expect(normalizeOsvRecord({ id: 'GHSA-1' }, 'npm')).toEqual([])
        expect(normalizeOsvRecord({ affected: [] }, 'npm')).toEqual([])
    })

    // One OSV record can list packages across several ecosystems, and each ecosystem syncs from its
    // own cursor. Letting another ecosystem's entries through would let one sync clobber another.
    it('keeps only the affected entries for the requested ecosystem', function () {
        const rows = normalizeOsvRecord(
            record({
                affected: [
                    { package: { name: 'lodash', ecosystem: 'npm' }, versions: ['1.0.0'] },
                    { package: { name: 'requests', ecosystem: 'PyPI' }, versions: ['1.0.0'] }
                ]
            }),
            'npm'
        )
        expect(rows).toHaveLength(1)
        expect(rows[0]?.packageName).toBe('lodash')
    })

    it('skips an affected entry with no package name', function () {
        const rows = normalizeOsvRecord(record({ affected: [{ package: { ecosystem: 'npm' }, versions: ['1.0.0'] }] }), 'npm')
        expect(rows).toEqual([])
    })

    it('collapses a package listed twice into one row', function () {
        const rows = normalizeOsvRecord(
            record({
                affected: [
                    { package: { name: 'lodash', ecosystem: 'npm' }, versions: ['1.0.0'] },
                    { package: { name: 'lodash', ecosystem: 'npm' }, versions: ['2.0.0'] }
                ]
            }),
            'npm'
        )
        expect(rows).toHaveLength(1)
    })

    // Without a range or an enumerated version there is nothing to match on, so a plain advisory is
    // dropped — but malware is kept, because the engine falls back to flag-by-presence for it.
    it('drops an unmatchable plain advisory but keeps unmatchable malware', function () {
        const empty = { affected: [{ package: { name: 'lodash', ecosystem: 'npm' } }] }
        expect(normalizeOsvRecord({ id: 'GHSA-1', ...empty }, 'npm')).toEqual([])
        expect(normalizeOsvRecord({ id: 'MAL-1', ...empty }, 'npm')).toHaveLength(1)
    })
})

describe('normalizeOsvRecord — range extraction', function () {
    it('reconstructs a half-open interval from an introduced/fixed event pair', function () {
        const rows = normalizeOsvRecord(record(), 'npm')
        expect(rows[0]?.ranges).toEqual([{ type: 'SEMVER', introduced: '4.0.0', fixed: '4.17.21', lastAffected: null }])
    })

    it('keeps ECOSYSTEM ranges alongside SEMVER ones', function () {
        const rows = normalizeOsvRecord(
            record({
                affected: [
                    {
                        package: { name: 'lodash', ecosystem: 'npm' },
                        ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '1.0.0' }, { fixed: '2.0.0' }] }]
                    }
                ]
            }),
            'npm'
        )
        expect(rows[0]?.ranges[0]?.type).toBe('ECOSYSTEM')
    })

    // GIT ranges carry commit hashes, not versions; no comparator can evaluate them, so keeping them
    // would only add unmatchable noise.
    it('drops GIT ranges entirely', function () {
        const rows = normalizeOsvRecord(
            record({
                affected: [
                    {
                        package: { name: 'lodash', ecosystem: 'npm' },
                        versions: ['1.0.0'],
                        ranges: [{ type: 'GIT', events: [{ introduced: 'abc123' }, { fixed: 'def456' }] }]
                    }
                ]
            }),
            'npm'
        )
        expect(rows[0]?.ranges).toEqual([])
        expect(rows[0]?.versions).toEqual(['1.0.0'])
    })

    it('defaults an untyped range to SEMVER', function () {
        const rows = normalizeOsvRecord(
            record({
                affected: [
                    { package: { name: 'lodash', ecosystem: 'npm' }, ranges: [{ events: [{ introduced: '1.0.0' }, { fixed: '2.0.0' }] }] }
                ]
            }),
            'npm'
        )
        expect(rows[0]?.ranges[0]?.type).toBe('SEMVER')
    })

    it('records last_affected as an inclusive bound with no fix', function () {
        const rows = normalizeOsvRecord(
            record({
                affected: [
                    {
                        package: { name: 'lodash', ecosystem: 'npm' },
                        ranges: [{ type: 'SEMVER', events: [{ introduced: '1.0.0' }, { last_affected: '1.5.0' }] }]
                    }
                ]
            }),
            'npm'
        )
        expect(rows[0]?.ranges).toEqual([{ type: 'SEMVER', introduced: '1.0.0', fixed: null, lastAffected: '1.5.0' }])
    })

    it('emits an open-ended range for a trailing introduced with no bound', function () {
        const rows = normalizeOsvRecord(
            record({
                affected: [
                    { package: { name: 'lodash', ecosystem: 'npm' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '1.0.0' }] }] }
                ]
            }),
            'npm'
        )
        expect(rows[0]?.ranges).toEqual([{ type: 'SEMVER', introduced: '1.0.0', fixed: null, lastAffected: null }])
    })

    // OSV event streams are flat: several introduced/fixed pairs can share one range object.
    it('splits a multi-interval event stream into separate ranges', function () {
        const rows = normalizeOsvRecord(
            record({
                affected: [
                    {
                        package: { name: 'lodash', ecosystem: 'npm' },
                        ranges: [
                            {
                                type: 'SEMVER',
                                events: [
                                    { introduced: '1.0.0' },
                                    { fixed: '1.5.0' },
                                    { introduced: '2.0.0' },
                                    { fixed: '2.5.0' }
                                ]
                            }
                        ]
                    }
                ]
            }),
            'npm'
        )
        expect(rows[0]?.ranges).toEqual([
            { type: 'SEMVER', introduced: '1.0.0', fixed: '1.5.0', lastAffected: null },
            { type: 'SEMVER', introduced: '2.0.0', fixed: '2.5.0', lastAffected: null }
        ])
    })

    // A new `introduced` must flush a still-open interval rather than silently discarding it.
    it('flushes an open last_affected interval when a new introduced arrives', function () {
        const rows = normalizeOsvRecord(
            record({
                affected: [
                    {
                        package: { name: 'lodash', ecosystem: 'npm' },
                        ranges: [
                            {
                                type: 'SEMVER',
                                events: [
                                    { introduced: '1.0.0' },
                                    { last_affected: '1.5.0' },
                                    { introduced: '2.0.0' },
                                    { fixed: '2.5.0' }
                                ]
                            }
                        ]
                    }
                ]
            }),
            'npm'
        )
        expect(rows[0]?.ranges).toEqual([
            { type: 'SEMVER', introduced: '1.0.0', fixed: null, lastAffected: '1.5.0' },
            { type: 'SEMVER', introduced: '2.0.0', fixed: '2.5.0', lastAffected: null }
        ])
    })
})

describe('normalizeOsvRecord — metadata', function () {
    it('flags a MAL- record as malicious and everything else as not', function () {
        expect(normalizeOsvRecord(record({ id: 'MAL-2025-1' }), 'npm')[0]?.malicious).toBe(true)
        expect(normalizeOsvRecord(record({ id: 'GHSA-1' }), 'npm')[0]?.malicious).toBe(false)
    })

    it('takes severity only from database_specific', function () {
        expect(normalizeOsvRecord(record({ database_specific: { severity: 'HIGH' } }), 'npm')[0]?.severity).toBe('HIGH')
        // A CVSS vector under severity[] is deliberately ignored here; the scanner defaults instead.
        expect(normalizeOsvRecord(record({ severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N' }] }), 'npm')[0]?.severity).toBeNull()
    })

    it('keeps only non-empty string aliases', function () {
        const rows = normalizeOsvRecord(record({ aliases: ['CVE-2024-1', '', 42, null] }), 'npm')
        expect(rows[0]?.aliases).toEqual(['CVE-2024-1'])
    })

    it('parses a withdrawn timestamp and leaves it null when absent', function () {
        expect(normalizeOsvRecord(record({ withdrawn: '2026-01-01T00:00:00Z' }), 'npm')[0]?.withdrawn).toBe(
            Date.parse('2026-01-01T00:00:00Z')
        )
        expect(normalizeOsvRecord(record(), 'npm')[0]?.withdrawn).toBeNull()
    })

    it('prefers an ADVISORY reference for the url', function () {
        const rows = normalizeOsvRecord(
            record({ references: [{ type: 'WEB', url: 'https://web.test' }, { type: 'ADVISORY', url: 'https://advisory.test' }] }),
            'npm'
        )
        expect(rows[0]?.url).toBe('https://advisory.test')
    })

    it('falls back to any reference, then to the osv.dev permalink', function () {
        expect(normalizeOsvRecord(record({ references: [{ type: 'WEB', url: 'https://web.test' }] }), 'npm')[0]?.url).toBe(
            'https://web.test'
        )
        expect(normalizeOsvRecord(record(), 'npm')[0]?.url).toBe('https://osv.dev/vulnerability/GHSA-1')
    })
})
