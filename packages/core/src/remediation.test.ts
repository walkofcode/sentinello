import { describe, expect, it } from 'vitest'
import { PLAIN_FIX_STYLE } from './fix-status'
import {
    daysSince,
    describeAlternative,
    describeDevOnly,
    describeHealth,
    describeOption,
    describeRemediation,
    describeSignals,
    describeVerdict,
    isUnmaintained,
    parseRemediation,
    summarizeRemediation,
    UNMAINTAINED_AFTER_DAYS,
    type ChainVerdict,
    type Remediation,
    type RemediationHealth
} from './remediation'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 9, 3)
const PROOF = { release: 'chokidar@4.0.0', closureSize: 2 }

function health(overrides: Partial<RemediationHealth> = {}): RemediationHealth {
    return { name: 'braces', latest: '3.0.3', lastPublishAt: Date.UTC(2024, 4, 21), maintainers: 1, weeklyDownloads: 1, deprecated: null, daysSinceLastPublish: 865, unmaintained: true, ...overrides }
}

function remediation(overrides: Partial<Remediation> = {}): Remediation {
    return {
        v: 1,
        checkedAt: NOW,
        package: 'braces',
        health: health(),
        chains: [{ importer: '.', rootKind: 'prod', path: ['a@1.0.0', 'braces@3.0.3'], verdict: { kind: 'noEscape', packages: ['a'] } }],
        moreChains: 0, moreChainsAtLeast: false,
        alternatives: [],
        devOnly: false,
        partial: false,
        ...overrides
    }
}

describe('the unmaintained rule (D5: deprecated, or no publish for 183+ days)', function () {
    it('pins the boundary at 182 / 183 days', function () {
        expect(UNMAINTAINED_AFTER_DAYS).toBe(183)
        expect(isUnmaintained(null, daysSince(NOW - 182 * DAY, NOW))).toBe(false)
        expect(isUnmaintained(null, daysSince(NOW - 183 * DAY, NOW))).toBe(true)
    })

    it('counts a deprecation notice on its own, even on a release published yesterday', function () {
        expect(isUnmaintained('no longer supported', daysSince(NOW - DAY, NOW))).toBe(true)
    })

    it('does not guess from a missing publish date', function () {
        expect(daysSince(null, NOW)).toBeNull()
        expect(isUnmaintained(null, null)).toBe(false)
        expect(daysSince(NOW + DAY, NOW)).toBe(0)
    })
})

describe('parseRemediation', function () {
    it('round-trips a stored remediation', function () {
        const r = remediation({ alternatives: [{ replaces: 'a', reason: 'noEscape', signals: null, options: [{ kind: 'removal', description: 'x', url: null }], url: null }] })
        expect(parseRemediation(JSON.stringify(r))).toEqual(r)
    })

    it.each([
        ['null', null],
        ['not json', '{'],
        ['an array', '[]'],
        ['a future version', JSON.stringify({ ...remediation(), v: 2 })],
        ['no checkedAt', JSON.stringify({ ...remediation(), checkedAt: 'x' })],
        ['a bad devOnly', JSON.stringify({ ...remediation(), devOnly: 'yes' })],
        ['no health', JSON.stringify({ ...remediation(), health: null })],
        ['health without a name', JSON.stringify({ ...remediation(), health: { unmaintained: true } })],
        ['chains not a list', JSON.stringify({ ...remediation(), chains: {} })],
        ['a chain without a path', JSON.stringify({ ...remediation(), chains: [{ verdict: { kind: 'direct' } }] })],
        ['an unknown verdict', JSON.stringify({ ...remediation(), chains: [{ path: [], verdict: { kind: 'maybe' } }] })],
        ['alternatives not a list', JSON.stringify({ ...remediation(), alternatives: null })],
        ['an alternative without options', JSON.stringify({ ...remediation(), alternatives: [{ replaces: 'a' }] })],
        ['an unknown option', JSON.stringify({ ...remediation(), alternatives: [{ replaces: 'a', options: [{ kind: 'guess' }] }] })]
    ])('reads %s as no way out', function (_label, json) {
        expect(parseRemediation(json)).toBeNull()
    })

    it('accepts a null devOnly', function () {
        expect(parseRemediation(JSON.stringify(remediation({ devOnly: null })))?.devOnly).toBeNull()
    })

    // Issue 017: an accepted value must render. A remediation carrying every verdict and option variant is
    // corrupted at each of its fields in turn (removed, or given a value of the wrong kind); every corruption
    // either reads as no way out or still renders on every surface without throwing.
    const signals = { name: 'tinyglobby', latest: '0.2.15', lastPublishAt: NOW, maintainers: 1, weeklyDownloads: 10 }
    const full = remediation({
        chains: [
            { importer: '.', rootKind: 'prod', path: ['a@1.0.0', 'braces@3.0.3'], verdict: { kind: 'upgrade', package: 'a', toAtLeast: '2.0.0', proof: PROOF } },
            { importer: 'apps/web', rootKind: 'dev', path: ['n@3.1.14', 'c@3.6.0', 'braces@3.0.3'], verdict: { kind: 'blocked', escapePackage: 'c', escapeVersion: '4.0.0', blockedBy: 'n', blockedByLatest: '3.1.14', blockedRange: '^3.5.2', proof: PROOF } },
            { importer: '.', rootKind: 'optional', path: ['f@1.0.0', 'braces@3.0.3'], verdict: { kind: 'noEscape', packages: ['f'] } },
            { importer: null, rootKind: null, path: [], verdict: { kind: 'unknown', at: 'braces', reason: 'no graph' } },
            { importer: '.', rootKind: 'prod', path: ['braces@3.0.3'], verdict: { kind: 'direct' } }
        ],
        moreChains: 3,
        alternatives: [{
            replaces: 'f', reason: 'noEscape', signals, url: 'https://e18e.dev',
            options: [
                { kind: 'module', name: 'tinyglobby', version: '0.2.15', verified: true, proof: PROOF, signals },
                { kind: 'module', name: 'x', version: null, verified: false, proof: null, signals: null },
                { kind: 'native', id: 'fs.glob', description: null, url: null },
                { kind: 'snippet', id: 's', description: 'a loop', url: 'https://x' },
                { kind: 'removal', description: 'drop it', url: null }
            ]
        }]
    })

    function leaves(value: unknown, path: (string | number)[] = []): (string | number)[][] {
        if (typeof value !== 'object' || value === null) return [path]
        const keys = Array.isArray(value) ? value.map(function index(_v, i) { return i }) : Object.keys(value)
        return [path, ...keys.flatMap(function deeper(k) { return leaves((value as Record<string | number, unknown>)[k], [...path, k]) })]
    }

    function corrupt(path: (string | number)[], replacement: unknown): unknown {
        const copy = JSON.parse(JSON.stringify(full)) as Record<string | number, unknown>
        let at = copy
        for (const k of path.slice(0, -1)) at = at[k] as Record<string | number, unknown>
        const last = path[path.length - 1] as string | number
        if (replacement === undefined) delete at[last]
        else at[last] = replacement
        return copy
    }

    function renders(r: Remediation): void {
        describeRemediation(r, PLAIN_FIX_STYLE)
        summarizeRemediation(r, PLAIN_FIX_STYLE)
        for (const c of r.chains) describeVerdict(c.verdict, r.package, PLAIN_FIX_STYLE)
    }

    it('accepts the full value and renders it', function () {
        const parsed = parseRemediation(JSON.stringify(full))
        expect(parsed).toEqual(full)
        renders(parsed as Remediation)
    })

    const paths = leaves(full).filter(function notRoot(p) { return p.length > 0 })
    it.each(paths.flatMap(function each(p) {
        return [undefined, 'x', 1.5, -1, 9e15, null, [], {}].map(function bad(v) { return [p.join('.'), JSON.stringify(v) ?? 'missing', p, v] as const })
    }))('%s = %s: rejected, or still renders', function (_label, _value, path, value) {
        const parsed = parseRemediation(JSON.stringify(corrupt(path, value)))
        if (parsed !== null) expect(function render() { renders(parsed) }).not.toThrow()
    })

    it.each([
        ['a noEscape verdict without packages', { kind: 'noEscape' }],
        ['an upgrade verdict without a proof', { kind: 'upgrade', package: 'a', toAtLeast: '2.0.0' }],
        ['a blocked verdict without its range', { kind: 'blocked', escapePackage: 'c', escapeVersion: '4.0.0', blockedBy: 'n', blockedByLatest: null, proof: PROOF }]
    ])('rejects %s (the shapes the review found accepted)', function (_label, verdict) {
        expect(parseRemediation(JSON.stringify({ ...remediation(), chains: [{ importer: '.', rootKind: 'prod', path: [], verdict }] }))).toBeNull()
    })

    it('rejects a publish date no Date can print, and a module option without its signals field', function () {
        expect(parseRemediation(JSON.stringify(remediation({ health: health({ lastPublishAt: 9e15 }) })))).toBeNull()
        expect(parseRemediation(JSON.stringify({ ...remediation(), alternatives: [{ replaces: 'a', reason: 'noEscape', signals: null, url: null, options: [{ kind: 'module', name: 'x', version: null, verified: false, proof: null }] }] }))).toBeNull()
    })
})

describe('the wording', function () {
    it('describes signals, with unknowns said plainly', function () {
        expect(describeSignals({ name: 'x', latest: '1.0.0', lastPublishAt: Date.UTC(2026, 0, 2), maintainers: 1, weeklyDownloads: 1 })).toBe('latest 1.0.0 · last release 2026-01-02 · 1 maintainer · 1 weekly download')
        expect(describeSignals({ name: 'x', latest: null, lastPublishAt: null, maintainers: 3, weeklyDownloads: null })).toBe('last release unknown · 3 maintainers · weekly downloads unknown')
    })

    it.each([
        ['unmaintained', health(), 'braces: last publish 2024-05-21 (28 months ago) · 1 maintainer · 1 weekly download — unmaintained (no publish for 6+ months) → replace it'],
        ['deprecated', health({ deprecated: 'use x' }), 'braces: last publish 2024-05-21 (28 months ago) · 1 maintainer · 1 weekly download — deprecated ("use x") → replace it'],
        ['maintained, nothing known', health({ unmaintained: false, lastPublishAt: null, daysSinceLastPublish: null, weeklyDownloads: null, maintainers: 2 }), 'braces: last publish unknown · 2 maintainers · weekly downloads unknown — maintained']
    ])('describes health: %s', function (_label, h, expected) {
        expect(describeHealth(h, PLAIN_FIX_STYLE)).toBe(expected)
    })

    it.each([
        ['upgrade', { kind: 'upgrade', package: 'p', toAtLeast: '2.0.0', proof: PROOF } as const, 'upgrade p to ≥ 2.0.0 — its resolved closure (2 packages) does not reach braces'],
        ['blocked', { kind: 'blocked', escapePackage: 'chokidar', escapeVersion: '4.0.0', blockedBy: 'nodemon', blockedByLatest: '3.1.14', blockedRange: '^3.5.2', proof: PROOF } as const, 'chokidar ≥ 4.0.0 drops braces, but no released nodemon admits it (latest 3.1.14 requires ^3.5.2)'],
        ['blocked, latest unknown', { kind: 'blocked', escapePackage: 'a', escapeVersion: '2.0.0', blockedBy: 'p', blockedByLatest: null, blockedRange: '1.0.0', proof: PROOF } as const, 'a ≥ 2.0.0 drops braces, but no released p admits it (requires 1.0.0)'],
        ['noEscape, one', { kind: 'noEscape', packages: ['micromatch'] } as const, 'no released micromatch drops braces'],
        ['noEscape, three', { kind: 'noEscape', packages: ['micromatch', 'fast-glob', '@next/eslint-plugin-next'] } as const, 'no released micromatch, fast-glob or @next/eslint-plugin-next drops braces'],
        ['unknown', { kind: 'unknown', at: 'fast-glob', reason: 'fetch budget exhausted' } as const, 'unknown — not enough registry evidence at fast-glob (fetch budget exhausted)'],
        ['direct', { kind: 'direct' } as const, 'braces is a direct dependency — the only way out is to replace it']
    ])('describes a %s verdict', function (_label, verdict, expected) {
        expect(describeVerdict(verdict as ChainVerdict, 'braces', PLAIN_FIX_STYLE)).toBe(expected)
    })

    it.each([
        ['a verified module', { kind: 'module', name: 'tinyglobby', version: '0.2.15', verified: true, proof: { release: 'tinyglobby@0.2.15', closureSize: 3 }, signals: { name: 'tinyglobby', latest: '0.2.15', lastPublishAt: null, maintainers: 1, weeklyDownloads: 10 } } as const, 'tinyglobby 0.2.15 (closure of 3 packages checked) — latest 0.2.15 · last release unknown · 1 maintainer · 10 weekly downloads'],
        ['an unverified module', { kind: 'module', name: 'z', version: null, verified: false, proof: null, signals: null } as const, 'z (not verified — its dependency closure could not be checked)'],
        ['a native', { kind: 'native', id: 'fs.promises.glob', description: null, url: 'https://nodejs.org/x' } as const, 'built-in fs.promises.glob (https://nodejs.org/x)'],
        ['a described native', { kind: 'native', id: 'URLSearchParams', description: 'parse it', url: null } as const, 'built-in URLSearchParams: parse it'],
        ['a snippet', { kind: 'snippet', id: 's', description: 'use filter', url: null } as const, 'inline code: use filter'],
        ['a removal', { kind: 'removal', description: 'native APIs cover it', url: 'https://e18e.dev/x' } as const, 'remove it: native APIs cover it (https://e18e.dev/x)']
    ])('describes %s', function (_label, option, expected) {
        expect(describeOption(option, PLAIN_FIX_STYLE)).toBe(expected)
    })

    it('describes alternatives, and says when none is known', function () {
        const signals = { name: 'nodemon', latest: '3.1.14', lastPublishAt: null, maintainers: 1, weeklyDownloads: null }
        expect(describeAlternative({ replaces: 'nodemon', reason: 'blocked', signals, options: [], url: null }, PLAIN_FIX_STYLE)).toBe('no curated alternative known for nodemon (latest 3.1.14 · last release unknown · 1 maintainer · weekly downloads unknown)')
        expect(describeAlternative({ replaces: 'a', reason: 'noEscape', signals: null, options: [{ kind: 'removal', description: 'x', url: null }], url: null }, PLAIN_FIX_STYLE)).toBe('alternatives to a: remove it: x')
    })

    it('describes dev-only reach in all three states', function () {
        expect(describeDevOnly(true, 'braces')).toMatch(/^Every path to braces reaches only dev tooling/)
        expect(describeDevOnly(false, 'braces')).toBe('At least one production path reaches braces.')
        expect(describeDevOnly(null, 'braces')).toMatch(/could not be determined/)
    })

    it('lays the block out with tags, a remainder and the partial note', function () {
        const text = describeRemediation(remediation({
            chains: [
                { importer: '.', rootKind: 'dev', path: ['a@1.0.0', 'braces@3.0.3'], verdict: { kind: 'direct' } },
                { importer: 'packages/api', rootKind: 'optional', path: ['o@1.0.0', 'braces@3.0.3'], verdict: { kind: 'direct' } },
                { importer: null, rootKind: null, path: [], verdict: { kind: 'unknown', at: 'braces', reason: 'no lockfile graph' } }
            ],
            moreChains: 2, moreChainsAtLeast: false,
            alternatives: [{ replaces: 'a', reason: 'noEscape', signals: null, options: [], url: null }],
            partial: true
        }), PLAIN_FIX_STYLE)
        expect(text.alternatives).toEqual(['no curated alternative known for a'])
        expect(text.chains).toEqual([
            'a@1.0.0 › braces@3.0.3 [dev tooling only]: braces is a direct dependency — the only way out is to replace it',
            'o@1.0.0 › braces@3.0.3 in packages/api [optional]: braces is a direct dependency — the only way out is to replace it',
            'unknown — not enough registry evidence at braces (no lockfile graph)',
            'and 2 more paths'
        ])
        expect(describeRemediation(remediation({ moreChains: 2, moreChainsAtLeast: true }), PLAIN_FIX_STYLE).chains.at(-1)).toBe('and at least 2 more paths')
        expect(text.partial).toMatch(/budget ran out/)
        expect(describeRemediation(remediation(), PLAIN_FIX_STYLE).partial).toBeNull()
    })

    it('summarizes in one line', function () {
        expect(summarizeRemediation(remediation({ moreChains: 1, moreChainsAtLeast: false, devOnly: true }), PLAIN_FIX_STYLE)).toBe('braces is unmaintained → replace it; no released a drops braces; 1 more path in the advisory; dev tooling only')
        expect(summarizeRemediation(remediation({ moreChains: 1, moreChainsAtLeast: true }), PLAIN_FIX_STYLE)).toBe('braces is unmaintained → replace it; no released a drops braces; at least 1 more path in the advisory')
        expect(summarizeRemediation(remediation({ health: health({ deprecated: 'x' }) }), PLAIN_FIX_STYLE)).toBe('braces is deprecated → replace it; no released a drops braces')
        expect(summarizeRemediation(remediation({ health: health({ unmaintained: false }), chains: [] }), PLAIN_FIX_STYLE)).toBe('see the advisory')
    })
})
