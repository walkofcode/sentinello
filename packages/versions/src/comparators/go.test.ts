import { describe, expect, it } from 'vitest'
import { goComparator, normalizeGo } from './go'

// Go's ordering is semver precedence, so the ordering table below is the specification's own: tags,
// tagged prereleases, and the three pseudo-version forms (https://go.dev/ref/mod#pseudo-versions), each
// placed where the toolchain places it. Every adjacent pair is asserted both ways.
const ASCENDING = [
    'v0.0.0-20170101000000-aaaaaaaaaaaa',
    'v0.0.0-20180523222229-09b5706aa936',
    'v0.1.0',
    'v1.0.0-alpha',
    'v1.0.0-beta.2',
    'v1.0.0-beta.10',
    'v1.0.0-rc.1',
    'v1.0.0-rc.1.0.20190101000000-abcdefabcdef',
    'v1.0.0',
    'v1.0.1-0.20190101000000-abcdefabcdef',
    'v1.0.1',
    'v1.9.0',
    'v1.10.0',
    'v2.0.0-20190101000000-abcdefabcdef',
    'v2.0.0'
]

const PAIRS = ASCENDING.slice(1).map(function pair(higher, i) { return [ASCENDING[i] as string, higher] as const })

describe('goComparator ordering', function () {
    it.each(PAIRS)('orders %s below %s', function (lower, higher) {
        const a = goComparator.normalize(lower) as string
        const b = goComparator.normalize(higher) as string
        expect(goComparator.lt(a, b)).toBe(true)
        expect(goComparator.lte(a, b)).toBe(true)
        expect(goComparator.gt(b, a)).toBe(true)
        expect(goComparator.gte(b, a)).toBe(true)
        expect(goComparator.compare(a, b)).toBeLessThan(0)
        expect(goComparator.gt(a, b)).toBe(false)
    })

    // `+incompatible` is build metadata, which precedence ignores — and so does Go.
    it('ignores +incompatible for ordering', function () {
        expect(goComparator.normalize('v2.1.0+incompatible')).toBe('2.1.0')
        expect(goComparator.compare(normalizeGo('v2.1.0+incompatible') as string, normalizeGo('v2.1.0') as string)).toBe(0)
    })
})

describe('goComparator.normalize', function () {
    it('accepts the version with or without its v', function () {
        expect(normalizeGo('v1.2.3')).toBe('1.2.3')
        expect(normalizeGo('1.2.3')).toBe('1.2.3')
        expect(normalizeGo('  v1.2.3 ')).toBe('1.2.3')
    })

    // No coercion: Go has no partial versions, and a guess would read garbage as a release.
    it.each(['1.2', 'v1', 'v01.2.3', 'latest', 'v1.2.3.4', '', 'V1.2.3'])('refuses %j', function (raw) {
        expect(normalizeGo(raw)).toBeNull()
    })
})

describe('goComparator.releaseKind', function () {
    it.each([
        ['1.2.3', 'release'],
        ['1.0.0-rc.1', 'prerelease'],
        ['0.0.0-20180523222229-09b5706aa936', 'pseudo'],
        ['1.2.4-0.20190101000000-abcdefabcdef', 'pseudo'],
        ['1.0.0-rc.1.0.20190101000000-abcdefabcdef', 'pseudo'],
        // vX.0.0-<time>-<rev> is the pseudo-version of a major with no tag at all.
        ['1.0.0-20190101000000-abcdefabcdef', 'pseudo'],
        ['1.2.3-20190101000000-abcdefabcdef', 'prerelease'],
        ['1.2.4-0.2019010100000-abcdefabcdef', 'prerelease']
    ])('reads %s as a %s', function (version, kind) {
        expect(goComparator.releaseKind(version)).toBe(kind)
    })
})
