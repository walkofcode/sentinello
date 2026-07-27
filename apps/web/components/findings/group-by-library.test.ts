import { describe, expect, it } from 'vitest'
import type { CurrentFindingRow } from '@sentinello/db'
import { compareVersions, groupByLibrary } from './group-by-library'

function row(overrides: Partial<CurrentFindingRow> = {}): CurrentFindingRow {
    return {
        id: 'finding-1',
        scanId: 'scan-1',
        projectId: 'project-1',
        scanner: 'npm-audit',
        source: 'npm-audit',
        ecosystem: 'npm',
        advisoryId: 'GHSA-1',
        advisoryTitle: null,
        advisoryUrl: null,
        packageName: 'lodash',
        installedVersion: '4.17.20',
        vulnerableRange: '<4.17.21',
        severity: 'high',
        fixAvailable: false,
        fixVersion: null,
        depPathJson: '[]',
        isMuted: false,
        isProd: true,
        isDev: false,
        firstDetectedAt: null,
        lastSeenAt: null,
        ...overrides
    }
}

describe('groupByLibrary', function () {
    it('collapses several advisories on one package into a single group', function () {
        const groups = groupByLibrary([row({ advisoryId: 'GHSA-1' }), row({ advisoryId: 'GHSA-2' })])
        expect(groups).toHaveLength(1)
        expect(groups[0]?.advisoryCount).toBe(2)
        expect(groups[0]?.findings).toHaveLength(2)
    })

    // The ecosystem is part of the grouping key, so an npm `requests` and a PyPI `requests` stay
    // distinct libraries rather than merging into one bogus row.
    it('keeps the same package name in different ecosystems apart', function () {
        const groups = groupByLibrary([
            row({ packageName: 'requests', ecosystem: 'npm' }),
            row({ packageName: 'requests', ecosystem: 'PyPI' })
        ])
        expect(groups).toHaveLength(2)
    })

    it('collects the distinct installed versions', function () {
        const groups = groupByLibrary([
            row({ installedVersion: '4.17.20' }),
            row({ installedVersion: '4.17.19' }),
            row({ installedVersion: '4.17.20' })
        ])
        expect(groups[0]?.installedVersions).toEqual(['4.17.20', '4.17.19'])
    })

    it('collects the distinct severities and reports the highest', function () {
        const groups = groupByLibrary([
            row({ severity: 'low' }),
            row({ severity: 'critical' }),
            row({ severity: 'low' })
        ])
        expect(groups[0]?.severities).toEqual(['low', 'critical'])
        expect(groups[0]?.maxSeverity).toBe('critical')
    })

    it('counts only findings that have both a fix flag and a fix version', function () {
        const groups = groupByLibrary([
            row({ fixAvailable: true, fixVersion: '4.17.21' }),
            row({ fixAvailable: true, fixVersion: null }),
            row({ fixAvailable: false, fixVersion: '4.17.21' })
        ])
        expect(groups[0]?.fixedCount).toBe(1)
    })

    // `partial` drives the "some of these cannot be fixed by upgrading" disclosure, so it must be true
    // whenever ANY finding lacks a fix.
    it('marks a group partial when any finding lacks a fix', function () {
        const groups = groupByLibrary([
            row({ fixAvailable: true, fixVersion: '4.17.21' }),
            row({ fixAvailable: false, fixVersion: null })
        ])
        expect(groups[0]?.partial).toBe(true)
    })

    it('does not mark a group partial when every finding has a fix', function () {
        const groups = groupByLibrary([
            row({ fixAvailable: true, fixVersion: '4.17.21' }),
            row({ fixAvailable: true, fixVersion: '4.17.22' })
        ])
        expect(groups[0]?.partial).toBe(false)
    })

    it('recommends the highest fix version across the group', function () {
        const groups = groupByLibrary([
            row({ fixAvailable: true, fixVersion: '4.17.9' }),
            row({ fixAvailable: true, fixVersion: '4.17.21' }),
            row({ fixAvailable: true, fixVersion: '4.17.10' })
        ])
        expect(groups[0]?.recommendedUpgrade).toBe('4.17.21')
    })

    it('recommends nothing when no finding carries a fix version', function () {
        expect(groupByLibrary([row()])[0]?.recommendedUpgrade).toBeNull()
    })

    it('marks a group muted only when every finding is muted', function () {
        expect(groupByLibrary([row({ isMuted: true }), row({ isMuted: true })])[0]?.allMuted).toBe(true)
        expect(groupByLibrary([row({ isMuted: true }), row({ isMuted: false })])[0]?.allMuted).toBe(false)
    })

    // Mirrors the per-row chip rule exactly: dev-only means isDev AND NOT isProd, for every finding.
    it('marks a group dev-only only when every finding is dev and not prod', function () {
        expect(groupByLibrary([row({ isDev: true, isProd: false })])[0]?.devOnly).toBe(true)
        expect(groupByLibrary([row({ isDev: true, isProd: true })])[0]?.devOnly).toBe(false)
        expect(
            groupByLibrary([row({ isDev: true, isProd: false }), row({ isDev: false, isProd: true })])[0]?.devOnly
        ).toBe(false)
    })

    it('sorts the most severe group first', function () {
        const groups = groupByLibrary([
            row({ packageName: 'a', severity: 'low' }),
            row({ packageName: 'b', severity: 'critical' }),
            row({ packageName: 'c', severity: 'moderate' })
        ])
        expect(groups.map(function name(g) { return g.packageName })).toEqual(['b', 'c', 'a'])
    })

    it('breaks a severity tie by package name', function () {
        const groups = groupByLibrary([
            row({ packageName: 'zeta', severity: 'high' }),
            row({ packageName: 'alpha', severity: 'high' })
        ])
        expect(groups.map(function name(g) { return g.packageName })).toEqual(['alpha', 'zeta'])
    })

    it('returns nothing for no findings', function () {
        expect(groupByLibrary([])).toEqual([])
    })
})

describe('compareVersions', function () {
    it.each([
        ['1.0.1', '1.0.0'],
        ['1.1.0', '1.0.9'],
        ['2.0.0', '1.99.99'],
        ['1.0.10', '1.0.9'],
        ['1.0.0', '1.0.0-beta'],
        ['1.0.0-beta', '1.0.0-alpha'],
        ['1.0.1', '1.0'],
        ['v2.0.0', '1.0.0']
    ] as Array<[string, string]>)('ranks %s above %s', function (higher, lower) {
        expect(compareVersions(higher, lower)).toBeGreaterThan(0)
        expect(compareVersions(lower, higher)).toBeLessThan(0)
    })

    it.each([
        ['1.0.0', '1.0.0'],
        ['1.0.0', 'v1.0.0'],
        ['1.0.0', '=1.0.0'],
        ['1.0', '1.0.0'],
        ['1.0.0-beta', '1.0.0-beta']
    ] as Array<[string, string]>)('ranks %s equal to %s', function (a, b) {
        expect(compareVersions(a, b)).toBe(0)
    })

    // Numeric comparison per segment, so a double-digit patch must not lose to a single digit the way
    // a string compare would.
    it('compares segments numerically rather than lexically', function () {
        expect(compareVersions('1.0.10', '1.0.9')).toBeGreaterThan(0)
    })

    it('treats an unparseable segment as zero', function () {
        expect(compareVersions('1.x.0', '1.0.0')).toBe(0)
    })
})
