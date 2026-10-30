import { describe, expect, it } from 'vitest'
import { patchedVersionSet, versionSetFromSemverRange, type AffectedSet, type FixEvidence } from '@sentinello/scanners'
import { pickReleasedFix, type PublishedVersion } from './settle'

// pickReleasedFix decides "is this a released fix" from the registry's version list and every source's
// evidence. Its three answers are not interchangeable: `released` sends someone to install a version,
// `none` tells them no upgrade exists, and `unknown` admits the inputs could not prove either. Turning an
// unknown into either of the other two is the defect class this replaces — a guessed version is how agents
// chased braces 3.0.4 — so most cases below pin where `unknown` must win.

function published(...versions: string[]): PublishedVersion[] {
    return versions.map(function toPublished(version) {
        return { version, deprecated: false }
    })
}

// An affected set written the way npm audit states one: a node-semver range, or none for an exact-only set.
function affected(ranges: string | null = '<1.1.0', overrides: Partial<AffectedSet> = {}): AffectedSet {
    const base: AffectedSet = ranges === null ? { comparator: 'semver', ranges: [], exact: [], complete: true } : versionSetFromSemverRange(ranges)
    return { ...base, ...overrides }
}

function evidence(overrides: Partial<FixEvidence> = {}): FixEvidence {
    return { source: 'osv', installed: ['1.0.0'], affected: affected(), patched: null, patchedSet: null, statedFix: null, fixViaParent: false, ...overrides }
}

describe('pickReleasedFix — released', function () {
    it('picks the lowest published version outside the affected set', function () {
        expect(pickReleasedFix({ published: published('1.0.0', '1.1.0', '1.2.0'), evidence: [evidence()], installed: ['1.0.0'] }))
            .toEqual({ kind: 'released', version: '1.1.0' })
    })

    // Noah's issue-004 fixture: a mixed advisory, `<1.1.0` plus exact 1.1.0. 1.1.0 is outside the range but
    // listed, so it is affected; the fix is 1.2.0.
    it('rejects an exact affected version that lies outside the ranges', function () {
        const mixed = evidence({ affected: affected('>=0.0.0 <1.1.0', { exact: ['1.1.0'] }) })
        expect(pickReleasedFix({ published: published('1.0.0', '1.1.0', '1.2.0'), evidence: [mixed], installed: ['1.0.0'] }))
            .toEqual({ kind: 'released', version: '1.2.0' })
    })

    // Exact versions are compared normalized, the way the matcher compared them.
    it('normalizes exact versions before comparing', function () {
        const mixed = evidence({ affected: affected('<1.1.0', { exact: ['v1.1.0'] }) })
        expect(pickReleasedFix({ published: published('1.1.0', '1.2.0'), evidence: [mixed], installed: ['1.0.0'] }))
            .toEqual({ kind: 'released', version: '1.2.0' })
    })

    // Exact-only: no ranges at all; the next published version that is not listed qualifies.
    it('handles an exact-only advisory', function () {
        const exactOnly = evidence({ installed: ['4.4.2'], affected: affected(null, { exact: ['4.4.2', '4.4.3'] }) })
        expect(pickReleasedFix({ published: published('4.4.1', '4.4.2', '4.4.3', '4.4.4'), evidence: [exactOnly], installed: ['4.4.2'] }))
            .toEqual({ kind: 'released', version: '4.4.4' })
    })

    // The fix must clear every source's affected set, so the answer does not depend on which source ran
    // first: npm-audit `<1.1.0` and OSV `<1.2.0` agree only on 1.2.0.
    it('is outside every source’s affected set, in either order', function () {
        const npm = evidence({ source: 'npm-audit', affected: affected('<1.1.0') })
        const osv = evidence({ source: 'osv', affected: affected('<1.2.0') })
        const versions = published('1.0.0', '1.1.0', '1.2.0')
        expect(pickReleasedFix({ published: versions, evidence: [npm, osv], installed: ['1.0.0'] })).toEqual({ kind: 'released', version: '1.2.0' })
        expect(pickReleasedFix({ published: versions, evidence: [osv, npm], installed: ['1.0.0'] })).toEqual({ kind: 'released', version: '1.2.0' })
    })

    // Every installed copy is a floor: a second copy at 1.1.5 must not be told to go back to 1.1.0.
    it('never goes below the highest installed copy', function () {
        expect(pickReleasedFix({ published: published('1.1.0', '1.1.5', '1.2.0'), evidence: [evidence({ affected: affected('<1.0.5') })], installed: ['1.0.0', '1.1.5'] }))
            .toEqual({ kind: 'released', version: '1.1.5' })
    })

    it('skips prereleases and versions that are not semver', function () {
        expect(pickReleasedFix({ published: published('1.1.0-rc.1', 'not-a-version', '1.1.1'), evidence: [evidence()], installed: ['1.0.0'] }))
            .toEqual({ kind: 'released', version: '1.1.1' })
    })

    it('prefers a non-deprecated version, falling back to a deprecated one', function () {
        const versions: PublishedVersion[] = [
            { version: '1.1.0', deprecated: true },
            { version: '1.2.0', deprecated: false }
        ]
        expect(pickReleasedFix({ published: versions, evidence: [evidence()], installed: ['1.0.0'] })).toEqual({ kind: 'released', version: '1.2.0' })
        expect(pickReleasedFix({ published: [{ version: '1.1.0', deprecated: true }], evidence: [evidence()], installed: ['1.0.0'] }))
            .toEqual({ kind: 'released', version: '1.1.0' })
    })

    // Unsorted registry order must not change the answer.
    it('does not depend on the order the registry lists versions in', function () {
        expect(pickReleasedFix({ published: published('1.3.0', '1.1.0', '1.2.0'), evidence: [evidence()], installed: ['1.0.0'] }))
            .toEqual({ kind: 'released', version: '1.1.0' })
    })

    // A genuine patched range is a constraint: 1.1.0 clears the vulnerable range but is not blessed.
    it('stays inside every stated patched range', function () {
        expect(pickReleasedFix({ published: published('1.1.0', '1.2.0'), evidence: [evidence({ patched: '>=1.2.0', patchedSet: patchedVersionSet('>=1.2.0') })], installed: ['1.0.0'] }))
            .toEqual({ kind: 'released', version: '1.2.0' })
    })

    // pnpm's `<0.0.0` says "no patched version"; it is provenance, not a range that would exclude everything.
    it('treats the <0.0.0 sentinel as no constraint', function () {
        expect(pickReleasedFix({ published: published('1.1.0'), evidence: [evidence({ patched: '<0.0.0', patchedSet: patchedVersionSet('<0.0.0') })], installed: ['1.0.0'] }))
            .toEqual({ kind: 'released', version: '1.1.0' })
        expect(pickReleasedFix({ published: published('1.1.0'), evidence: [evidence({ patched: '  ', patchedSet: patchedVersionSet('  ') })], installed: ['1.0.0'] }))
            .toEqual({ kind: 'released', version: '1.1.0' })
    })
})

describe('pickReleasedFix — none', function () {
    // braces 3.0.3, GHSA-vfj7-8cjw-p6xm, as the registry stood on 2026-10-03: nothing above 3.0.3 exists.
    it('answers none for braces <=3.0.3', function () {
        const braces = evidence({ installed: ['3.0.3'], affected: affected('>=0.0.0 <=3.0.3') })
        expect(pickReleasedFix({ published: published('3.0.0', '3.0.1', '3.0.2', '3.0.3'), evidence: [braces], installed: ['3.0.3'] }))
            .toEqual({ kind: 'none' })
    })

    // Malware with no version data is `*`: every version is affected, the way out is removal.
    it('answers none when every version is affected', function () {
        expect(pickReleasedFix({ published: published('1.0.0', '2.0.0'), evidence: [evidence({ affected: affected('*') })], installed: ['1.0.0'] }))
            .toEqual({ kind: 'none' })
    })

    it('answers none when the registry lists nothing usable', function () {
        expect(pickReleasedFix({ published: [], evidence: [evidence()], installed: ['1.0.0'] })).toEqual({ kind: 'none' })
    })

    // The sentinel adds no constraint, but it does not by itself make the answer `none` either.
    it('answers none from the versions, not from the sentinel', function () {
        expect(pickReleasedFix({ published: published('1.0.0'), evidence: [evidence({ patched: '<0.0.0', patchedSet: patchedVersionSet('<0.0.0') })], installed: ['1.0.0'] }))
            .toEqual({ kind: 'none' })
    })
})

describe('pickReleasedFix — unknown, never a guess', function () {
    it('answers unknown with no evidence', function () {
        expect(pickReleasedFix({ published: published('2.0.0'), evidence: [], installed: ['1.0.0'] }))
            .toEqual({ kind: 'unknown', reason: 'no_evidence' })
    })

    it('answers unknown when no installed version is known', function () {
        expect(pickReleasedFix({ published: published('2.0.0'), evidence: [evidence()], installed: [] }))
            .toEqual({ kind: 'unknown', reason: 'installed_unknown' })
    })

    // npm-audit falls back to the vulnerable range when it has no lockfile; that is not a version.
    it('answers unknown when an installed version does not parse', function () {
        expect(pickReleasedFix({ published: published('2.0.0'), evidence: [evidence()], installed: ['1.0.0', '<=3.0.3'] }))
            .toEqual({ kind: 'unknown', reason: 'installed_unknown' })
    })

    // A dropped or unparseable range could hide the very version a candidate is: incomplete is unknown.
    it('answers unknown when any evidence is incomplete', function () {
        const incomplete = evidence({ affected: affected('<1.1.0', { complete: false }) })
        expect(pickReleasedFix({ published: published('2.0.0'), evidence: [evidence(), incomplete], installed: ['1.0.0'] }))
            .toEqual({ kind: 'unknown', reason: 'affected_incomplete' })
    })

    // Absent ranges (exact-only) are fine; ranges that are present but invalid are not.
    it('distinguishes absent ranges from invalid ones', function () {
        const absent = evidence({ affected: affected(null, { exact: ['1.0.0'] }) })
        const invalid = evidence({ affected: affected('not a range') })
        expect(pickReleasedFix({ published: published('1.0.1'), evidence: [absent], installed: ['1.0.0'] })).toEqual({ kind: 'released', version: '1.0.1' })
        expect(pickReleasedFix({ published: published('1.0.1'), evidence: [invalid], installed: ['1.0.0'] })).toEqual({ kind: 'unknown', reason: 'affected_incomplete' })
    })

    it('answers unknown when an exact version cannot be normalized', function () {
        const unreadable = evidence({ affected: affected('<1.1.0', { exact: ['not-a-version'] }) })
        expect(pickReleasedFix({ published: published('2.0.0'), evidence: [unreadable], installed: ['1.0.0'] }))
            .toEqual({ kind: 'unknown', reason: 'affected_incomplete' })
    })

    it('answers unknown when a patched range does not parse', function () {
        expect(pickReleasedFix({ published: published('2.0.0'), evidence: [evidence({ patched: 'fixed in the next release', patchedSet: patchedVersionSet('fixed in the next release') })], installed: ['1.0.0'] }))
            .toEqual({ kind: 'unknown', reason: 'patched_unparseable' })
    })
})

// issue 011: a candidate is compared in normalized form, the way the exact entries were — `v1.2.1` and
// `1.2.1+build` are the release 1.2.1 and must not slip past an exact entry for it.
describe('pickReleasedFix — alternate spellings of an affected version', function () {
    const exactOnly: AffectedSet = affected(null, { exact: ['1.2.1'] })

    it('never returns a prefixed or build-tagged spelling of an affected version', function () {
        const e = evidence({ installed: ['1.2.1'], affected: exactOnly })
        expect(pickReleasedFix({ published: published('v1.2.1', '1.2.1+build.7', '1.2.2'), evidence: [e], installed: ['1.2.1'] }))
            .toEqual({ kind: 'released', version: '1.2.2' })
    })

    it('returns the registry spelling of the version it chose', function () {
        const e = evidence({ installed: ['1.2.1'], affected: exactOnly })
        expect(pickReleasedFix({ published: published('v1.2.3'), evidence: [e], installed: ['1.2.1'] }))
            .toEqual({ kind: 'released', version: 'v1.2.3' })
    })
})

// The affected sets the OSV matcher hands over (matcher.test.ts pins how it writes them): the rule must
// read each as the matcher meant it.
describe('pickReleasedFix — over the matcher\'s evidence', function () {
    it('clears a partial exclusive lower bound written out in full', function () {
        const inputs = evidence({ installed: ['1.2.1'], affected: affected('>1.2.0 <2.0.0') })
        expect(pickReleasedFix({ published: published('1.2.1', '2.0.0'), evidence: [inputs], installed: ['1.2.1'] })).toEqual({ kind: 'released', version: '2.0.0' })
    })

    // issue 010: malware with no version data affects every version; malware whose ranges were dropped is
    // unknown — never "no fix".
    it('settles complete malware to none and incomplete malware to unknown', function () {
        const none = evidence({ installed: ['1.2.1'], affected: affected('*') })
        expect(pickReleasedFix({ published: published('2.0.0'), evidence: [none], installed: ['1.2.1'] })).toEqual({ kind: 'none' })
        const dropped = evidence({ installed: ['1.2.1'], affected: affected('*', { complete: false }) })
        expect(pickReleasedFix({ published: published('2.0.0'), evidence: [dropped], installed: ['1.2.1'] })).toEqual({ kind: 'unknown', reason: 'affected_incomplete' })
    })
})

// Every comparison is the finding's own comparator's, and so is the question of which versions may be a
// fix at all.
describe('pickReleasedFix — in the ecosystem\'s own comparator', function () {
    function goEvidence(fixed: string, statedFix: string | null = fixed): FixEvidence {
        const set: AffectedSet = { comparator: 'go', ranges: [{ introduced: '0', fixed, lastAffected: null }], exact: [], complete: true }
        return { source: 'osv', installed: ['v0.0.0-20200101000000-aaaaaaaaaaaa'], affected: set, patched: null, patchedSet: null, statedFix, fixViaParent: false }
    }

    // Some Go modules are only ever fixed in a commit. A pseudo-version the advisory states, in `published`
    // because the registry confirmed it, is the fix.
    it('admits a Go pseudo-version the advisory states', function () {
        const fix = 'v0.0.0-20210101000000-abcdefabcdef'
        expect(pickReleasedFix({ published: published(fix, 'v0.1.0'), evidence: [goEvidence('0.0.0-20210101000000-abcdefabcdef')], installed: ['v0.0.0-20200101000000-aaaaaaaaaaaa'] }))
            .toEqual({ kind: 'released', version: fix })
    })

    // Stated as a `fixed` bound alone counts too: the affected set is the advisory's own statement.
    it('admits one stated only as a fixed bound', function () {
        const fix = 'v0.0.0-20210101000000-abcdefabcdef'
        expect(pickReleasedFix({ published: published(fix), evidence: [goEvidence('0.0.0-20210101000000-abcdefabcdef', null)], installed: ['v0.0.0-20200101000000-aaaaaaaaaaaa'] }))
            .toEqual({ kind: 'released', version: fix })
    })

    // A commit nobody named is not a release, and a tagged prerelease never is.
    it('skips a pseudo-version nobody stated, and every tagged prerelease', function () {
        const evidence = [goEvidence('0.1.0')]
        expect(pickReleasedFix({ published: published('v0.1.1-0.20210101000000-abcdefabcdef', 'v0.2.0-rc.1', 'v0.2.0'), evidence, installed: ['v0.0.1'] }))
            .toEqual({ kind: 'released', version: 'v0.2.0' })
        expect(pickReleasedFix({ published: published('v0.2.0-rc.1', 'v0.2.0-0.20210101000000-abcdefabcdef'), evidence, installed: ['v0.0.1'] })).toEqual({ kind: 'none' })
    })

    // PEP 440: 4.2.11 above 4.2.10 above 3.2.23, a post-release above its release, a dev release a
    // prerelease. Under semver none of these orders the same way.
    it('orders and filters PyPI versions by PEP 440', function () {
        const set: AffectedSet = { comparator: 'pep440', ranges: [{ introduced: '4.2', fixed: '4.2.11', lastAffected: null }], exact: [], complete: true }
        const evidence: FixEvidence = { source: 'osv', installed: ['4.2'], affected: set, patched: null, patchedSet: null, statedFix: '4.2.11', fixViaParent: false }
        expect(pickReleasedFix({ published: published('3.2.23', '4.2.10.post1', '4.2.11.dev1', '4.2.11rc1', '4.2.11', '5.0'), evidence: [evidence], installed: ['4.2'] }))
            .toEqual({ kind: 'released', version: '4.2.11' })
        expect(pickReleasedFix({ published: published('4.2.0'), evidence: [evidence], installed: ['4.2'] })).toEqual({ kind: 'none' })
    })

    it('answers installed_unknown for an install its comparator cannot read', function () {
        expect(pickReleasedFix({ published: published('v1.0.0'), evidence: [goEvidence('1.0.0')], installed: ['1.2'] })).toEqual({ kind: 'unknown', reason: 'installed_unknown' })
    })

    // A finding's identity includes its ecosystem; evidence in two comparators is a grouping defect.
    it('fails loudly on evidence in two comparators', function () {
        expect(function mixed() { return pickReleasedFix({ published: published('1.1.0'), evidence: [evidence(), goEvidence('1.0.0')], installed: ['1.0.0'] }) })
            .toThrow('fix evidence mixes comparators: semver and go')
    })
})

// gemnasium states PyPI ranges as PEP 440 specifiers, which ignore a candidate's local label; OSV states
// intervals of the order, where a local build sorts above its public version. Settlement applies the same
// rule the matcher did, so the fix it names is never a version the finding's own source still covers
// (SENTINEL-127).
describe('pickReleasedFix — PEP 440 specifier semantics', function () {
    function pep440Evidence(source: string, specifier: AffectedSet['specifier']): FixEvidence {
        const set: AffectedSet = { comparator: 'pep440', ranges: [{ introduced: '0', fixed: null, lastAffected: '2.2.0' }], exact: [], complete: true }
        if (specifier !== undefined) set.specifier = specifier
        return { source, installed: ['2.1.0'], affected: set, patched: null, patchedSet: null, statedFix: null, fixViaParent: false }
    }

    it('never names a local build of a version a public specifier covers', function () {
        const versions = published('2.2.0+cu118', '2.2.1')
        expect(pickReleasedFix({ published: versions, evidence: [pep440Evidence('gemnasium', 'pep440')], installed: ['2.1.0'] }))
            .toEqual({ kind: 'released', version: '2.2.1' })
        // Under the ordering, the local build is above `<=2.2.0`, so it is outside the set.
        expect(pickReleasedFix({ published: versions, evidence: [pep440Evidence('osv', undefined)], installed: ['2.1.0'] }))
            .toEqual({ kind: 'released', version: '2.2.0+cu118' })
    })
})

// A part of the source's range the normalizer refused is unknown, so the rest of the set cannot prove a
// candidate safe (SENTINEL-132): gemnasium `<1.0 || ~=2.0` kept `~=2.0` as a refused part, and 2.0 — inside
// that branch — must not come back as the fix.
describe('pickReleasedFix — a refused part of the affected set', function () {
    it('answers unknown rather than proving a version inside the refused branch safe', function () {
        const set: AffectedSet = {
            comparator: 'pep440',
            ranges: [{ introduced: '0', fixed: '1.0', lastAffected: null }, { introduced: '~=2.0', fixed: null, lastAffected: null, refused: '~=2.0' }],
            exact: [],
            complete: false
        }
        const evidence: FixEvidence = { source: 'gemnasium', installed: ['0.5'], affected: set, patched: null, patchedSet: null, statedFix: null, fixViaParent: false }
        expect(pickReleasedFix({ published: published('2.0'), evidence: [evidence], installed: ['0.5'] })).toEqual({ kind: 'unknown', reason: 'affected_incomplete' })
        // Even a set that claimed completeness cannot be evaluated with a refused part in it.
        expect(pickReleasedFix({ published: published('2.0'), evidence: [{ ...evidence, affected: { ...set, complete: true } }], installed: ['0.5'] }))
            .toEqual({ kind: 'unknown', reason: 'affected_incomplete' })
    })
})

describe('pickReleasedFix — stated fixes it cannot read', function () {
    // An unreadable stated fix admits nothing; the rest of the evidence still settles.
    it('ignores a stated fix its comparator cannot read', function () {
        expect(pickReleasedFix({ published: published('1.1.0'), evidence: [evidence({ statedFix: 'next release' })], installed: ['1.0.0'] }))
            .toEqual({ kind: 'released', version: '1.1.0' })
    })
})
