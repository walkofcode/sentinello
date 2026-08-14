import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
    countGemnasiumAdvisories,
    lookupGemnasiumByPackages,
    openGemnasiumDb,
    runGemnasiumMigrations,
    upsertGemnasiumAdvisories,
    type GemnasiumDrizzleDb
} from '@sentinello/db'
import type { GemnasiumAdvisoryRow, GemnasiumRange } from '@sentinello/core'
import { resolveGemnasiumRanges } from './gemnasium-resolve'

// This pass exists because gemnasium writes `affected_range: "<0"` — the empty set — on records that have
// no machine-readable range, 698 of 10,777 npm advisories. The normalizer refuses to invent a range for
// them and caches them as inert 'unresolved' rows; this is what then recovers one, in a strict order of
// trust, or deletes the row.
//
// The ordering is not a preference, it is measured: across the 442 records where a sibling range and
// parseable prose BOTH exist they agree 438 times, and in all four disagreements the sibling is narrower
// and correct. uuid GHSA-w5hq-g745-h8pq is the sharpest case — the sibling excludes the patched 11.1.1,
// 12.0.1 and 13.0.1, while the prose sweeps in everything below 14.0.0. So a sibling must be allowed to
// overrule a prose range that is already in place, which is why 'prose' rows are revisited here at all.

let db: GemnasiumDrizzleDb
let sqlite: { close(): void }
let dir: string

function row(overrides: Partial<GemnasiumAdvisoryRow> = {}): GemnasiumAdvisoryRow {
    return {
        advisoryId: 'CVE-2024-1',
        ecosystem: 'npm',
        packageName: 'protobufjs',
        aliases: [],
        ranges: [],
        versions: [],
        severity: 'critical',
        summary: 'Arbitrary code execution in protobufjs',
        url: null,
        malicious: false,
        withdrawn: null,
        rangeSource: 'range',
        ...overrides
    }
}

// The real pair from gemnasium-db: a GHSA-keyed stub with no range, and the CVE-keyed record for the same
// vulnerability and package that lists the GHSA in its identifiers and carries both release branches.
const PROTOBUFJS_TRUE_RANGES: GemnasiumRange[] = [
    { introduced: '0', fixed: '7.5.5' },
    { introduced: '8.0.0', fixed: '8.0.1' }
]

function protobufjsStub(overrides: Partial<GemnasiumAdvisoryRow> = {}): GemnasiumAdvisoryRow {
    return row({ advisoryId: 'GHSA-xq3m-2v4x-88gg', rangeSource: 'unresolved', ranges: [], ...overrides })
}

function protobufjsSibling(): GemnasiumAdvisoryRow {
    return row({
        advisoryId: 'CVE-2026-41242',
        aliases: ['GHSA-xq3m-2v4x-88gg'],
        ranges: PROTOBUFJS_TRUE_RANGES,
        rangeSource: 'range'
    })
}

function rangesFor(advisoryId: string, packageName = 'protobufjs'): GemnasiumRange[] | null {
    const found = lookupGemnasiumByPackages(db, 'npm', [packageName]).get(packageName) || []
    const match = found.find(function byId(r) {
        return r.advisoryId === advisoryId
    })
    return match ? match.ranges : null
}

beforeEach(async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-gemnasium-resolve-'))
    const opened = openGemnasiumDb(join(dir, 'gemnasium.db'))
    db = opened.db
    sqlite = opened.sqlite
    runGemnasiumMigrations(db)
})

afterEach(async function teardown() {
    sqlite.close()
    await rm(dir, { recursive: true, force: true })
})

describe('resolveGemnasiumRanges — sibling tier', function () {
    it('recovers both branches of the protobufjs stub from its CVE-keyed twin', function () {
        upsertGemnasiumAdvisories(db, [protobufjsStub(), protobufjsSibling()])
        const result = resolveGemnasiumRanges(db)
        expect(result.fromSibling).toBe(1)
        expect(result.dropped).toBe(0)
        expect(rangesFor('GHSA-xq3m-2v4x-88gg')).toEqual(PROTOBUFJS_TRUE_RANGES)
    })

    // The recovered row must actually reach the scanner — an 'unresolved' row is filtered out of the
    // lookup, so a resolution that failed to update rangeSource would leave it invisible.
    it('makes the recovered row visible to the scanner lookup', function () {
        upsertGemnasiumAdvisories(db, [protobufjsStub(), protobufjsSibling()])
        expect(rangesFor('GHSA-xq3m-2v4x-88gg')).toBeNull()
        resolveGemnasiumRanges(db)
        expect(rangesFor('GHSA-xq3m-2v4x-88gg')).not.toBeNull()
    })

    // The cross-reference can be recorded on either side depending on which identifier gemnasium keyed the
    // file by, so the link is checked in both directions.
    it('matches a sibling through the stub own alias list', function () {
        upsertGemnasiumAdvisories(db, [
            protobufjsStub({ aliases: ['CVE-2026-41242'] }),
            row({ advisoryId: 'CVE-2026-41242', aliases: [], ranges: PROTOBUFJS_TRUE_RANGES })
        ])
        expect(resolveGemnasiumRanges(db).fromSibling).toBe(1)
        expect(rangesFor('GHSA-xq3m-2v4x-88gg')).toEqual(PROTOBUFJS_TRUE_RANGES)
    })

    // A sibling is only a sibling for the SAME package. Copying a range across packages would attribute
    // one library's affected versions to another.
    it('ignores a cross-referenced advisory for a different package', function () {
        upsertGemnasiumAdvisories(db, [
            protobufjsStub(),
            row({ advisoryId: 'CVE-2026-41242', packageName: 'vite', aliases: ['GHSA-xq3m-2v4x-88gg'], ranges: PROTOBUFJS_TRUE_RANGES })
        ])
        const result = resolveGemnasiumRanges(db)
        expect(result.fromSibling).toBe(0)
        expect(result.dropped).toBe(1)
    })

    it('ignores an unrelated advisory for the same package', function () {
        upsertGemnasiumAdvisories(db, [
            protobufjsStub(),
            row({ advisoryId: 'CVE-2022-25878', aliases: ['GHSA-unrelated'], ranges: [{ introduced: '0', fixed: '6.11.3' }] })
        ])
        expect(resolveGemnasiumRanges(db).fromSibling).toBe(0)
    })

    // A candidate with no ranges of its own would "resolve" the stub to an empty affected set — which is
    // the very sentinel state being escaped.
    it('does not resolve against a sibling that has no ranges either', function () {
        upsertGemnasiumAdvisories(db, [
            protobufjsStub(),
            row({ advisoryId: 'CVE-2026-41242', aliases: ['GHSA-xq3m-2v4x-88gg'], ranges: [], rangeSource: 'unresolved' })
        ])
        const result = resolveGemnasiumRanges(db)
        expect(result.fromSibling).toBe(0)
        expect(result.dropped).toBe(2)
    })

    // The measured case for why a sibling outranks prose: keeping the prose range would report the patched
    // uuid 11.1.1, 12.0.1 and 13.0.1 as vulnerable.
    it('lets a sibling overrule a range already recovered from prose', function () {
        const siblingRanges: GemnasiumRange[] = [
            { introduced: '0', fixed: '11.1.1' },
            { introduced: '12.0.0', fixed: '12.0.1' },
            { introduced: '13.0.0', fixed: '13.0.1' }
        ]
        upsertGemnasiumAdvisories(db, [
            row({
                advisoryId: 'GHSA-w5hq-g745-h8pq',
                packageName: 'uuid',
                ranges: [{ introduced: '0', fixed: '14.0.0' }],
                rangeSource: 'prose'
            }),
            row({
                advisoryId: 'CVE-2026-99999',
                packageName: 'uuid',
                aliases: ['GHSA-w5hq-g745-h8pq'],
                ranges: siblingRanges,
                rangeSource: 'range'
            })
        ])
        expect(resolveGemnasiumRanges(db).fromSibling).toBe(1)
        expect(rangesFor('GHSA-w5hq-g745-h8pq', 'uuid')).toEqual(siblingRanges)
    })

    // Two candidates cross-reference the stub; the more completely curated one — the multi-branch range —
    // is the one carrying the structure the stub is missing.
    it('prefers the candidate with the most intervals', function () {
        upsertGemnasiumAdvisories(db, [
            protobufjsStub(),
            row({ advisoryId: 'CVE-a', aliases: ['GHSA-xq3m-2v4x-88gg'], ranges: [{ introduced: '0', fixed: '7.5.5' }] }),
            row({ advisoryId: 'CVE-b', aliases: ['GHSA-xq3m-2v4x-88gg'], ranges: PROTOBUFJS_TRUE_RANGES })
        ])
        resolveGemnasiumRanges(db)
        expect(rangesFor('GHSA-xq3m-2v4x-88gg')).toEqual(PROTOBUFJS_TRUE_RANGES)
    })
})

describe('resolveGemnasiumRanges — prose tier', function () {
    it('keeps a prose range when no sibling improves on it', function () {
        upsertGemnasiumAdvisories(db, [
            protobufjsStub({ ranges: PROTOBUFJS_TRUE_RANGES, rangeSource: 'prose' })
        ])
        const result = resolveGemnasiumRanges(db)
        expect(result.fromProse).toBe(1)
        expect(result.dropped).toBe(0)
        expect(rangesFor('GHSA-xq3m-2v4x-88gg')).toEqual(PROTOBUFJS_TRUE_RANGES)
    })

    // A row already sourced from a real machine range is final — the pass must not even consider it, or a
    // sibling could quietly overwrite an authoritative range with another advisory's.
    it('never revisits a row that already has a machine-readable range', function () {
        upsertGemnasiumAdvisories(db, [
            row({ advisoryId: 'CVE-2026-41242', ranges: PROTOBUFJS_TRUE_RANGES, rangeSource: 'range' })
        ])
        expect(resolveGemnasiumRanges(db).considered).toBe(0)
    })
})

describe('resolveGemnasiumRanges — OSV tier', function () {
    it('recovers a range from the OSV cache when no sibling exists', function () {
        upsertGemnasiumAdvisories(db, [protobufjsStub()])
        const result = resolveGemnasiumRanges(db, {
            osvRanges: function osvRanges() {
                return PROTOBUFJS_TRUE_RANGES
            }
        })
        expect(result.fromOsv).toBe(1)
        expect(rangesFor('GHSA-xq3m-2v4x-88gg')).toEqual(PROTOBUFJS_TRUE_RANGES)
    })

    it('is queried with the row identity so the lookup can match on id or alias', function () {
        upsertGemnasiumAdvisories(db, [protobufjsStub({ aliases: ['CVE-2026-41242'] })])
        const seen: { ecosystem: string; packageName: string; ids: string[] }[] = []
        resolveGemnasiumRanges(db, {
            osvRanges: function osvRanges(ecosystem, packageName, ids) {
                seen.push({ ecosystem, packageName, ids })
                return null
            }
        })
        expect(seen).toEqual([
            { ecosystem: 'npm', packageName: 'protobufjs', ids: ['GHSA-xq3m-2v4x-88gg', 'CVE-2026-41242'] }
        ])
    })

    // The sibling tier is strictly stronger, so OSV must not be consulted when one was found — that also
    // keeps the pass from opening the OSV cache for records it does not need.
    it('does not consult OSV when a sibling already resolved the row', function () {
        upsertGemnasiumAdvisories(db, [protobufjsStub(), protobufjsSibling()])
        let calls = 0
        resolveGemnasiumRanges(db, {
            osvRanges: function osvRanges() {
                calls += 1
                return PROTOBUFJS_TRUE_RANGES
            }
        })
        expect(calls).toBe(0)
    })

    // OSV is optional. With the source disabled the worker passes no lookup at all, and the record must
    // fall through to being dropped rather than to a guess.
    it('drops the row when OSV is disabled and nothing else resolved it', function () {
        upsertGemnasiumAdvisories(db, [protobufjsStub()])
        const result = resolveGemnasiumRanges(db)
        expect(result.fromOsv).toBe(0)
        expect(result.dropped).toBe(1)
        expect(countGemnasiumAdvisories(db)).toBe(0)
    })

    it('drops the row when OSV knows nothing usable about it', function () {
        upsertGemnasiumAdvisories(db, [protobufjsStub()])
        const result = resolveGemnasiumRanges(db, {
            osvRanges: function osvRanges() {
                return null
            }
        })
        expect(result.dropped).toBe(1)
    })

    it('treats an empty OSV answer as no answer', function () {
        upsertGemnasiumAdvisories(db, [protobufjsStub()])
        const result = resolveGemnasiumRanges(db, {
            osvRanges: function osvRanges() {
                return []
            }
        })
        expect(result.fromOsv).toBe(0)
        expect(result.dropped).toBe(1)
    })
})

describe('resolveGemnasiumRanges — drop tier', function () {
    // Deleting is the point. An advisory whose affected set cannot be established must contribute nothing
    // rather than a fabricated range — the entire failure this pass exists to undo.
    it('deletes a record no tier could resolve', function () {
        upsertGemnasiumAdvisories(db, [protobufjsStub(), row({ advisoryId: 'CVE-2022-25878', ranges: [{ introduced: '0', fixed: '6.11.3' }] })])
        const result = resolveGemnasiumRanges(db)
        expect(result.dropped).toBe(1)
        expect(countGemnasiumAdvisories(db)).toBe(1)
        expect(rangesFor('CVE-2022-25878')).toEqual([{ introduced: '0', fixed: '6.11.3' }])
    })

    it('reports nothing to do on a cache with no unresolved rows', function () {
        upsertGemnasiumAdvisories(db, [row({ ranges: [{ introduced: '0', fixed: '4.17.21' }] })])
        expect(resolveGemnasiumRanges(db)).toEqual({ considered: 0, fromSibling: 0, fromProse: 0, fromOsv: 0, dropped: 0 })
    })

    // Re-running after a sync that changed nothing must be a no-op, not a second round of deletions.
    it('is idempotent across repeated passes', function () {
        upsertGemnasiumAdvisories(db, [protobufjsStub(), protobufjsSibling()])
        resolveGemnasiumRanges(db)
        const second = resolveGemnasiumRanges(db)
        expect(second.considered).toBe(0)
        expect(rangesFor('GHSA-xq3m-2v4x-88gg')).toEqual(PROTOBUFJS_TRUE_RANGES)
    })
})
