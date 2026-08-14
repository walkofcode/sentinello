import { describe, expect, it } from 'vitest'
import { normalizeGemnasiumRecord, parseAffectedRange, parseAffectedVersionsProse } from './normalize'

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

    // A record stating no affected set is now KEPT, as an inert 'unresolved' row carrying no ranges, so
    // the worker's resolution pass can see it and recover a range from a sibling advisory or the OSV
    // cache. It can never match in the meantime — the matcher needs a range or an enumerated version.
    it('keeps a record that yields neither a range nor a version, as unresolved', function () {
        const rows = normalizeGemnasiumRecord(
            record({ affected_range: '', fixed_versions: [] }),
            'npm',
            'npm/'
        )
        expect(rows).toHaveLength(1)
        expect(rows[0]?.rangeSource).toBe('unresolved')
        expect(rows[0]?.ranges).toEqual([])
        expect(rows[0]?.versions).toEqual([])
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
            withdrawn: null,
            rangeSource: 'range'
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
        expect(rows[0]?.ranges).toEqual([{ introduced: '0', fixed: '2' }])
    })

    // An affected_range that is not a string is read as absent. With no machine range to work from the
    // record is unresolved — NOT silently widened to [0, fixed_versions[0]).
    it('treats a non-string affected_range as absent and leaves the record unresolved', function () {
        const rows = normalizeGemnasiumRecord(record({ affected_range: 42 }), 'npm', 'npm/')
        expect(rows[0]?.rangeSource).toBe('unresolved')
        expect(rows[0]?.ranges).toEqual([])
    })

    it('keeps a record whose affected_range is unusable and has no fixed versions, as unresolved', function () {
        const rows = normalizeGemnasiumRecord(record({ affected_range: 42, fixed_versions: [] }), 'npm', 'npm/')
        expect(rows[0]?.rangeSource).toBe('unresolved')
    })
})

describe('normalizeGemnasiumRecord — the "<0" empty-set sentinel', function () {
    // REGRESSION — npm/protobufjs/GHSA-xq3m-2v4x-88gg.yml, verbatim from gemnasium-db.
    //
    // This exact record is what reported protobufjs 7.6.5 as a critical RCE across 88 projects. It has no
    // machine-readable range, and `fixed_versions` is an UNORDERED per-branch set whose first entry is the
    // 8.x fix. The old code produced [0, 8.0.1) from it and swept in every 7.x release, including the
    // fully-patched ones. The CVE-keyed twin in the same directory carries the real range.
    const protobufjsStub = {
        identifier: 'GHSA-xq3m-2v4x-88gg',
        identifiers: ['GHSA-xq3m-2v4x-88gg'],
        package_slug: 'npm/protobufjs',
        title: 'Arbitrary code execution in protobufjs',
        affected_range: '<0',
        fixed_versions: ['8.0.1', '7.5.5'],
        affected_versions: 'All versions before 7.5.5, all versions starting from 8.0.0 before 8.0.1',
        cvss_v3: 'CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:C/C:H/I:H/A:H'
    }

    it('never widens the sentinel into [0, fixed_versions[0])', function () {
        const rows = normalizeGemnasiumRecord(protobufjsStub, 'npm', 'npm/')
        expect(rows[0]?.ranges).not.toContainEqual({ introduced: '0', fixed: '8.0.1' })
    })

    it('recovers both release branches from the generated prose', function () {
        const rows = normalizeGemnasiumRecord(protobufjsStub, 'npm', 'npm/')
        expect(rows[0]?.rangeSource).toBe('prose')
        expect(rows[0]?.ranges).toEqual([
            { introduced: '0', fixed: '7.5.5' },
            { introduced: '8.0.0', fixed: '8.0.1' }
        ])
    })

    // REGRESSION — npm/vite/GHSA-4w7w-66w2-5vf9.yml. Three separate vite advisories carried this shape,
    // each of them claiming every vite below 8.0.5 was vulnerable.
    it('recovers all three vite branches rather than collapsing to [0, 8.0.5)', function () {
        const rows = normalizeGemnasiumRecord({
            identifier: 'GHSA-4w7w-66w2-5vf9',
            identifiers: ['GHSA-4w7w-66w2-5vf9'],
            package_slug: 'npm/vite',
            affected_range: '<0',
            fixed_versions: ['8.0.5', '7.3.2', '6.4.2'],
            affected_versions: 'All versions before 6.4.2, all versions starting from 7.0.0 before 7.3.2, all versions starting from 8.0.0 before 8.0.5'
        }, 'npm', 'npm/')
        expect(rows[0]?.ranges).toEqual([
            { introduced: '0', fixed: '6.4.2' },
            { introduced: '7.0.0', fixed: '7.3.2' },
            { introduced: '8.0.0', fixed: '8.0.5' }
        ])
    })

    // The sentinel with NO usable prose is the case the worker's sibling/OSV tiers exist for. It must
    // leave the record inert rather than fall back to fabricating a range.
    it('leaves the record unresolved when the prose says nothing', function () {
        const rows = normalizeGemnasiumRecord({
            identifier: 'GHSA-9f65-56v6-gxw7',
            identifiers: ['GHSA-9f65-56v6-gxw7'],
            package_slug: 'npm/example',
            affected_range: '<0',
            fixed_versions: ['2.0.0'],
            affected_versions: 'None'
        }, 'npm', 'npm/')
        expect(rows[0]?.rangeSource).toBe('unresolved')
        expect(rows[0]?.ranges).toEqual([])
    })

    it('leaves a withdrawn record unresolved rather than reading its notice as a range', function () {
        const rows = normalizeGemnasiumRecord({
            identifier: 'GHSA-45q2-gjvg-7973',
            identifiers: ['GHSA-45q2-gjvg-7973'],
            package_slug: 'npm/example',
            affected_range: '<0',
            fixed_versions: ['1.0.0'],
            affected_versions: 'This advisory has been withdrawn.'
        }, 'npm', 'npm/')
        expect(rows[0]?.rangeSource).toBe('unresolved')
    })
})

// gemnasium-db's schema has no `withdrawn` field — OSV's formal one is what we filter on there, and GitHub
// simply removes withdrawn entries before npm-audit ever sees them. gemnasium retracts by rewriting the
// record in place and leaving `affected_versions` / `fixed_versions` describing what it used to claim, so
// anything reading those reinstates the finding upstream withdrew. 372 records across npm/PyPI/Go/crates.io
// carry one of these markers.
describe('normalizeGemnasiumRecord — advisories retracted upstream', function () {
    // REGRESSION — npm/express/CVE-2024-51999.yml, verbatim. Retracted, yet the prose still names the
    // range it claimed before retraction, so reading it reported express across six real projects.
    it('drops a record retracted as a false positive, prose and all', function () {
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

    // The lower-case spelling gemnasium also uses (npm/express-hbs CVE-2021-32820).
    it('drops it whatever the marker capitalisation', function () {
        const rows = normalizeGemnasiumRecord(
            record({ title: 'False positive', description: 'This advisory has been marked as a False Positive.' }),
            'npm',
            'npm/'
        )
        expect(rows).toEqual([])
    })

    // 278 records — the largest class by far, and the one that shows up as a second finding for a package
    // that already has the real advisory (npm/braces GHSA-g95f-p29q-9xw4 alongside GMS-2019-5).
    it('drops an advisory withdrawn as a duplicate of another', function () {
        const rows = normalizeGemnasiumRecord(
            record({ title: 'Duplicate Advisory: Regular Expression Denial of Service in braces', package_slug: 'npm/braces' }),
            'npm',
            'npm/'
        )
        expect(rows).toEqual([])
    })

    it('drops a withdrawn advisory', function () {
        const rows = normalizeGemnasiumRecord(
            record({ title: 'Withdrawn Advisory: Bootstrap Cross-Site Scripting (XSS) vulnerability' }),
            'npm',
            'npm/'
        )
        expect(rows).toEqual([])
    })

    // Both spellings occur upstream, and a record can carry the marker in the description while its title
    // still reads as an ordinary advisory — so the description is checked independently of the title.
    it('drops one marked a false positive in the description without the article', function () {
        const rows = normalizeGemnasiumRecord(
            record({
                title: 'Prototype Pollution in lodash',
                description: 'This advisory has been marked as False Positive and removed.'
            }),
            'npm',
            'npm/'
        )
        expect(rows).toEqual([])
    })

    // 16 records read as ordinary advisories in the title and carry the withdrawal only in the description.
    it('drops one whose withdrawal is stated only in the description', function () {
        const rows = normalizeGemnasiumRecord(
            record({
                title: 'Angular: SSRF via protocol-relative and backslash URLs',
                description: '## Duplicate Advisory\nThis advisory has been withdrawn because it is a duplicate of GHSA-xxxx.'
            }),
            'npm',
            'npm/'
        )
        expect(rows).toEqual([])
    })

    // The reason the title tests anchor rather than search. This is a REAL advisory that happens to be
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
        const rows = normalizeGemnasiumRecord(
            record({ description: 'The scanner emits a false positive when the header is absent.' }),
            'npm',
            'npm/'
        )
        expect(rows).toHaveLength(1)
    })
})

describe('parseAffectedRange — no machine-readable range', function () {
    // The old contract was "assume everything before the fix is affected". That is the fabrication this
    // change removes: with no range and nothing but fixed_versions, the record states no affected set.
    it('does not invent a range from fixed_versions alone', function () {
        expect(parseAffectedRange('', ['4.17.21'])).toEqual({ ranges: [], versions: [], source: 'unresolved' })
    })

    it('yields nothing when there is no range and no fix', function () {
        expect(parseAffectedRange('', [])).toEqual({ ranges: [], versions: [], source: 'unresolved' })
        expect(parseAffectedRange('   ', [])).toEqual({ ranges: [], versions: [], source: 'unresolved' })
    })

    // `<0` matches no version that exists. Treating it as a range — of any width — is the bug.
    it('reads the "<0" sentinel as unresolved, not as an interval', function () {
        expect(parseAffectedRange('<0', [])).toEqual({ ranges: [], versions: [], source: 'unresolved' })
        expect(parseAffectedRange('<0', ['8.0.1', '7.5.5'])).toEqual({ ranges: [], versions: [], source: 'unresolved' })
    })

    it('reads the "<0.0.0" spelling of the sentinel the same way', function () {
        expect(parseAffectedRange('<0.0.0', ['2.0.0'])).toEqual({ ranges: [], versions: [], source: 'unresolved' })
    })

    it('falls back to the prose when the machine range is the sentinel', function () {
        expect(parseAffectedRange('<0', ['8.0.1', '7.5.5'], 'All versions before 7.5.5, all versions starting from 8.0.0 before 8.0.1')).toEqual({
            ranges: [
                { introduced: '0', fixed: '7.5.5' },
                { introduced: '8.0.0', fixed: '8.0.1' }
            ],
            versions: [],
            source: 'prose'
        })
    })

    // The prose is a fallback for a MISSING range, never an override of a present one.
    it('ignores the prose when a real machine range is present', function () {
        expect(parseAffectedRange('>=1.0.0 <2.0.0', [], 'All versions before 9.9.9')).toEqual({
            ranges: [{ introduced: '1.0.0', fixed: '2.0.0' }],
            versions: [],
            source: 'range'
        })
    })
})

describe('parseAffectedVersionsProse', function () {
    it('reads a single "before" clause', function () {
        expect(parseAffectedVersionsProse('All versions before 7.5.5')).toEqual([{ introduced: '0', fixed: '7.5.5' }])
    })

    it('reads a bounded "starting from … before" clause', function () {
        expect(parseAffectedVersionsProse('All versions starting from 8.0.0 before 8.0.1')).toEqual([
            { introduced: '8.0.0', fixed: '8.0.1' }
        ])
    })

    it('reads an open-ended "starting from" clause', function () {
        expect(parseAffectedVersionsProse('All versions starting from 2.0.0')).toEqual([{ introduced: '2.0.0', fixed: null }])
    })

    it('reads a bare "All versions" as the whole package', function () {
        expect(parseAffectedVersionsProse('All versions')).toEqual([{ introduced: '0', fixed: null }])
    })

    it('reads several comma-separated clauses in order', function () {
        expect(parseAffectedVersionsProse(
            'All versions before 6.4.2, all versions starting from 7.0.0 before 7.3.2, all versions starting from 8.0.0 before 8.0.5'
        )).toEqual([
            { introduced: '0', fixed: '6.4.2' },
            { introduced: '7.0.0', fixed: '7.3.2' },
            { introduced: '8.0.0', fixed: '8.0.5' }
        ])
    })

    // gemnasium wraps long sentences across YAML lines, so the parser sees embedded newlines.
    it('tolerates the line wrapping the YAML introduces', function () {
        expect(parseAffectedVersionsProse('All versions before 7.5.5, all versions starting from 8.0.0 before\n  8.0.1')).toEqual([
            { introduced: '0', fixed: '7.5.5' },
            { introduced: '8.0.0', fixed: '8.0.1' }
        ])
    })

    it('strips a leading v from a bound', function () {
        expect(parseAffectedVersionsProse('All versions before v3.0.0')).toEqual([{ introduced: '0', fixed: '3.0.0' }])
    })

    it('rejects the explicit "nothing here" phrasings', function () {
        expect(parseAffectedVersionsProse('None')).toBeNull()
        expect(parseAffectedVersionsProse('none')).toBeNull()
        expect(parseAffectedVersionsProse('No version are affected')).toBeNull()
        expect(parseAffectedVersionsProse('This advisory has been withdrawn.')).toBeNull()
        expect(parseAffectedVersionsProse('')).toBeNull()
        expect(parseAffectedVersionsProse('   ')).toBeNull()
    })

    // "up to X" is an INCLUSIVE upper bound, which the half-open [introduced, fixed) shape cannot express
    // without inventing X's successor. Refusing hands the record to the sibling/OSV tiers instead of
    // guessing — 15 npm advisories are phrased this way.
    it('refuses an inclusive "up to" bound rather than guessing at it', function () {
        expect(parseAffectedVersionsProse('All versions up to 2026.3.24')).toBeNull()
    })

    // All-or-nothing: a partially understood sentence would silently drop a vulnerable interval, which is
    // exactly the failure mode this whole change is about.
    it('discards the whole sentence when any clause is unrecognised', function () {
        expect(parseAffectedVersionsProse('All versions before 1.0.0, something we do not understand')).toBeNull()
    })
})

describe('parseAffectedRange — comparator form', function () {
    it('reads an upper bound alone as [0, fixed)', function () {
        expect(parseAffectedRange('<4.17.12', [])).toEqual({
            ranges: [{ introduced: '0', fixed: '4.17.12' }],
            versions: [],
            source: 'range'
        })
    })

    it('reads a bounded range', function () {
        expect(parseAffectedRange('>=4.0.0 <4.0.1', [])).toEqual({
            ranges: [{ introduced: '4.0.0', fixed: '4.0.1' }],
            versions: [],
            source: 'range'
        })
    })

    it('leaves fixed null for an open-ended lower bound', function () {
        expect(parseAffectedRange('>=2.0.0', [])).toEqual({
            ranges: [{ introduced: '2.0.0', fixed: null }],
            versions: [],
            source: 'range'
        })
    })

    // ">" is deliberately read as an inclusive lower bound: at worst it flags the boundary version
    // itself, which is the safe direction to be wrong in.
    it('treats an exclusive lower bound as inclusive', function () {
        expect(parseAffectedRange('>1.0.0 <2.0.0', [])).toEqual({
            ranges: [{ introduced: '1.0.0', fixed: '2.0.0' }],
            versions: [],
            source: 'range'
        })
    })

    it('splits a disjunction into separate ranges', function () {
        expect(parseAffectedRange('>=1 <2 || >=3 <4', [])).toEqual({
            ranges: [
                { introduced: '1', fixed: '2' },
                { introduced: '3', fixed: '4' }
            ],
            versions: [],
            source: 'range'
        })
    })

    // "<=X" says X itself is affected, but the half-open [introduced, fixed) model cannot express
    // that without X's successor. With no authoritative fix to override it, falling back to fixed=X
    // under-includes only the boundary — far safer than null, which would flag every version forever.
    it('reads a bare <= bound as fixed at that version', function () {
        expect(parseAffectedRange('<=2.0.0', [])).toEqual({
            ranges: [{ introduced: '0', fixed: '2.0.0' }],
            versions: [],
            source: 'range'
        })
    })

    // A token that is nothing but a version prefix strips to the empty string. Skipping it keeps the
    // rest of the disjunct usable instead of pinning the advisory to an empty exact version.
    it('skips a token that strips to nothing', function () {
        expect(parseAffectedRange('>=1.0.0 v <2.0.0', [])).toEqual({
            ranges: [{ introduced: '1.0.0', fixed: '2.0.0' }],
            versions: [],
            source: 'range'
        })
    })

    it('drops an empty disjunct rather than emitting an unbounded range', function () {
        expect(parseAffectedRange('>=1 <2 || ', [])).toEqual({
            ranges: [{ introduced: '1', fixed: '2' }],
            versions: [],
            source: 'range'
        })
        expect(parseAffectedRange('||', [])).toEqual({ ranges: [], versions: [], source: 'unresolved' })
    })

    it('strips a leading v from either bound', function () {
        expect(parseAffectedRange('>=v1.0.0 <V2.0.0', [])).toEqual({
            ranges: [{ introduced: '1.0.0', fixed: '2.0.0' }],
            versions: [],
            source: 'range'
        })
    })

    it('reads an explicit pin as an enumerated version, not a range', function () {
        expect(parseAffectedRange('=1.2.3', [])).toEqual({ ranges: [], versions: ['1.2.3'], source: 'range' })
    })

    it('reads a bare version as a pin', function () {
        expect(parseAffectedRange('1.2.3', [])).toEqual({ ranges: [], versions: ['1.2.3'], source: 'range' })
    })

    it('tolerates irregular whitespace between tokens', function () {
        expect(parseAffectedRange('  >=1.0.0    <2.0.0  ', [])).toEqual({
            ranges: [{ introduced: '1.0.0', fixed: '2.0.0' }],
            versions: [],
            source: 'range'
        })
    })
})

describe('parseAffectedRange — maven-style interval notation', function () {
    it('reads an open lower bound', function () {
        expect(parseAffectedRange('(,4.1.2)', [])).toEqual({
            ranges: [{ introduced: '0', fixed: '4.1.2' }],
            versions: [],
            source: 'range'
        })
    })

    it('reads a fully bounded interval', function () {
        expect(parseAffectedRange('[1.0.0,2.0.0)', [])).toEqual({
            ranges: [{ introduced: '1.0.0', fixed: '2.0.0' }],
            versions: [],
            source: 'range'
        })
    })

    it('reads an open upper bound as unfixed', function () {
        expect(parseAffectedRange('[1.0.0,)', [])).toEqual({
            ranges: [{ introduced: '1.0.0', fixed: null }],
            versions: [],
            source: 'range'
        })
    })

    it('reads a comma-less interval as an exact version', function () {
        expect(parseAffectedRange('[1.2.3]', [])).toEqual({ ranges: [], versions: ['1.2.3'], source: 'range' })
    })

    it('accepts a closing square bracket as well as a paren', function () {
        expect(parseAffectedRange('[1.0.0,2.0.0]', [])).toEqual({
            ranges: [{ introduced: '1.0.0', fixed: '2.0.0' }],
            versions: [],
            source: 'range'
        })
    })

    // An unterminated interval is unparseable rather than unbounded. Dropping it loses one advisory;
    // guessing at it could flag every version of the package.
    it('drops an unterminated interval instead of guessing', function () {
        expect(parseAffectedRange('(1.0.0', [])).toEqual({ ranges: [], versions: [], source: 'unresolved' })
        expect(parseAffectedRange('[1.0.0', [])).toEqual({ ranges: [], versions: [], source: 'unresolved' })
    })

    it('drops an empty interval', function () {
        expect(parseAffectedRange('[]', [])).toEqual({ ranges: [], versions: [], source: 'unresolved' })
    })
})

describe('parseAffectedRange — authoritative fixed_versions override', function () {
    // This is the whole reason the override exists. "<=2.0.0" means 2.0.0 IS affected, but a half-open
    // [introduced, fixed) interval cannot say that without naming 2.0.0's successor — which the
    // comparator string does not know and fixed_versions does.
    it('repairs <=X using the real fix version', function () {
        expect(parseAffectedRange('<=2.0.0', ['2.0.1'])).toEqual({
            ranges: [{ introduced: '0', fixed: '2.0.1' }],
            versions: [],
            source: 'range'
        })
    })

    // Without the override, <=X under-includes X itself. That is documented and deliberate: it misses
    // exactly one version, where a null upper bound would flag every future version forever.
    it('falls back to the bound itself when no fix is known', function () {
        expect(parseAffectedRange('<=2.0.0', [])).toEqual({
            ranges: [{ introduced: '0', fixed: '2.0.0' }],
            versions: [],
            source: 'range'
        })
    })

    it('overrides a parsed upper bound that disagrees with the recorded fix', function () {
        expect(parseAffectedRange('<4.17.12', ['4.17.21'])).toEqual({
            ranges: [{ introduced: '0', fixed: '4.17.21' }],
            versions: [],
            source: 'range'
        })
    })

    it('preserves the lower bound while overriding the upper', function () {
        expect(parseAffectedRange('>=4.0.0 <4.0.1', ['4.0.9'])).toEqual({
            ranges: [{ introduced: '4.0.0', fixed: '4.0.9' }],
            versions: [],
            source: 'range'
        })
    })

    // REGRESSION. `fixed_versions` is an UNORDERED set with one fix per release branch, so on a
    // multi-branch advisory `fixed_versions[0]` is an arbitrary pick. Applying it to a single interval
    // claims every version below some OTHER branch's fix is vulnerable — which is how a correctly-parsed
    // `>=7.5.0 <7.6.5` would have become `>=7.5.0 <8.6.6`. One entry is the only safe case.
    it('does not override when several branch fixes are listed', function () {
        expect(parseAffectedRange('>=7.5.0 <7.6.5', ['7.6.5', '8.6.6'])).toEqual({
            ranges: [{ introduced: '7.5.0', fixed: '7.6.5' }],
            versions: [],
            source: 'range'
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
            versions: [],
            source: 'range'
        })
    })

    it('does not override when enumerated versions are also present', function () {
        expect(parseAffectedRange('<2.0.0 || 3.0.0', ['9.9.9'])).toEqual({
            ranges: [{ introduced: '0', fixed: '2.0.0' }],
            versions: ['3.0.0'],
            source: 'range'
        })
    })

    it('does not override an exact pin', function () {
        expect(parseAffectedRange('[1.2.3]', ['2.0.0'])).toEqual({ ranges: [], versions: ['1.2.3'], source: 'range' })
    })
})
