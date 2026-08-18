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

    it('refuses an unreadable SEMVER lower bound without inventing one', function () {
        const ranges = [{ type: 'SEMVER', events: [{ introduced: 'not-a-version' }] }]
        const rows = normalizeOsvRecord(record({ affected: affected({ ranges }) }), 'npm')
        expect(rows[0]?.ranges).toEqual([])
        expect(rows[0]?.versions).toEqual(['1.0.0'])
    })

    it.each([
        [{ introduced: '1.0.0' }, { fixed: 'not-a-version' }],
        [{ introduced: '1.0.0' }, { last_affected: 'not-a-version' }]
    ])('keeps an interval open when its SEMVER upper event is unreadable', function (...events) {
        const ranges = [{ type: 'SEMVER', events }]
        const rows = normalizeOsvRecord(record({ affected: affected({ ranges }) }), 'npm')
        expect(rows[0]?.ranges).toEqual([{ type: 'SEMVER', introduced: '1.0.0', fixed: null, lastAffected: null }])
    })

    it('uses semver validation for an ECOSYSTEM range in a semver ecosystem', function () {
        const ranges = [{ type: 'ECOSYSTEM', events: [{ introduced: '1.0.0' }, { fixed: 'not-a-version' }] }]
        const rows = normalizeOsvRecord(record({ affected: affected({ ranges }) }), 'npm')
        expect(rows[0]?.ranges).toEqual([{ type: 'ECOSYSTEM', introduced: '1.0.0', fixed: null, lastAffected: null }])
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

// One affected entry whose ranges are whatever `ranges` says, carrying the entry-level database_specific
// this block is about. Named for the package under test so the real advisories below read as themselves.
function entry(name: string, ranges: unknown[], lastKnownAffected?: string) {
    const affectedEntry: Record<string, unknown> = { package: { name, ecosystem: 'npm' }, ranges }
    if (lastKnownAffected !== undefined) {
        affectedEntry.database_specific = { last_known_affected_version_range: lastKnownAffected }
    }
    return affectedEntry
}

function open(introduced: string) {
    return { type: 'SEMVER', events: [{ introduced }] }
}

describe('normalizeOsvRecord — last_known_affected_version_range', function () {
    // GitHub will not emit a `fixed` event naming a version the registry does not serve under that package
    // name, so it states the range as "everything from 0" and puts the real bound here. SheetJS moved xlsx
    // 0.19.x+ to cdn.sheetjs.com, so the npm package stops at 0.18.5 and both advisories arrive open-ended.
    // Before this was read, a fully patched 0.20.3 was reported high-severity-no-fix on 11 projects.
    it('recovers the bound xlsx GHSA-4r6h-8v6p-xvw6 states outside its range', function () {
        const rows = normalizeOsvRecord(
            record({ id: 'GHSA-4r6h-8v6p-xvw6', affected: [entry('xlsx', [open('0')], '< 0.19.3')] }),
            'npm'
        )
        // `type` has to survive the rewrite: the matcher drops an untyped range when it filters by type.
        expect(rows[0]?.ranges).toEqual([{ type: 'SEMVER', introduced: '0', fixed: '0.19.3', lastAffected: null }])
    })

    it('recovers the bound xlsx GHSA-5pgg-2g8v-p4x9 states outside its range', function () {
        const rows = normalizeOsvRecord(
            record({ id: 'GHSA-5pgg-2g8v-p4x9', affected: [entry('xlsx', [open('0')], '< 0.20.2')] }),
            'npm'
        )
        expect(rows[0]?.ranges).toEqual([{ type: 'SEMVER', introduced: '0', fixed: '0.20.2', lastAffected: null }])
    })

    // Same record, two package names: GHSA-67hx-6x53-jw92 bounds `@babel/traverse` normally and leaves
    // `babel-traverse` open, because 7.23.2 was only ever published under the renamed scope.
    it('recovers the bound for babel-traverse, whose fix exists only as @babel/traverse', function () {
        const rows = normalizeOsvRecord(
            record({ id: 'GHSA-67hx-6x53-jw92', affected: [entry('babel-traverse', [open('0')], '< 7.23.2')] }),
            'npm'
        )
        expect(rows[0]?.ranges).toEqual([{ type: 'SEMVER', introduced: '0', fixed: '7.23.2', lastAffected: null }])
    })

    it('reads a <= bound as inclusive with no fix', function () {
        const rows = normalizeOsvRecord(record({ affected: [entry('lodash', [open('0')], '<= 1.2.3')] }), 'npm')
        expect(rows[0]?.ranges).toEqual([{ type: 'SEMVER', introduced: '0', fixed: null, lastAffected: '1.2.3' }])
    })

    it('leaves the interval open when the fallback is at or below its lower bound', function () {
        for (const fallback of ['< 2.0.0', '< 1.0.0']) {
            const rows = normalizeOsvRecord(record({ affected: [entry('lodash', [open('2.0.0')], fallback)] }), 'npm')
            expect(rows[0]?.ranges, fallback).toEqual([
                { type: 'SEMVER', introduced: '2.0.0', fixed: null, lastAffected: null }
            ])
        }
    })

    // REGRESSION: the fallback only fires on a lone range, so it has to be counted AFTER the degenerate
    // ones are dropped. Counting first let an empty sibling leave the record's one live interval open
    // forever — a finding no upgrade can clear — while every test stayed green.
    it('still bounds the only live range when a degenerate sibling is present', function () {
        const ranges = [
            { type: 'SEMVER', events: [{ introduced: '2.0.0' }, { fixed: '1.0.0' }] },
            { type: 'SEMVER', events: [{ introduced: '3.0.0' }] }
        ]
        const rows = normalizeOsvRecord(record({ affected: [entry('lodash', ranges, '< 4.0.0')] }), 'npm')
        expect(rows[0]?.ranges).toEqual([{ type: 'SEMVER', introduced: '3.0.0', fixed: '4.0.0', lastAffected: null }])
    })

    it('keeps an inclusive fallback equal to the lower bound', function () {
        const rows = normalizeOsvRecord(record({ affected: [entry('lodash', [open('2.0.0')], '<= 2.0.0')] }), 'npm')
        expect(rows[0]?.ranges).toEqual([
            { type: 'SEMVER', introduced: '2.0.0', fixed: null, lastAffected: '2.0.0' }
        ])
    })

    it('validates an ECOSYSTEM fallback with the npm comparator', function () {
        const ranges = [{ type: 'ECOSYSTEM', events: [{ introduced: '2.0.0' }] }]
        const rows = normalizeOsvRecord(record({ affected: [entry('lodash', ranges, '< 1.0.0')] }), 'npm')
        expect(rows[0]?.ranges).toEqual([
            { type: 'ECOSYSTEM', introduced: '2.0.0', fixed: null, lastAffected: null }
        ])
    })

    it('leaves an ECOSYSTEM fallback to the non-semver ecosystem comparator', function () {
        const rows = normalizeOsvRecord(
            record({
                affected: [{
                    package: { name: 'django', ecosystem: 'PyPI' },
                    ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '1!1.0' }] }],
                    database_specific: { last_known_affected_version_range: '<= 1!2.0' }
                }]
            }),
            'PyPI'
        )
        expect(rows[0]?.ranges).toEqual([
            { type: 'ECOSYSTEM', introduced: '1!1.0', fixed: null, lastAffected: '1!2.0' }
        ])
    })

    // REGRESSION: the field is a fallback, never a supplement. GHSA-25hc-qcg6-38wj claims `< 2.5.0` while
    // the record's real branch fixes are 2.5.1 AND 4.6.2 — applying it over a stated bound would turn a
    // correct range into a false negative and hide everything from 2.5.0 to 4.6.1.
    it('never overrides the branch fixes GHSA-25hc-qcg6-38wj already states', function () {
        const rows = normalizeOsvRecord(
            record({
                id: 'GHSA-25hc-qcg6-38wj',
                affected: [
                    entry(
                        'socket.io',
                        [
                            { type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '2.5.1' }] },
                            { type: 'SEMVER', events: [{ introduced: '3.0.0' }, { fixed: '4.6.2' }] }
                        ],
                        '< 2.5.0'
                    )
                ]
            }),
            'npm'
        )
        expect(rows[0]?.ranges).toEqual([
            { type: 'SEMVER', introduced: '0', fixed: '2.5.1', lastAffected: null },
            { type: 'SEMVER', introduced: '3.0.0', fixed: '4.6.2', lastAffected: null }
        ])
    })

    it('does not supplement an interval already bounded by last_affected', function () {
        const ranges = [{ type: 'SEMVER', events: [{ introduced: '1.0.0' }, { last_affected: '1.5.0' }] }]
        const rows = normalizeOsvRecord(record({ affected: [entry('lodash', ranges, '< 9.9.9')] }), 'npm')
        expect(rows[0]?.ranges).toEqual([{ type: 'SEMVER', introduced: '1.0.0', fixed: null, lastAffected: '1.5.0' }])
    })

    // A single upper bound cannot close two intervals, and choosing which one to close would be exactly the
    // arbitrary pick that made protobufjs report a patched release as critical on the gemnasium side.
    it('leaves an entry alone when it produced more than one interval', function () {
        const ranges = [{ type: 'SEMVER', events: [{ introduced: '1.0.0' }, { introduced: '2.0.0' }] }]
        const rows = normalizeOsvRecord(record({ affected: [entry('lodash', ranges, '< 3.0.0')] }), 'npm')
        expect(rows[0]?.ranges).toEqual([
            { type: 'SEMVER', introduced: '1.0.0', fixed: null, lastAffected: null },
            { type: 'SEMVER', introduced: '2.0.0', fixed: null, lastAffected: null }
        ])
    })

    // The field belongs to the affected ENTRY, so it has to be applied before entries are merged per
    // package — otherwise one branch's bound would leak onto another branch's range.
    it('applies per affected entry rather than per record', function () {
        const rows = normalizeOsvRecord(
            record({
                affected: [
                    entry('lodash', [open('0')], '< 1.9.9'),
                    entry('lodash', [{ type: 'SEMVER', events: [{ introduced: '2.0.0' }, { fixed: '2.5.0' }] }])
                ]
            }),
            'npm'
        )
        expect(rows[0]?.ranges).toEqual([
            { type: 'SEMVER', introduced: '0', fixed: '1.9.9', lastAffected: null },
            { type: 'SEMVER', introduced: '2.0.0', fixed: '2.5.0', lastAffected: null }
        ])
    })

    // The two-form grammar was measured on a sample, not the whole export, so an unrecognised shape must
    // leave the range untouched. A too-wide range is the behaviour we already have; a bound invented from a
    // misread string would hide a real vulnerability.
    it.each(['>= 1.0.0', '', '<', '<=', '  ', '<banana', '< 1.0.0 || < 2.0.0', '>=1.0.0 <2.0.0', '<1.0.0,<2.0.0'])(
        'refuses a bound it cannot read: %j',
        function (raw) {
            const rows = normalizeOsvRecord(record({ affected: [entry('lodash', [open('0')], raw)] }), 'npm')
            expect(rows[0]?.ranges).toEqual([{ type: 'SEMVER', introduced: '0', fixed: null, lastAffected: null }])
        }
    )

    // 480 of the 495 open-ended npm advisories are genuinely unfixed. They must keep saying so.
    it('leaves a genuinely unfixed advisory open-ended', function () {
        const withoutField = normalizeOsvRecord(record({ affected: [entry('lodash', [open('0')])] }), 'npm')
        expect(withoutField[0]?.ranges).toEqual([{ type: 'SEMVER', introduced: '0', fixed: null, lastAffected: null }])
        const emptyField = normalizeOsvRecord(
            record({ affected: [{ package: { name: 'lodash', ecosystem: 'npm' }, ranges: [open('0')], database_specific: {} }] }),
            'npm'
        )
        expect(emptyField[0]?.ranges).toEqual([{ type: 'SEMVER', introduced: '0', fixed: null, lastAffected: null }])
    })
})
