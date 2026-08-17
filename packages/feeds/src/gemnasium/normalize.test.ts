import { describe, expect, it } from 'vitest'
import { normalizeGemnasiumRecord, parseAffectedRange } from './normalize'

// Three things are being pinned here, and the third one is why this file exists.
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
//
// And then there is `affected_range: "<0"` — gemnasium's sentinel for "this record has NO machine-readable
// range", which is the empty set by construction. It appears on 698 of 10,777 npm advisories. The parser
// used to read it correctly and then OVERWRITE it with [0, fixed_versions[0]), turning "affects nothing"
// into "affects everything below an arbitrary branch fix". Every fixture below tagged REGRESSION is a real
// upstream record that the old code turned into a false critical, kept verbatim so the shape cannot drift.

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

    // A record that states no affected set can never match anything, so caching it could only ever cost
    // space — or, as it once did, invite something downstream to invent a range for it.
    it('rejects a record that yields neither a range nor a version', function () {
        expect(normalizeGemnasiumRecord(record({ affected_range: '', fixed_versions: [] }), 'npm', 'npm/')).toEqual([])
    })

    it('produces exactly one row for a well-formed record', function () {
        const rows = normalizeGemnasiumRecord(record(), 'npm', 'npm/')
        expect(rows).toHaveLength(1)
        expect(rows[0]).toEqual({
            advisoryId: 'CVE-2024-1',
            ecosystem: 'npm',
            packageName: 'lodash',
            aliases: ['GHSA-aaaa-bbbb-cccc'],
            ranges: [{ introduced: '0', fixed: '4.17.21', lastAffected: null }],
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

    // gemnasium ships some advisories with only a v2 vector, so the v3-then-v2 preference has to
    // reach the v2 arm when v3 is absent rather than giving up at the first null.
    it('derives severity from the CVSS v2 vector when there is no v3', function () {
        const rows = normalizeGemnasiumRecord(record({ cvss_v2: 'AV:N/AC:L/Au:N/C:C/I:C/A:C' }), 'npm', 'npm/')
        expect(rows[0]?.severity).toBe('high')
    })

    it('ignores a CVSS field that is not a string', function () {
        const rows = normalizeGemnasiumRecord(record({ cvss_v3: 42, cvss_v2: { vector: 'AV:N' } }), 'npm', 'npm/')
        expect(rows[0]?.severity).toBeNull()
    })

    // YAML happily produces a number where a version string is expected (`fixed_versions: [2]`), and the
    // list is still the authoritative fix boundary for a single-branch advisory.
    it('coerces a numeric entry in a string list', function () {
        const rows = normalizeGemnasiumRecord(
            record({ affected_range: '<1.0.0', fixed_versions: [2, '', null] }),
            'npm',
            'npm/'
        )
        expect(rows[0]?.ranges).toEqual([{ introduced: '0', fixed: '2', lastAffected: null }])
    })

    // An affected_range that is not a string is read as absent, and absent means the record states no
    // affected set — NOT that one should be invented from fixed_versions.
    it('drops a record whose affected_range is not a string', function () {
        expect(normalizeGemnasiumRecord(record({ affected_range: 42 }), 'npm', 'npm/')).toEqual([])
        expect(normalizeGemnasiumRecord(record({ affected_range: 42, fixed_versions: [] }), 'npm', 'npm/')).toEqual([])
    })
})

// `<0` is a valid node-semver range that selects no version, and gemnasium's field reference calls
// `affected_range` the machine-readable statement of what an advisory affects. So a record carrying it
// affects nothing and is dropped. It used to be widened into [0, fixed_versions[0]) — an unordered
// per-branch list, so the pick was arbitrary — which is how protobufjs 7.6.5 and every vite below 8.0.5
// were reported. The CVE-keyed twin of such a record carries the real range and reports on its own.
// gemnasium-db's schema has no `withdrawn` field — OSV's formal one is what we filter on there, and GitHub
// removes withdrawn entries before npm-audit ever sees them. gemnasium retracts by rewriting the record in
// place and leaving `affected_versions` / `fixed_versions` describing what it used to claim, so anything
// reading those reinstates the finding upstream withdrew. 383 records across npm/PyPI/Go/crates.io carry
// one of these markers: 278 duplicate, 43 withdrawn, 26 false-positive titles, and 36 stating it only in
// the description.
describe('normalizeGemnasiumRecord — advisories retracted upstream', function () {
    // REGRESSION — npm/express/CVE-2024-51999.yml, verbatim. Reported on six real projects under the
    // title "False Positive", because its prose still named the range it claimed before retraction.
    it('drops a record retracted as a false positive', function () {
        const rows = normalizeGemnasiumRecord({
            identifier: 'CVE-2024-51999',
            identifiers: ['CVE-2024-51999', 'GHSA-pj86-cfqh-vqx6'],
            package_slug: 'npm/express',
            title: 'False Positive',
            description: 'This advisory has been marked as False Positive and removed.',
            affected_range: '<0',
            fixed_versions: [],
            affected_versions: 'All versions before 4.22.0, all versions starting from 5.0.0 before 5.2.0'
        }, 'npm', 'npm/')
        expect(rows).toEqual([])
    })

    it('drops it whatever the marker capitalisation', function () {
        expect(normalizeGemnasiumRecord(
            record({ title: 'False positive', description: 'This advisory has been marked as a False Positive.' }),
            'npm', 'npm/'
        )).toEqual([])
    })

    // 278 records — the largest class, and the one that surfaces as a second finding for a package that
    // already has the real advisory (npm/braces GHSA-g95f-p29q-9xw4 alongside GMS-2019-5).
    it('drops an advisory withdrawn as a duplicate of another', function () {
        expect(normalizeGemnasiumRecord(
            record({ title: 'Duplicate Advisory: Regular Expression Denial of Service in braces', package_slug: 'npm/braces' }),
            'npm', 'npm/'
        )).toEqual([])
    })

    it('drops a withdrawn advisory', function () {
        expect(normalizeGemnasiumRecord(
            record({ title: 'Withdrawn Advisory: Bootstrap Cross-Site Scripting (XSS) vulnerability' }),
            'npm', 'npm/'
        )).toEqual([])
    })

    // REGRESSION — npm/babel-plugin-polyfill-corejs2/CVE-2023-45133.yml. The title reads as an ordinary
    // advisory ("Incorrect Comparison") and only the description retracts it, so the title tests cannot
    // find it. Eight babel packages share this shape and four were reporting.
    it('drops one whose title looks ordinary and whose description states the retraction', function () {
        const rows = normalizeGemnasiumRecord({
            identifier: 'CVE-2023-45133',
            identifiers: ['CVE-2023-45133', 'GHSA-67hx-6x53-jw92'],
            package_slug: 'npm/babel-plugin-polyfill-corejs2',
            title: 'Incorrect Comparison',
            description: 'This is a false positive.',
            affected_range: '<0',
            fixed_versions: ['0.4.6'],
            affected_versions: 'All versions before 0.4.6'
        }, 'npm', 'npm/')
        expect(rows).toEqual([])
    })

    it('drops one withdrawn only in the description', function () {
        expect(normalizeGemnasiumRecord(
            record({
                title: 'Angular: SSRF via protocol-relative and backslash URLs',
                description: '## Duplicate Advisory\nThis advisory has been withdrawn because it is a duplicate of GHSA-xxxx.'
            }),
            'npm', 'npm/'
        )).toEqual([])
    })

    // npm/axios CVE-2022-1214 — a CVE the numbering authority rejected outright.
    it('drops one invalidated because the CVE was rejected', function () {
        expect(normalizeGemnasiumRecord(
            record({ description: 'This advisory has been invalidated due to the CVE being rejected.' }),
            'npm', 'npm/'
        )).toEqual([])
    })

    // The reason every title test anchors instead of searching. This is a REAL advisory that happens to be
    // about a false positive in someone else's tool, and it must keep reporting.
    it('keeps a real advisory whose title merely mentions a false positive', function () {
        const rows = normalizeGemnasiumRecord({
            identifier: 'CVE-2026-39395',
            identifiers: ['CVE-2026-39395'],
            package_slug: 'go/github.com/sigstore/cosign',
            title: "Cosign's verify-blob-attestation reports false positive when payload parsing fails",
            affected_range: '>=3.0.0 <3.0.6||<2.6.3',
            fixed_versions: ['3.0.6', '2.6.3']
        }, 'Go', 'go/')
        expect(rows).toHaveLength(1)
        expect(rows[0]?.ranges.length).toBeGreaterThan(0)
    })

    it('keeps an advisory whose description merely discusses false positives', function () {
        expect(normalizeGemnasiumRecord(
            record({ description: 'The scanner emits a false positive when the header is absent.' }),
            'npm', 'npm/'
        )).toHaveLength(1)
    })
})

describe('normalizeGemnasiumRecord — a range that selects no version', function () {
    // REGRESSION — npm/protobufjs/GHSA-xq3m-2v4x-88gg.yml, verbatim from gemnasium-db.
    it('drops the protobufjs stub rather than widening it to [0, 8.0.1)', function () {
        const rows = normalizeGemnasiumRecord({
            identifier: 'GHSA-xq3m-2v4x-88gg',
            identifiers: ['GHSA-xq3m-2v4x-88gg'],
            package_slug: 'npm/protobufjs',
            title: 'Arbitrary code execution in protobufjs',
            affected_range: '<0',
            fixed_versions: ['8.0.1', '7.5.5'],
            affected_versions: 'All versions before 7.5.5, all versions starting from 8.0.0 before 8.0.1',
            cvss_v3: 'CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:C/C:H/I:H/A:H'
        }, 'npm', 'npm/')
        expect(rows).toEqual([])
    })

    // REGRESSION — npm/vite/GHSA-4w7w-66w2-5vf9.yml. Three vite advisories carried this shape, each
    // claiming every vite below 8.0.5 was vulnerable.
    it('drops the vite stub rather than widening it to [0, 8.0.5)', function () {
        const rows = normalizeGemnasiumRecord({
            identifier: 'GHSA-4w7w-66w2-5vf9',
            identifiers: ['GHSA-4w7w-66w2-5vf9'],
            package_slug: 'npm/vite',
            affected_range: '<0',
            fixed_versions: ['8.0.5', '7.3.2', '6.4.2'],
            affected_versions: 'All versions before 6.4.2, all versions starting from 7.0.0 before 7.3.2, all versions starting from 8.0.0 before 8.0.5'
        }, 'npm', 'npm/')
        expect(rows).toEqual([])
    })

    // `affected_versions` is display text per gemnasium's own field reference, and on a retracted record it
    // still describes the withdrawn claim — so it is never read, however well-formed it looks.
    it('never reads the display prose, even when it parses cleanly', function () {
        const rows = normalizeGemnasiumRecord(
            record({ affected_range: '<0', fixed_versions: [], affected_versions: 'All versions before 9.9.9' }),
            'npm',
            'npm/'
        )
        expect(rows).toEqual([])
    })

    it('drops the "<0.0.0" spelling the same way', function () {
        expect(normalizeGemnasiumRecord(record({ affected_range: '<0.0.0' }), 'npm', 'npm/')).toEqual([])
    })
})

describe('parseAffectedRange — no machine-readable range', function () {
    // The old contract was "assume everything before the fix is affected". That is the fabrication this
    // change removes: with no range and nothing but fixed_versions, the record states no affected set.
    it('does not invent a range from fixed_versions alone', function () {
        expect(parseAffectedRange('', ['4.17.21'])).toEqual({ ranges: [], versions: [] })
    })

    it('yields nothing when there is no range and no fix', function () {
        expect(parseAffectedRange('', [])).toEqual({ ranges: [], versions: [] })
        expect(parseAffectedRange('   ', [])).toEqual({ ranges: [], versions: [] })
    })

    // `<0` matches no version that exists. Treating it as a range — of any width — is the bug.
    it('reads the "<0" sentinel as unresolved, not as an interval', function () {
        expect(parseAffectedRange('<0', [])).toEqual({ ranges: [], versions: [] })
        expect(parseAffectedRange('<0', ['8.0.1', '7.5.5'])).toEqual({ ranges: [], versions: [] })
    })

    it('reads the "<0.0.0" spelling of the sentinel the same way', function () {
        expect(parseAffectedRange('<0.0.0', ['2.0.0'])).toEqual({ ranges: [], versions: [] })
    })

    // The display prose is not an input at all, so a record whose machine range selects nothing yields
    // nothing regardless of how much the human-readable field claims.
    it('yields nothing for the sentinel however rich the record looks', function () {
        expect(parseAffectedRange('<0', ['8.0.1', '7.5.5'])).toEqual({ ranges: [], versions: [] })
    })
})

describe('parseAffectedRange — comparator form', function () {
    it('reads an upper bound alone as an exclusive bound from zero', function () {
        expect(parseAffectedRange('<4.17.12', [])).toEqual({
            ranges: [{ introduced: '0', fixed: '4.17.12', lastAffected: null }],
            versions: []
        })
    })

    it('reads a bounded range', function () {
        expect(parseAffectedRange('>=4.0.0 <4.0.1', [])).toEqual({
            ranges: [{ introduced: '4.0.0', fixed: '4.0.1', lastAffected: null }],
            versions: []
        })
    })

    it('leaves fixed null for an open-ended lower bound', function () {
        expect(parseAffectedRange('>=2.0.0', [])).toEqual({
            ranges: [{ introduced: '2.0.0', fixed: null, lastAffected: null }],
            versions: []
        })
    })

    // REGRESSION (npm/rc GMS-2021-3). ">" excludes its own bound, and rounding it to ">=" is not the
    // safe direction to be wrong in — it reports the boundary version as affected, always, at whatever
    // severity the advisory carries. gemnasium states the rc hijack as ">1.2.8" while 1.2.8 is the last
    // CLEAN release, so the rounding reported the one safe version as critical malware with no fix.
    it('keeps an exclusive lower bound exclusive', function () {
        expect(parseAffectedRange('>1.0.0 <2.0.0', [])).toEqual({
            ranges: [{ introduced: '1.0.0', introducedExclusive: true, fixed: '2.0.0', lastAffected: null }],
            versions: []
        })
    })

    it('reads an exclusive lower bound with no upper bound', function () {
        expect(parseAffectedRange('>1.2.8', [])).toEqual({
            ranges: [{ introduced: '1.2.8', introducedExclusive: true, fixed: null, lastAffected: null }],
            versions: []
        })
    })

    it('splits a disjunction into separate ranges', function () {
        expect(parseAffectedRange('>=1 <2 || >=3 <4', [])).toEqual({
            ranges: [
                { introduced: '1', fixed: '2', lastAffected: null },
                { introduced: '3', fixed: '4', lastAffected: null }
            ],
            versions: []
        })
    })

    // "<=X" says X itself is affected, and the range type says so directly. It used to collapse into an
    // exclusive `fixed: X`, which dropped X — the one version the advisory was most explicit about.
    it('reads a bare <= bound as an inclusive upper bound', function () {
        expect(parseAffectedRange('<=2.0.0', [])).toEqual({
            ranges: [{ introduced: '0', fixed: null, lastAffected: '2.0.0' }],
            versions: []
        })
    })

    // A token this parser cannot read makes the whole disjunct unreadable. Skipping it instead looks
    // harmless on a stray "v", but the same skip applied to "^1.0.0" leaves the loop with no bounds at
    // all — an unbounded range matching EVERY version of the package.
    it('drops a disjunct containing a token it cannot read', function () {
        expect(parseAffectedRange('>=1.0.0 v <2.0.0', [])).toEqual({ ranges: [], versions: [] })
    })

    it('drops an empty disjunct rather than emitting an unbounded range', function () {
        expect(parseAffectedRange('>=1 <2 || ', [])).toEqual({
            ranges: [{ introduced: '1', fixed: '2', lastAffected: null }],
            versions: []
        })
        expect(parseAffectedRange('||', [])).toEqual({ ranges: [], versions: [] })
    })

    it('strips a leading v from either bound', function () {
        expect(parseAffectedRange('>=v1.0.0 <V2.0.0', [])).toEqual({
            ranges: [{ introduced: '1.0.0', fixed: '2.0.0', lastAffected: null }],
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
            ranges: [{ introduced: '1.0.0', fixed: '2.0.0', lastAffected: null }],
            versions: []
        })
    })

    // REGRESSION. npm range operators this parser does not implement used to fall through to the bare
    // "exact version" branch and be cached verbatim — "^1.0.0" became a pin on the literal string
    // "^1.0.0", which no installed version can ever equal. The row looked like a live advisory and
    // matched nothing for as long as it stayed in the cache.
    it.each(['^1.0.0', '~1.0.0', '!=1.0.0', '1.x', '*'])('refuses %j rather than pinning it', function (raw) {
        expect(parseAffectedRange(raw, [])).toEqual({ ranges: [], versions: [] })
    })
})

// REGRESSION (npm/fresh GMS-2017-232). gemnasium writes the operator apart from its version in 19 records,
// and node-semver reads each pair as one comparator — `validRange('< 0.5.2')` is `'<0.5.2'`. Splitting on
// whitespace alone made two tokens of the pair, so the naked "<" took an empty version and the version
// token, now bare, was read as an exact pin that returned from the parser at once and discarded every
// later comparator in the disjunct.
//
// The damage was an INVERTED finding rather than a lost one: "< 0.5.2" cached as "exactly 0.5.2 is
// affected", and 0.5.2 is the release that FIXED the ReDoS. A pin carries no fix boundary, so the finding
// named no remediation — a moderate on the one version that clears the advisory, unfixable by upgrading.
describe('parseAffectedRange — an operator written apart from its version', function () {
    // Each spaced spelling against its unspaced twin, which is the assertion that matters: the space is
    // insignificant to npm, so it must be insignificant here. Testing them against hand-written expected
    // objects would let both sides drift together.
    it.each([
        ['< 0.5.2', '<0.5.2'],
        ['<= 0.3.3', '<=0.3.3'],
        ['> 1.2.8', '>1.2.8'],
        ['>= 2.0.0', '>=2.0.0'],
        ['= 1.2.3', '=1.2.3'],
        ['>= 1.0.0 < 2.0.0', '>=1.0.0 <2.0.0'],
        ['>= 1.7.0 <1.7.8', '>=1.7.0 <1.7.8'],
        ['< 1.6.14 || >= 1.7.0 < 1.7.8', '<1.6.14 || >=1.7.0 <1.7.8'],
        // PEP 440 spells an intersection with a comma, and gemnasium's PyPI records add a space after it.
        ['>= 5.0, < 5.8', '>=5.0,<5.8']
    ])('reads %j exactly as %j', function (spaced, tight) {
        expect(parseAffectedRange(spaced, [])).toEqual(parseAffectedRange(tight, []))
    })

    // The record itself, end to end. `fixed_versions: ["0.5.2"]` is passed as upstream states it, so the
    // authoritative-fix override runs too and the assertion covers the row a scan would actually match on.
    it('does NOT report fresh 0.5.2 — the version that fixed it — as affected', function () {
        const parsed = parseAffectedRange('< 0.5.2', ['0.5.2'])
        expect(parsed).toEqual({
            ranges: [{ introduced: '0', fixed: '0.5.2', lastAffected: null }],
            versions: []
        })
        expect(parsed.versions).not.toContain('0.5.2')
    })

    // npm/pg GMS-2017-178: eleven branches, every one of them spaced, and one disjunct carrying a double
    // space after the "||". Before the fix this pinned eleven versions — each branch's FIRST affected
    // version plus the 2.11.2 that fixed the oldest branch — and produced not one usable range.
    it('reads all eleven branches of the npm/pg advisory', function () {
        const parsed = parseAffectedRange(
            '< 2.11.2 || >= 3.0.0 < 3.6.4 ||  >= 4.0.0 < 4.5.7 || >= 5.0.0 < 5.2.1 || >= 6.0.0 < 6.0.5',
            []
        )
        expect(parsed.versions).toEqual([])
        expect(parsed.ranges).toEqual([
            { introduced: '0', fixed: '2.11.2', lastAffected: null },
            { introduced: '3.0.0', fixed: '3.6.4', lastAffected: null },
            { introduced: '4.0.0', fixed: '4.5.7', lastAffected: null },
            { introduced: '5.0.0', fixed: '5.2.1', lastAffected: null },
            { introduced: '6.0.0', fixed: '6.0.5', lastAffected: null }
        ])
    })

    // A trailing operator has no version to bind to. Dropping it silently would leave ">=1.0.0" unbounded
    // — a finding on every release of the package, forever — so the disjunct goes instead, which is also
    // what node-semver does: `validRange('<')` is null.
    it('refuses a disjunct whose operator has no version', function () {
        expect(parseAffectedRange('<', [])).toEqual({ ranges: [], versions: [] })
        expect(parseAffectedRange('>=1.0.0 <', [])).toEqual({ ranges: [], versions: [] })
    })
})

describe('parseAffectedRange — maven-style interval notation', function () {
    // "(," names no lower bound at all, so there is nothing for the paren to exclude — the range starts
    // at the bottom of the version space inclusively.
    it('reads an open lower bound', function () {
        expect(parseAffectedRange('(,4.1.2)', [])).toEqual({
            ranges: [{ introduced: '0', fixed: '4.1.2', lastAffected: null }],
            versions: []
        })
    })

    it('reads a fully bounded interval', function () {
        expect(parseAffectedRange('[1.0.0,2.0.0)', [])).toEqual({
            ranges: [{ introduced: '1.0.0', fixed: '2.0.0', lastAffected: null }],
            versions: []
        })
    })

    // "(" on a bound that exists IS exclusive — that is the entire difference from "[".
    it('reads an exclusive open bracket as an exclusive lower bound', function () {
        expect(parseAffectedRange('(1.0.0,2.0.0)', [])).toEqual({
            ranges: [{ introduced: '1.0.0', introducedExclusive: true, fixed: '2.0.0', lastAffected: null }],
            versions: []
        })
    })

    it('reads an open upper bound as unfixed', function () {
        expect(parseAffectedRange('[1.0.0,)', [])).toEqual({
            ranges: [{ introduced: '1.0.0', fixed: null, lastAffected: null }],
            versions: []
        })
    })

    it('reads a comma-less interval as an exact version', function () {
        expect(parseAffectedRange('[1.2.3]', [])).toEqual({ ranges: [], versions: ['1.2.3'] })
    })

    // "]" is an INCLUSIVE close, not a spelling variant of ")". Reading the two as equivalent silently
    // excluded the upper bound version from every maven-notation advisory that used it.
    it('reads a closing square bracket as an inclusive upper bound', function () {
        expect(parseAffectedRange('[1.0.0,2.0.0]', [])).toEqual({
            ranges: [{ introduced: '1.0.0', fixed: null, lastAffected: '2.0.0' }],
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
    // A known fix version is a better upper bound than a parsed one, and it names the remediation
    // target. Note this is no longer how "<=X" is expressed — that has its own representation now.
    it('prefers the real fix version over an inclusive parsed bound', function () {
        expect(parseAffectedRange('<=2.0.0', ['2.0.1'])).toEqual({
            ranges: [{ introduced: '0', fixed: '2.0.1', lastAffected: null }],
            versions: []
        })
    })

    // With no fix recorded, "<=X" stands on its own and still includes X. It used to fall back to an
    // exclusive fixed=X here, silently dropping the boundary version.
    it('keeps <=X inclusive when no fix is known', function () {
        expect(parseAffectedRange('<=2.0.0', [])).toEqual({
            ranges: [{ introduced: '0', fixed: null, lastAffected: '2.0.0' }],
            versions: []
        })
    })

    it('overrides a parsed upper bound that disagrees with the recorded fix', function () {
        expect(parseAffectedRange('<4.17.12', ['4.17.21'])).toEqual({
            ranges: [{ introduced: '0', fixed: '4.17.21', lastAffected: null }],
            versions: []
        })
    })

    it('preserves the lower bound while overriding the upper', function () {
        expect(parseAffectedRange('>=4.0.0 <4.0.1', ['4.0.9'])).toEqual({
            ranges: [{ introduced: '4.0.0', fixed: '4.0.9', lastAffected: null }],
            versions: []
        })
    })

    // The override replaces the UPPER bound only. An exclusive lower bound is the advisory's own
    // statement and survives it.
    it('preserves an exclusive lower bound while overriding the upper', function () {
        expect(parseAffectedRange('>1.0.0 <2.0.0', ['2.5.0'])).toEqual({
            ranges: [{ introduced: '1.0.0', introducedExclusive: true, fixed: '2.5.0', lastAffected: null }],
            versions: []
        })
    })

    // REGRESSION. `fixed_versions` is an UNORDERED set with one fix per release branch, so on a
    // multi-branch advisory `fixed_versions[0]` is an arbitrary pick. Applying it to a single interval
    // claims every version below some OTHER branch's fix is vulnerable — which is how a correctly-parsed
    // `>=7.5.0 <7.6.5` would have become `>=7.5.0 <8.6.6`. One entry is the only safe case.
    it('does not override when several branch fixes are listed', function () {
        expect(parseAffectedRange('>=7.5.0 <7.6.5', ['7.6.5', '8.6.6'])).toEqual({
            ranges: [{ introduced: '7.5.0', fixed: '7.6.5', lastAffected: null }],
            versions: []
        })
    })

    // npm/sauce-connect-launcher GMS-2014-4, the case the count check used to cost us: "<=0.3.3" with two
    // branch fixes skips the override, and now keeps 0.3.3 instead of under-including it.
    it('keeps an inclusive bound the multi-fix guard declines to override', function () {
        expect(parseAffectedRange('<=0.3.3', ['0.3.5', '0.4.0'])).toEqual({
            ranges: [{ introduced: '0', fixed: null, lastAffected: '0.3.3' }],
            versions: []
        })
    })

    // With several disjoint ranges there is no way to know which one the single fixed version closes,
    // so applying it to the first would be a guess.
    it('does not override when the range is disjoint', function () {
        expect(parseAffectedRange('>=1 <2 || >=3 <4', ['4.0.1'])).toEqual({
            ranges: [
                { introduced: '1', fixed: '2', lastAffected: null },
                { introduced: '3', fixed: '4', lastAffected: null }
            ],
            versions: []
        })
    })

    it('does not override when enumerated versions are also present', function () {
        expect(parseAffectedRange('<2.0.0 || 3.0.0', ['9.9.9'])).toEqual({
            ranges: [{ introduced: '0', fixed: '2.0.0', lastAffected: null }],
            versions: ['3.0.0']
        })
    })

    it('does not override an exact pin', function () {
        expect(parseAffectedRange('[1.2.3]', ['2.0.0'])).toEqual({ ranges: [], versions: ['1.2.3'] })
    })
})

// An interval with no upper bound claims every version from `introduced` onward is vulnerable forever with
// no fix — a finding no upgrade can clear. When the record lists fix versions that claim is false, and the
// highest of them is the boundary. This runs after the single-fix override above, so it only ever sees
// intervals that override declined to close.
describe('parseAffectedRange — an open-ended range bounded by the highest known fix', function () {
    it.each([
        [['7.5.5', '8.0.1']],
        [['8.0.1', '7.5.5']]
    ])('bounds at the highest fix whatever order the set arrives in: %j', function (fixedVersions) {
        expect(parseAffectedRange('>=2.0.0', fixedVersions)).toEqual({
            ranges: [{ introduced: '2.0.0', fixed: '8.0.1', lastAffected: null }],
            versions: []
        })
    })

    it('bounds only the disjunct that has no upper bound', function () {
        expect(parseAffectedRange('>=1 <2 || >=3', ['2.0.0', '4.0.0'])).toEqual({
            ranges: [
                { introduced: '1', fixed: '2', lastAffected: null },
                { introduced: '3', fixed: '4.0.0', lastAffected: null }
            ],
            versions: []
        })
    })

    // The rc GMS-2021-3 shape: ">1.2.8" excludes 1.2.8, which is the clean release. Bounding above must not
    // quietly pull the lower bound back to inclusive.
    it('keeps an exclusive lower bound exclusive while bounding above', function () {
        expect(parseAffectedRange('>1.2.8', ['1.3.0', '2.0.0'])).toEqual({
            ranges: [{ introduced: '1.2.8', introducedExclusive: true, fixed: '2.0.0', lastAffected: null }],
            versions: []
        })
    })

    // A fix at or below the lower bound belongs to a different branch. Pairing them builds a range that
    // matches nothing, which mutes the advisory outright — worse than leaving it too wide.
    it('refuses a fix that is not above the lower bound', function () {
        expect(parseAffectedRange('>=9.0.0', ['1.0.0', '2.0.0'])).toEqual({
            ranges: [{ introduced: '9.0.0', fixed: null, lastAffected: null }],
            versions: []
        })
    })

    it('refuses fix versions it cannot order', function () {
        expect(parseAffectedRange('>=2.0.0', ['not-a-version', 'also-bad'])).toEqual({
            ranges: [{ introduced: '2.0.0', fixed: null, lastAffected: null }],
            versions: []
        })
    })

    // With exactly one fix the override above has already closed the range; this pass sees a bounded
    // interval and leaves it alone. Same answer, different rule — worth pinning so a future edit to either
    // one shows up here.
    it('leaves the single-fix override result untouched', function () {
        expect(parseAffectedRange('>=2.0.0', ['4.0.0'])).toEqual({
            ranges: [{ introduced: '2.0.0', fixed: '4.0.0', lastAffected: null }],
            versions: []
        })
    })
})

// PEP 440 spells an intersection with a comma. Splitting the disjunct on whitespace alone kept ">=5.0,<5.8"
// as ONE token, so the lower bound became the literal "5.0,<5.8" — which no PEP 440 parser reads, so the
// matcher refused the bound and the range matched nothing — and the upper bound vanished entirely. 2,830 of
// 7,159 cached PyPI records were in that state, unable to report anything at all.
describe('parseAffectedRange — PEP 440 comma intersections', function () {
    it('splits a comma intersection into one bounded interval', function () {
        expect(parseAffectedRange('>=5.0,<5.8', [])).toEqual({
            ranges: [{ introduced: '5.0', fixed: '5.8', lastAffected: null }],
            versions: []
        })
    })

    it('keeps an inclusive upper bound across a comma', function () {
        expect(parseAffectedRange('>=1.0,<=1.0.1', [])).toEqual({
            ranges: [{ introduced: '1.0', fixed: null, lastAffected: '1.0.1' }],
            versions: []
        })
    })

    it('reads a disjunction of comma intersections', function () {
        expect(parseAffectedRange('>=2.2.0,<7.1.0 || >=4.0.0,<4.3.0', [])).toEqual({
            ranges: [
                { introduced: '2.2.0', fixed: '7.1.0', lastAffected: null },
                { introduced: '4.0.0', fixed: '4.3.0', lastAffected: null }
            ],
            versions: []
        })
    })

    it('tolerates a space after the comma', function () {
        expect(parseAffectedRange('>=5.0, <5.8', [])).toEqual({
            ranges: [{ introduced: '5.0', fixed: '5.8', lastAffected: null }],
            versions: []
        })
    })

    // A maven interval's comma is structural, and parseDisjunct routes it away on the leading bracket
    // before the comparator parser ever sees it.
    it('leaves maven interval notation to its own parser', function () {
        expect(parseAffectedRange('[1.0.0,2.0.0)', [])).toEqual({
            ranges: [{ introduced: '1.0.0', fixed: '2.0.0', lastAffected: null }],
            versions: []
        })
    })
})
