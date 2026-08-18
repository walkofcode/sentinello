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
        const canonical = parseAffectedRange(operator + version, [], 'npm')
        // A canonical spelling that parses to nothing would make every comparison below vacuous.
        expect(canonical.ranges.length + canonical.versions.length).toBeGreaterThan(0)
        for (const gap of GAPS) {
            for (const prefix of PREFIXES) {
                const spelling = comparator(operator, gap, prefix, version)
                expect(parseAffectedRange(spelling, [], 'npm'), spelling).toEqual(canonical)
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
        const canonical = parseAffectedRange(low + version + ' ' + high + upper, [], 'npm')
        expect(canonical.ranges).toHaveLength(1)
        for (const lowGap of GAPS) {
            for (const highGap of GAPS) {
                for (const prefix of PREFIXES) {
                    for (const join of INTERSECTIONS) {
                        const spelling =
                            comparator(low, lowGap, prefix, version) + join + comparator(high, highGap, prefix, upper)
                        expect(parseAffectedRange(spelling, [], 'npm'), spelling).toEqual(canonical)
                    }
                }
            }
        }
    })
})

describe('P1 — every spelling of a disjunction parses identically', function () {
    // Two disjuncts, each an intersection, which is the shape of a real multi-branch advisory
    // (npm/electron GMS-2017-249, npm/pg GMS-2017-178).
    const canonical = parseAffectedRange('<1.6.14 || >=1.7.0 <1.7.8', [], 'npm')

    it('parses the canonical two-branch shape', function () {
        expect(canonical.ranges).toHaveLength(2)
        expect(canonical.versions).toEqual([])
    })

    it.each(UNIONS)('joins branches with %j identically', function (union) {
        for (const gap of GAPS) {
            const spelling = '<' + gap + '1.6.14' + union + '>=' + gap + '1.7.0 <' + gap + '1.7.8'
            expect(parseAffectedRange(spelling, [], 'npm'), spelling).toEqual(canonical)
        }
    })
})

describe('P2 — the generated canon means what npm says it means', function () {
    // Probe versions spanning both bounds, including each bound exactly — the boundary is where an
    // inclusivity mistake lives and nowhere else.
    const PROBES = ['0.9.9', '1.0.0', '1.0.1', '1.9.9', '2.0.0', '2.0.1', '3.0.0'] as const

    function ourVerdict(range: string, version: string): boolean {
        const parsed = parseAffectedRange(range, [], 'npm')
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
        expect(parseAffectedRange(notation, [], 'npm')).toEqual(expected)
    })

    // Neither bound given: the notation states no boundary at all, so there is nothing to cache.
    it.each(['(,)', '[,]', '(,]', '[,)'])('yields nothing for %j', function (notation) {
        expect(parseAffectedRange(notation, [], 'npm')).toEqual({ ranges: [], versions: [] })
    })

    // An unterminated interval is not a range we can read, and guessing the missing bracket would pick an
    // inclusivity the record never stated.
    it.each(['[1.0.0,2.0.0', '(1.0.0,2.0.0', '[1.0.0'])('refuses the unterminated %j', function (notation) {
        expect(parseAffectedRange(notation, [], 'npm')).toEqual({ ranges: [], versions: [] })
    })

    // P1 AGAIN, FOR BRACKETS. The comparator forms get a generated spacing sweep at the top of this file
    // and maven notation had none — which is how a single space went unnoticed in the comparator parser for
    // as long as it did. Whitespace can appear around either bound, inside either bracket, or around the
    // comma, so every combination is generated and must parse identically to the tight spelling.
    //
    // Maven notation is NOT canonicalised — `validRange('[1.0.0,2.0.0)')` is null, because node-semver
    // cannot read the notation at all — so unlike the comparator forms nothing upstream normalises these
    // for us. This sweep is the only thing standing between a spaced bracket and the fresh bug again.
    const GAPS = ['', ' ', '  '] as const

    it.each([
        ['[1.0.0,2.0.0]', { introduced: '1.0.0', fixed: null, lastAffected: '2.0.0' }],
        ['[1.0.0,2.0.0)', { introduced: '1.0.0', fixed: '2.0.0', lastAffected: null }],
        ['(1.0.0,2.0.0]', { introduced: '1.0.0', introducedExclusive: true, fixed: null, lastAffected: '2.0.0' }],
        ['(1.0.0,2.0.0)', { introduced: '1.0.0', introducedExclusive: true, fixed: '2.0.0', lastAffected: null }],
        ['(,2.0.0)', { introduced: '0', fixed: '2.0.0', lastAffected: null }],
        ['[1.0.0,)', { introduced: '1.0.0', fixed: null, lastAffected: null }]
    ])('reads %j the same however it is spaced', function (tight, expected) {
        const open = tight.indexOf(tight[0] === '[' || tight[0] === '(' ? tight[0] : '[')
        const comma = tight.indexOf(',')
        const lo = tight.slice(1, comma)
        const hi = tight.slice(comma + 1, tight.length - 1)
        expect(open).toBe(0)
        for (const afterOpen of GAPS) {
            for (const beforeComma of GAPS) {
                for (const afterComma of GAPS) {
                    for (const beforeClose of GAPS) {
                        const spelling =
                            tight[0] + afterOpen + lo + beforeComma + ',' + afterComma + hi + beforeClose + tight[tight.length - 1]
                        expect(parseAffectedRange(spelling, [], 'npm'), spelling).toEqual({
                            ranges: [expected],
                            versions: []
                        })
                    }
                }
            }
        }
    })

    // A single exact version in brackets, spaced every way it can be.
    it('reads a bracketed pin the same however it is spaced', function () {
        for (const afterOpen of GAPS) {
            for (const beforeClose of GAPS) {
                const spelling = '[' + afterOpen + '1.2.3' + beforeClose + ']'
                expect(parseAffectedRange(spelling, [], 'npm'), spelling).toEqual({ ranges: [], versions: ['1.2.3'] })
            }
        }
    })
})

// Every npm range shape that used to be refused because this parser had no rule for it. They are not
// special-cased now either — canonicaliseRange hands each one to node-semver, whose reading is the
// specification, and what comes back is an ordinary bounded interval the parser already understood.
//
// The old behaviour was to drop the record. That was the honest answer while the alternative was pinning
// `^1.0.0` verbatim as an "exact version" no installed version can equal, but it is still a dropped
// advisory: a record gemnasium published and Sentinello silently declined to match. None of these appear
// in gemnasium today — the value is that the NEXT spelling upstream reaches for is read rather than lost.
describe('npm range syntax is understood rather than dropped', function () {
    it.each([
        ['^1.0.0', { introduced: '1.0.0', fixed: '2.0.0', lastAffected: null }],
        ['^0.2.3', { introduced: '0.2.3', fixed: '0.3.0', lastAffected: null }],
        ['~1.0.0', { introduced: '1.0.0', fixed: '1.1.0', lastAffected: null }],
        ['~>1.0.0', { introduced: '1.0.0', fixed: '1.1.0', lastAffected: null }],
        ['1.x', { introduced: '1.0.0', fixed: '2.0.0', lastAffected: null }],
        ['1.2.x', { introduced: '1.2.0', fixed: '1.3.0', lastAffected: null }],
        ['1.0.0 - 2.0.0', { introduced: '1.0.0', fixed: null, lastAffected: '2.0.0' }],
        // The partial-version forms, which npm reads as X-ranges over a whole release line. `<=3.3` means
        // "through the end of 3.3.x" — read literally it stopped at 3.3.0 and missed 3.3.1, which is
        // npm/converse.js CVE-2018-6591.
        ['<=3.3', { introduced: '0', fixed: '3.4.0', lastAffected: null }],
        ['<=1', { introduced: '0', fixed: '2.0.0', lastAffected: null }],
        ['=103', { introduced: '103.0.0', fixed: '104.0.0', lastAffected: null }],
        ['=4.0', { introduced: '4.0.0', fixed: '4.1.0', lastAffected: null }],
        ['>1.2', { introduced: '1.3.0', fixed: null, lastAffected: null }],
        // `<` and `>=` on a partial already agreed with npm before canonicalisation; they must still.
        ['<0.16', { introduced: '0', fixed: '0.16.0', lastAffected: null }],
        ['>=4.0', { introduced: '4.0.0', fixed: null, lastAffected: null }]
    ])('reads %j as npm reads it', function (raw, expected) {
        expect(parseAffectedRange(raw, [], 'npm')).toEqual({ ranges: [expected], versions: [] })
    })

    // A union where one branch is a form the parser could not previously read: both branches survive now.
    it('reads every branch of a mixed-syntax union', function () {
        expect(parseAffectedRange('^1.0.0 || >=2.0.0 <3.0.0', [], 'npm')).toEqual({
            ranges: [
                { introduced: '1.0.0', fixed: '2.0.0', lastAffected: null },
                { introduced: '2.0.0', fixed: '3.0.0', lastAffected: null }
            ],
            versions: []
        })
    })
})

describe('syntax this parser does not implement is refused, never guessed', function () {
    // What must still be refused, and the two reasons.
    //
    // `!=1.0.0` and `latest` are not node-semver at all, so there is no reading to import — the record is
    // dropped rather than guessed at, exactly as before.
    //
    // `*`, `x`, `''` and `||` ARE valid npm, and mean "any version". That reading is right for a dependency
    // spec and wrong for an advisory, where the same strings are indistinguishable from a field nobody
    // filled in — and the two readings differ by the entire package. Reading them as "every version is
    // vulnerable, forever, with no fix" is precisely the finding this whole class of defect produces, so a
    // range that names no version at all is refused. A record that means everything writes `>=0`.
    it.each([
        '!=1.0.0',
        'latest',
        '*',
        'x',
        '',
        '   ',
        '>=1.0.0 <',
        '<',
        '>=',
        '=',
        '||',
        '>= || <'
    ])('refuses %j', function (raw) {
        const parsed = parseAffectedRange(raw, [], 'npm')
        expect(parsed.versions, raw).toEqual([])
        expect(parsed.ranges, raw).toEqual([])
    })

    // A stray separator must not widen the range it trails. `>=1 <2 || ` is `A || (any)` to node-semver,
    // which canonicalises to `*` — so canonicalising the whole string would turn a two-major interval into
    // every version ever published. Each disjunct is canonicalised on its own for exactly this reason.
    it('does not let an empty disjunct swallow its siblings', function () {
        expect(parseAffectedRange('>=1 <2 || ', [], 'npm')).toEqual({
            ranges: [{ introduced: '1.0.0', fixed: '2.0.0', lastAffected: null }],
            versions: []
        })
    })

    // One unreadable token still poisons its own disjunct rather than being skipped — a skip would leave
    // the remaining comparators as an under-constrained range — and the sibling disjunct is unaffected.
    it('drops only the unreadable disjunct of a union', function () {
        expect(parseAffectedRange('!=1.0.0 || >=2.0.0 <3.0.0', [], 'npm')).toEqual({
            ranges: [{ introduced: '2.0.0', fixed: '3.0.0', lastAffected: null }],
            versions: []
        })
    })
})
