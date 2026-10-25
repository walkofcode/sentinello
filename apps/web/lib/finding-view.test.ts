import { describe, expect, test } from 'vitest'
import { atOrAboveSeverity, parseMinSeverityParam, parseSortParam, sortForView } from './finding-view'

describe('parseMinSeverityParam', function suite() {
    test('accepts every dashboard severity floor', function valid() {
        expect(parseMinSeverityParam('critical')).toBe('critical')
        expect(parseMinSeverityParam('low')).toBe('low')
    })

    test('reads an absent or unknown value as no floor', function invalid() {
        expect(parseMinSeverityParam(null)).toBe('')
        expect(parseMinSeverityParam(undefined)).toBe('')
        expect(parseMinSeverityParam('info')).toBe('')
        expect(parseMinSeverityParam('nonsense')).toBe('')
    })
})

describe('parseSortParam', function suite() {
    test('accepts name', function valid() {
        expect(parseSortParam('name')).toBe('name')
    })

    test('reads an absent or unknown value as severity', function invalid() {
        expect(parseSortParam(null)).toBe('severity')
        expect(parseSortParam('newest')).toBe('severity')
    })
})

describe('atOrAboveSeverity', function suite() {
    const rows = [{ severity: 'critical' }, { severity: 'high' }, { severity: 'moderate' }, { severity: 'low' }]

    test('keeps every row without a floor', function noFloor() {
        expect(atOrAboveSeverity(rows, '')).toBe(rows)
    })

    test('keeps the rows at or above the floor', function floor() {
        expect(atOrAboveSeverity(rows, 'high')).toEqual([{ severity: 'critical' }, { severity: 'high' }])
    })
})

describe('sortForView', function suite() {
    const rows = [
        { packageName: 'zod', severity: 'critical' },
        { packageName: 'axios', severity: 'high' },
        { packageName: 'zod', severity: 'low' }
    ]

    test('leaves the producer order for severity', function bySeverity() {
        expect(sortForView(rows, 'severity')).toBe(rows)
    })

    test('orders by package name, keeping severity order within a package', function byName() {
        expect(sortForView(rows, 'name').map(function label(r) { return r.packageName + ':' + r.severity })).toEqual([
            'axios:high',
            'zod:critical',
            'zod:low'
        ])
        expect(rows[0]?.packageName).toBe('zod')
    })
})
