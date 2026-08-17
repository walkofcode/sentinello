import { describe, expect, it } from 'vitest'
import { satisfies, validRange } from 'semver'
import { parseAffectedRange } from './normalize'

// EXHAUSTIVE GRAMMAR SWEEP — generated spellings, not remembered ones.
//
// Every range bug this parser has shipped was a spelling nobody thought to write down. `>` read as `>=`
// (npm/rc 1.2.8 reported as critical malware), `<=` read as `<`, a PEP 440 comma making one token of
// `>=5.0,<5.8`, and — the one this file was written for — a SPACE between an operator and its version
// turning npm/fresh's `< 0.5.2` into a pin on 0.5.2, the release that fixed the bug.
//
// Each of those got a hand-written regression test afterwards, and each time the next spelling got through
// anyway. Hand-written cases can only ever cover the inputs their author already imagines, and the defect
// is definitionally an input the author did not imagine. So this file stops choosing inputs. It enumerates
// the CROSS-PRODUCT of the grammar — every operator against every spacing against every prefix against
// every separator — and asserts two properties over the whole space.
//
//   P1, SPELLING INVARIANCE: two spellings of the same range parse to the same thing. This is the property
//   that catches the whole class. It needs no oracle and no expected value, so it cannot be written wrong
//   in the same direction as the parser: `< 0.5.2` and `<0.5.2` MUST agree, and what they agree on is a
//   separate question. Every defect above is a P1 violation.
//
//   P2, SEMANTIC FIDELITY: the canonical spelling means what npm says it means. node-semver is the
//   specification for an npm range — gemnasium's field reference calls `affected_range` "machine-readable
//   syntax used by the package manager" — so this is checked against it rather than against expectations
//   we wrote. range-fidelity.test.ts runs P2 over the real corpus; here it pins the generated canon.
//
// P1 covers spellings node-semver cannot read at all (the PEP 440 comma is not npm syntax), which is why
// the two properties are separate sweeps rather than one.

const OPERATORS = ['<', '<=', '>', '>=', '='] as const
// The gap between an operator and its version. Upstream writes all three.
const GAPS = ['', ' ', '  '] as const
// gemnasium tags some versions with a v, in both cases.
const PREFIXES = ['', 'v', 'V'] as const
// How two comparators of one intersection are joined. Whitespace is npm's; the comma is PEP 440's, which
// gemnasium uses throughout its PyPI records and which reaches this same parser.
const INTERSECTIONS = [' ', '  ', ',', ', ', ' ,', ' , '] as const
// How two disjuncts are joined.
const UNIONS = ['||', ' || ', '|| ', ' ||', '  ||  '] as const

// A spelling npm itself can read, for the P2 sweep. The comma is not npm syntax and `V1.2.3` is not either.
function isNpmSpelling(range: string): boolean {
    return validRange(range) !== null
}

function comparator(operator: string, gap: string, prefix: string, version: string): string {
    return operator + gap + prefix + version
}

describe('P1 — every spelling of one comparator parses identically', function () {
    // The canonical spelling of each operator, against which all 9 variants of it must agree.
    const cases: { operator: string; version: string }[] = []
    for (const operator of OPERATORS) {
        for (const version of ['0.5.2', '1.2.8', '2.0.0-beta0', '10.0.0']) {
            cases.push({ operator, version })
        }
    }

    it.each(cases)('$operator$version — all 9 spellings agree', function ({ operator, version }) {
        const canonical = parseAffectedRange(operator + version, [])
        // A canonical spelling that parses to nothing would make every comparison below vacuous.
        expect(canonical.ranges.length + canonical.versions.length).toBeGreaterThan(0)
        for (const gap of GAPS) {
            for (const prefix of PREFIXES) {
                const spelling = comparator(operator, gap, prefix, version)
                expect(parseAffectedRange(spelling, []), spelling).toEqual(canonical)
            }
        }
    })
})

describe('P1 — every spelling of a two-comparator intersection parses identically', function () {
    const cases: { low: string; high: string; version: string; upper: string }[] = []
    for (const low of ['>', '>=']) {
        for (const high of ['<', '<=']) {
            cases.push({ low, high, version: '1.0.0', upper: '2.0.0' })
        }
    }

    it.each(cases)('$low$version $high$upper — all 648 spellings agree', function ({ low, high, version, upper }) {
        const canonical = parseAffectedRange(low + version + ' ' + high + upper, [])
        expect(canonical.ranges).toHaveLength(1)
        for (const lowGap of GAPS) {
            for (const highGap of GAPS) {
                for (const prefix of PREFIXES) {
                    for (const join of INTERSECTIONS) {
                        const spelling =
                            comparator(low, lowGap, prefix, version) + join + comparator(high, highGap, prefix, upper)
                        expect(parseAffectedRange(spelling, []), spelling).toEqual(canonical)
                    }
                }
            }
        }
    })
})

describe('P1 — every spelling of a disjunction parses identically', function () {
    // Two disjuncts, each an intersection, which is the shape of a real multi-branch advisory
    // (npm/electron GMS-2017-249, npm/pg GMS-2017-178).
    const canonical = parseAffectedRange('<1.6.14 || >=1.7.0 <1.7.8', [])

    it('parses the canonical two-branch shape', function () {
        expect(canonical.ranges).toHaveLength(2)
        expect(canonical.versions).toEqual([])
    })

    it.each(UNIONS)('joins branches with %j identically', function (union) {
        for (const gap of GAPS) {
            const spelling = '<' + gap + '1.6.14' + union + '>=' + gap + '1.7.0 <' + gap + '1.7.8'
            expect(parseAffectedRange(spelling, []), spelling).toEqual(canonical)
        }
    })
})

describe('P2 — the generated canon means what npm says it means', function () {
    // Probe versions spanning both bounds, including each bound exactly — the boundary is where an
    // inclusivity mistake lives and nowhere else.
    const PROBES = ['0.9.9', '1.0.0', '1.0.1', '1.9.9', '2.0.0', '2.0.1', '3.0.0'] as const

    function ourVerdict(range: string, version: string): boolean {
        const parsed = parseAffectedRange(range, [])
        if (parsed.versions.includes(version)) return true
        return parsed.ranges.some(function inAny(r) {
            const aboveLower =
                r.introducedExclusive === true ? compare(version, r.introduced) > 0 : compare(version, r.introduced) >= 0
            if (!aboveLower) return false
            if (r.fixed !== null) return compare(version, r.fixed) < 0
            if (r.lastAffected !== null && r.lastAffected !== undefined) return compare(version, r.lastAffected) <= 0
            return true
        })
    }

    // Deliberately a plain numeric compare rather than the shipped comparator: this sweep is checking the
    // PARSER against npm, and routing through the same comparator the scanner uses would let a bug in
    // either one hide a bug in the other.
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

    const spellings: string[] = []
    for (const low of ['>', '>=']) {
        for (const high of ['<', '<=']) {
            for (const lowGap of GAPS) {
                for (const highGap of GAPS) {
                    const spelling = low + lowGap + '1.0.0 ' + high + highGap + '2.0.0'
                    if (isNpmSpelling(spelling)) spellings.push(spelling)
                }
            }
        }
    }

    it('generated every intersection spelling npm can read', function () {
        expect(spellings).toHaveLength(36)
    })

    it.each(spellings)('%j agrees with npm on every probe', function (spelling) {
        const npmRange = validRange(spelling)
        expect(npmRange).not.toBeNull()
        for (const version of PROBES) {
            // satisfies() via the canonicalised range: the point is what the SPELLING means, and npm
            // canonicalises the spelling away before it evaluates anything.
            expect(ourVerdict(spelling, version), spelling + ' @ ' + version).toBe(
                satisfies(version, spelling, { includePrerelease: true })
            )
        }
    })
})

describe('maven interval notation — the full bracket cross-product', function () {
    // A closed 16-cell grammar: two bracket choices at each end, and each bound present or absent. Small
    // enough to state exhaustively with the meaning of every cell written out, which is what makes this
    // one safe to assert against expected values rather than against an oracle.
    const CASES: { notation: string; expected: ReturnType<typeof parseAffectedRange> }[] = [
        // Both bounds present. The brackets are the entire meaning of the notation.
        { notation: '[1.0.0,2.0.0]', expected: { ranges: [{ introduced: '1.0.0', fixed: null, lastAffected: '2.0.0' }], versions: [] } },
        { notation: '[1.0.0,2.0.0)', expected: { ranges: [{ introduced: '1.0.0', fixed: '2.0.0', lastAffected: null }], versions: [] } },
        { notation: '(1.0.0,2.0.0]', expected: { ranges: [{ introduced: '1.0.0', introducedExclusive: true, fixed: null, lastAffected: '2.0.0' }], versions: [] } },
        { notation: '(1.0.0,2.0.0)', expected: { ranges: [{ introduced: '1.0.0', introducedExclusive: true, fixed: '2.0.0', lastAffected: null }], versions: [] } },
        // No lower bound. There is nothing for an open paren to exclude, so it starts at zero INCLUSIVELY
        // — treating "(,2.0.0)" as exclusive-of-nothing would drop the bottom of the version space.
        { notation: '(,2.0.0)', expected: { ranges: [{ introduced: '0', fixed: '2.0.0', lastAffected: null }], versions: [] } },
        { notation: '(,2.0.0]', expected: { ranges: [{ introduced: '0', fixed: null, lastAffected: '2.0.0' }], versions: [] } },
        { notation: '[,2.0.0)', expected: { ranges: [{ introduced: '0', fixed: '2.0.0', lastAffected: null }], versions: [] } },
        { notation: '[,2.0.0]', expected: { ranges: [{ introduced: '0', fixed: null, lastAffected: '2.0.0' }], versions: [] } },
        // No upper bound: vulnerable from the lower bound onward, with no fix stated.
        { notation: '(1.0.0,)', expected: { ranges: [{ introduced: '1.0.0', introducedExclusive: true, fixed: null, lastAffected: null }], versions: [] } },
        { notation: '[1.0.0,)', expected: { ranges: [{ introduced: '1.0.0', fixed: null, lastAffected: null }], versions: [] } },
        { notation: '(1.0.0,]', expected: { ranges: [{ introduced: '1.0.0', introducedExclusive: true, fixed: null, lastAffected: null }], versions: [] } },
        { notation: '[1.0.0,]', expected: { ranges: [{ introduced: '1.0.0', fixed: null, lastAffected: null }], versions: [] } },
        // A single exact version.
        { notation: '[1.2.3]', expected: { ranges: [], versions: ['1.2.3'] } },
        { notation: '(1.2.3)', expected: { ranges: [], versions: ['1.2.3'] } }
    ]

    it.each(CASES)('reads $notation', function ({ notation, expected }) {
        expect(parseAffectedRange(notation, [])).toEqual(expected)
    })

    // Neither bound given: the notation states no boundary at all, so there is nothing to cache.
    it.each(['(,)', '[,]', '(,]', '[,)'])('yields nothing for %j', function (notation) {
        expect(parseAffectedRange(notation, [])).toEqual({ ranges: [], versions: [] })
    })

    // An unterminated interval is not a range we can read, and guessing the missing bracket would pick an
    // inclusivity the record never stated.
    it.each(['[1.0.0,2.0.0', '(1.0.0,2.0.0', '[1.0.0'])('refuses the unterminated %j', function (notation) {
        expect(parseAffectedRange(notation, [])).toEqual({ ranges: [], versions: [] })
    })
})

describe('syntax this parser does not implement is refused, never guessed', function () {
    // Each of these is a real npm range shape with a meaning we do not model. The failure mode that
    // matters is not refusing them — it is pinning them verbatim as an "exact version", which caches a row
    // that looks like a live advisory and matches nothing for as long as it stays in the cache.
    it.each([
        '^1.0.0',
        '~1.0.0',
        '~>1.0.0',
        '!=1.0.0',
        '1.x',
        '1.2.x',
        '*',
        'x',
        'latest',
        '',
        '   ',
        '1.0.0 - 2.0.0',
        '>=1.0.0 <',
        '<',
        '>=',
        '=',
        '||',
        '>= || <'
    ])('refuses %j', function (raw) {
        const parsed = parseAffectedRange(raw, [])
        expect(parsed.versions, raw).toEqual([])
        expect(parsed.ranges, raw).toEqual([])
    })

    // One unreadable token poisons its whole disjunct rather than being skipped — a skip would leave the
    // remaining comparators as an under-constrained range. The SIBLING disjunct is unaffected, because a
    // union of ranges is exactly that.
    it('drops only the unreadable disjunct of a union', function () {
        expect(parseAffectedRange('^1.0.0 || >=2.0.0 <3.0.0', [])).toEqual({
            ranges: [{ introduced: '2.0.0', fixed: '3.0.0', lastAffected: null }],
            versions: []
        })
    })
})
