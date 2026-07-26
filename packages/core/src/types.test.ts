import { describe, expect, it } from 'vitest'
import { SEVERITY_RANK, findingIdentity, maxSeverity, severityRank } from './types'
import type { Severity } from './types'

describe('severityRank', function () {
    it('orders severities most-severe-first, so a lower rank is worse', function () {
        expect(severityRank('critical')).toBe(0)
        expect(severityRank('high')).toBe(1)
        expect(severityRank('moderate')).toBe(2)
        expect(severityRank('low')).toBe(3)
        expect(severityRank('info')).toBe(4)
    })

    it('agrees with the SEVERITY_RANK table for every declared severity', function () {
        for (const [severity, rank] of Object.entries(SEVERITY_RANK)) {
            expect(severityRank(severity)).toBe(rank)
        }
    })

    // The function takes `string`, not `Severity` — advisory feeds hand us whatever they like, so
    // an unrecognised value must degrade to the least-severe bucket rather than throw or return NaN.
    it('treats an unknown severity as info rather than throwing', function () {
        expect(severityRank('catastrophic')).toBe(4)
        expect(severityRank('')).toBe(4)
        expect(severityRank('CRITICAL')).toBe(4)
    })
})

describe('maxSeverity', function () {
    it('returns the most severe entry', function () {
        expect(maxSeverity(['low', 'critical', 'moderate'])).toBe('critical')
        expect(maxSeverity(['info', 'low'])).toBe('low')
    })

    it('returns info for an empty list', function () {
        expect(maxSeverity([])).toBe('info')
    })

    it('ignores unknown severities in favour of a real one', function () {
        expect(maxSeverity(['bogus', 'high'])).toBe('high')
    })

    // An all-unknown list ranks 4 across the board, and nothing ever beats the initial best, so the
    // seeded 'info' is returned rather than the unrecognised input being echoed back.
    it('falls back to info when nothing is recognised', function () {
        expect(maxSeverity(['bogus', 'nonsense'])).toBe('info')
    })

    it('is order-independent', function () {
        const severities: Severity[] = ['low', 'critical', 'info', 'high']
        expect(maxSeverity([...severities].reverse())).toBe(maxSeverity(severities))
    })
})

describe('findingIdentity', function () {
    // Identity is the dedup key across sources, so it must project exactly these five fields and
    // drop everything else — a stray field leaking in would split one finding into two episodes.
    it('projects exactly the five identity fields', function () {
        const identity = findingIdentity({
            projectId: 'proj-1',
            source: 'osv',
            ecosystem: 'npm',
            advisoryId: 'GHSA-xxxx',
            packageName: 'lodash'
        })

        expect(identity).toEqual({
            projectId: 'proj-1',
            source: 'osv',
            ecosystem: 'npm',
            advisoryId: 'GHSA-xxxx',
            packageName: 'lodash'
        })
        expect(Object.keys(identity).sort()).toEqual([
            'advisoryId',
            'ecosystem',
            'packageName',
            'projectId',
            'source'
        ])
    })

    it('does not carry over unrelated fields', function () {
        const identity = findingIdentity({
            projectId: 'proj-1',
            source: 'osv',
            ecosystem: 'npm',
            advisoryId: 'GHSA-xxxx',
            packageName: 'lodash',
            severity: 'critical'
        } as Parameters<typeof findingIdentity>[0])

        expect(identity).not.toHaveProperty('severity')
    })
})
