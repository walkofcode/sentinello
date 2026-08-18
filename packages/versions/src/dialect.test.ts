import { describe, expect, it } from 'vitest'
import { satisfies, validRange } from 'semver'
import { canMatchSomething, canonicaliseRange } from './dialect'

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
    it.each(['>0', '> 0', '>0.0', '>v0', '>0.0.0'])('leaves the zero lower bound %j alone', function (raw) {
        expect(canonicaliseRange(raw, 'npm')).toBe(raw)
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

describe('canonicaliseRange — every other dialect is left alone', function () {
    // PEP 440 spells an exact pin `==1.0` and its wildcard `==1.0.*`, so npm's X-range reading applied here
    // would invent an interval the record never claimed. Go and crates.io share the semver COMPARATOR but
    // are not node-semver range DIALECTS, which is why this is keyed on the ecosystem and not on that.
    it.each(['PyPI', 'Go', 'crates.io', 'unknown'])('leaves a %s range untouched', function (dialect) {
        for (const raw of ['<=3.3', '=103', '^1.0.0', '>=5.0,<5.8', '< 0.5.2']) {
            expect(canonicaliseRange(raw, dialect)).toBe(raw)
        }
    })
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
        expect(canMatchSomething({ introduced: '1.0.0', fixed: null })).toBe(true)
        expect(canMatchSomething({ introduced: '0', fixed: null, lastAffected: null })).toBe(true)
    })

    // `fixed` is EXCLUSIVE, so an upper bound equal to the lower one admits nothing.
    it('drops [X, X)', function () {
        expect(canMatchSomething({ introduced: '1.0.0', fixed: '1.0.0' })).toBe(false)
    })

    // …but an INCLUSIVE upper bound equal to the lower one is "exactly this version", which is a real
    // advisory. This distinction is why inclusivity became load-bearing once `<=` stopped collapsing.
    it('keeps [X, X] and drops (X, X]', function () {
        expect(canMatchSomething({ introduced: '1.0.0', fixed: null, lastAffected: '1.0.0' })).toBe(true)
        expect(canMatchSomething({ introduced: '1.0.0', introducedExclusive: true, fixed: null, lastAffected: '1.0.0' })).toBe(false)
    })

    // gemnasium's empty-set sentinel in both spellings.
    it.each([
        ['0', '0'],
        ['0', '0.0.0'],
        ['0.0', '0']
    ])('drops the zero sentinel [%s, %s)', function (introduced, fixed) {
        expect(canMatchSomething({ introduced, fixed })).toBe(false)
    })

    // ORDERING IS SEMVER-ONLY. compareVersions is semver, and running it over a PEP 440 range would
    // mis-order the spellings PEP 440 exists to express and delete live advisories. An unset or ECOSYSTEM
    // type keeps the range: caching a dead one is a bug, deleting a live one is a worse bug.
    it('drops an inverted SEMVER interval', function () {
        expect(canMatchSomething({ type: 'SEMVER', introduced: '2.0.0', fixed: '1.0.0' })).toBe(false)
        expect(canMatchSomething({ type: 'SEMVER', introduced: '1.0.0', fixed: '2.0.0' })).toBe(true)
    })

    it('keeps an inverted interval whose ordering it cannot judge', function () {
        expect(canMatchSomething({ type: 'ECOSYSTEM', introduced: '2.0.0', fixed: '1.0.0' })).toBe(true)
        expect(canMatchSomething({ introduced: '2.0.0', fixed: '1.0.0' })).toBe(true)
    })

    it('keeps a SEMVER interval when either bound is unreadable', function () {
        expect(canMatchSomething({ type: 'SEMVER', introduced: '1.0.0', fixed: 'not-a-version' })).toBe(true)
        expect(canMatchSomething({ type: 'SEMVER', introduced: 'not-a-version', fixed: '2.0.0' })).toBe(true)
    })

    // Two spellings of one version under semver ordering: `1.0` and `1.0.0` are the same point, so the
    // interval between them is empty even though the strings differ.
    it('drops a SEMVER interval whose bounds differ only in spelling', function () {
        expect(canMatchSomething({ type: 'SEMVER', introduced: '1.0', fixed: '1.0.0' })).toBe(false)
        expect(canMatchSomething({ type: 'SEMVER', introduced: '1.0', fixed: '1.0.0', lastAffected: null })).toBe(false)
    })

    it('keeps a SEMVER interval whose inclusive bound equals its lower bound by spelling', function () {
        expect(canMatchSomething({ type: 'SEMVER', introduced: '1.0', fixed: null, lastAffected: '1.0.0' })).toBe(true)
        expect(canMatchSomething({ type: 'SEMVER', introduced: '1.0', introducedExclusive: true, fixed: null, lastAffected: '1.0.0' })).toBe(false)
    })

    it('drops a SEMVER interval whose inclusive upper bound sits below its lower bound', function () {
        expect(canMatchSomething({ type: 'SEMVER', introduced: '2.0.0', fixed: null, lastAffected: '1.0.0' })).toBe(false)
    })
})
