import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { parse, prerelease, valid } from 'semver'
import type { VersionRange } from '@sentinello/versions'
import { acceptedRangeTypesForEcosystem, comparatorForEcosystem } from './engine/comparators'
import { matchAdvisories } from './engine/matcher'
import type { CanonicalAdvisory } from './engine/types'
import type { RawFinding } from './types'
import { affectedSetContains } from './version-fix'

// A SWEEP OF THE REAL CORPUS, not a list of cases. `fixtures/fix-corpus.ndjson.gz` is every distinct
// affected-data record in the live osv and gemnasium caches (scripts/freeze-fix-corpus.mjs regenerates it),
// all four ecosystems. Each record is matched against installs probed from its OWN bounds, so the boundary
// versions are covered by construction rather than by whoever remembered them.
//
// Three invariants, none of which needs an expected value:
//   1. the stated fix is a `fixed` bound the record literally carries — never derived;
//   2. the affected set handed to registry settlement keeps every exact version, and is marked incomplete
//      whenever a range was dropped or does not render to a range node-semver evaluates;
//   3. where the set is complete, it says "affected" for exactly the versions the matcher does — the
//      registry check reads the set, so any disagreement here is a fix that is still vulnerable.

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

function advisoryFor(record: CorpusRecord): CanonicalAdvisory {
    return {
        id: 'CORPUS',
        source: record.source,
        aliases: [],
        ecosystem: record.ecosystem,
        packageName: 'pkg',
        affected: { ranges: record.ranges, exactVersions: record.versions },
        kind: record.malicious ? 'malware' : 'vulnerability',
        severity: 'HIGH',
        summary: null,
        url: null,
        withdrawn: null
    }
}

// OSV filters range types per comparator; gemnasium carries none and evaluates every range.
function acceptedTypes(record: CorpusRecord): string[] | undefined {
    return record.source === 'osv' ? acceptedRangeTypesForEcosystem(record.ecosystem) ?? [] : undefined
}

// Every probe matched in one engine call: probe version → its finding, absent when not affected.
function matchAll(record: CorpusRecord, versions: string[]): Map<string, RawFinding> {
    const comparator = comparatorForEcosystem(record.ecosystem)
    if (!comparator) throw new Error('no comparator for ' + record.ecosystem)
    const packages = versions.map(function pkg(version) {
        return { ecosystem: record.ecosystem, name: 'pkg', version, scope: { isProd: true, isDev: false, isOptional: false }, depPaths: [] }
    })
    const findings = matchAdvisories(packages, new Map([['pkg', [advisoryFor(record)]]]), comparator, acceptedTypes(record))
    return new Map(findings.map(function byVersion(f) {
        return [f.installedVersion, f] as const
    }))
}

// Generous: the sweep is ~25k records × ~8 probes, and coverage instrumentation slows the engine severalfold.
const SWEEP_TIMEOUT_MS = 120_000

function neighbours(version: string): string[] {
    const v = parse(version)
    if (!v) return []
    const out = [v.major + '.' + v.minor + '.' + (v.patch + 1)]
    if (v.patch > 0) out.push(v.major + '.' + v.minor + '.' + (v.patch - 1))
    else if (v.minor > 0) out.push(v.major + '.' + (v.minor - 1) + '.999')
    else if (v.major > 0) out.push((v.major - 1) + '.999.999')
    return out
}

// Every version the record names, each semver one stepped both ways, plus two far outside.
function probesFor(record: CorpusRecord): string[] {
    const out = new Set<string>(['0.0.1', '9999.0.0'])
    const named = [...record.versions]
    for (const r of record.ranges) {
        named.push(r.introduced)
        if (r.fixed) named.push(r.fixed)
        if (r.lastAffected) named.push(r.lastAffected)
    }
    for (const v of named) {
        out.add(v)
        for (const n of neighbours(v)) out.add(n)
    }
    return [...out]
}

describe('fix derivation over the frozen advisory corpus', function () {
    it('loaded the corpus', function () {
        expect(CORPUS.length).toBeGreaterThan(20000)
        const ecosystems = new Set(CORPUS.map(function eco(r) { return r.ecosystem }))
        expect([...ecosystems].sort()).toEqual(['Go', 'PyPI', 'crates.io', 'npm'])
    })

    it('states only fixes the record carries, never below the install and never still affected', function () {
        const bad: string[] = []
        let stated = 0
        for (const record of CORPUS) {
            const comparator = comparatorForEcosystem(record.ecosystem)!
            const fixedBounds = new Set(record.ranges.flatMap(function fixed(r) {
                const n = r.fixed ? comparator.normalize(r.fixed) : null
                return n === null ? [] : [n]
            }))
            const matched = matchAll(record, probesFor(record))
            const fixes = [...matched.values()].flatMap(function fix(f) {
                return f.fixVersion === null ? [] : [f.fixVersion]
            })
            const fixesAffected = matchAll(record, fixes)
            for (const [probe, finding] of matched) {
                if (finding.fixVersion === null) continue
                stated++
                const fix = finding.fixVersion
                const where = JSON.stringify(record) + ' @ ' + probe + ' -> ' + fix
                if (!fixedBounds.has(fix)) bad.push('not a fixed bound: ' + where)
                if (finding.fixInputs.statedFix !== fix) bad.push('statedFix disagrees: ' + where)
                const installed = comparator.normalize(probe)
                if (installed !== null && comparator.lt(fix, installed)) bad.push('downgrade: ' + where)
                if (fixesAffected.has(fix)) bad.push('still affected: ' + where)
            }
        }
        expect(bad.slice(0, 20)).toEqual([])
        // Vacuity guard: most of the corpus names a fix, so a sweep that stated none checked nothing.
        expect(stated).toBeGreaterThan(10000)
    }, SWEEP_TIMEOUT_MS)

    it('keeps every exact version, and marks dropped or unrenderable ranges incomplete', function () {
        const bad: string[] = []
        let incomplete = 0
        let withExact = 0
        for (const record of CORPUS) {
            const accepted = acceptedTypes(record)
            const applicable = accepted === undefined
                ? record.ranges
                : record.ranges.filter(function ok(r) { return r.type !== undefined && accepted.includes(r.type) })
            const dropped = applicable.length !== record.ranges.length
            for (const [probe, finding] of matchAll(record, probesFor(record))) {
                const set = finding.fixInputs.affected
                const where = JSON.stringify(record) + ' @ ' + probe + ' -> ' + JSON.stringify(set)
                const hasData = applicable.length > 0 || record.versions.length > 0
                if (!hasData) {
                    // Malware with no usable version data: every version is affected — but only a record that
                    // stated no ranges at all is complete; one whose ranges were all dropped is unknown.
                    if (set.ranges !== '*' || set.complete !== (record.ranges.length === 0)) bad.push('malware without data: ' + where)
                    continue
                }
                if (record.versions.length > 0) withExact++
                if (JSON.stringify(set.exact) !== JSON.stringify(record.versions)) bad.push('exact versions lost: ' + where)
                if (dropped && set.complete) bad.push('dropped range but complete: ' + where)
                // The text itself is re-normalized per comparator (issue 009); what it MEANS is checked
                // against the matcher by the differential sweep below.
                if (applicable.length > 0 && set.ranges === null) bad.push('ranges lost: ' + where)
                if (!set.complete) incomplete++
            }
        }
        expect(bad.slice(0, 20)).toEqual([])
        // Both arms are exercised by the real data, not only by construction.
        expect(withExact).toBeGreaterThan(1000)
        expect(incomplete).toBeGreaterThan(0)
    }, SWEEP_TIMEOUT_MS)

    // The registry check decides "affected" from the set, the matcher decided it from the record. For every
    // complete npm set they must agree on every release probe — otherwise pickReleasedFix could name a
    // version the matcher would still flag.
    it('agrees with the matcher on every probe wherever the npm set is complete', function () {
        const bad: string[] = []
        let compared = 0
        for (const record of CORPUS) {
            if (record.ecosystem !== 'npm') continue
            const probes = probesFor(record).filter(function release(v) {
                return valid(v) !== null && prerelease(v) === null
            })
            const matched = matchAll(record, probes)
            // Any matched probe carries the record's affected set; it is the same for every probe.
            const [carrier] = matched.values()
            if (!carrier || !carrier.fixInputs.affected.complete) continue
            const set = carrier.fixInputs.affected
            for (const probe of probes) {
                compared++
                const bySet = affectedSetContains(set, probe)
                const byMatcher = matched.has(probe)
                if (bySet !== byMatcher) bad.push(JSON.stringify(record) + ' @ ' + probe + ': set ' + bySet + ', matcher ' + byMatcher)
            }
        }
        expect(bad.slice(0, 20)).toEqual([])
        expect(compared).toBeGreaterThan(50000)
    }, SWEEP_TIMEOUT_MS)
})
