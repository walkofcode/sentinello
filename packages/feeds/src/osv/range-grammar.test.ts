import { describe, expect, it } from 'vitest'
import { satisfies } from 'semver'
import { normalizeOsvRecord } from './normalize'

// EXHAUSTIVE EVENT-SEQUENCE SWEEP — the OSV half of the same argument made in
// ../gemnasium/range-grammar.test.ts.
//
// gemnasium states a range as a string, so its defects were spellings. OSV states one as an ORDERED EVENT
// LIST — `introduced`, `fixed`, `last_affected` — and its defects are therefore sequences: which event
// opens an interval, which closes it, what a second `introduced` does to an interval still open, what an
// event means when it arrives with no interval open at all. The one this repo shipped (fixed in cdf75a8)
// was exactly that shape: a `fixed` bound read while the parser sat outside any range.
//
// The failure mode is identical to the string case, and so is the reason tests kept missing it — a
// hand-written OSV fixture contains the sequence its author had in mind. So this file enumerates every
// sequence of up to four events over a small version alphabet, 1,554 of them, and asserts INVARIANTS that
// must hold for all of them rather than expected values for a chosen few.
//
// Invariants beat expected values here for the same reason P1 does in the gemnasium sweep: an invariant
// cannot be written wrong in the same direction as the code, because it never states what the answer is.
// It states what the answer may never be — and every range defect this repo has shipped violates one of
// the five below.

const VERSIONS = ['1.0.0', '2.0.0'] as const

type Event = { introduced: string } | { fixed: string } | { last_affected: string }

const EVENTS: Event[] = []
for (const version of VERSIONS) {
    EVENTS.push({ introduced: version })
    EVENTS.push({ fixed: version })
    EVENTS.push({ last_affected: version })
}

// Every sequence of length 1..4 over the six events above.
function allSequences(maxLength: number): Event[][] {
    let level: Event[][] = [[]]
    const out: Event[][] = []
    for (let length = 0; length < maxLength; length += 1) {
        const next: Event[][] = []
        for (const prefix of level) {
            for (const event of EVENTS) {
                const extended = prefix.concat([event])
                next.push(extended)
                out.push(extended)
            }
        }
        level = next
    }
    return out
}

const SEQUENCES = allSequences(4)

function rangesFor(events: Event[]): { introduced: string; fixed?: string | null; lastAffected?: string | null }[] {
    const rows = normalizeOsvRecord(
        {
            id: 'GHSA-sweep',
            affected: [{ package: { name: 'pkg', ecosystem: 'npm' }, ranges: [{ type: 'SEMVER', events }] }]
        },
        'npm'
    )
    return rows[0]?.ranges ?? []
}

// What the sequence itself names, so an invariant can check that nothing was invented.
function statedVersions(events: Event[], key: 'introduced' | 'fixed' | 'last_affected'): string[] {
    const out: string[] = []
    for (const event of events) {
        const value = (event as Record<string, string>)[key]
        if (typeof value === 'string') out.push(value)
    }
    return out
}

function compare(a: string, b: string): number {
    const left = a.split('.').map(Number)
    const right = b.split('.').map(Number)
    for (let i = 0; i < 3; i += 1) {
        const l = left[i] ?? 0
        const r = right[i] ?? 0
        if (l !== r) return l < r ? -1 : 1
    }
    return 0
}

describe('OSV event sequences — invariants that must hold for all 1,554', function () {
    it('generated the whole space', function () {
        expect(SEQUENCES).toHaveLength(6 + 36 + 216 + 1296)
    })

    // INV1 — NO EMPTY OR INVERTED INTERVAL. `fixed` is an exclusive upper bound, so `fixed <= introduced`
    // describes a range that admits no version. It is the signature of every inverted-boundary defect this
    // repo has had: the interval either silently matches nothing, or gets rescued downstream into a bound
    // pointing at the version that FIXED the advisory.
    it('never emits an interval whose fixed bound is at or below its introduced bound', function () {
        const bad: string[] = []
        for (const events of SEQUENCES) {
            for (const range of rangesFor(events)) {
                if (typeof range.fixed !== 'string') continue
                if (compare(range.fixed, range.introduced) > 0) continue
                bad.push(JSON.stringify(events) + ' -> ' + JSON.stringify(range))
            }
        }
        expect(bad).toEqual([])
    })

    // INV2 — the two upper bounds are mutually exclusive. `fixed` is exclusive and `lastAffected` is
    // inclusive; a range carrying both states two different upper boundaries at once, and which one the
    // matcher honours is then an implementation detail rather than a decision.
    it('never emits an interval carrying both an exclusive and an inclusive upper bound', function () {
        const bad: string[] = []
        for (const events of SEQUENCES) {
            for (const range of rangesFor(events)) {
                if (typeof range.fixed === 'string' && typeof range.lastAffected === 'string') {
                    bad.push(JSON.stringify(events) + ' -> ' + JSON.stringify(range))
                }
            }
        }
        expect(bad).toEqual([])
    })

    // INV3 — NEVER INVENT A BOUND. Every bound emitted has to be a version the sequence actually named.
    // This is the invariant that would have caught the protobufjs regression on the gemnasium side, where
    // a fix from one branch was pinned onto another branch's interval.
    it('never emits a bound the sequence did not state', function () {
        const bad: string[] = []
        for (const events of SEQUENCES) {
            const introduced = statedVersions(events, 'introduced')
            const fixed = statedVersions(events, 'fixed')
            const lastAffected = statedVersions(events, 'last_affected')
            for (const range of rangesFor(events)) {
                if (!introduced.includes(range.introduced)) {
                    bad.push('introduced ' + JSON.stringify(events) + ' -> ' + JSON.stringify(range))
                }
                if (typeof range.fixed === 'string' && !fixed.includes(range.fixed)) {
                    bad.push('fixed ' + JSON.stringify(events) + ' -> ' + JSON.stringify(range))
                }
                if (typeof range.lastAffected === 'string' && !lastAffected.includes(range.lastAffected)) {
                    bad.push('lastAffected ' + JSON.stringify(events) + ' -> ' + JSON.stringify(range))
                }
            }
        }
        expect(bad).toEqual([])
    })

    // INV4 — an interval needs an opening event. A sequence of nothing but `fixed` and `last_affected`
    // names no vulnerable starting point, and reading a bound while outside any range is the defect
    // cdf75a8 fixed; this pins the general case rather than the one record that exposed it.
    it('emits nothing for a sequence that never opens an interval', function () {
        const bad: string[] = []
        for (const events of SEQUENCES) {
            if (statedVersions(events, 'introduced').length > 0) continue
            const ranges = rangesFor(events)
            if (ranges.length > 0) bad.push(JSON.stringify(events) + ' -> ' + JSON.stringify(ranges))
        }
        expect(bad).toEqual([])
    })

    // INV5 — no more intervals out than `introduced` events in. Each one opens exactly one interval, so
    // emitting more means an interval was duplicated, which double-reports a finding.
    it('never emits more intervals than the sequence opened', function () {
        const bad: string[] = []
        for (const events of SEQUENCES) {
            const opened = statedVersions(events, 'introduced').length
            const ranges = rangesFor(events)
            if (ranges.length > opened) bad.push(JSON.stringify(events) + ' -> ' + ranges.length + ' of ' + opened)
        }
        expect(bad).toEqual([])
    })
})

describe('OSV event sequences — the well-formed ones agree with npm', function () {
    // A well-formed SEMVER sequence maps onto a node-semver range with no interpretation required:
    // introduced A + fixed B is ">=A <B", introduced A + last_affected B is ">=A <=B", and a bare
    // introduced A is ">=A". Those three are the whole of OSV's npm grammar, which makes node-semver an
    // oracle here exactly as it is for a gemnasium range string.
    const CASES: { events: Event[]; npm: string }[] = [
        { events: [{ introduced: '0' }], npm: '>=0.0.0' },
        { events: [{ introduced: '1.0.0' }], npm: '>=1.0.0' },
        { events: [{ introduced: '1.0.0' }, { fixed: '2.0.0' }], npm: '>=1.0.0 <2.0.0' },
        { events: [{ introduced: '0' }, { fixed: '0.5.2' }], npm: '>=0.0.0 <0.5.2' },
        { events: [{ introduced: '1.0.0' }, { last_affected: '2.0.0' }], npm: '>=1.0.0 <=2.0.0' },
        { events: [{ introduced: '1.0.0' }, { fixed: '1.0.1' }], npm: '>=1.0.0 <1.0.1' },
        {
            events: [{ introduced: '1.0.0' }, { fixed: '2.0.0' }, { introduced: '3.0.0' }, { fixed: '4.0.0' }],
            npm: '>=1.0.0 <2.0.0 || >=3.0.0 <4.0.0'
        },
        {
            events: [{ introduced: '1.0.0' }, { last_affected: '1.9.9' }, { introduced: '3.0.0' }, { fixed: '4.0.0' }],
            npm: '>=1.0.0 <=1.9.9 || >=3.0.0 <4.0.0'
        }
    ]

    const PROBES = ['0.0.1', '0.5.1', '0.5.2', '1.0.0', '1.0.1', '1.9.9', '2.0.0', '2.5.0', '3.0.0', '4.0.0', '9.9.9']

    it.each(CASES)('$npm', function ({ events, npm }) {
        const ranges = rangesFor(events)
        expect(ranges.length).toBeGreaterThan(0)
        for (const version of PROBES) {
            const ours = ranges.some(function inAny(range) {
                if (compare(version, range.introduced) < 0) return false
                if (typeof range.fixed === 'string') return compare(version, range.fixed) < 0
                if (typeof range.lastAffected === 'string') return compare(version, range.lastAffected) <= 0
                return true
            })
            expect(ours, npm + ' @ ' + version).toBe(satisfies(version, npm, { includePrerelease: true }))
        }
    })
})

describe('OSV range types', function () {
    // GIT ranges carry commit hashes. No comparator can evaluate one against an installed version, so a
    // retained GIT range is a row that can only ever fail to match — or, if a comparator were ever fed
    // one, match on a string comparison against a sha.
    it('drops a GIT range and keeps a SEMVER one from the same entry', function () {
        const rows = normalizeOsvRecord(
            {
                id: 'GHSA-mixed',
                affected: [
                    {
                        package: { name: 'pkg', ecosystem: 'npm' },
                        ranges: [
                            { type: 'GIT', events: [{ introduced: 'abc123' }, { fixed: 'def456' }] },
                            { type: 'SEMVER', events: [{ introduced: '1.0.0' }, { fixed: '2.0.0' }] }
                        ]
                    }
                ]
            },
            'npm'
        )
        expect(rows[0]?.ranges).toEqual([{ type: 'SEMVER', introduced: '1.0.0', fixed: '2.0.0', lastAffected: null }])
    })

    it.each(['SEMVER', 'ECOSYSTEM'])('retains a %s range', function (type) {
        const rows = normalizeOsvRecord(
            {
                id: 'GHSA-typed',
                affected: [{ package: { name: 'pkg', ecosystem: 'npm' }, ranges: [{ type, events: [{ introduced: '1.0.0' }] }] }]
            },
            'npm'
        )
        expect(rows[0]?.ranges).toHaveLength(1)
        expect(rows[0]?.ranges[0]?.type).toBe(type)
    })

    // An untyped range defaults to SEMVER, which is what the OSV schema says and — more to the point — is
    // what keeps the matcher's accepted-type filter from dropping it silently.
    it('defaults an untyped range to SEMVER rather than dropping it', function () {
        const rows = normalizeOsvRecord(
            {
                id: 'GHSA-untyped',
                affected: [{ package: { name: 'pkg', ecosystem: 'npm' }, ranges: [{ events: [{ introduced: '1.0.0' }] }] }]
            },
            'npm'
        )
        expect(rows[0]?.ranges[0]?.type).toBe('SEMVER')
    })

    it.each(['GIT', 'UNKNOWN', 'ECOSYSTEM_UNSUPPORTED', ''])('drops a %j range', function (type) {
        const rows = normalizeOsvRecord(
            {
                id: 'GHSA-dropped',
                affected: [{ package: { name: 'pkg', ecosystem: 'npm' }, ranges: [{ type, events: [{ introduced: '1.0.0' }] }] }]
            },
            'npm'
        )
        expect(rows[0]?.ranges ?? []).toEqual([])
    })
})

describe('OSV malformed events are ignored, never guessed at', function () {
    // Each of these is an event whose value is not a version string. The dangerous outcome is not dropping
    // it — it is coercing it into a bound, which caches a boundary no record stated.
    it.each([
        [{ introduced: 0 }],
        [{ introduced: null }],
        [{ fixed: 2 }],
        [{ last_affected: {} }],
        [{ introduced: '1.0.0' }, { fixed: null }],
        [{ introduced: '1.0.0' }, { fixed: 2 }],
        [{}]
    ])('tolerates %j without inventing a bound', function (...events) {
        const ranges = rangesFor(events as unknown as Event[])
        for (const range of ranges) {
            expect(typeof range.introduced).toBe('string')
            expect(range.fixed === null || typeof range.fixed === 'string').toBe(true)
            expect(range.lastAffected === null || typeof range.lastAffected === 'string').toBe(true)
        }
    })

    it('ignores a ranges field that is not an array', function () {
        const rows = normalizeOsvRecord(
            { id: 'GHSA-bad', affected: [{ package: { name: 'pkg', ecosystem: 'npm' }, ranges: 'nope', versions: ['1.0.0'] }] },
            'npm'
        )
        expect(rows[0]?.ranges ?? []).toEqual([])
    })

    it('ignores an events field that is not an array', function () {
        const rows = normalizeOsvRecord(
            {
                id: 'GHSA-bad-events',
                affected: [{ package: { name: 'pkg', ecosystem: 'npm' }, ranges: [{ type: 'SEMVER', events: 'nope' }], versions: ['1.0.0'] }]
            },
            'npm'
        )
        expect(rows[0]?.ranges ?? []).toEqual([])
    })
})
