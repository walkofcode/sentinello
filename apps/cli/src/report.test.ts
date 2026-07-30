import { describe, expect, it } from 'vitest'
import { DEFAULT_EXPORT_PROMPT } from '@sentinello/core'
import { defaultOutputFilename, renderJson, resolvePrompt, shouldFail, summarize } from './report'
import { parseArgs } from './options'
import type { CliOptions } from './options'
import type { ProjectScanResult, ScannerOutcome } from './scan'
import type { RawFinding } from '@sentinello/scanners'
import type { DiscoveredProject } from '@sentinello/scanners'

// A fixed instant so every rendered document is byte-stable: 2026-03-04T05:06:07.000Z.
const GENERATED_AT = Date.UTC(2026, 2, 4, 5, 6, 7)

function optionsWith(argv: string[]): CliOptions {
    const result = parseArgs(argv)
    if (result.kind !== 'options') throw new Error('expected options, got ' + result.kind)
    return result.options
}

function project(name: string, relPath: string): DiscoveredProject {
    return {
        absolutePath: '/repo/' + name,
        relPath,
        name,
        packageManager: 'npm',
        nvmrcVersion: null,
        gitBranch: null,
        ecosystems: ['npm']
    }
}

function finding(overrides: Partial<RawFinding> = {}): RawFinding {
    return {
        advisoryId: 'GHSA-1',
        advisoryTitle: 'Prototype pollution',
        advisoryUrl: 'https://example.test/GHSA-1',
        packageName: 'lodash',
        installedVersion: '4.17.11',
        vulnerableRange: '>=4.0.0 <4.17.21',
        severity: 'high',
        fixAvailable: true,
        fixVersion: '4.17.21',
        depPath: ['lodash'],
        isProd: true,
        isDev: false,
        ...overrides
    }
}

function outcome(overrides: Partial<ScannerOutcome> = {}): ScannerOutcome {
    return { scanner: 'osv', status: 'ok', reasonCode: 'ok', errorText: null, durationMs: 1, ...overrides }
}

function result(
    proj: DiscoveredProject,
    findings: RawFinding[],
    outcomes: ScannerOutcome[] = [outcome()]
): ProjectScanResult {
    return { project: proj, findings, outcomes }
}

describe('summarize — counting', function () {
    it('counts findings per project and in total, bucketed by severity', function () {
        const summary = summarize(
            [
                result(project('a', 'a'), [finding({ severity: 'high' }), finding({ advisoryId: 'GHSA-2', severity: 'low' })]),
                result(project('b', 'b'), [finding({ advisoryId: 'GHSA-3', severity: 'high' })])
            ],
            optionsWith([])
        )

        expect(summary.totalFindings).toBe(3)
        expect(summary.counts).toEqual({ critical: 0, high: 2, moderate: 0, low: 1, info: 0 })
        expect(summary.projects[0]?.findingCount).toBe(2)
        expect(summary.projects[1]?.findingCount).toBe(1)
        expect(summary.projects[0]?.counts.high).toBe(1)
    })

    it('reports a project with no findings rather than dropping it', function () {
        const summary = summarize([result(project('clean', 'clean'), [])], optionsWith([]))
        expect(summary.projects).toHaveLength(1)
        expect(summary.projects[0]?.findingCount).toBe(0)
        expect(summary.totalFindings).toBe(0)
    })

    // "0 findings" and "nothing could be checked" must never look the same in the output.
    it('carries non-ok scanner outcomes through as unauditable entries', function () {
        const summary = summarize(
            [
                result(project('a', 'a'), [], [
                    outcome({ scanner: 'npm-audit', status: 'unauditable', reasonCode: 'unsupported_lockfile', errorText: 'yarn' }),
                    outcome({ scanner: 'osv', status: 'ok' })
                ])
            ],
            optionsWith([])
        )

        expect(summary.projects[0]?.unauditable).toEqual([
            { scanner: 'npm-audit', reasonCode: 'unsupported_lockfile', errorText: 'yarn' }
        ])
    })
})

describe('summarize — filtering', function () {
    const findings = [
        finding({ advisoryId: 'P', isProd: true, isDev: false }),
        finding({ advisoryId: 'D', isProd: false, isDev: true })
    ]

    it('keeps everything under --dep-type all', function () {
        expect(summarize([result(project('a', 'a'), findings)], optionsWith([])).totalFindings).toBe(2)
    })

    it('narrows to production dependencies under --dep-type prod', function () {
        const summary = summarize([result(project('a', 'a'), findings)], optionsWith(['--dep-type=prod']))
        expect(summary.totalFindings).toBe(1)
        expect(summary.findings[0]?.advisoryId).toBe('P')
    })

    it('narrows to dev dependencies under --dep-type dev', function () {
        const summary = summarize([result(project('a', 'a'), findings)], optionsWith(['--dep-type=dev']))
        expect(summary.findings[0]?.advisoryId).toBe('D')
    })

    it('drops findings below the --severity floor', function () {
        const mixed = [
            finding({ advisoryId: 'C', severity: 'critical' }),
            finding({ advisoryId: 'H', severity: 'high' }),
            finding({ advisoryId: 'L', severity: 'low' })
        ]
        const summary = summarize([result(project('a', 'a'), mixed)], optionsWith(['--severity=high']))
        expect(summary.totalFindings).toBe(2)
        expect(summary.findings.map(function id(f) { return f.advisoryId })).toEqual(['C', 'H'])
    })

    // Filtering is a reporting concern; the project list itself must stay complete so the reader can
    // still see that a project was scanned and came back clean under the current filter.
    it('still lists a project whose findings were entirely filtered out', function () {
        const summary = summarize(
            [result(project('a', 'a'), [finding({ severity: 'low' })])],
            optionsWith(['--severity=critical'])
        )
        expect(summary.projects).toHaveLength(1)
        expect(summary.projects[0]?.findingCount).toBe(0)
        expect(summary.totalFindings).toBe(0)
    })
})

describe('summarize — project attribution', function () {
    it('labels a finding with the project relative path', function () {
        const summary = summarize([result(project('web', 'apps/web'), [finding()])], optionsWith([]))
        expect(summary.findings[0]?.projectName).toBe('apps/web')
    })

    // When the scan root IS the project, relPath is '.', which would be a useless label.
    it('falls back to the project name when the project is the root itself', function () {
        const summary = summarize([result(project('myrepo', '.'), [finding()])], optionsWith([]))
        expect(summary.findings[0]?.projectName).toBe('myrepo')
    })
})

describe('shouldFail — the exit-code gate', function () {
    function summaryWith(counts: Partial<Record<string, number>>, total: number) {
        return {
            projects: [],
            totalFindings: total,
            counts: { critical: 0, high: 0, moderate: 0, low: 0, info: 0, ...counts },
            findings: []
        } as Parameters<typeof shouldFail>[0]
    }

    // Findings alone are a report, not a failure — the gate only applies when asked for.
    it('never fails under the default of none', function () {
        expect(shouldFail(summaryWith({ critical: 99 }, 99), 'none')).toBe(false)
    })

    it('fails on any finding under any', function () {
        expect(shouldFail(summaryWith({ info: 1 }, 1), 'any')).toBe(true)
        expect(shouldFail(summaryWith({}, 0), 'any')).toBe(false)
    })

    it('fails when a finding is at or above the named severity', function () {
        expect(shouldFail(summaryWith({ critical: 1 }, 1), 'high')).toBe(true)
        expect(shouldFail(summaryWith({ high: 1 }, 1), 'high')).toBe(true)
    })

    it('does not fail when every finding is below the named severity', function () {
        expect(shouldFail(summaryWith({ moderate: 5, low: 5 }, 10), 'high')).toBe(false)
    })

    it('does not fail on an empty run regardless of threshold', function () {
        expect(shouldFail(summaryWith({}, 0), 'critical')).toBe(false)
        expect(shouldFail(summaryWith({}, 0), 'info')).toBe(false)
    })
})

describe('renderJson', function () {
    function parsed(argv: string[], results: ProjectScanResult[]) {
        const options = optionsWith(argv)
        return JSON.parse(renderJson(summarize(results, options), options, GENERATED_AT))
    }

    it('emits the run metadata alongside a flat findings array', function () {
        const doc = parsed(['--dep-type=prod', '--severity=high'], [result(project('a', 'apps/a'), [finding()])])

        expect(doc.generatedAt).toBe('2026-03-04T05:06:07.000Z')
        expect(doc.depType).toBe('prod')
        expect(doc.minSeverity).toBe('high')
        expect(doc.totalFindings).toBe(1)
        expect(doc.totals).toEqual({ critical: 0, high: 1, moderate: 0, low: 0, info: 0 })
        expect(doc.findings).toHaveLength(1)
        expect(doc.findings[0].packageName).toBe('lodash')
    })

    it('reports each project with its path and counts', function () {
        const doc = parsed([], [result(project('a', 'apps/a'), [finding()])])
        expect(doc.projects).toEqual([
            {
                name: 'a',
                path: 'apps/a',
                findingCount: 1,
                counts: { critical: 0, high: 1, moderate: 0, low: 0, info: 0 },
                unauditable: []
            }
        ])
    })

    it('is valid JSON terminated by a newline, so it pipes cleanly', function () {
        const options = optionsWith([])
        const text = renderJson(summarize([], options), options, GENERATED_AT)
        expect(text.endsWith('\n')).toBe(true)
        expect(function reparse() {
            JSON.parse(text)
        }).not.toThrow()
    })

    it('is deterministic for a fixed instant', function () {
        const options = optionsWith([])
        const results = [result(project('a', 'a'), [finding()])]
        const first = renderJson(summarize(results, options), options, GENERATED_AT)
        const second = renderJson(summarize(results, options), options, GENERATED_AT)
        expect(first).toBe(second)
    })
})

// stdout carries the advisory document a user may pipe straight into an agent, so "findings alone"
// has to mean exactly that. Two spellings clear the flag — `--no-prompt` and `--prompt none` — and a
// regression in either one prepends several hundred words of agent instructions to a document the
// caller asked to be data.
describe('resolvePrompt', function () {
    it('returns nothing for --no-prompt', async function () {
        expect(await resolvePrompt(optionsWith(['--no-prompt']))).toBe('')
    })

    it('returns nothing for --prompt none', async function () {
        expect(await resolvePrompt(optionsWith(['--prompt', 'none']))).toBe('')
    })

    // The contrast that makes the two assertions above mean something: absent either flag, the
    // built-in prompt IS included, so an empty string is a decision rather than the default.
    it('returns the built-in prompt by default', async function () {
        expect(await resolvePrompt(optionsWith([]))).toBe(DEFAULT_EXPORT_PROMPT)
    })
})

describe('defaultOutputFilename', function () {
    it('stamps the generated date into the filename', function () {
        expect(defaultOutputFilename(optionsWith([]), GENERATED_AT)).toContain('2026-03-04')
    })

    it('is stable for the same instant', function () {
        const options = optionsWith([])
        expect(defaultOutputFilename(options, GENERATED_AT)).toBe(defaultOutputFilename(options, GENERATED_AT))
    })
})
