import { describe, expect, it } from 'vitest'
import { coerce, inc, parse, satisfies } from 'semver'
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

// Real `affected_range` strings from gemnasium-db npm advisories, chosen for bound diversity.
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
    const parsed = parseAffectedRange(affectedRange, [])
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
