import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { coerce, inc, parse, satisfies, validRange } from 'semver'
import { semverComparator, versionInRange } from '@sentinello/versions'
import { normalizeGemnasiumRecord, parseAffectedRange } from './normalize'

// A DIFFERENTIAL test, not an example-based one.
//
// Every other test in this directory asserts what the parser returns, which means it was written by
// reading the parser — and a test written from the implementation agrees with the implementation by
// construction. That is exactly how `>` came to be read as `>=` with a green suite and a passing test
// literally named "treats an exclusive lower bound as inclusive": the assertion recorded the behaviour
// instead of checking it, and the comment justifying it was wrong about its own blast radius.
//
// So this file checks against an ORACLE rather than against expectations we wrote. gemnasium's own field
// reference calls `affected_range` "the range of affected versions, machine-readable syntax used by the
// package manager" — for npm the package manager is npm, and its range syntax is node-semver. node-semver
// is therefore not a second opinion; it is the specification. Anywhere we disagree with it on an npm
// range, we are wrong.
//
// Probe versions are derived from each advisory's OWN bounds, so the boundary cases are covered by
// construction rather than by whoever remembered to write them down — and boundaries are precisely where
// `>` differs from `>=` and `<` from `<=`.

// A hand-picked list, kept for the regressions each entry records — the annotations are the value here,
// not the coverage. Four of these are verbatim gemnasium-db strings and the rest were composed for bound
// diversity, which is worth stating plainly: a curated list is written from what its author already
// understands, and that is exactly the limit the corpus sweep at the bottom of this file exists to escape.
const NPM_RANGES = [
    // npm/rc GMS-2021-3, the 2021 hijack. The bug this whole file exists for: 1.2.8 is the CLEAN release
    // and the advisory excludes it, but a `>`-read-as-`>=` reported it as critical malware.
    '>1.2.8',
    // npm/sauce-connect-launcher GMS-2014-4 — an inclusive upper bound, where `<=` read as `<` drops 0.3.3.
    '<=0.3.3',
    '<4.17.21',
    '>=4.0.0 <4.0.1',
    '>=7.5.0 <7.6.5',
    '>=1 <2 || >=3 <4',
    '>=3.0.0 <3.0.6||<2.6.3',
    '>=1.0.0 <=1.9.9',
    '>2.0.0 <3.0.0',
    '>=0.0.1'
] as const

// One version below the given one, so a lower bound is probed from underneath as well as on it.
function justBelow(version: string): string | null {
    const v = parse(version)
    if (!v) return null
    if (v.patch > 0) return v.major + '.' + v.minor + '.' + (v.patch - 1)
    if (v.minor > 0) return v.major + '.' + (v.minor - 1) + '.999'
    if (v.major > 0) return (v.major - 1) + '.999.999'
    return null
}

// Every version named in the range, each bound stepped one in both directions, plus two versions far
// outside it. Prereleases are deliberately excluded: node-semver applies special prerelease-visibility
// rules to ranges that our ordering comparison does not model, and that difference is a separate question
// from bound inclusivity.
function probesFor(affectedRange: string): string[] {
    const out = new Set<string>(['0.0.1', '9999.0.0'])
    for (const token of affectedRange.match(/[0-9]+(?:\.[0-9]+)*/g) ?? []) {
        const base = coerce(token)
        if (!base) continue
        out.add(base.version)
        for (const release of ['patch', 'minor', 'major'] as const) {
            out.add(inc(base.version, release) ?? base.version)
        }
        const below = justBelow(base.version)
        if (below) out.add(below)
    }
    return Array.from(out)
}

// What Sentinello concludes for one installed version, using the real parser and the real bound evaluator
// — not a reimplementation of either. `fixedVersions` is empty on purpose: the authoritative-fix override
// deliberately departs from `affected_range`, so including it would test a different question.
function sentinelloSaysAffected(affectedRange: string, version: string): boolean {
    const parsed = parseAffectedRange(affectedRange, [], 'npm')
    const normalized = semverComparator.normalize(version)
    for (const pinned of parsed.versions) {
        if (semverComparator.normalize(pinned) === normalized) return true
    }
    return parsed.ranges.some(function inAny(range) {
        return versionInRange(version, range, semverComparator)
    })
}

describe('gemnasium npm ranges agree with node-semver', function () {
    it.each(NPM_RANGES)('%s', function (affectedRange) {
        const probes = probesFor(affectedRange)
        // A range that produced no probes would pass vacuously, which is the failure mode this guards.
        expect(probes.length).toBeGreaterThan(3)
        for (const version of probes) {
            expect(
                sentinelloSaysAffected(affectedRange, version),
                affectedRange + ' @ ' + version
            ).toBe(satisfies(version, affectedRange, { includePrerelease: true }))
        }
    })
})

// The record that started it. Verbatim from gemnasium-db npm/rc/GMS-2021-3.yml — including the
// `description` naming the wrong package, which is upstream's copy-paste from the coa advisory and is
// reproduced here rather than tidied, because a fixture that has been cleaned up is not the record.
const RC_GMS_2021_3 = {
    identifier: 'GMS-2021-3',
    identifiers: ['GMS-2021-3'],
    package_slug: 'npm/rc',
    title: 'Embedded Malicious Code',
    description: 'This version of coa can be used to steal credentials.',
    date: '2021-11-04',
    pubdate: '2021-11-04',
    affected_range: '>1.2.8',
    fixed_versions: [],
    affected_versions: 'All versions after 1.2.8',
    not_impacted: 'All versions up to 1.2.8',
    solution: 'Downgrade to version 1.2.8',
    urls: ['https://www.rapid7.com/blog/post/2021/11/05/new-npm-library-hijacks-coa-and-rc/'],
    cvss_v3: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H',
    uuid: '075e9726-0846-478d-bf80-057218fbc323',
    cwe_ids: ['CWE-1035', 'CWE-506', 'CWE-937']
}

describe('npm/rc GMS-2021-3 — the hijack advisory end to end', function () {
    const rows = normalizeGemnasiumRecord(RC_GMS_2021_3, 'npm', 'npm/')
    const range = rows[0]?.ranges[0]

    it('keeps the advisory, with an exclusive lower bound', function () {
        expect(rows).toHaveLength(1)
        expect(range).toEqual({ introduced: '1.2.8', introducedExclusive: true, fixed: null, lastAffected: null })
    })

    // THE regression. 1.2.8 is the last legitimate release of rc — npm unpublished the hijacked 1.2.9,
    // 1.3.9 and 2.3.9 within hours, so 1.2.8 is still `latest` and is what the advisory's own `solution`
    // field tells you to be on. Reporting it as affected is not a conservative over-flag: it is a critical,
    // permanently unfixable finding against the one version that is safe.
    it('does NOT report the clean 1.2.8 as affected', function () {
        expect(range).toBeDefined()
        if (!range) return
        expect(versionInRange('1.2.8', range, semverComparator)).toBe(false)
    })

    it('still reports the versions that were actually hijacked', function () {
        expect(range).toBeDefined()
        if (!range) return
        for (const hijacked of ['1.2.9', '1.3.9', '2.3.9']) {
            expect(versionInRange(hijacked, range, semverComparator)).toBe(true)
        }
    })
})

// THE CORPUS SWEEP — the oracle above, pointed at every range gemnasium actually states instead of at the
// ten someone remembered.
//
// The differential test at the top of this file was already correct, already used node-semver as the
// specification, and still missed npm/fresh GMS-2017-232 for as long as the record has existed. It missed
// it because an oracle only ever answers about the inputs you hand it, and every input above was typed by
// someone who writes `<0.5.2` without a space. gemnasium writes `< 0.5.2` in 19 of its records, the parser
// read the pair as two comparators, and the version token — bare, now that its operator had become a token
// of its own — was cached as an exact pin ON THE VERSION THAT FIXED THE BUG. No curated list catches that,
// because the whole defect is a spelling nobody thought to curate.
//
// So the input list stops being curated. `ranges.fixture.json` holds every distinct `affected_range`
// gemnasium-db states — 12,472 of them across all four ecosystems, frozen at the sha it records. Its npm
// half, 4,696 ranges, feeds this sweep; all four feed the readability assertion at the bottom of the file.
// Run against the parser as it stood before this file's fix, 28 of those npm ranges disagreed with npm
// across 87 probes; the 19 spaced ones were all in that set. Anything upstream invents from here on that
// we read differently from npm fails the build on the sync that first imports it, rather than after a
// user reports it.
//
// Frozen rather than fetched because tests are hermetic — no network — and because a moving corpus turns a
// failure into "did upstream change or did we break it?". Regenerate by re-running the extraction over a
// fresh archive and committing the new sha in the same change as whatever made it necessary.
//
// npm only. node-semver is the specification for npm ranges and nothing else, and gemnasium's PyPI records
// are PEP 440, which would need its own oracle to sweep the same way. That is worth doing and is not done
// here.
type RangeCorpus = { sha: string; counts: Record<string, number>; ranges: Record<string, string[]> }

const FIXTURE = JSON.parse(
    readFileSync(new URL('./ranges.fixture.json', import.meta.url), 'utf8')
) as RangeCorpus

const CORPUS = { ranges: FIXTURE.ranges.npm ?? [], count: FIXTURE.counts.npm ?? 0 }

// The one range we knowingly read differently from npm — and it is a DECISION, not a gap.
//
// This list used to hold nine, all of them the partial-version class: `<=3.3` means "through the end of
// 3.3.x" to npm while a literal reading stops at 3.3.0, `=103` means the whole 103 line rather than a
// single point. Eight are gone because the parser no longer interprets npm syntax itself — canonicaliseRange
// hands each disjunct to node-semver first, so the parser only ever sees a canonical interval.
//
// `>0` stays, deliberately. npm reads it as `>=1.0.0`, which would clear every 0.x release, and the record
// it belongs to is npm/pandora-doomsday CVE-2017-16127: `affected_versions: "All Versions"`,
// `solution: "Omit this package."`, a package published to steal credentials and since unpublished. A zero
// exclusive lower bound is gemnasium's idiom for "everything", and following npm here would mean reporting
// 0.x of known malware as clean. Over-reporting an unpublished malicious package is the cheap direction to
// be wrong in.
//
// Still an inventory rather than a mute: the test below asserts this entry STILL diverges, so if the
// carve-out in canonicaliseRange is ever removed this fails rather than passing quietly.
const KNOWN_DIVERGENCES: Record<string, string> = {
    '>0': 'deliberate: a zero exclusive lower bound keeps meaning every version — npm/pandora-doomsday'
}

describe('every npm range gemnasium states agrees with node-semver', function () {
    // node-semver can only arbitrate the ranges it can itself read; the three it rejects are upstream
    // syntax errors, and what the parser makes of those is a question this oracle cannot answer.
    const readable = CORPUS.ranges.filter(function byNpm(range) {
        return validRange(range) !== null
    })

    const diverging = new Map<string, string>()
    for (const range of readable) {
        for (const version of probesFor(range)) {
            if (sentinelloSaysAffected(range, version) === satisfies(version, range, { includePrerelease: true })) continue
            if (!diverging.has(range)) diverging.set(range, version)
        }
    }

    it('sweeps the whole frozen corpus', function () {
        expect(CORPUS.ranges).toHaveLength(CORPUS.count)
        // A corpus that stopped loading, or an oracle that started rejecting everything, would make every
        // assertion below pass while checking nothing.
        expect(readable.length).toBeGreaterThan(4000)
    })

    it('agrees with npm on every range not inventoried above', function () {
        const unexpected = Array.from(diverging.entries())
            .filter(function notInventoried(entry) {
                return KNOWN_DIVERGENCES[entry[0]] === undefined
            })
            .map(function describe(entry) {
                return entry[0] + ' @ ' + entry[1]
            })
        expect(unexpected).toEqual([])
    })

    // The ratchet. Without this the inventory above would be a skip list that silently outlives its
    // reason, which is how a suite ends up green about behaviour nobody has checked in two years.
    it('still diverges on exactly the inventoried ranges, and no others', function () {
        const stale = Object.keys(KNOWN_DIVERGENCES).filter(function fixed(range) {
            return !diverging.has(range)
        })
        expect(stale).toEqual([])
    })
})

// NOTHING GEMNASIUM PUBLISHES MAY BE SILENTLY DROPPED.
//
// This is the assertion the rest of the file was missing, and it is the one that matters most, because
// refusing a range is not a neutral outcome. `parseAffectedRange` returning nothing makes
// normalizeGemnasiumRecord return no row at all: the advisory is never cached, never matched, and never
// reported. There is no error, no warning and no count — a real vulnerability simply stops existing as far
// as Sentinello is concerned. Every other failure in this codebase at least produces a wrong answer; this
// one produces silence, which is strictly harder to notice.
//
// The parser refuses syntax it cannot read on purpose, and that is right — guessing at a range is how
// `^1.0.0` once got cached as a pin on the literal string "^1.0.0". But "we refuse what we cannot read"
// is only safe while the set of things we cannot read is EMPTY. Today it is: across all 26,547 records
// with a machine-readable range, in all four ecosystems, the number refused is zero. The only records that
// yield nothing are the 1,121 carrying gemnasium's `<0` sentinel, which is upstream stating that the
// record has no machine-readable range at all — their omission is intentional and theirs, not ours.
//
// So the number is pinned at zero. The moment upstream writes a shape this parser cannot read, this test
// fails and names it, and someone goes and implements it — instead of the advisory quietly vanishing and
// the suite staying green. That is the whole point: it converts the one failure mode that produces silence
// into the one that produces a red build.
//
// All four ecosystems, not just npm. The npm path is canonicalised through node-semver upstream of the
// parser and the other three are not, so PyPI, Go and crates.io depend on the hand-written parser alone —
// they are the ones most likely to meet a shape nobody has taught it.
const ECOSYSTEM_SENTINEL = /^<\s*v?0(\.0){0,2}$/

describe('every range gemnasium publishes can be read', function () {
    it.each(['npm', 'PyPI', 'Go', 'crates.io'])('refuses nothing in the %s corpus', function (ecosystem) {
        const ranges = FIXTURE.ranges[ecosystem] ?? []
        // A corpus that failed to load would make the assertion below pass while checking nothing.
        expect(ranges.length).toBeGreaterThan(900)

        const refused: string[] = []
        for (const range of ranges) {
            const parsed = parseAffectedRange(range, [], ecosystem)
            if (parsed.ranges.length > 0 || parsed.versions.length > 0) continue
            // gemnasium's deliberate "no machine-readable range" sentinel, in both its spellings.
            if (ECOSYSTEM_SENTINEL.test(range)) continue
            refused.push(range)
        }
        expect(refused).toEqual([])
    })
})
