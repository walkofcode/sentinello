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

    it('coerces loose but recognisable versions rather than giving up', function () {
        // 'v3.0.0' coerces to 3.0.0, which is outside the range, so this one is safely droppable.
        expect(keptIds([finding('v3.0.0', '>=1.0.0 <2.0.0')])).toEqual([])
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
