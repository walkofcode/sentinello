import { describe, expect, it } from 'vitest'
import {
    formatAbsoluteTime,
    formatDuration,
    formatExposureWindow,
    formatRelativeTime,
    parseJsonArray,
    pluralize,
    rootDisplayLabel,
    type Translator
} from './format'

// These helpers run on both sides of the SSR/hydration boundary, so they must be deterministic. Every
// one of them takes its clock and its translator as arguments, which means no fake timers and no i18n
// setup are needed here — the tests just pass a fixed `now` and a translator that echoes what it was
// asked for. Asserting on that echo pins the message key AND its interpolation values, which is what
// actually breaks when a branch boundary shifts.
const t: Translator = function translate(key, values) {
    if (!values) return key
    const parts = Object.keys(values).map(function pair(k) {
        return k + '=' + String(values[k])
    })
    return key + '(' + parts.join(',') + ')'
}

const NOW = Date.UTC(2026, 5, 15, 12, 0, 0)
const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

// [milliseconds before NOW, expected translator output]
const RELATIVE_CASES: Array<[number, string]> = [
    [0, 'justNow'],
    [59 * SECOND, 'justNow'],
    [MINUTE, 'minutesAgo(n=1)'],
    [59 * MINUTE, 'minutesAgo(n=59)'],
    [HOUR, 'hoursAgo(n=1)'],
    [23 * HOUR, 'hoursAgo(n=23)'],
    [DAY, 'daysAgo(n=1)'],
    [29 * DAY, 'daysAgo(n=29)'],
    [30 * DAY, 'monthsAgo(n=1)'],
    [359 * DAY, 'monthsAgo(n=11)'],
    [360 * DAY, 'yearsAgo(n=1)'],
    [900 * DAY, 'yearsAgo(n=2)']
]

// [milliseconds of exposure, expected translator output]
const WINDOW_CASES: Array<[number, string]> = [
    [0, 'windowUnderMinute'],
    [59 * SECOND, 'windowUnderMinute'],
    [MINUTE, 'windowMinutes(n=1)'],
    [59 * MINUTE, 'windowMinutes(n=59)'],
    [HOUR, 'windowHours(n=1)'],
    [23 * HOUR, 'windowHours(n=23)'],
    [DAY, 'windowDays(n=1)'],
    [29 * DAY, 'windowDays(n=29)'],
    [30 * DAY, 'windowMonths(n=1)'],
    [359 * DAY, 'windowMonths(n=11)'],
    [360 * DAY, 'windowYears(n=1)']
]

describe('formatRelativeTime', function () {
    it.each(RELATIVE_CASES)('renders %dms ago as %s', function (ago, expected) {
        expect(formatRelativeTime(NOW - ago, t, NOW)).toBe(expected)
    })

    it('renders a null timestamp as never', function () {
        expect(formatRelativeTime(null, t, NOW)).toBe('never')
    })

    // 0 is falsy and the guard is `if (!at)`, so the epoch is reported as "never" rather than as a very
    // old timestamp. Pinned deliberately: a scan can never legitimately carry at=0.
    it('treats the epoch as never', function () {
        expect(formatRelativeTime(0, t, NOW)).toBe('never')
    })

    it('renders a future timestamp with its own key rather than a negative age', function () {
        expect(formatRelativeTime(NOW + MINUTE, t, NOW)).toBe('inFuture')
    })
})

describe('formatAbsoluteTime', function () {
    it('renders a UTC timestamp without sub-second noise', function () {
        expect(formatAbsoluteTime(Date.UTC(2026, 0, 2, 3, 4, 5, 678))).toBe('2026-01-02 03:04:05 UTC')
    })

    it('renders a null timestamp as an em dash', function () {
        expect(formatAbsoluteTime(null)).toBe('—')
    })
})

describe('formatDuration', function () {
    it.each([
        [0, '0ms'],
        [1, '1ms'],
        [999, '999ms'],
        [1000, '1.0s'],
        [1499, '1.5s'],
        [65_000, '65.0s']
    ] as Array<[number, string]>)('renders %dms as %s', function (ms, expected) {
        expect(formatDuration(ms)).toBe(expected)
    })

    // `ms == null` rather than `!ms`, so a genuine zero survives as '0ms' — see the 0 row above.
    it('renders a null duration as an em dash', function () {
        expect(formatDuration(null)).toBe('—')
    })
})

describe('formatExposureWindow', function () {
    it.each(WINDOW_CASES)('renders a %dms window as %s', function (ms, expected) {
        expect(formatExposureWindow(ms, t)).toBe(expected)
    })

    it('renders a null window as an em dash', function () {
        expect(formatExposureWindow(null, t)).toBe('—')
    })

    it('renders a negative window as an em dash rather than a bogus duration', function () {
        expect(formatExposureWindow(-1, t)).toBe('—')
    })
})

describe('parseJsonArray', function () {
    it('parses an array of strings', function () {
        expect(parseJsonArray('["a","b"]')).toEqual(['a', 'b'])
    })

    it('drops non-string members rather than failing', function () {
        expect(parseJsonArray('["a",1,null,{"b":2},"c"]')).toEqual(['a', 'c'])
    })

    it.each(['', 'not json', '{"a":1}', 'null', '"a string"', '42'])(
        'returns an empty array for %j',
        function (raw) {
            expect(parseJsonArray(raw)).toEqual([])
        }
    )
})

describe('rootDisplayLabel', function () {
    it('prefers the operator label when set', function () {
        expect(rootDisplayLabel('Work', '/roots/personal')).toBe('Work')
    })

    it('falls back to the final path segment', function () {
        expect(rootDisplayLabel(null, '/roots/personal')).toBe('personal')
    })

    it('ignores a trailing slash', function () {
        expect(rootDisplayLabel(null, '/roots/personal/')).toBe('personal')
    })

    it('falls back to the whole path when there is no segment', function () {
        expect(rootDisplayLabel(null, '/')).toBe('/')
    })

    it('treats an empty label as unset', function () {
        expect(rootDisplayLabel('', '/roots/personal')).toBe('personal')
    })
})

describe('pluralize', function () {
    it('uses the singular for exactly one', function () {
        expect(pluralize(1, 'finding')).toBe('1 finding')
    })

    it.each([0, 2, 17])('appends s for %d', function (n) {
        expect(pluralize(n, 'finding')).toBe(n + ' findings')
    })

    it('uses an explicit plural when the word is irregular', function () {
        expect(pluralize(2, 'vulnerability', 'vulnerabilities')).toBe('2 vulnerabilities')
    })
})
