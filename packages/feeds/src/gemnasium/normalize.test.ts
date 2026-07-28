import { describe, expect, it } from 'vitest'
import { normalizeGemnasiumRecord, parseAffectedRange } from './normalize'

// Two things are being pinned here, and the second one is why this file exists.
//
// normalizeGemnasiumRecord() is the gate: a record that survives it gets cached and matched against
// every resolved package, so the scoping rules (slug prefix, ecosystem, primary id) decide whether an
// advisory is attributed to the right package at all.
//
// parseAffectedRange() is the part that decides whether a *version* is affected. Getting it wrong is
// silent in both directions — too narrow and a real CVE never fires, too wide and every version of a
// package is flagged forever. gemnasium encodes ranges three different ways (comparator, maven-style
// interval, bare pin), so each form gets its own cases, plus the authoritative-fixed override that
// exists specifically to repair `<=X`.

function record(overrides: Record<string, unknown> = {}) {
    return {
        identifier: 'CVE-2024-1',
        identifiers: ['CVE-2024-1', 'GHSA-aaaa-bbbb-cccc'],
        package_slug: 'npm/lodash',
        title: 'Prototype pollution',
        affected_range: '<4.17.21',
        fixed_versions: ['4.17.21'],
        urls: ['https://example.test/advisory/1'],
        ...overrides
    }
}

describe('normalizeGemnasiumRecord — record gating', function () {
    it('rejects anything that is not an object', function () {
        expect(normalizeGemnasiumRecord(null, 'npm', 'npm/')).toEqual([])
        expect(normalizeGemnasiumRecord(undefined, 'npm', 'npm/')).toEqual([])
        expect(normalizeGemnasiumRecord('nope', 'npm', 'npm/')).toEqual([])
        expect(normalizeGemnasiumRecord(42, 'npm', 'npm/')).toEqual([])
    })

    it('rejects a record with no package_slug', function () {
        expect(normalizeGemnasiumRecord(record({ package_slug: undefined }), 'npm', 'npm/')).toEqual([])
        expect(normalizeGemnasiumRecord(record({ package_slug: 123 }), 'npm', 'npm/')).toEqual([])
    })

    // The seed walks every package-type directory in one archive. A pypi/ file reaching the npm rows
    // would attribute a Python advisory to a JavaScript package of the same name — so the prefix check
    // is what keeps the ecosystems apart, exactly as OSV's per-ecosystem filter does.
    it('rejects a slug that does not carry the requested package-type prefix', function () {
        expect(normalizeGemnasiumRecord(record({ package_slug: 'pypi/django' }), 'npm', 'npm/')).toEqual([])
        expect(normalizeGemnasiumRecord(record({ package_slug: 'go/github.com/x/y' }), 'npm', 'npm/')).toEqual([])
    })

    it('rejects a slug that is nothing but the prefix', function () {
        expect(normalizeGemnasiumRecord(record({ package_slug: 'npm/' }), 'npm', 'npm/')).toEqual([])
    })

    // Without an id the row cannot be keyed or deduped, and reconcile could never collapse it against
    // the same advisory reported by npm-audit or OSV.
    it('rejects a record with no usable identifier', function () {
        const rows = normalizeGemnasiumRecord(record({ identifier: undefined, identifiers: [] }), 'npm', 'npm/')
        expect(rows).toEqual([])
    })

    // "No range and no enumerated version" means the record can never match anything, so caching it
    // would only cost space.
    it('rejects a record that yields neither a range nor a version', function () {
        const rows = normalizeGemnasiumRecord(
            record({ affected_range: '', fixed_versions: [] }),
            'npm',
            'npm/'
        )
        expect(rows).toEqual([])
    })

    it('produces exactly one row for a well-formed record', function () {
        const rows = normalizeGemnasiumRecord(record(), 'npm', 'npm/')
        expect(rows).toHaveLength(1)
        expect(rows[0]).toEqual({
            advisoryId: 'CVE-2024-1',
            ecosystem: 'npm',
            packageName: 'lodash',
            aliases: ['GHSA-aaaa-bbbb-cccc'],
            ranges: [{ introduced: '0', fixed: '4.17.21' }],
            versions: [],
            severity: null,
            summary: 'Prototype pollution',
            url: 'https://example.test/advisory/1',
            malicious: false,
            withdrawn: null
        })
    })
})

describe('normalizeGemnasiumRecord — identity', function () {
    it('prefers the explicit identifier and drops it from the aliases', function () {
        const rows = normalizeGemnasiumRecord(
            record({ identifier: 'CVE-2024-1', identifiers: ['GMS-1', 'CVE-2024-1', 'GHSA-x'] }),
            'npm',
            'npm/'
        )
        expect(rows[0]?.advisoryId).toBe('CVE-2024-1')
        expect(rows[0]?.aliases).toEqual(['GMS-1', 'GHSA-x'])
    })

    it('falls back to the first listed identifier when there is no explicit one', function () {
        const rows = normalizeGemnasiumRecord(
            record({ identifier: undefined, identifiers: ['GMS-1', 'GHSA-x'] }),
            'npm',
            'npm/'
        )
        expect(rows[0]?.advisoryId).toBe('GMS-1')
        expect(rows[0]?.aliases).toEqual(['GHSA-x'])
    })

    it('treats an empty-string identifier as absent', function () {
        const rows = normalizeGemnasiumRecord(
            record({ identifier: '', identifiers: ['GMS-1'] }),
            'npm',
            'npm/'
        )
        expect(rows[0]?.advisoryId).toBe('GMS-1')
    })

    it('ignores identifiers that are not an array, and coerces numeric ones', function () {
        expect(
            normalizeGemnasiumRecord(record({ identifiers: 'CVE-2024-1' }), 'npm', 'npm/')[0]?.aliases
        ).toEqual([])
        expect(
            normalizeGemnasiumRecord(
                record({ identifier: 'CVE-2024-1', identifiers: ['CVE-2024-1', 2024] }),
                'npm',
                'npm/'
            )[0]?.aliases
        ).toEqual(['2024'])
    })
})

describe('normalizeGemnasiumRecord — package naming', function () {
    it('keeps a scoped npm name intact', function () {
        const rows = normalizeGemnasiumRecord(record({ package_slug: 'npm/@babel/cli' }), 'npm', 'npm/')
        expect(rows[0]?.packageName).toBe('@babel/cli')
    })

    // PEP 503: the resolver keys PyPI packages on the canonical name, so an advisory that kept
    // "Flask_Login" would sit in the cache and never match the resolved "flask-login".
    it('canonicalises a PyPI name to its PEP 503 form', function () {
        const rows = normalizeGemnasiumRecord(
            record({ package_slug: 'pypi/Flask_Login' }),
            'PyPI',
            'pypi/'
        )
        expect(rows[0]?.packageName).toBe('flask-login')
    })

    it('collapses runs of separators in a PyPI name', function () {
        const rows = normalizeGemnasiumRecord(
            record({ package_slug: 'pypi/zope..interface__x' }),
            'PyPI',
            'pypi/'
        )
        expect(rows[0]?.packageName).toBe('zope-interface-x')
    })

    it('leaves a non-PyPI name unnormalised', function () {
        const rows = normalizeGemnasiumRecord(
            record({ package_slug: 'go/github.com/Sirupsen/logrus' }),
            'Go',
            'go/'
        )
        expect(rows[0]?.packageName).toBe('github.com/Sirupsen/logrus')
    })
})

describe('normalizeGemnasiumRecord — metadata', function () {
    it('derives severity from the CVSS v3 vector', function () {
        const rows = normalizeGemnasiumRecord(
            record({ cvss_v3: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }),
            'npm',
            'npm/'
        )
        expect(rows[0]?.severity).toBe('critical')
    })

    it('leaves severity null when no vector is present', function () {
        expect(normalizeGemnasiumRecord(record(), 'npm', 'npm/')[0]?.severity).toBeNull()
    })

    it('nulls an absent or empty title and url rather than emitting empty strings', function () {
        const rows = normalizeGemnasiumRecord(
            record({ title: '', urls: [] }),
            'npm',
            'npm/'
        )
        expect(rows[0]?.summary).toBeNull()
        expect(rows[0]?.url).toBeNull()
    })

    it('takes the first url when several are listed', function () {
        const rows = normalizeGemnasiumRecord(
            record({ urls: ['https://a.test/1', 'https://b.test/2'] }),
            'npm',
            'npm/'
        )
        expect(rows[0]?.url).toBe('https://a.test/1')
    })
})

describe('parseAffectedRange — no machine-readable range', function () {
    // gemnasium files sometimes carry only fixed_versions. "Everything before the fix" is the
    // conservative reading, and it is the only one that can match anything at all.
    it('assumes everything before the fix is affected', function () {
        expect(parseAffectedRange('', ['4.17.21'])).toEqual({
            ranges: [{ introduced: '0', fixed: '4.17.21' }],
            versions: []
        })
    })

    it('yields nothing when there is no range and no fix', function () {
        expect(parseAffectedRange('', [])).toEqual({ ranges: [], versions: [] })
        expect(parseAffectedRange('   ', [])).toEqual({ ranges: [], versions: [] })
    })
})

describe('parseAffectedRange — comparator form', function () {
    it('reads an upper bound alone as [0, fixed)', function () {
        expect(parseAffectedRange('<4.17.12', [])).toEqual({
            ranges: [{ introduced: '0', fixed: '4.17.12' }],
            versions: []
        })
    })

    it('reads a bounded range', function () {
        expect(parseAffectedRange('>=4.0.0 <4.0.1', [])).toEqual({
            ranges: [{ introduced: '4.0.0', fixed: '4.0.1' }],
            versions: []
        })
    })

    it('leaves fixed null for an open-ended lower bound', function () {
        expect(parseAffectedRange('>=2.0.0', [])).toEqual({
            ranges: [{ introduced: '2.0.0', fixed: null }],
            versions: []
        })
    })

    // ">" is deliberately read as an inclusive lower bound: at worst it flags the boundary version
    // itself, which is the safe direction to be wrong in.
    it('treats an exclusive lower bound as inclusive', function () {
        expect(parseAffectedRange('>1.0.0 <2.0.0', [])).toEqual({
            ranges: [{ introduced: '1.0.0', fixed: '2.0.0' }],
            versions: []
        })
    })

    it('splits a disjunction into separate ranges', function () {
        expect(parseAffectedRange('>=1 <2 || >=3 <4', [])).toEqual({
            ranges: [
                { introduced: '1', fixed: '2' },
                { introduced: '3', fixed: '4' }
            ],
            versions: []
        })
    })

    it('strips a leading v from either bound', function () {
        expect(parseAffectedRange('>=v1.0.0 <V2.0.0', [])).toEqual({
            ranges: [{ introduced: '1.0.0', fixed: '2.0.0' }],
            versions: []
        })
    })

    it('reads an explicit pin as an enumerated version, not a range', function () {
        expect(parseAffectedRange('=1.2.3', [])).toEqual({ ranges: [], versions: ['1.2.3'] })
    })

    it('reads a bare version as a pin', function () {
        expect(parseAffectedRange('1.2.3', [])).toEqual({ ranges: [], versions: ['1.2.3'] })
    })

    it('tolerates irregular whitespace between tokens', function () {
        expect(parseAffectedRange('  >=1.0.0    <2.0.0  ', [])).toEqual({
            ranges: [{ introduced: '1.0.0', fixed: '2.0.0' }],
            versions: []
        })
    })
})

describe('parseAffectedRange — maven-style interval notation', function () {
    it('reads an open lower bound', function () {
        expect(parseAffectedRange('(,4.1.2)', [])).toEqual({
            ranges: [{ introduced: '0', fixed: '4.1.2' }],
            versions: []
        })
    })

    it('reads a fully bounded interval', function () {
        expect(parseAffectedRange('[1.0.0,2.0.0)', [])).toEqual({
            ranges: [{ introduced: '1.0.0', fixed: '2.0.0' }],
            versions: []
        })
    })

    it('reads an open upper bound as unfixed', function () {
        expect(parseAffectedRange('[1.0.0,)', [])).toEqual({
            ranges: [{ introduced: '1.0.0', fixed: null }],
            versions: []
        })
    })

    it('reads a comma-less interval as an exact version', function () {
        expect(parseAffectedRange('[1.2.3]', [])).toEqual({ ranges: [], versions: ['1.2.3'] })
    })

    it('accepts a closing square bracket as well as a paren', function () {
        expect(parseAffectedRange('[1.0.0,2.0.0]', [])).toEqual({
            ranges: [{ introduced: '1.0.0', fixed: '2.0.0' }],
            versions: []
        })
    })

    // An unterminated interval is unparseable rather than unbounded. Dropping it loses one advisory;
    // guessing at it could flag every version of the package.
    it('drops an unterminated interval instead of guessing', function () {
        expect(parseAffectedRange('(1.0.0', [])).toEqual({ ranges: [], versions: [] })
        expect(parseAffectedRange('[1.0.0', [])).toEqual({ ranges: [], versions: [] })
    })

    it('drops an empty interval', function () {
        expect(parseAffectedRange('[]', [])).toEqual({ ranges: [], versions: [] })
    })
})

describe('parseAffectedRange — authoritative fixed_versions override', function () {
    // This is the whole reason the override exists. "<=2.0.0" means 2.0.0 IS affected, but a half-open
    // [introduced, fixed) interval cannot say that without naming 2.0.0's successor — which the
    // comparator string does not know and fixed_versions does.
    it('repairs <=X using the real fix version', function () {
        expect(parseAffectedRange('<=2.0.0', ['2.0.1'])).toEqual({
            ranges: [{ introduced: '0', fixed: '2.0.1' }],
            versions: []
        })
    })

    // Without the override, <=X under-includes X itself. That is documented and deliberate: it misses
    // exactly one version, where a null upper bound would flag every future version forever.
    it('falls back to the bound itself when no fix is known', function () {
        expect(parseAffectedRange('<=2.0.0', [])).toEqual({
            ranges: [{ introduced: '0', fixed: '2.0.0' }],
            versions: []
        })
    })

    it('overrides a parsed upper bound that disagrees with the recorded fix', function () {
        expect(parseAffectedRange('<4.17.12', ['4.17.21'])).toEqual({
            ranges: [{ introduced: '0', fixed: '4.17.21' }],
            versions: []
        })
    })

    it('preserves the lower bound while overriding the upper', function () {
        expect(parseAffectedRange('>=4.0.0 <4.0.1', ['4.0.9'])).toEqual({
            ranges: [{ introduced: '4.0.0', fixed: '4.0.9' }],
            versions: []
        })
    })

    // With several disjoint ranges there is no way to know which one the single fixed version closes,
    // so applying it to the first would be a guess.
    it('does not override when the range is disjoint', function () {
        expect(parseAffectedRange('>=1 <2 || >=3 <4', ['4.0.1'])).toEqual({
            ranges: [
                { introduced: '1', fixed: '2' },
                { introduced: '3', fixed: '4' }
            ],
            versions: []
        })
    })

    it('does not override when enumerated versions are also present', function () {
        expect(parseAffectedRange('<2.0.0 || 3.0.0', ['9.9.9'])).toEqual({
            ranges: [{ introduced: '0', fixed: '2.0.0' }],
            versions: ['3.0.0']
        })
    })

    it('does not override an exact pin', function () {
        expect(parseAffectedRange('[1.2.3]', ['2.0.0'])).toEqual({ ranges: [], versions: ['1.2.3'] })
    })
})
