import { describe, expect, it } from 'vitest'
import { satisfies, validRange } from 'semver'
import { canMatchSomething, canonicaliseRange, specifierSemantics } from './dialect'
import type { VersionComparator } from './comparator'
import { goComparator } from './comparators/go'
import { pep440Comparator } from './comparators/pep440'
import { rubygemsComparator } from './comparators/rubygems'
import { semverComparator } from './comparators/semver'
import { refusedRange } from './range'

// canonicaliseRange is the single place a range STRING is interpreted, so its two failure directions are
// the ones the whole advisory pipeline inherits: read a range too narrowly and a real vulnerability never
// fires, read it too widely and every version of a package is flagged forever with no fix. The second is
// what an unguarded delegation to node-semver produces, because npm answers "any version" for several
// strings that mean "this field is empty" in an advisory — hence the refusals below.

describe('canonicaliseRange — npm', function () {
    // Whitespace, partial versions, and the caret/tilde/x-range/hyphen forms, all delegated rather than
    // reimplemented. The right-hand side is what `validRange` returns, minus the prerelease marker.
    it.each([
        ['< 0.5.2', '<0.5.2'],
        ['>= 1.7.0 < 1.7.8', '>=1.7.0 <1.7.8'],
        ['<=3.3', '<3.4.0'],
        ['<=1', '<2.0.0'],
        ['=103', '>=103.0.0 <104.0.0'],
        ['=4.0', '>=4.0.0 <4.1.0'],
        ['>1.2', '>=1.3.0'],
        ['^1.0.0', '>=1.0.0 <2.0.0'],
        ['~1.2.0', '>=1.2.0 <1.3.0'],
        ['1.x', '>=1.0.0 <2.0.0'],
        ['1.0.0 - 2.0.0', '>=1.0.0 <=2.0.0'],
        ['v1.2.3', '1.2.3'],
        ['>=0', '>=0']
    ])('canonicalises %j to %j', function (raw, expected) {
        expect(canonicaliseRange(raw, 'npm')).toBe(expected)
    })

    // gemnasium's empty-set sentinel. `<0` canonicalises to `<0.0.0-0`, and stripping the marker is what
    // keeps `isZeroVersion` able to recognise it — without that, the sentinel survives as a live-looking
    // row whose interval matches nothing, which is the failure mode the marker-stripping comment names.
    it.each(['<0', '<0.0.0'])('keeps the %j empty-set sentinel recognisable', function (raw) {
        expect(canonicaliseRange(raw, 'npm')).toBe('<0.0.0')
    })

    // A RANGE THAT NAMES NO VERSION. Every one of these is "any version" to node-semver and "nobody filled
    // this field in" to an advisory. Taking npm's reading turns each into a finding against every release
    // of the package that no upgrade can ever clear.
    it.each(['', '   ', '*', 'x', 'X', '||', 'latest'])('refuses to widen %j into every version', function (raw) {
        expect(canonicaliseRange(raw, 'npm')).toBeNull()
    })

    // Syntax node-semver cannot read either. Numeric source-specific forms are handed back unchanged so
    // the gemnasium parser can apply its Maven/PEP 440 grammar or refuse the token itself.
    it.each(['!=1.0.0', '[1.0.0,2.0.0)', '(,4.1.2)', '>=5.0,<5.8'])('hands %j back untouched', function (raw) {
        expect(canonicaliseRange(raw, 'npm')).toBe(raw)
    })

    // THE CARVE-OUT. npm reads `>0` as `>=1.0.0`, which clears every 0.x release. npm/pandora-doomsday
    // CVE-2017-16127 states `>0` with `affected_versions: "All Versions"` and `solution: "Omit this
    // package."` — a credential stealer, unpublished from the registry. A zero exclusive lower bound is
    // gemnasium's idiom for "everything", and following npm here reports known malware as clean.
    it.each(['>0', '> 0', '>0.0', '>0.0.0'])('leaves the zero lower bound %j alone', function (raw) {
        expect(canonicaliseRange(raw, 'npm')).toBe(raw)
    })

    // The one change it does make is the `v`, which no reader downstream has to know about.
    it('keeps the zero lower bound without its v', function () {
        expect(canonicaliseRange('>v0', 'npm')).toBe('>0')
    })

    // Narrow on purpose: only a bound that is the WHOLE range is exempt. An intersection keeps npm's
    // reading, `>0` and all — `>0 <2.0.0` becomes `>=1.0.0 <2.0.0`, so 0.x falls outside it. That is the
    // right trade: the exemption exists for one record whose range is nothing BUT `>0`, and gemnasium
    // writes no other `>` partial anywhere in the corpus, so widening it further would be guessing at
    // intent on inputs that do not exist.
    it('still applies npm semantics inside an intersection', function () {
        expect(canonicaliseRange('>0 <2.0.0', 'npm')).toBe('>=1.0.0 <2.0.0')
    })

    // `-0` is also a genuine prerelease. Five ranges in the gemnasium corpus pin one, and a blanket strip
    // would collapse each into a duplicate of its release version.
    it('keeps a real -0 prerelease that is not an upper bound', function () {
        expect(canonicaliseRange('=1.0.8-0||=1.0.10', 'npm')).toBe('1.0.8-0||1.0.10')
    })

    it('keeps a real -0 prerelease used as an explicit upper bound', function () {
        expect(canonicaliseRange('<1.2.3-0', 'npm')).toBe('<1.2.3-0')
    })
})

describe('canonicaliseRange — an unknown dialect is left alone', function () {
    it('returns the range untouched', function () {
        for (const raw of ['<=3.3', '=103', '^1.0.0', '>=5.0,<5.8', '< 0.5.2']) {
            expect(canonicaliseRange(raw, 'unknown')).toBe(raw)
        }
    })
})

// The operator dialects. None is node-semver: PEP 440's `==1.0` is an exact pin and its wildcard is
// `==1.0.*`, so npm's X-range reading applied here would invent an interval the record never claimed. Go and
// crates.io advisories use plain comparators, and Gem requirements add `~>`.
describe('canonicaliseRange — operator dialects', function () {
    it('reads a PEP 440 pin as an exact version', function () {
        expect(canonicaliseRange('==1.0', 'PyPI')).toBe('=1.0')
        expect(canonicaliseRange('== 2.0.0rc1', 'PyPI')).toBe('=2.0.0rc1')
        // A pin may carry a local label: it then matches that build strictly.
        expect(canonicaliseRange('==1.0+cpu', 'PyPI')).toBe('=1.0+cpu')
    })

    // `===` is string equality (`===1.0` does not select 1.0.0), which no interval or normalized pin
    // expresses; a local label is not permitted on an ordered comparison or an exclusion.
    it('refuses what a PEP 440 specifier cannot be read as', function () {
        for (const raw of ['===1.0', '=== 1.0', '<=2.2.0+cpu', '>1.0+local', '!=1.0+local', '>=1.0,<2.0+cpu', '~=2.0', '==1.0.*', '!=1.*']) {
            expect(canonicaliseRange(raw, 'PyPI'), raw).toBeNull()
        }
    })

    // Only PyPI's ranges are specifiers whose matching departs from the ordering.
    it('names the specifier semantics of each dialect', function () {
        expect(specifierSemantics('PyPI')).toBe('pep440')
        for (const dialect of ['npm', 'Go', 'crates.io', 'RubyGems', 'Maven']) expect(specifierSemantics(dialect), dialect).toBeUndefined()
    })

    it('turns a PEP 440 comma intersection, spaced or not, into one conjunction', function () {
        expect(canonicaliseRange('>=5.0,<5.8', 'PyPI')).toBe('>=5.0 <5.8')
        expect(canonicaliseRange('>= 5.0 , < 5.8', 'PyPI')).toBe('>=5.0 <5.8')
    })

    // Neither occurs in any corpus; reading them would be a guess, and the refusal ratchet names the
    // record the day one does.
    it('refuses a PEP 440 prefix match and the compatible-release operator', function () {
        expect(canonicaliseRange('==1.2.*', 'PyPI')).toBeNull()
        expect(canonicaliseRange('~=1.4.2', 'PyPI')).toBeNull()
        expect(canonicaliseRange('!=1.2.*', 'PyPI')).toBeNull()
    })

    it('strips the v from a Go version and binds a spaced operator', function () {
        expect(canonicaliseRange('< v0.0.0-20180523222229-09b5706aa936', 'Go')).toBe('<0.0.0-20180523222229-09b5706aa936')
        expect(canonicaliseRange('>=v2.0.0+incompatible <v2.3.0+incompatible', 'Go')).toBe('>=2.0.0+incompatible <2.3.0+incompatible')
    })

    it('reads a bare version as a pin', function () {
        expect(canonicaliseRange('1.2.3', 'crates.io')).toBe('=1.2.3')
    })

    it('refuses an operator its dialect does not define', function () {
        expect(canonicaliseRange('==1.0.0', 'Go')).toBeNull()
        expect(canonicaliseRange('~>1.0', 'crates.io')).toBeNull()
        expect(canonicaliseRange('^1.0', 'PyPI')).toBeNull()
    })

    it.each([
        ['~> 2.2', '>=2.2 <3'],
        ['~> 2.2.0', '>=2.2.0 <2.3'],
        ['~> 1', '>=1 <2'],
        ['~> 2.2.0.pre1', '>=2.2.0.pre1 <2.3'],
        ['~> 4.0, >= 4.0.2', '>=4.0 <5 >=4.0.2']
    ])('expands the Gem pessimistic operator %j to %j', function (raw, expected) {
        expect(canonicaliseRange(raw, 'RubyGems')).toBe(expected)
    })

    it('refuses a pessimistic operator on something Gem would not read as a version', function () {
        expect(canonicaliseRange('~> 1.0-beta', 'RubyGems')).toBeNull()
    })

    // An exclusion is the two intervals either side of it; two exclusions are four conjunctions, two of
    // which the parser drops as empty once it orders the bounds.
    it('splits a conjunction around each exclusion', function () {
        expect(canonicaliseRange('>= 1.0, != 1.5', 'RubyGems')).toBe('>=1.0 <1.5 || >=1.0 >1.5')
        expect(canonicaliseRange('!=1.0,!=2.0', 'PyPI')).toBe('<1.0 <2.0 || <1.0 >2.0 || >1.0 <2.0 || >1.0 >2.0')
    })

    it.each(['PyPI', 'Go', 'crates.io', 'RubyGems'])('refuses a %s range that names no version', function (dialect) {
        for (const raw of ['', '  ', '*', '>=', '< ']) {
            expect(canonicaliseRange(raw, dialect)).toBeNull()
        }
    })
})

// The property that matters for an operator dialect: canonicalising never changes which versions a range
// selects. Checked over a generated cross-product of every operator, spacing and the version shapes each
// dialect exists to express, against a reading of the RAW string that evaluates each operator directly with
// the dialect's comparator — written from the specification, not from canonicaliseRange.
//
// PyPI is not here. Its operators are PEP 440 specifiers, whose meaning is not the comparator's ordering
// (a public specifier ignores the candidate's local label), so an oracle that evaluates them by ordering
// would only restate an assumption. Its oracle is written from the specifier rules themselves and runs
// end to end, through the parser and the matching rule: range-grammar.test.ts in @sentinello/feeds.
describe('canonicaliseRange — operator dialects keep their meaning across the generated grammar', function () {
    type Dialect = { id: string; comparator: VersionComparator; operators: string[]; versions: string[]; probes: string[] }
    // Gem::Version#bump for the versions below, worked out by hand from rubygems' version.rb.
    const GEM_BUMPS: Record<string, string> = { '1': '2', '1.2': '2', '1.2.3': '1.3', '2.0.0.pre1': '2.1', '0.9': '1' }
    const DIALECTS: Dialect[] = [
        {
            id: 'Go',
            comparator: goComparator,
            operators: ['=', '>=', '>', '<=', '<', '!='],
            versions: ['v1.2.3', '1.2.3', 'v0.0.0-20180523222229-09b5706aa936', 'v1.2.4-0.20190101000000-abcdefabcdef', 'v2.1.0+incompatible'],
            probes: ['v0.0.0-20170101000000-aaaaaaaaaaaa', 'v0.0.0-20180523222229-09b5706aa936', 'v0.1.0', 'v1.2.3', 'v1.2.4-0.20190101000000-abcdefabcdef', 'v1.2.4', 'v2.1.0', 'v2.1.0+incompatible', 'v3.0.0']
        },
        {
            id: 'crates.io',
            comparator: semverComparator,
            operators: ['=', '>=', '>', '<=', '<', '!='],
            versions: ['1.2.3', '0.8.5', '1.0.0-alpha.2'],
            probes: ['0.8.4', '0.8.5', '0.9.0', '1.0.0-alpha.1', '1.0.0-alpha.2', '1.0.0', '1.2.3', '1.2.4']
        },
        {
            id: 'RubyGems',
            comparator: rubygemsComparator,
            operators: ['=', '>=', '>', '<=', '<', '!=', '~>'],
            versions: ['1', '1.2', '1.2.3', '2.0.0.pre1', '0.9'],
            probes: ['0.8', '0.9', '0.9.9', '1', '1.0.0', '1.1', '1.2', '1.2.2', '1.2.3', '1.2.9', '1.3', '1.3.a', '2', '2.0.0.pre1', '2.0.0', '2.0.9', '2.1', '3']
        }
    ]

    function holds(operator: string, version: string, probe: string, dialect: Dialect): boolean {
        const c = dialect.comparator
        const v = c.normalize(probe) as string
        const bound = c.normalize(version.replace(/^v/, '')) as string
        if (operator === '=') return c.compare(v, bound) === 0
        if (operator === '!=') return c.compare(v, bound) !== 0
        if (operator === '>=') return c.gte(v, bound)
        if (operator === '>') return c.gt(v, bound)
        if (operator === '<=') return c.lte(v, bound)
        if (operator === '<') return c.lt(v, bound)
        // `~>`: at least the version, below its bump. The bump's own prereleases are below the bump, and
        // canonicaliseRange documents including them, so the reference reads it the same way.
        const bump = c.normalize(GEM_BUMPS[version] as string) as string
        return c.gte(v, bound) && c.lt(v, bump)
    }

    // A canonical disjunction of comparator conjunctions, evaluated token by token.
    function selects(canonical: string, probe: string, dialect: Dialect): boolean {
        return canonical.split('||').some(function conjunction(part) {
            return part.trim().split(/\s+/).every(function token(t) {
                const match = /^(>=|<=|>|<|=)(.+)$/.exec(t) as RegExpExecArray
                return holds(match[1] as string, match[2] as string, probe, dialect)
            })
        })
    }

    for (const dialect of DIALECTS) {
        const cases: Array<{ raw: string; parts: Array<[string, string]> }> = []
        for (const operator of dialect.operators) {
            for (const version of dialect.versions) {
                if (operator === '~>' && GEM_BUMPS[version] === undefined) continue
                for (const gap of ['', ' ']) cases.push({ raw: operator + gap + version, parts: [[operator, version]] })
            }
        }
        // Two-sided intersections, both separators.
        const [low, high] = [dialect.versions[0] as string, dialect.versions[dialect.versions.length - 1] as string]
        for (const separator of [',', ' ', ', ']) {
            cases.push({ raw: '>=' + low + separator + '<' + high, parts: [['>=', low], ['<', high]] })
            cases.push({ raw: '>' + low + separator + '<=' + high + separator + '!=' + high, parts: [['>', low], ['<=', high], ['!=', high]] })
        }

        it.each(cases)(dialect.id + ' %j', function ({ raw, parts }) {
            const canonical = canonicaliseRange(raw, dialect.id)
            expect(canonical, raw).not.toBeNull()
            for (const probe of dialect.probes) {
                const expected = parts.every(function each([operator, version]) { return holds(operator, version, probe, dialect) })
                expect(selects(canonical as string, probe, dialect), raw + ' -> ' + canonical + ' @ ' + probe).toBe(expected)
            }
        })
    }
})

describe('canonicaliseRange — agrees with npm across the generated grammar', function () {
    // The property that matters is not the exact string but that canonicalising never changes which
    // versions a range selects. Checked against node-semver itself over a generated cross-product.
    const RANGES: string[] = []
    for (const operator of ['<', '<=', '>', '>=', '=']) {
        for (const version of ['1.2.3', '1.2', '2', '0.5.2']) {
            for (const gap of ['', ' ']) RANGES.push(operator + gap + version)
        }
    }
    for (const raw of ['^1.0.0', '~1.2.0', '1.x', '1.0.0 - 2.0.0', '>=1.0.0 <2.0.0', '>=1 <2 || >=3 <4']) {
        RANGES.push(raw)
    }

    const PROBES = ['0.0.1', '0.5.1', '0.5.2', '1.0.0', '1.2.0', '1.2.3', '1.2.4', '1.9.9', '2.0.0', '2.5.0', '3.5.0', '9.9.9']

    it.each(RANGES)('%j selects the same versions before and after', function (raw) {
        const canonical = canonicaliseRange(raw, 'npm')
        expect(validRange(raw)).not.toBeNull()
        expect(canonical).not.toBeNull()
        if (canonical === null) throw new Error('valid npm range was refused: ' + raw)
        expect(validRange(canonical)).not.toBeNull()
        for (const version of PROBES) {
            expect(satisfies(version, canonical), raw + ' -> ' + canonical + ' @ ' + version).toBe(
                satisfies(version, raw)
            )
        }
    })
})

describe('canMatchSomething', function () {
    // An unbounded interval matches everything, which is a real statement ("no fix is known") rather than a
    // degenerate one.
    it('keeps an interval with no upper bound', function () {
        expect(canMatchSomething({ introduced: '1.0.0', fixed: null }, semverComparator)).toBe(true)
        expect(canMatchSomething({ introduced: '0', fixed: null, lastAffected: null }, semverComparator)).toBe(true)
    })

    // `fixed` is EXCLUSIVE, so an upper bound equal to the lower one admits nothing.
    it('drops [X, X)', function () {
        expect(canMatchSomething({ introduced: '1.0.0', fixed: '1.0.0' }, semverComparator)).toBe(false)
    })

    // …but an INCLUSIVE upper bound equal to the lower one is "exactly this version", which is a real
    // advisory. This distinction is why inclusivity became load-bearing once `<=` stopped collapsing.
    it('keeps [X, X] and drops (X, X]', function () {
        expect(canMatchSomething({ introduced: '1.0.0', fixed: null, lastAffected: '1.0.0' }, semverComparator)).toBe(true)
        expect(canMatchSomething({ introduced: '1.0.0', introducedExclusive: true, fixed: null, lastAffected: '1.0.0' }, semverComparator)).toBe(false)
    })

    // gemnasium's empty-set sentinel in both spellings.
    it.each([
        ['0', '0'],
        ['0', '0.0.0'],
        ['0.0', '0']
    ])('drops the zero sentinel [%s, %s)', function (introduced, fixed) {
        expect(canMatchSomething({ introduced, fixed }, semverComparator)).toBe(false)
    })

    // Ordered by the ecosystem's comparator, whatever the range's type: an inverted interval is dead in
    // every ecosystem, and only its own comparator can tell.
    it.each([
        ['semver', semverComparator, '2.0.0', '1.0.0'],
        ['PEP 440', pep440Comparator, '2.0', '1.0.post1'],
        ['PEP 440 epochs', pep440Comparator, '1!1.0', '9.0'],
        ['Go', goComparator, 'v1.2.3', 'v1.2.3-0.20190101000000-abcdefabcdef'],
        ['RubyGems', rubygemsComparator, '1.0', '1.0.rc1']
    ] as Array<[string, VersionComparator, string, string]>)('drops an inverted %s interval', function (_label, comparator, introduced, fixed) {
        expect(canMatchSomething({ introduced, fixed }, comparator)).toBe(false)
        expect(canMatchSomething({ introduced: fixed, fixed: introduced }, comparator)).toBe(true)
    })

    // What semver would have got wrong: PEP 440 orders 1.0.post1 ABOVE 1.0, so this interval is live.
    it('keeps a PEP 440 interval semver would mis-order', function () {
        expect(canMatchSomething({ introduced: '1.0', fixed: '1.0.post1' }, pep440Comparator)).toBe(true)
    })

    // The bottom of the version space has nothing below it. A Go advisory for every pseudo-version before a
    // commit is `[0, 0.0.0-<time>-<rev>)`; ordering "0" as the release 0.0.0 would call it inverted.
    it('keeps an interval from the bottom to a pseudo-version', function () {
        expect(canMatchSomething({ introduced: '0', fixed: '0.0.0-20180523222229-09b5706aa936' }, goComparator)).toBe(true)
        expect(canMatchSomething({ introduced: '0', introducedExclusive: true, fixed: '0.0.0-20180523222229-09b5706aa936' }, semverComparator)).toBe(false)
    })

    // A part of a source's range the parser refused is unknown, not empty — whatever text it carries.
    it('keeps a refused part', function () {
        expect(canMatchSomething(refusedRange('~=2.0'), pep440Comparator)).toBe(true)
        expect(canMatchSomething(refusedRange('<0'), semverComparator)).toBe(true)
    })

    it('keeps an interval when either bound is unreadable', function () {
        expect(canMatchSomething({ introduced: '1.0.0', fixed: 'not-a-version' }, semverComparator)).toBe(true)
        expect(canMatchSomething({ introduced: 'not-a-version', fixed: '2.0.0' }, semverComparator)).toBe(true)
        expect(canMatchSomething({ introduced: '1.2', fixed: '1.0.0' }, goComparator)).toBe(true)
    })

    // Two spellings of one version: `1.0` and `1.0.0` are the same point, so the interval between them is
    // empty even though the strings differ.
    it('drops an interval whose bounds differ only in spelling', function () {
        expect(canMatchSomething({ introduced: '1.0', fixed: '1.0.0' }, semverComparator)).toBe(false)
        expect(canMatchSomething({ introduced: '1.0', fixed: '1.0.0', lastAffected: null }, pep440Comparator)).toBe(false)
        expect(canMatchSomething({ introduced: '1.0', fixed: '1.0.0' }, rubygemsComparator)).toBe(false)
    })

    it('keeps an interval whose inclusive bound equals its lower bound by spelling', function () {
        expect(canMatchSomething({ introduced: '1.0', fixed: null, lastAffected: '1.0.0' }, semverComparator)).toBe(true)
        expect(canMatchSomething({ introduced: '1.0', introducedExclusive: true, fixed: null, lastAffected: '1.0.0' }, semverComparator)).toBe(false)
    })

    it('drops an interval whose inclusive upper bound sits below its lower bound', function () {
        expect(canMatchSomething({ introduced: '2.0.0', fixed: null, lastAffected: '1.0.0' }, semverComparator)).toBe(false)
    })
})

describe('canonicaliseRange — separators with nothing between them', function () {
    it('skips an empty token', function () {
        expect(canonicaliseRange(',<1.0,', 'PyPI')).toBe('<1.0')
    })
})
