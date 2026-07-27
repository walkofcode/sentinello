import { describe, expect, it } from 'vitest'
import type { CurrentFindingRow } from '@sentinello/db'
import { advisoryIdentity, mergeFindings } from './merge-findings'

// The raw table stores one row per (scanner, advisory, dep-path), so one real vulnerability appears
// many times. Merging collapses them. Both directions are dangerous: merging too eagerly HIDES a
// vulnerability, merging too little shows the operator the same thing three times and erodes trust in
// the count. The tests below therefore pin the identity rules from both sides.

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

describe('advisoryIdentity', function () {
    it('uses the normalized title when there is one', function () {
        expect(advisoryIdentity('Prototype Pollution', 'GHSA-1')).toBe('t:prototype pollution')
    })

    it('normalizes case and surrounding whitespace', function () {
        expect(advisoryIdentity('  Prototype Pollution  ', 'GHSA-1')).toBe(advisoryIdentity('prototype pollution', 'GHSA-2'))
    })

    it('falls back to the id when there is no title', function () {
        expect(advisoryIdentity(null, 'GHSA-1')).toBe('a:GHSA-1')
    })

    it('falls back to the id when the title is blank', function () {
        expect(advisoryIdentity('   ', 'GHSA-1')).toBe('a:GHSA-1')
    })

    // The t:/a: prefixes exist so a title can never collide with an id that happens to look like it.
    it('keeps a title-keyed identity distinct from an id-keyed one', function () {
        expect(advisoryIdentity('GHSA-1', 'other')).not.toBe(advisoryIdentity(null, 'GHSA-1'))
    })
})

describe('mergeFindings identity', function () {
    // The whole point: npm-audit and OSV give the same CVE different ids but the same title, so the
    // title is what collapses them into one row.
    it('merges two sources reporting the same advisory title', function () {
        const merged = mergeFindings([
            row({ scanner: 'npm-audit', source: 'npm-audit', advisoryId: '1234', advisoryTitle: 'Prototype pollution' }),
            row({ scanner: 'osv', source: 'osv', advisoryId: 'GHSA-abc', advisoryTitle: 'Prototype pollution' })
        ])
        expect(merged).toHaveLength(1)
        expect(merged[0]?.scanners).toEqual(['npm-audit', 'osv'])
    })

    it('keeps two genuinely different advisories apart', function () {
        const merged = mergeFindings([
            row({ advisoryId: 'GHSA-1', advisoryTitle: 'Prototype pollution' }),
            row({ advisoryId: 'GHSA-2', advisoryTitle: 'Command injection' })
        ])
        expect(merged).toHaveLength(2)
    })

    // Same title, same package name, different ecosystem — these are unrelated vulnerabilities and
    // must never collapse (issue-019).
    it('keeps the same advisory on the same package name apart across ecosystems', function () {
        const merged = mergeFindings([
            row({ packageName: 'requests', ecosystem: 'npm', advisoryTitle: 'SSRF' }),
            row({ packageName: 'requests', ecosystem: 'PyPI', advisoryTitle: 'SSRF' })
        ])
        expect(merged).toHaveLength(2)
    })

    it('keeps the same advisory on different packages apart', function () {
        const merged = mergeFindings([
            row({ packageName: 'lodash', advisoryTitle: 'ReDoS' }),
            row({ packageName: 'moment', advisoryTitle: 'ReDoS' })
        ])
        expect(merged).toHaveLength(2)
    })

    it('merges rows differing only by dependency path', function () {
        const merged = mergeFindings([
            row({ depPathJson: '["a","lodash"]' }),
            row({ depPathJson: '["b","lodash"]' })
        ])
        expect(merged).toHaveLength(1)
        expect(merged[0]?.depPaths).toHaveLength(2)
    })

    it('returns nothing for no rows', function () {
        expect(mergeFindings([])).toEqual([])
    })
})

describe('mergeFindings aggregation', function () {
    it('keeps the highest severity in the bucket', function () {
        const merged = mergeFindings([
            row({ scanner: 'npm-audit', severity: 'low' }),
            row({ scanner: 'osv', severity: 'critical' })
        ])
        expect(merged[0]?.severity).toBe('critical')
    })

    it('unions installed versions and sorts them numerically', function () {
        const merged = mergeFindings([
            row({ scanner: 'npm-audit', installedVersion: '4.17.21, 4.17.9' }),
            row({ scanner: 'osv', installedVersion: '4.17.10' })
        ])
        expect(merged[0]?.installedVersion).toBe('4.17.9, 4.17.10, 4.17.21')
    })

    it('deduplicates a version reported by both sources', function () {
        const merged = mergeFindings([
            row({ scanner: 'npm-audit', installedVersion: '4.17.20' }),
            row({ scanner: 'osv', installedVersion: '4.17.20' })
        ])
        expect(merged[0]?.installedVersion).toBe('4.17.20')
    })

    // OSV frequently has no fix while npm audit does, so the merged row must take the best fix on
    // offer rather than whichever source happened to sort first.
    it('takes the highest fix version across sources', function () {
        const merged = mergeFindings([
            row({ scanner: 'npm-audit', fixAvailable: true, fixVersion: '4.17.9' }),
            row({ scanner: 'osv', fixAvailable: true, fixVersion: '4.17.21' })
        ])
        expect(merged[0]?.fixAvailable).toBe(true)
        expect(merged[0]?.fixVersion).toBe('4.17.21')
    })

    it('takes a fix from one source when the other has none', function () {
        const merged = mergeFindings([
            row({ scanner: 'osv', fixAvailable: false, fixVersion: null }),
            row({ scanner: 'npm-audit', fixAvailable: true, fixVersion: '4.17.21' })
        ])
        expect(merged[0]?.fixVersion).toBe('4.17.21')
    })

    it('reports no fix when neither source has one', function () {
        const merged = mergeFindings([row({ scanner: 'osv' }), row({ scanner: 'npm-audit' })])
        expect(merged[0]?.fixAvailable).toBe(false)
        expect(merged[0]?.fixVersion).toBeNull()
    })

    it('unions the prod and dev flags', function () {
        const merged = mergeFindings([
            row({ scanner: 'npm-audit', isProd: true, isDev: false }),
            row({ scanner: 'osv', isProd: false, isDev: true })
        ])
        expect(merged[0]?.isProd).toBe(true)
        expect(merged[0]?.isDev).toBe(true)
    })

    it('takes the earliest first-detected and the latest last-seen', function () {
        const merged = mergeFindings([
            row({ scanner: 'npm-audit', firstDetectedAt: 200, lastSeenAt: 300 }),
            row({ scanner: 'osv', firstDetectedAt: 100, lastSeenAt: 400 })
        ])
        expect(merged[0]?.firstDetectedAt).toBe(100)
        expect(merged[0]?.lastSeenAt).toBe(400)
    })

    it('ignores null lifecycle timestamps rather than treating them as zero', function () {
        const merged = mergeFindings([
            row({ scanner: 'npm-audit', firstDetectedAt: null, lastSeenAt: null }),
            row({ scanner: 'osv', firstDetectedAt: 100, lastSeenAt: 400 })
        ])
        expect(merged[0]?.firstDetectedAt).toBe(100)
        expect(merged[0]?.lastSeenAt).toBe(400)
    })

    it('flags a malicious-package advisory', function () {
        expect(mergeFindings([row({ advisoryId: 'MAL-2024-1' })])[0]?.malicious).toBe(true)
        expect(mergeFindings([row({ advisoryId: 'GHSA-1' })])[0]?.malicious).toBe(false)
    })

    it('records one identity per distinct source, ecosystem and advisory id', function () {
        const merged = mergeFindings([
            row({ scanner: 'npm-audit', source: 'npm-audit', advisoryId: '1234', advisoryTitle: 'X' }),
            row({ scanner: 'osv', source: 'osv', advisoryId: 'GHSA-abc', advisoryTitle: 'X' }),
            row({ scanner: 'osv', source: 'osv', advisoryId: 'GHSA-abc', advisoryTitle: 'X', depPathJson: '["other"]' })
        ])
        expect(merged[0]?.identities).toEqual([
            { source: 'npm-audit', ecosystem: 'npm', scanner: 'npm-audit', advisoryId: '1234' },
            { source: 'osv', ecosystem: 'npm', scanner: 'osv', advisoryId: 'GHSA-abc' }
        ])
    })

    it('deduplicates identical dependency paths', function () {
        const merged = mergeFindings([row({ depPathJson: '["a"]' }), row({ depPathJson: '["a"]' })])
        expect(merged[0]?.depPaths).toEqual([['a']])
    })

    it('shows the shortest dependency path first', function () {
        const merged = mergeFindings([
            row({ depPathJson: '["a","b","lodash"]' }),
            row({ depPathJson: '["lodash"]' })
        ])
        expect(merged[0]?.depPaths[0]).toEqual(['lodash'])
    })

    it('orders source tags npm-audit, osv, gemnasium', function () {
        const merged = mergeFindings([
            row({ scanner: 'gemnasium', advisoryTitle: 'X' }),
            row({ scanner: 'osv', advisoryTitle: 'X' }),
            row({ scanner: 'npm-audit', advisoryTitle: 'X' })
        ])
        expect(merged[0]?.scanners).toEqual(['npm-audit', 'osv', 'gemnasium'])
    })
})

describe('mergeFindings advisory selection', function () {
    // Prefer a row that actually has a URL, and among those the npm-audit one, because its advisory
    // tends to carry the remediation — the link the operator will click.
    it('prefers a row that has an advisory url', function () {
        const merged = mergeFindings([
            row({ scanner: 'osv', advisoryTitle: 'X', advisoryUrl: null, advisoryId: 'no-url' }),
            row({ scanner: 'gemnasium', advisoryTitle: 'X', advisoryUrl: 'https://a.example', advisoryId: 'has-url' })
        ])
        expect(merged[0]?.advisoryUrl).toBe('https://a.example')
        expect(merged[0]?.advisoryId).toBe('has-url')
    })

    it('prefers npm-audit when both candidates have a url', function () {
        const merged = mergeFindings([
            row({ scanner: 'osv', advisoryTitle: 'X', advisoryUrl: 'https://osv.example', advisoryId: 'osv-id' }),
            row({ scanner: 'npm-audit', advisoryTitle: 'X', advisoryUrl: 'https://npm.example', advisoryId: 'npm-id' })
        ])
        expect(merged[0]?.advisoryUrl).toBe('https://npm.example')
    })

    it('takes the vulnerable range from the row that supplied the fix', function () {
        const merged = mergeFindings([
            row({ scanner: 'osv', advisoryTitle: 'X', vulnerableRange: 'osv-range' }),
            row({ scanner: 'npm-audit', advisoryTitle: 'X', vulnerableRange: 'npm-range', fixAvailable: true, fixVersion: '9.9.9' })
        ])
        expect(merged[0]?.vulnerableRange).toBe('npm-range')
    })
})

describe('mergeFindings ordering', function () {
    it('puts the most severe row first', function () {
        const merged = mergeFindings([
            row({ packageName: 'a', severity: 'low', advisoryTitle: 'A' }),
            row({ packageName: 'b', severity: 'critical', advisoryTitle: 'B' })
        ])
        expect(merged.map(function name(m) { return m.packageName })).toEqual(['b', 'a'])
    })

    it('breaks a severity tie by package name', function () {
        const merged = mergeFindings([
            row({ packageName: 'zeta', advisoryTitle: 'A' }),
            row({ packageName: 'alpha', advisoryTitle: 'B' })
        ])
        expect(merged.map(function name(m) { return m.packageName })).toEqual(['alpha', 'zeta'])
    })

    it('breaks a name tie by installed version', function () {
        const merged = mergeFindings([
            row({ installedVersion: '2.0.0', advisoryTitle: 'A' }),
            row({ installedVersion: '1.0.0', advisoryTitle: 'B' })
        ])
        expect(merged.map(function v(m) { return m.installedVersion })).toEqual(['1.0.0', '2.0.0'])
    })
})
