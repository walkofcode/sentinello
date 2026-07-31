import { describe, expect, it } from 'vitest'
import { filterFindingsByLockfileResolution } from './lockfile-cross-check'
import type { RawFinding } from './types'

function finding(installedVersion: string, vulnerableRange: string, advisoryId = 'GHSA-1'): RawFinding {
    return {
        advisoryId,
        advisoryTitle: null,
        advisoryUrl: null,
        packageName: 'lodash',
        installedVersion,
        vulnerableRange,
        severity: 'high',
        fixAvailable: false,
        fixVersion: null,
        depPath: [],
        isProd: true,
        isDev: false
    }
}

function keptIds(findings: RawFinding[]): string[] {
    return filterFindingsByLockfileResolution(findings).kept.map(function id(f) {
        return f.advisoryId
    })
}

describe('filterFindingsByLockfileResolution — the real signal', function () {
    it('keeps a finding whose installed version is inside the vulnerable range', function () {
        expect(keptIds([finding('1.5.0', '>=1.0.0 <2.0.0')])).toEqual(['GHSA-1'])
    })

    // This is the false positive the cross-check exists to remove: the audit tool matched the
    // declared spec, but an override moved the actual install to a safe version.
    it('drops a finding whose installed version is definitively outside the range', function () {
        const result = filterFindingsByLockfileResolution([finding('3.0.0', '>=1.0.0 <2.0.0')])
        expect(result.kept).toEqual([])
        expect(result.droppedCount).toBe(1)
        expect(result.droppedAdvisoryIds).toEqual(['GHSA-1'])
    })

    it('reports kept and dropped counts that account for every input', function () {
        const result = filterFindingsByLockfileResolution([
            finding('1.5.0', '>=1.0.0 <2.0.0', 'IN'),
            finding('9.0.0', '>=1.0.0 <2.0.0', 'OUT')
        ])
        expect(result.kept).toHaveLength(1)
        expect(result.droppedCount).toBe(1)
        expect(result.kept.length + result.droppedCount).toBe(2)
    })
})

describe('filterFindingsByLockfileResolution — fail-open on uncertainty', function () {
    // Every branch below keeps the finding. Dropping one we cannot reason about would silently
    // swallow a real vulnerability, which is strictly worse than showing a false positive.
    it('keeps when the installed version is empty', function () {
        expect(keptIds([finding('', '>=1.0.0 <2.0.0')])).toEqual(['GHSA-1'])
        expect(keptIds([finding('   ', '>=1.0.0 <2.0.0')])).toEqual(['GHSA-1'])
    })

    it('keeps when the vulnerable range is empty', function () {
        expect(keptIds([finding('1.5.0', '')])).toEqual(['GHSA-1'])
    })

    it('keeps when the vulnerable range is unparseable', function () {
        expect(keptIds([finding('1.5.0', 'not a range at all')])).toEqual(['GHSA-1'])
    })

    it('keeps when the installed version is not coercible to semver', function () {
        expect(keptIds([finding('git+ssh://example.test/repo.git', '>=1.0.0 <2.0.0')])).toEqual(['GHSA-1'])
        expect(keptIds([finding('workspace:*', '>=1.0.0 <2.0.0')])).toEqual(['GHSA-1'])
        expect(keptIds([finding('file:../local', '>=1.0.0 <2.0.0')])).toEqual(['GHSA-1'])
    })

    // A lockfile can name a package manager's own idea of a version. semver.valid already accepts the
    // 'v' prefix, so 'v3.0.0' never reaches coerce at all; '3.0' does, and is the case that proves the
    // coercion path rather than the strict one.
    it('accepts a v-prefixed version directly', function () {
        expect(keptIds([finding('v3.0.0', '>=1.0.0 <2.0.0')])).toEqual([])
    })

    it('coerces a partial version rather than giving up', function () {
        // '3.0' is not strict semver; coerced to 3.0.0 it sits outside the range, so it is droppable.
        expect(keptIds([finding('3.0', '>=1.0.0 <2.0.0')])).toEqual([])
        // And the same shape inside the range is kept, so the coercion is not just always-drop.
        expect(keptIds([finding('1.5', '>=1.0.0 <2.0.0')])).toEqual(['GHSA-1'])
    })

    // The hoisted-duplicate format is a comma-joined list. A degenerate one that lists no versions at
    // all leaves nothing to compare, which is uncertainty like any other.
    it('keeps when the version list has no entries', function () {
        expect(keptIds([finding(',', '>=1.0.0 <2.0.0')])).toEqual(['GHSA-1'])
    })

    // Regression guard for a silent false negative. When npm-audit cannot resolve a concrete installed
    // version — a lockfileVersion 1 package-lock, an unreadable one, or one the schema rejects —
    // pickInstalledVersion falls back to the vulnerability's own RANGE, so `installedVersion` arrives
    // here as something like '<4.17.21'. coerce() then reads that as the version 4.17.21, which is the
    // first FIXED version rather than anything installed, concludes it sits outside its own vulnerable
    // range, and drops the finding. The scan then reports status ok with zero findings — a clean bill of
    // health for a vulnerable project, which is precisely the outcome the fail-open rule exists to
    // prevent. A range is not a version; it is the absence of one.
    it('keeps when the installed version is a range expression rather than a version', function () {
        expect(keptIds([finding('<4.17.21', '<4.17.21')])).toEqual(['GHSA-1'])
    })

    it.each([
        ['a less-than comparator', '<2.0.0'],
        ['a compound comparator', '>=1.0.0 <2.0.0'],
        ['a caret range', '^1.5.0'],
        ['a tilde range', '~1.5.0'],
        ['a wildcard patch', '1.5.x'],
        ['a union', '1.5.0 || 3.0.0'],
        ['a hyphen range', '1.0.0 - 1.9.0'],
        ['a bare star', '*']
    ])('keeps when the installed version is %s', function (_label, installed) {
        expect(keptIds([finding(installed as string, '>=1.0.0 <2.0.0')])).toEqual(['GHSA-1'])
    })
})

describe('filterFindingsByLockfileResolution — hoisted duplicate installs', function () {
    // npm hoisting can leave several copies at different versions, joined with ", ".
    it('keeps the finding when any single copy is vulnerable', function () {
        expect(keptIds([finding('3.0.0, 1.5.0', '>=1.0.0 <2.0.0')])).toEqual(['GHSA-1'])
    })

    it('drops only when every copy is outside the range', function () {
        expect(keptIds([finding('3.0.0, 4.0.0', '>=1.0.0 <2.0.0')])).toEqual([])
    })

    // One unreadable copy is enough uncertainty to keep the whole finding.
    it('keeps the finding when any copy is unparseable', function () {
        expect(keptIds([finding('3.0.0, workspace:*', '>=1.0.0 <2.0.0')])).toEqual(['GHSA-1'])
    })

    it('tolerates whitespace around the separator', function () {
        expect(keptIds([finding('3.0.0,1.5.0', '>=1.0.0 <2.0.0')])).toEqual(['GHSA-1'])
    })
})

describe('filterFindingsByLockfileResolution — prerelease handling', function () {
    // includePrerelease is on, so a prerelease inside the window still counts as vulnerable.
    it('treats a prerelease inside the range as vulnerable', function () {
        expect(keptIds([finding('1.5.0-beta.1', '>=1.0.0 <2.0.0')])).toEqual(['GHSA-1'])
    })
})
