import { describe, expect, it } from 'vitest'
import { LOCALES, SEVERITY_ORDER, type Finding, type Locale } from '@sentinello/core'
import { FLEET_SUMMARY_COPY } from './fleet-copy'
import { renderFleetSummary, sortFleetLines, summarizeFleetFindings, type FleetCounts } from './fleet-summary'
import { toTelegramHtml } from './telegram'
import type { FleetPackageLine, FleetResolvedLine, FleetUnscannableLine } from './types'

const ZERO: FleetCounts = { critical: 0, high: 0, moderate: 0, unrated: 0, low: 0, info: 0 }

function finding(overrides: Partial<Finding> = {}): Finding {
    return {
        id: 'f', scanId: 's', projectId: 'p', scanner: 'osv', source: 'osv', ecosystem: 'npm', advisoryId: 'GHSA-1', advisoryTitle: null, advisoryUrl: null, packageName: 'lodash',
        installedVersion: '1.0.0', vulnerableRange: '<2', installations: [], severity: 'high', corroborations: [], noticeKind: null, aliases: [], advisoryKey: null, fixStatus: 'none_released',
        fixAvailable: false, fixVersion: null, fixCheck: null, remediation: null, depPath: [], isProd: true, isDev: false, firstDetectedAt: 0, lastSeenAt: 0, resolvedAt: null, resolvedScanId: null,
        ...overrides
    } as Finding
}

function line(i: number, severity: 'critical' | 'high'): FleetPackageLine {
    return { projectId: 'p' + i, projectName: 'project-' + i, packageName: 'package-' + i, ecosystem: 'npm', severity, advisories: 1, topFix: { version: '2.0.0', untagged: false } }
}

describe('summarizeFleetFindings', function () {
    it('counts one vulnerability once at its worst grade, and lists packages by project then package', function () {
        const { counts, listed } = summarizeFleetFindings([
            finding({ id: '1', projectId: 'b', advisoryKey: 'K', severity: 'moderate' }),
            finding({ id: '2', projectId: 'b', advisoryKey: 'K', source: 'gemnasium', severity: 'critical', fixStatus: 'released', fixVersion: '2.0.0' }),
            finding({ id: '3', projectId: 'b', advisoryKey: 'K2', severity: 'high', fixStatus: 'released', fixVersion: '1.5.0' }),
            finding({ id: '4', projectId: 'a', packageName: 'qs', severity: 'high' }),
            finding({ id: '5', projectId: 'a', advisoryId: 'GHSA-2', packageName: 'qs', severity: 'unrated' }),
            finding({ id: '6', projectId: 'a', advisoryId: 'GHSA-3', packageName: 'ms', severity: 'low' })
        ], function name(id) { return 'project ' + id })
        expect(counts).toEqual({ critical: 1, high: 2, moderate: 0, unrated: 1, low: 1, info: 0 })
        expect(listed).toEqual([
            { projectId: 'a', projectName: 'project a', packageName: 'qs', ecosystem: 'npm', severity: 'high', advisories: 1, topFix: null },
            { projectId: 'b', projectName: 'project b', packageName: 'lodash', ecosystem: 'npm', severity: 'critical', advisories: 2, topFix: { version: '2.0.0', untagged: false } }
        ])
    })

    it('takes the fix of the worst advisory with one, and says when it is an untagged commit', function () {
        const { listed } = summarizeFleetFindings([
            finding({ id: '1', ecosystem: 'Go', advisoryKey: 'A', severity: 'high', fixStatus: 'released', fixVersion: '1.5.0' }),
            finding({ id: '2', ecosystem: 'Go', advisoryKey: 'B', severity: 'critical', fixStatus: 'released', fixVersion: 'v0.0.0-20260101000000-abcdefabcdef' }),
            finding({ id: '3', ecosystem: 'Go', advisoryKey: 'C', severity: 'high', fixStatus: 'released', fixVersion: '1.6.0' })
        ], function name(id) { return id })
        expect(listed[0]?.topFix).toEqual({ version: 'v0.0.0-20260101000000-abcdefabcdef', untagged: true })
    })
})

describe('sortFleetLines', function () {
    it('leaves its input alone', function () {
        const lines = [{ projectName: 'b', packageName: 'x' }, { projectName: 'a', packageName: 'y' }, { projectName: 'a', packageName: 'x' }]
        expect(sortFleetLines(lines).map(function key(l) { return l.projectName + l.packageName })).toEqual(['ax', 'ay', 'bx'])
        expect(lines[0]?.projectName).toBe('b')
    })
})

describe('renderFleetSummary', function () {
    const base = { targetKind: 'slack' as const, resolved: [], unscannable: [], portalBaseUrl: null }

    it('says everything in the portal\'s words, in order, with a portal link', function () {
        const message = renderFleetSummary({
            ...base,
            kind: 'run_summary',
            counts: { critical: 1, high: 1, moderate: 2, unrated: 1, low: 0, info: 0 },
            listed: [line(1, 'critical'), { ...line(2, 'high'), topFix: null, advisories: 2 }, { ...line(3, 'high'), topFix: { version: 'abc', untagged: true } }],
            resolved: [{ projectId: 'r', projectName: 'old', packageName: 'qs', ecosystem: 'PyPI', advisories: 1 }],
            unscannable: [{ projectId: 'u', projectName: 'broken', state: 'cannot_scan', reason: 'No lockfile' }],
            portalBaseUrl: 'https://sentinello.example//'
        })
        expect(message.title).toBe('Sentinello run summary: 1 critical, 1 high, 2 moderate, 1 unrated, 0 low, 0 info')
        expect(message.markdown).toBe([
            '*Sentinello run summary:* 1 critical, 1 high, 2 moderate, 1 unrated, 0 low, 0 info',
            '*CRITICAL*',
            '• project-1 › package-1 (Node.js): 1 advisory, fix 2.0.0',
            '*HIGH*',
            '• project-2 › package-2 (Node.js): 2 advisories, no fix released',
            '• project-3 › package-3 (Node.js): 1 advisory, fix abc (untagged commit)',
            '*Newly unscannable*',
            '• broken: No lockfile',
            '*Resolved*',
            '• old › qs (Python): 1 advisory',
            '*Portal:* https://sentinello.example'
        ].join('\n'))
        expect(message.text).not.toContain('*')
        expect(message.portalUrl).toBe('https://sentinello.example')
    })

    it('a digest with nothing says so, and names an ecosystem the registry does not know as it stands', function () {
        expect(renderFleetSummary({ ...base, kind: 'weekly_digest', counts: ZERO, listed: [] }).markdown).toBe('*Sentinello weekly digest:* Nothing outstanding')
        const unknown = renderFleetSummary({ ...base, kind: 'weekly_digest', counts: { ...ZERO, high: 1 }, listed: [{ ...line(1, 'high'), ecosystem: 'Hex' }], unscannable: [{ projectId: 'u', projectName: 'broken', state: 'partial', reason: 'r' }] })
        expect(unknown.markdown).toContain('(Hex)')
        expect(unknown.markdown).toContain('*Cannot be fully scanned*')
    })

    it('carries the whole lists for a webhook, however a message is cut', function () {
        const listed = Array.from({ length: 200 }, function each(_u, i) { return line(i, 'high') })
        const message = renderFleetSummary({ ...base, targetKind: 'telegram', kind: 'weekly_digest', counts: { ...ZERO, high: 200 }, listed, locale: 'es' })
        expect(message.webhook).toEqual({ event: 'weekly_digest', locale: 'es', counts: { ...ZERO, high: 200 }, listed, resolved: [], unscannable: [] })
        expect(renderFleetSummary({ ...base, targetKind: 'webhook', kind: 'weekly_digest', counts: ZERO, listed }).markdown.split('\n')).toHaveLength(202)
    })

    describe('within Telegram\'s limit', function () {
        function generate(n: number) {
            return {
                critical: Array.from({ length: n }, function each(_u, i) { return line(i, 'critical') }),
                high: Array.from({ length: n }, function each(_u, i) { return line(i + n, 'high') }),
                resolved: Array.from({ length: n }, function each(_u, i): FleetResolvedLine { return { projectId: 'r' + i, projectName: 'gone<&>' + i, packageName: 'pkg', ecosystem: 'npm', advisories: 1 } }),
                unscannable: Array.from({ length: n }, function each(_u, i): FleetUnscannableLine { return { projectId: 'u' + i, projectName: 'broken' + i, state: 'partial', reason: 'No lockfile (the project)' } })
            }
        }

        function render(n: number, locale: Locale = 'en') {
            const { critical, high, resolved, unscannable } = generate(n)
            return renderFleetSummary({ kind: 'run_summary', targetKind: 'telegram', counts: { ...ZERO, critical: n, high: n, moderate: 7 }, listed: [...critical, ...high], resolved, unscannable, portalBaseUrl: 'https://sentinello.example', locale })
        }

        it('cuts resolved first, then unscannable, then high, and critical last, counting what it left out', function () {
            const small = render(5)
            expect(small.markdown).not.toContain('more')
            const some = render(40)
            expect(toTelegramHtml(some.markdown).length).toBeLessThanOrEqual(4096)
            expect(some.markdown).toContain('*Resolved*')
            const huge = render(2000)
            const html = toTelegramHtml(huge.markdown)
            expect(html.length).toBeLessThanOrEqual(4096)
            expect(huge.markdown).toContain('*CRITICAL*')
            expect(huge.markdown).toMatch(/…and 2000 more/)
            expect(huge.markdown).toContain('*Resolved*\n…and 2000 more')
            expect(huge.markdown).toContain('*Newly unscannable*\n…and 2000 more')
            expect(huge.markdown).toContain('*HIGH*\n…and 2000 more')
        })

        it('never cuts the counts or the portal link', function () {
            for (const locale of LOCALES) {
                const { markdown } = render(3000, locale)
                expect(toTelegramHtml(markdown).length).toBeLessThanOrEqual(4096)
                expect(markdown.split('\n')[0]).toContain('3000 critical, 3000 high, 7 moderate, 0 unrated, 0 low, 0 info')
                expect(markdown).toContain('*Portal:* https://sentinello.example')
            }
        })

        it('measures the escaped form: a name full of markup costs what Telegram counts', function () {
            const heavy = Array.from({ length: 100 }, function each(_u, i): FleetUnscannableLine { return { projectId: 'u' + i, projectName: '<&>'.repeat(20), state: 'partial', reason: 'r' } })
            const { markdown } = renderFleetSummary({ kind: 'weekly_digest', targetKind: 'telegram', counts: ZERO, listed: [], resolved: [], unscannable: heavy, portalBaseUrl: null })
            expect(markdown.length).toBeLessThan(4096)
            expect(toTelegramHtml(markdown).length).toBeLessThanOrEqual(4096)
            expect(markdown).toContain('more')
        })
    })
})

describe('the copy', function () {
    it('covers every locale, in its own words', function () {
        const missing: string[] = []
        for (const locale of LOCALES) {
            const copy = FLEET_SUMMARY_COPY[locale]
            const said = [copy.runSummaryTitle, copy.digestTitle, copy.nothingOutstanding, copy.resolvedHeading, copy.newlyUnscannableHeading, copy.currentlyUnscannableHeading, copy.advisories(1), copy.advisories(2), copy.advisories(5), copy.fix('1'), copy.untaggedFix('1'), copy.noFix, copy.andMore(3)]
            for (const text of said) if (typeof text !== 'string' || text.length === 0) missing.push(locale)
            if (locale !== 'en' && copy.nothingOutstanding === FLEET_SUMMARY_COPY.en.nothingOutstanding) missing.push(locale + ' is English')
            if (!copy.andMore(3).includes('3') || !copy.fix('1.2').includes('1.2') || !copy.untaggedFix('1.2').includes('1.2')) missing.push(locale + ' drops a value')
        }
        expect(missing).toEqual([])
    })

    it('uses the severity words the portal does, whatever the locale', function () {
        for (const locale of LOCALES) {
            const { title } = renderFleetSummary({ kind: 'weekly_digest', targetKind: 'slack', counts: { ...ZERO, high: 1 }, listed: [], resolved: [], unscannable: [], portalBaseUrl: null, locale })
            for (const severity of SEVERITY_ORDER) expect(title).toContain(severity)
        }
    })
})
