import { describe, expect, it } from 'vitest'
import { SEVERITY_ORDER, compareSeverity, findingIdentity, maxSeverity, meetsSeverityFloor, severityWeight } from './types'
import type { Severity } from './types'

// There used to be four SEVERITY_RANK tables in this repo — one here, one in merge-findings.ts, and one
// in each of two filter components — and the first two pointed in OPPOSITE directions under the same
// name. These tests pin the single replacement contract: one order, higher weight = worse.

describe('severityWeight', function () {
    it('ranks the declared severities worst-first', function () {
        const weights = SEVERITY_ORDER.map(severityWeight)
        expect(weights).toEqual([...weights].sort(function descending(a, b) { return b - a }))
        expect(new Set(weights).size).toBe(SEVERITY_ORDER.length)
    })

    it('weighs critical above info', function () {
        expect(severityWeight('critical')).toBeGreaterThan(severityWeight('info'))
    })

    // Takes `string`, not `Severity`: advisory feeds hand us whatever they like and findings.severity is
    // a plain TEXT column. Moderate, not info — an unknown advisory must never be silently downgraded,
    // and it must never fall outside the five weights the SQL buckets sum over.
    it('weighs an unrecognized severity as moderate', function () {
        expect(severityWeight('catastrophic')).toBe(severityWeight('moderate'))
        expect(severityWeight('')).toBe(severityWeight('moderate'))
    })

    it('normalizes case and whitespace rather than treating them as unknown', function () {
        expect(severityWeight('CRITICAL')).toBe(severityWeight('critical'))
        expect(severityWeight(' High ')).toBe(severityWeight('high'))
    })
})

describe('compareSeverity', function () {
    it('sorts most severe first', function () {
        const shuffled: string[] = ['low', 'critical', 'info', 'high', 'moderate']
        expect(shuffled.sort(compareSeverity)).toEqual(['critical', 'high', 'moderate', 'low', 'info'])
    })

    it('reports equal severities as tied so callers can fall through to their next key', function () {
        expect(compareSeverity('high', 'high')).toBe(0)
    })
})

describe('meetsSeverityFloor', function () {
    it('admits a severity at the floor', function () {
        expect(meetsSeverityFloor('high', 'high')).toBe(true)
    })

    it('admits anything worse than the floor', function () {
        expect(meetsSeverityFloor('critical', 'high')).toBe(true)
    })

    it('rejects anything below the floor', function () {
        expect(meetsSeverityFloor('low', 'high')).toBe(false)
    })

    // The old ascending scale ranked critical as 0, so any `&&`/`||` defaulting on the cutoff silently
    // dropped criticals — the exact inversion this API exists to make unrepresentable.
    it('never drops criticals when the floor is itself critical', function () {
        expect(meetsSeverityFloor('critical', 'critical')).toBe(true)
        expect(meetsSeverityFloor('high', 'critical')).toBe(false)
    })

    it('admits an unrecognized severity at a moderate floor rather than discarding it', function () {
        expect(meetsSeverityFloor('bogus', 'moderate')).toBe(true)
        expect(meetsSeverityFloor('bogus', 'high')).toBe(false)
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

    // maxSeverity's return type promises a declared Severity, so an unrecognised input must never be
    // echoed back out — it would flow into badges and filters typed as though it were valid.
    it('falls back to info when nothing is recognised', function () {
        expect(maxSeverity(['bogus', 'nonsense'])).toBe('info')
    })

    it('normalizes the casing of the winner rather than returning the raw string', function () {
        expect(maxSeverity(['CRITICAL', 'low'])).toBe('critical')
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
