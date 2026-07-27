import { describe, expect, it } from 'vitest'
import { createOsvScanner, matchPackages, OSV_SCANNER_NAME, type OsvAdvisory, type OsvLookup } from './osv'
import { makeGraph } from './resolver/graph'
import type { ResolvedPackage } from './resolver/types'
import type { ScanContext } from './types'

// The scanner is already dependency-injected — `lookup`, `isSeeded` and `isEnabled` are plain functions
// — so nothing here needs mocking or a database. What matters is the gating: a disabled or unseeded
// ecosystem must contribute NOTHING, and an unseeded database must not be reported as "zero findings",
// because "we found nothing" and "we did not look" are very different claims to make to an operator.

function pkg(name: string, version: string, ecosystem = 'npm'): ResolvedPackage {
    return {
        ecosystem,
        name,
        version,
        scope: { isProd: true, isDev: false, isOptional: false },
        depPaths: []
    }
}

function advisory(overrides: Partial<OsvAdvisory> = {}): OsvAdvisory {
    return {
        advisoryId: 'GHSA-1',
        aliases: ['CVE-2024-1'],
        ranges: [{ type: 'SEMVER', introduced: '0', fixed: '4.17.21', lastAffected: null }],
        versions: [],
        severity: 'high',
        summary: 'Prototype pollution',
        url: 'https://ghsa.example/1',
        malicious: false,
        ...overrides
    }
}

// Records which (ecosystem, names) pairs the scanner asked for, so the gating tests can assert the
// lookup was never even consulted rather than only that no findings came back.
function recordingLookup(answers: Record<string, Record<string, OsvAdvisory[]>>) {
    const calls: Array<{ ecosystem: string; names: string[] }> = []
    const lookup: OsvLookup = function lookup(ecosystem, packageNames) {
        calls.push({ ecosystem, names: packageNames })
        const forEco = answers[ecosystem] || {}
        const out = new Map<string, OsvAdvisory[]>()
        for (const name of packageNames) {
            const found = forEco[name]
            if (found) out.set(name, found)
        }
        return out
    }
    return { lookup, calls }
}

function always(value: boolean) {
    return function gate(): boolean {
        return value
    }
}

function contextFor(packages: ResolvedPackage[]): ScanContext {
    return { timeoutMs: 1000, resolvedGraph: makeGraph(packages) }
}

describe('createOsvScanner', function () {
    it('registers under the osv name', function () {
        const { lookup } = recordingLookup({})
        expect(createOsvScanner({ lookup, isSeeded: always(true), isEnabled: always(true) }).name).toBe(OSV_SCANNER_NAME)
    })

    // Fail open, same posture as the lockfile cross-check: no resolvable lockfile means we cannot
    // claim anything, so say so rather than reporting a clean bill of health.
    it('reports no_lockfile when there is no resolved graph', async function () {
        const { lookup, calls } = recordingLookup({})
        const scanner = createOsvScanner({ lookup, isSeeded: always(true), isEnabled: always(true) })
        const result = await scanner.scan('/p', { timeoutMs: 1000, resolvedGraph: null })
        expect(result.status).toBe('unauditable')
        expect(result.reasonCode).toBe('no_lockfile')
        expect(result.findings).toEqual([])
        expect(calls).toEqual([])
    })

    // The distinction that matters most: an unseeded database must never be reported as zero findings.
    it('reports osv_db_not_seeded rather than zero findings when nothing is seeded', async function () {
        const { lookup } = recordingLookup({})
        const scanner = createOsvScanner({ lookup, isSeeded: always(false), isEnabled: always(true) })
        const result = await scanner.scan('/p', contextFor([pkg('lodash', '4.17.20')]))
        expect(result.status).toBe('unauditable')
        expect(result.reasonCode).toBe('osv_db_not_seeded')
    })

    // With no enabled ecosystem there is nothing this source claims to cover, so the seed gate does not
    // apply and an ordinary empty 'ok' is the honest answer.
    it('returns ok when every ecosystem is disabled, even if unseeded', async function () {
        const { lookup } = recordingLookup({})
        const scanner = createOsvScanner({ lookup, isSeeded: always(false), isEnabled: always(false) })
        const result = await scanner.scan('/p', contextFor([pkg('lodash', '4.17.20')]))
        expect(result.status).toBe('ok')
        expect(result.findings).toEqual([])
    })

    it('returns findings for a seeded, enabled ecosystem', async function () {
        const { lookup } = recordingLookup({ npm: { lodash: [advisory()] } })
        const scanner = createOsvScanner({ lookup, isSeeded: always(true), isEnabled: always(true) })
        const result = await scanner.scan('/p', contextFor([pkg('lodash', '4.17.20')]))
        expect(result.status).toBe('ok')
        expect(result.reasonCode).toBe('ok')
        expect(result.findings).toHaveLength(1)
        expect(result.findings[0]?.advisoryId).toBe('GHSA-1')
    })

    it('records the package and finding counts plus coverage in rawJson', async function () {
        const { lookup } = recordingLookup({ npm: { lodash: [advisory()] } })
        const scanner = createOsvScanner({ lookup, isSeeded: always(true), isEnabled: always(true) })
        const ctx: ScanContext = {
            ...contextFor([pkg('lodash', '4.17.20'), pkg('express', '4.0.0')]),
            coverage: [{ ecosystem: 'npm', status: 'ok' }]
        }
        const result = await scanner.scan('/p', ctx)
        expect(JSON.parse(result.rawJson)).toEqual({
            source: 'osv',
            packageCount: 2,
            findingCount: 1,
            coverage: [{ ecosystem: 'npm', status: 'ok' }]
        })
    })

    it('defaults coverage to an empty list when the runner supplied none', async function () {
        const { lookup } = recordingLookup({})
        const scanner = createOsvScanner({ lookup, isSeeded: always(true), isEnabled: always(true) })
        const result = await scanner.scan('/p', contextFor([pkg('lodash', '4.17.20')]))
        expect(JSON.parse(result.rawJson).coverage).toEqual([])
    })
})

describe('matchPackages gating', function () {
    it('skips an ecosystem whose cell is disabled without consulting the lookup', function () {
        const { lookup, calls } = recordingLookup({ npm: { lodash: [advisory()] } })
        const findings = matchPackages([pkg('lodash', '4.17.20')], lookup, always(true), always(false))
        expect(findings).toEqual([])
        expect(calls).toEqual([])
    })

    it('skips an unseeded ecosystem without consulting the lookup', function () {
        const { lookup, calls } = recordingLookup({ npm: { lodash: [advisory()] } })
        const findings = matchPackages([pkg('lodash', '4.17.20')], lookup, always(false), always(true))
        expect(findings).toEqual([])
        expect(calls).toEqual([])
    })

    // Disabled is checked before seeded, so a disabled-yet-seeded ecosystem is skipped entirely.
    it('matches only the enabled ecosystem in a polyglot graph', function () {
        const { lookup, calls } = recordingLookup({
            npm: { lodash: [advisory()] },
            PyPI: { requests: [advisory({ advisoryId: 'PYSEC-1' })] }
        })
        const findings = matchPackages(
            [pkg('lodash', '4.17.20'), pkg('requests', '2.0.0', 'PyPI')],
            lookup,
            always(true),
            function isEnabled(ecosystem) {
                return ecosystem === 'npm'
            }
        )
        expect(calls.map(function eco(c) { return c.ecosystem })).toEqual(['npm'])
        expect(findings.map(function id(f) { return f.advisoryId })).toEqual(['GHSA-1'])
    })

    it('treats the gates as optional', function () {
        const { lookup } = recordingLookup({ npm: { lodash: [advisory()] } })
        expect(matchPackages([pkg('lodash', '4.17.20')], lookup)).toHaveLength(1)
    })

    it('skips an ecosystem with no comparator implemented', function () {
        const { lookup, calls } = recordingLookup({})
        expect(matchPackages([pkg('thing', '1.0.0', 'Hackage')], lookup, always(true), always(true))).toEqual([])
        expect(calls).toEqual([])
    })

    it('does not call the lookup for an empty package list', function () {
        const { lookup, calls } = recordingLookup({})
        expect(matchPackages([], lookup, always(true), always(true))).toEqual([])
        expect(calls).toEqual([])
    })

    it('asks for each distinct package name once', function () {
        const { lookup, calls } = recordingLookup({})
        matchPackages([pkg('lodash', '4.17.20'), pkg('lodash', '4.17.19')], lookup, always(true), always(true))
        expect(calls[0]?.names).toEqual(['lodash'])
    })
})

describe('matchPackages advisory normalization', function () {
    it('carries the advisory metadata onto the finding', function () {
        const { lookup } = recordingLookup({ npm: { lodash: [advisory()] } })
        const findings = matchPackages([pkg('lodash', '4.17.20')], lookup, always(true), always(true))
        expect(findings[0]).toMatchObject({
            advisoryId: 'GHSA-1',
            packageName: 'lodash',
            installedVersion: '4.17.20',
            advisoryUrl: 'https://ghsa.example/1',
            severity: 'high'
        })
    })

    // Aliases are what lets the worker suppress an OSV finding npm-audit already reported for the same
    // CVE, so they must survive normalization.
    it('carries aliases through so cross-source dedup can work', function () {
        const { lookup } = recordingLookup({ npm: { lodash: [advisory()] } })
        const findings = matchPackages([pkg('lodash', '4.17.20')], lookup, always(true), always(true))
        expect(findings[0]?.aliases).toEqual(['CVE-2024-1'])
    })

    it('does not report a version outside the vulnerable range', function () {
        const { lookup } = recordingLookup({ npm: { lodash: [advisory()] } })
        expect(matchPackages([pkg('lodash', '4.17.21')], lookup, always(true), always(true))).toEqual([])
    })

    it('matches an advisory that enumerates exact affected versions', function () {
        const mal = advisory({ advisoryId: 'MAL-2024-1', ranges: [], versions: ['1.0.0'], malicious: true })
        const { lookup } = recordingLookup({ npm: { evil: [mal] } })
        expect(matchPackages([pkg('evil', '1.0.0')], lookup, always(true), always(true))).toHaveLength(1)
        expect(matchPackages([pkg('evil', '1.0.1')], lookup, always(true), always(true))).toEqual([])
    })

    it('reports nothing when the lookup knows the ecosystem but not the package', function () {
        const { lookup } = recordingLookup({ npm: { other: [advisory()] } })
        expect(matchPackages([pkg('lodash', '4.17.20')], lookup, always(true), always(true))).toEqual([])
    })
})
