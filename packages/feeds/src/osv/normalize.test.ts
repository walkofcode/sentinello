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

// One affected entry for the npm package under test. Entries with no matchable range AND no
// enumerated version are dropped outright for non-malware, so anything probing range parsing has to
// carry a `versions` entry to keep the row alive long enough to inspect.
function affected(patch: Record<string, unknown>) {
    return [{ package: { name: 'lodash', ecosystem: 'npm' }, versions: ['1.0.0'], ...patch }]
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

    // One row, but carrying BOTH entries' affected sets. This used to assert only the row count, which is
    // why it stayed green while the second entry's versions were being thrown away.
    it('collapses a package listed twice into one row and keeps both affected sets', function () {
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
        expect(rows[0]?.versions).toEqual(['1.0.0', '2.0.0'])
    })

    // Without a range or an enumerated version there is nothing to match on, so a plain advisory is
    // dropped — but malware is kept, because the engine falls back to flag-by-presence for it.
    it('drops an unmatchable plain advisory but keeps unmatchable malware', function () {
        const empty = { affected: [{ package: { name: 'lodash', ecosystem: 'npm' } }] }
        expect(normalizeOsvRecord({ id: 'GHSA-1', ...empty }, 'npm')).toEqual([])
        expect(normalizeOsvRecord({ id: 'MAL-1', ...empty }, 'npm')).toHaveLength(1)
    })

    // The emptiness check has to run AFTER the merge. An entry carrying only a package name followed by
    // one carrying the ranges is a single package whose affected set arrives in pieces; testing the first
    // entry alone would discard the advisory before its ranges were ever seen.
    it('keeps a package whose affected set arrives on a later entry', function () {
        const rows = normalizeOsvRecord(
            record({
                affected: [
                    { package: { name: 'lodash', ecosystem: 'npm' } },
                    {
                        package: { name: 'lodash', ecosystem: 'npm' },
                        ranges: [{ type: 'SEMVER', events: [{ introduced: '1.0.0' }, { fixed: '2.0.0' }] }]
                    }
                ]
            }),
            'npm'
        )
        expect(rows).toHaveLength(1)
        expect(rows[0]?.ranges).toHaveLength(1)
    })
})

// REGRESSION — OSV expresses a per-release-branch fix as one `affected` entry PER BRANCH for the same
// package. The normalizer used to keep the first and `continue` past the rest, discarding 1,927 vulnerable
// intervals across the npm export alone. Every one of those is a false NEGATIVE: a real vulnerability the
// scanner could no longer see. Emitting one row per entry would not have helped either — the row key is
// (advisoryId, ecosystem, packageName), so they would collide on upsert and one branch would still win.
describe('normalizeOsvRecord — multi-branch advisories', function () {
    // npm/minimatch GHSA-23c5-xmqv-rm74, verbatim: eight branches, of which only [10.0.0, 10.2.3) survived.
    // A minimatch 3.0.4 or 9.0.0 install went unreported.
    it('merges every branch of a real eight-entry advisory', function () {
        const branches: [string, string][] = [
            ['10.0.0', '10.2.3'],
            ['9.0.0', '9.0.7'],
            ['8.0.0', '8.0.6'],
            ['7.0.0', '7.4.8'],
            ['6.0.0', '6.2.2'],
            ['5.0.0', '5.1.8'],
            ['4.0.0', '4.2.5'],
            ['0', '3.1.4']
        ]
        const rows = normalizeOsvRecord({
            id: 'GHSA-23c5-xmqv-rm74',
            affected: branches.map(function toEntry(branch) {
                return {
                    package: { name: 'minimatch', ecosystem: 'npm' },
                    ranges: [{ type: 'SEMVER', events: [{ introduced: branch[0] }, { fixed: branch[1] }] }]
                }
            })
        }, 'npm')
        expect(rows).toHaveLength(1)
        expect(rows[0]?.ranges).toHaveLength(8)
        expect(rows[0]?.ranges).toContainEqual({ type: 'SEMVER', introduced: '0', fixed: '3.1.4', lastAffected: null })
        expect(rows[0]?.ranges).toContainEqual({ type: 'SEMVER', introduced: '9.0.0', fixed: '9.0.7', lastAffected: null })
    })

    // npm/protobufjs GHSA-xq3m-2v4x-88gg — the same advisory whose gemnasium twin produced the false
    // positive, failing in the opposite direction here: OSV kept only the 8.x branch, so a genuinely
    // vulnerable protobufjs 7.0.0 was never reported.
    it('keeps both branches of the protobufjs advisory', function () {
        const rows = normalizeOsvRecord({
            id: 'GHSA-xq3m-2v4x-88gg',
            aliases: ['CVE-2026-41242'],
            affected: [
                {
                    package: { name: 'protobufjs', ecosystem: 'npm' },
                    ranges: [{ type: 'SEMVER', events: [{ introduced: '8.0.0' }, { fixed: '8.0.1' }] }]
                },
                {
                    package: { name: 'protobufjs', ecosystem: 'npm' },
                    ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '7.5.5' }] }]
                }
            ]
        }, 'npm')
        expect(rows[0]?.ranges).toEqual([
            { type: 'SEMVER', introduced: '8.0.0', fixed: '8.0.1', lastAffected: null },
            { type: 'SEMVER', introduced: '0', fixed: '7.5.5', lastAffected: null }
        ])
    })

    // Merging is per package, not per record: two different packages in one advisory stay two rows.
    it('does not merge across different packages', function () {
        const rows = normalizeOsvRecord(
            record({
                affected: [
                    { package: { name: 'lodash', ecosystem: 'npm' }, versions: ['1.0.0'] },
                    { package: { name: 'underscore', ecosystem: 'npm' }, versions: ['2.0.0'] }
                ]
            }),
            'npm'
        )
        expect(rows).toHaveLength(2)
        expect(rows.map(function name(r) { return r.packageName })).toEqual(['lodash', 'underscore'])
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

    // A range object with no events array bounds nothing. Dropping it is the safe reading: the row
    // survives on its enumerated versions instead of contributing an unbounded interval.
    it('drops a range whose events are missing or not an array', function () {
        expect(normalizeOsvRecord(record({ affected: affected({ ranges: [{ type: 'SEMVER' }] }) }), 'npm')[0]?.ranges).toEqual([])
        expect(
            normalizeOsvRecord(record({ affected: affected({ ranges: [{ type: 'SEMVER', events: {} }] }) }), 'npm')[0]?.ranges
        ).toEqual([])
    })

    // last_affected only bounds an interval that is already open. Honouring one with no `introduced`
    // before it would invent a lower bound the advisory never stated.
    it('ignores a last_affected event that opens no interval', function () {
        const ranges = [{ type: 'SEMVER', events: [{ last_affected: '1.0.0' }] }]
        expect(normalizeOsvRecord(record({ affected: affected({ ranges }) }), 'npm')[0]?.ranges).toEqual([])
    })

    it('ignores a fixed event that closes no interval', function () {
        const ranges = [{ type: 'SEMVER', events: [{ fixed: '1.0.0' }] }]
        expect(normalizeOsvRecord(record({ affected: affected({ ranges }) }), 'npm')[0]?.ranges).toEqual([])
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

    // An unparseable string is treated as "not withdrawn" rather than as NaN. A NaN here would be
    // written straight into the withdrawn column, and the lookup filters on `withdrawn IS NULL` —
    // so the advisory would silently stop matching anything.
    it.each(['whenever', '', 'yesterday'])('nulls the unparseable withdrawn value %j', function (withdrawn) {
        expect(normalizeOsvRecord(record({ withdrawn }), 'npm')[0]?.withdrawn).toBeNull()
    })

    it('keeps a string summary and nulls anything else', function () {
        expect(normalizeOsvRecord(record({ summary: 'Prototype pollution' }), 'npm')[0]?.summary).toBe('Prototype pollution')
        expect(normalizeOsvRecord(record({ summary: 42 }), 'npm')[0]?.summary).toBeNull()
    })

    it('keeps only non-empty string versions', function () {
        const rows = normalizeOsvRecord(record({ affected: affected({ versions: ['1.0.0', '', 42, null, '2.0.0'] }) }), 'npm')
        expect(rows[0]?.versions).toEqual(['1.0.0', '2.0.0'])
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

    // A references array that exists but carries no usable url must keep falling through rather than
    // resolving to an empty string — the url is rendered as a link in the portal.
    it('ignores references that carry no usable url', function () {
        const rows = normalizeOsvRecord(record({ references: [{ type: 'WEB' }, { type: 'PACKAGE', url: '' }] }), 'npm')
        expect(rows[0]?.url).toBe('https://osv.dev/vulnerability/GHSA-1')
    })

    it('prefers database_specific.source over the permalink', function () {
        const rows = normalizeOsvRecord(record({ database_specific: { source: 'https://source.test/GHSA-1.json' } }), 'npm')
        expect(rows[0]?.url).toBe('https://source.test/GHSA-1.json')
    })

    it('skips an empty database_specific.source', function () {
        expect(normalizeOsvRecord(record({ database_specific: { source: '' } }), 'npm')[0]?.url).toBe(
            'https://osv.dev/vulnerability/GHSA-1'
        )
    })
})
