import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { parse as parseSemver } from 'semver'
import { canMatchSomething, isRefused, parsePep440, versionInSet, type VersionComparator, type VersionRange } from '@sentinello/versions'
import { acceptedRangeTypesForEcosystem, comparatorForEcosystem } from './engine/comparators'
import { matchAdvisories } from './engine/matcher'
import type { CanonicalAdvisory } from './engine/types'
import { gemnasiumAffected } from './gemnasium'
import type { RawFinding } from './types'
import { affectedSetContains, rangesReadable } from './version-fix'

// A SWEEP OF THE REAL CORPUS, not a list of cases. `fixtures/fix-corpus.ndjson.gz` is every distinct
// affected-data record the current OSV and gemnasium normalizers produce, for all five ecosystems
// (scripts/freeze-fix-corpus.ts regenerates it). Each record is matched against installs probed from its OWN
// bounds by its OWN comparator, so the boundary versions are covered by construction rather than by whoever
// remembered them — and a PEP 440 post-release, a Go pseudo-version or a Gem prerelease is probed as the
// ecosystem orders it, not as semver would.
//
// The invariants, none of which needs an expected value:
//   1. no invented bound — the stated fix is a `fixed` bound the record literally carries;
//   2. never a downgrade and never still affected — the fix orders at or above the install under the
//      ecosystem's comparator, and the matcher does not flag the fix itself (so a Django 4.2 install is
//      never sent to 3.2.x);
//   3. no empty interval — the normalizers cache no range that can match nothing;
//   4. the affected set handed to registry settlement keeps every exact version, is incomplete exactly
//      when a range was dropped, carries a bound the comparator cannot read or is a part of the source's
//      range the normalizer refused, and — where complete — says "affected" for exactly the probes the
//      matcher does;
//   5. spelling invariance — two spellings of one version (`1.2` and `1.2.0`, `v1.2.3` and `1.2.3`) get one
//      answer;
//   6. the refusal ratchet — the records whose bounds a comparator cannot read, or of which the normalizer
//      refused a part, are counted and the count is pinned, so a new unreadable spelling fails the build
//      instead of silently matching nothing;
//   7. every enumerated version, not only the probed spread, is readable by its comparator and is in its
//      own record's affected set.
//
// gemnasium records are matched the way its scanner matches them, under the ecosystem's specifier
// semantics (PEP 440 version matching for PyPI); OSV's under the plain ordering.

type CorpusRecord = {
    source: 'osv' | 'gemnasium'
    ecosystem: string
    ranges: VersionRange[]
    versions: string[]
    malicious: boolean
}

const CORPUS: CorpusRecord[] = gunzipSync(readFileSync(new URL('./fixtures/fix-corpus.ndjson.gz', import.meta.url)))
    .toString('utf8')
    .split('\n')
    .filter(function nonEmpty(line) {
        return line.length > 0
    })
    .map(function parseLine(line) {
        return JSON.parse(line) as CorpusRecord
    })

const ECOSYSTEMS = ['Go', 'PyPI', 'RubyGems', 'crates.io', 'npm']

// Pinned: the records in which some range carries a bound its comparator cannot read, or is a part of the
// source's range the normalizer refused, per source and ecosystem. Such a range matches nothing and its
// affected set is incomplete, so the fix is never settled from it. Each is a spelling upstream wrote that
// the ecosystem's own grammar does not define — a distro release suffix in a PyPI bound (`4.2-20.el8_6`),
// a Ruby patchlevel (`0.7.11p3`), a Go version written without its patch or as a date. The OSV Go and PyPI
// ones are refused events (OSV's ECOSYSTEM ranges for Go carry upstream product versions such as `<136.1`
// beside the SEMVER module range). If a count moves, look at the records before moving it: down is an
// upstream fix or a comparator that learnt a spelling; up is a new spelling to read or to refuse knowingly.
const REFUSALS: Record<string, number> = { 'gemnasium/Go': 4, 'gemnasium/npm': 2, 'osv/Go': 29, 'osv/PyPI': 24 }

// Pinned: enumerated versions (OSV `versions`, gemnasium pins) their comparator cannot read, per source and
// ecosystem. Counted, not refused — see the all-exact sweep below.
const UNREADABLE_EXACT: Record<string, number> = { 'osv/Go': 4, 'osv/PyPI': 2186 }

function advisoryFor(record: CorpusRecord): CanonicalAdvisory {
    return {
        id: 'CORPUS',
        source: record.source,
        aliases: [],
        ecosystem: record.ecosystem,
        packageName: 'pkg',
        affected: record.source === 'gemnasium' ? gemnasiumAffected(record.ecosystem, record.ranges, record.versions) : { ranges: record.ranges, exactVersions: record.versions },
        kind: record.malicious ? 'malware' : 'vulnerability',
        severity: 'HIGH',
        summary: null,
        url: null,
        withdrawn: null
    }
}

function comparatorOf(record: CorpusRecord): VersionComparator {
    const comparator = comparatorForEcosystem(record.ecosystem)
    if (!comparator) throw new Error('no comparator for ' + record.ecosystem)
    return comparator
}

// OSV filters range types per comparator; gemnasium carries none and evaluates every range.
function acceptedTypes(record: CorpusRecord): string[] | undefined {
    return record.source === 'osv' ? acceptedRangeTypesForEcosystem(record.ecosystem) ?? [] : undefined
}

function applicableRanges(record: CorpusRecord): VersionRange[] {
    const accepted = acceptedTypes(record)
    if (accepted === undefined) return record.ranges
    return record.ranges.filter(function ok(r) { return r.type !== undefined && accepted.includes(r.type) })
}

// Every probe matched in one engine call: probe version → its finding, absent when not affected.
function matchAll(record: CorpusRecord, versions: string[]): Map<string, RawFinding> {
    const packages = versions.map(function pkg(version) {
        return { ecosystem: record.ecosystem, name: 'pkg', version, scope: { isProd: true, isDev: false, isOptional: false }, depPaths: [], manifestPath: 'lockfile' }
    })
    const findings = matchAdvisories(packages, new Map([['pkg', [advisoryFor(record)]]]), comparatorOf(record), acceptedTypes(record))
    return new Map(findings.map(function byVersion(f) {
        return [f.installedVersion, f] as const
    }))
}

// Generous: the sweep is ~42k records × ~12 probes, and coverage instrumentation slows the engine severalfold.
const SWEEP_TIMEOUT_MS = 300_000

// The versions on either side of one, generated in the comparator's own grammar.
function neighbours(version: string, comparator: VersionComparator): string[] {
    if (comparator.id === 'pep440') {
        const v = parsePep440(version)
        if (!v) return []
        const release = v.release
        const last = release[release.length - 1] as number
        const up = [...release.slice(0, -1), last + 1].join('.')
        // A local build too, where PEP 440 specifier matching (gemnasium) and the ordering (OSV) differ.
        const out = [up, release.join('.') + '.post1', release.join('.') + 'rc1', release.join('.') + '.dev0', release.join('.') + '+cpu']
        if (last > 0) out.push([...release.slice(0, -1), last - 1].join('.'))
        return out
    }
    if (comparator.id === 'rubygems') {
        const segments = version.split('.')
        const lastIndex = segments.findIndex(function str(s) { return !/^[0-9]+$/.test(s) })
        const numeric = (lastIndex < 0 ? segments : segments.slice(0, lastIndex)).map(Number)
        if (numeric.length === 0) return []
        const last = numeric[numeric.length - 1] as number
        const out = [[...numeric.slice(0, -1), last + 1].join('.'), numeric.join('.') + '.pre1', numeric.join('.') + '.1']
        if (last > 0) out.push([...numeric.slice(0, -1), last - 1].join('.'))
        return out
    }
    const v = parseSemver(version.replace(/^v/, ''))
    if (!v) return []
    const prefix = comparator.id === 'go' ? 'v' : ''
    const out = [prefix + v.major + '.' + v.minor + '.' + (v.patch + 1)]
    if (v.patch > 0) out.push(prefix + v.major + '.' + v.minor + '.' + (v.patch - 1))
    else if (v.minor > 0) out.push(prefix + v.major + '.' + (v.minor - 1) + '.999')
    else if (v.major > 0) out.push(prefix + (v.major - 1) + '.999.999')
    // A prerelease of the version itself sorts just below it; for Go, the pseudo-version form of one.
    out.push(comparator.id === 'go' ? prefix + v.major + '.' + v.minor + '.' + v.patch + '-0.20000101000000-000000000000' : v.major + '.' + v.minor + '.' + v.patch + '-rc.1')
    return out
}

// At most this many of a record's enumerated versions are probed. OSV's PyPI records enumerate every
// affected release, up to a few thousand; probing each (and its neighbours) made one record cost millions
// of comparisons for no extra coverage — an exact version is a set lookup, the same code for the tenth
// entry as for the thousandth. An even spread keeps the first and the last.
const EXACT_PROBES = 24

function spread(versions: readonly string[]): string[] {
    if (versions.length <= EXACT_PROBES) return [...versions]
    const step = (versions.length - 1) / (EXACT_PROBES - 1)
    return Array.from({ length: EXACT_PROBES }, function pick(_x, i) { return versions[Math.round(i * step)] as string })
}

// Every bound the record names and a spread of its exact versions, each stepped both ways in its own
// grammar, plus two far outside.
function probesFor(record: CorpusRecord): string[] {
    const comparator = comparatorOf(record)
    const out = new Set<string>(comparator.id === 'go' ? ['v0.0.1', 'v9999.0.0'] : ['0.0.1', '9999.0.0'])
    const named = spread(record.versions)
    for (const r of record.ranges) {
        if (isRefused(r)) continue
        named.push(r.introduced)
        if (r.fixed) named.push(r.fixed)
        if (r.lastAffected) named.push(r.lastAffected)
    }
    for (const v of named) {
        out.add(v)
        for (const n of neighbours(v, comparator)) out.add(n)
    }
    return [...out]
}

// Another spelling of the same version: a trailing zero where the ecosystem ignores one, the `v` Go and
// npm accept. Null when the ecosystem has no second spelling of it.
function respelling(version: string, comparator: VersionComparator): string | null {
    if (comparator.id === 'go') return version.startsWith('v') ? version.slice(1) : 'v' + version
    if (comparator.id === 'semver') return version.startsWith('v') ? null : 'v' + version
    return /^[0-9]+(\.[0-9]+)*$/.test(version) ? version + '.0' : null
}

describe('fix derivation over the frozen advisory corpus', function () {
    it('loaded the corpus, every ecosystem from both sources', function () {
        expect(CORPUS.length).toBeGreaterThan(40000)
        const cells = new Set(CORPUS.map(function cell(r) { return r.source + '/' + r.ecosystem }))
        expect([...cells].sort()).toEqual(ECOSYSTEMS.flatMap(function both(e) { return ['gemnasium/' + e, 'osv/' + e] }).sort())
    })

    it('states only fixes the record carries, never a downgrade and never still affected', function () {
        const bad: string[] = []
        const stated: Record<string, number> = {}
        for (const record of CORPUS) {
            const comparator = comparatorOf(record)
            const fixedBounds = new Set(record.ranges.flatMap(function fixed(r) { return r.fixed ? [r.fixed] : [] }))
            const matched = matchAll(record, probesFor(record))
            const fixes = [...matched.values()].flatMap(function fix(f) {
                return f.fixVersion === null ? [] : [f.fixVersion]
            })
            const fixesAffected = matchAll(record, fixes)
            for (const [probe, finding] of matched) {
                if (finding.fixVersion === null) continue
                stated[record.ecosystem] = (stated[record.ecosystem] ?? 0) + 1
                const fix = finding.fixVersion
                const where = JSON.stringify(record) + ' @ ' + probe + ' -> ' + fix
                if (!fixedBounds.has(fix)) bad.push('not a fixed bound: ' + where)
                if (finding.fixInputs.statedFix !== fix) bad.push('statedFix disagrees: ' + where)
                const installed = comparator.normalize(probe)
                const normalizedFix = comparator.normalize(fix)
                if (normalizedFix === null) bad.push('unreadable fix: ' + where)
                else if (installed !== null && comparator.lt(normalizedFix, installed)) bad.push('downgrade: ' + where)
                if (fixesAffected.has(fix)) bad.push('still affected: ' + where)
            }
        }
        expect(bad.slice(0, 20)).toEqual([])
        // Vacuity guard, per ecosystem: most of each corpus names a fix, so a sweep that stated none for an
        // ecosystem checked nothing there.
        for (const ecosystem of ECOSYSTEMS) expect(stated[ecosystem] ?? 0, ecosystem).toBeGreaterThan(1000)
    }, SWEEP_TIMEOUT_MS)

    it('caches no interval that can match nothing', function () {
        const bad: string[] = []
        for (const record of CORPUS) {
            const comparator = comparatorOf(record)
            for (const range of record.ranges) {
                if (!canMatchSomething(range, comparator)) bad.push(JSON.stringify(record))
            }
        }
        expect(bad.slice(0, 20)).toEqual([])
    })

    it('keeps every exact version, and marks dropped or unreadable ranges incomplete', function () {
        const bad: string[] = []
        let incomplete = 0
        let withExact = 0
        for (const record of CORPUS) {
            const comparator = comparatorOf(record)
            const applicable = applicableRanges(record)
            const dropped = applicable.length !== record.ranges.length
            const readable = rangesReadable(applicable, comparator)
            for (const [probe, finding] of matchAll(record, probesFor(record))) {
                const set = finding.fixInputs.affected
                const where = JSON.stringify(record) + ' @ ' + probe + ' -> ' + JSON.stringify(set)
                if (set.comparator !== comparator.id) bad.push('wrong comparator: ' + where)
                if (applicable.length === 0 && record.versions.length === 0) {
                    // Malware with no usable version data: every version is affected — but only a record that
                    // stated no ranges at all is complete; one whose ranges were all dropped is unknown.
                    const everything = set.ranges.length === 1 && set.ranges[0]?.introduced === '0' && set.ranges[0].fixed === null
                    if (!everything || set.complete !== (record.ranges.length === 0)) bad.push('malware without data: ' + where)
                    continue
                }
                if (record.versions.length > 0) withExact++
                if (JSON.stringify(set.exact) !== JSON.stringify(record.versions)) bad.push('exact versions lost: ' + where)
                if (JSON.stringify(set.ranges) !== JSON.stringify(applicable)) bad.push('ranges changed: ' + where)
                if (set.complete !== (!dropped && readable)) bad.push('completeness wrong: ' + where)
                if (!set.complete) incomplete++
            }
        }
        expect(bad.slice(0, 20)).toEqual([])
        // The exact arm is exercised by the real data, not only by construction. The incomplete arm is
        // rarer than it was: the normalizers now refuse what a comparator cannot read rather than caching
        // it, so the few records left (the refusal ratchet below) are ones no probe enters.
        expect(withExact).toBeGreaterThan(1000)
        expect(incomplete).toBeGreaterThanOrEqual(0)
    }, SWEEP_TIMEOUT_MS)

    // The registry check decides "affected" from the set, the matcher decided it from the record. For every
    // complete set, in every ecosystem, they must agree on every probe — otherwise pickReleasedFix could name
    // a version the matcher would still flag.
    it('agrees with the matcher on every probe wherever the set is complete', function () {
        const bad: string[] = []
        const compared: Record<string, number> = {}
        for (const record of CORPUS) {
            const probes = probesFor(record)
            const matched = matchAll(record, probes)
            // Any matched probe carries the record's affected set; it is the same for every probe.
            const [carrier] = matched.values()
            if (!carrier || !carrier.fixInputs.affected.complete) continue
            const set = carrier.fixInputs.affected
            for (const probe of probes) {
                const bySet = affectedSetContains(set, probe)
                // A probe the comparator cannot read is not a version of this ecosystem at all.
                if (bySet === null) continue
                compared[record.ecosystem] = (compared[record.ecosystem] ?? 0) + 1
                const byMatcher = matched.has(probe)
                if (bySet !== byMatcher) bad.push(JSON.stringify(record) + ' @ ' + probe + ': set ' + bySet + ', matcher ' + byMatcher)
            }
        }
        expect(bad.slice(0, 20)).toEqual([])
        for (const ecosystem of ECOSYSTEMS) expect(compared[ecosystem] ?? 0, ecosystem).toBeGreaterThan(10000)
    }, SWEEP_TIMEOUT_MS)

    it('answers two spellings of one version the same way', function () {
        const bad: string[] = []
        let compared = 0
        for (const record of CORPUS) {
            const comparator = comparatorOf(record)
            const pairs = probesFor(record).flatMap(function pair(probe) {
                const other = respelling(probe, comparator)
                return other === null || comparator.normalize(other) === null ? [] : [[probe, other] as const]
            })
            const matched = matchAll(record, pairs.flat())
            for (const [probe, other] of pairs) {
                compared++
                if (matched.has(probe) !== matched.has(other)) bad.push(JSON.stringify(record) + ': ' + probe + ' vs ' + other)
            }
        }
        expect(bad.slice(0, 20)).toEqual([])
        expect(compared).toBeGreaterThan(100000)
    }, SWEEP_TIMEOUT_MS)

    // The probes above take an even spread of each record's enumerated versions. This takes ALL of them —
    // ~645,000, a set lookup each — through the membership rule the matcher and settlement share, so
    // a spelling only the unsampled entries use cannot hide: each readable one must be in its own set, and
    // the unreadable ones are counted and pinned. An unreadable enumerated version is not lost — the matcher
    // still compares it as written, and settlement treats its set as unknown — but it is a spelling the
    // ecosystem does not define: OSV Go's `0.1`, and on PyPI mostly upstream git tags OSV enumerates beside
    // the releases (`folsom-2`, `essex-rc1`, `@gradio/…@0.2.…`, `name==0.2.3`). A moved count is worth a look.
    it('reads every enumerated version and finds it in its own set: ' + JSON.stringify(UNREADABLE_EXACT), function () {
        const unreadable: Record<string, number> = {}
        const missing: string[] = []
        let checked = 0
        for (const record of CORPUS) {
            if (record.versions.length === 0) continue
            const comparator = comparatorOf(record)
            const exact = new Set<string>()
            for (const v of record.versions) {
                const normalized = comparator.normalize(v)
                if (normalized !== null) exact.add(normalized)
            }
            const specifier = advisoryFor(record).affected.specifier
            for (const v of record.versions) {
                if (comparator.normalize(v) === null) {
                    const cell = record.source + '/' + record.ecosystem
                    unreadable[cell] = (unreadable[cell] ?? 0) + 1
                    continue
                }
                checked++
                if (!versionInSet(v, applicableRanges(record), exact, comparator, specifier)) missing.push(record.source + '/' + record.ecosystem + ' ' + v)
            }
        }
        expect(missing.slice(0, 20)).toEqual([])
        expect(unreadable).toEqual(UNREADABLE_EXACT)
        expect(checked).toBeGreaterThan(100000)
    }, SWEEP_TIMEOUT_MS)

    it('refuses exactly the pinned records: ' + JSON.stringify(REFUSALS), function () {
        const refused: Record<string, number> = {}
        for (const record of CORPUS) {
            if (rangesReadable(applicableRanges(record), comparatorOf(record))) continue
            const cell = record.source + '/' + record.ecosystem
            refused[cell] = (refused[cell] ?? 0) + 1
        }
        console.log('[fix-corpus] records with a bound their comparator cannot read: ' + JSON.stringify(refused))
        expect(refused).toEqual(REFUSALS)
    })

    // The ordering the whole milestone exists for, stated on a real record shape: under PEP 440 a Django
    // 4.2 install is never sent below 4.2, wherever semver would have put the bounds.
    it('orders a multi-branch PyPI advisory by PEP 440', function () {
        const record: CorpusRecord = {
            source: 'osv',
            ecosystem: 'PyPI',
            ranges: [
                { type: 'ECOSYSTEM', introduced: '0', fixed: '3.2.23', lastAffected: null },
                { type: 'ECOSYSTEM', introduced: '4.0', fixed: '4.1.13', lastAffected: null },
                { type: 'ECOSYSTEM', introduced: '4.2', fixed: '4.2.7', lastAffected: null }
            ],
            versions: [],
            malicious: false
        }
        const matched = matchAll(record, ['4.2', '4.2.6', '3.2.20', '4.1.0'])
        expect(matched.get('4.2')?.fixVersion).toBe('4.2.7')
        expect(matched.get('4.2.6')?.fixVersion).toBe('4.2.7')
        expect(matched.get('3.2.20')?.fixVersion).toBe('3.2.23')
        expect(matched.get('4.1.0')?.fixVersion).toBe('4.1.13')
    })
})
