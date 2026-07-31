import { describe, expect, it } from 'vitest'
import {
    createGemnasiumScanner,
    GEMNASIUM_SCANNER_NAME,
    matchPackages,
    type GemnasiumAdvisory,
    type GemnasiumLookup
} from './gemnasium'
import { makeGraph } from './resolver/graph'
import type { ResolvedPackage } from './resolver/types'
import type { ScanContext } from './types'

// The gemnasium scanner is already dependency-injected — lookup, isSeeded and isEnabled are plain
// functions — so nothing here needs a database.
//
// What matters is the gating, and the two places gemnasium deliberately differs from its OSV twin.
// First, the seed gate is GLOBAL rather than per-ecosystem, because the gemnasium cache is a single
// multi-ecosystem download; it is therefore checked before anything else, including the lockfile.
// Second, a failing lookup is caught and reported under gemnasium's own reason code, so a corrupt
// cache is not mislabelled as an npm-audit failure.
//
// Throughout: "we found nothing" and "we did not look" must stay distinguishable.

function pkg(name: string, version: string, ecosystem = 'npm'): ResolvedPackage {
    return {
        ecosystem,
        name,
        version,
        scope: { isProd: true, isDev: false, isOptional: false },
        depPaths: []
    }
}

function advisory(overrides: Partial<GemnasiumAdvisory> = {}): GemnasiumAdvisory {
    return {
        advisoryId: 'CVE-2024-1',
        aliases: ['GHSA-aaaa-bbbb-cccc'],
        ranges: [{ introduced: '0', fixed: '4.17.21' }],
        versions: [],
        severity: 'high',
        summary: 'Prototype pollution',
        url: 'https://example.test/advisory/1',
        ...overrides
    }
}

// Records which (ecosystem, names) pairs were requested, so a gating test can assert the lookup was
// never consulted rather than only that no findings came back.
function recordingLookup(answers: Record<string, Record<string, GemnasiumAdvisory[]>>) {
    const calls: Array<{ ecosystem: string; names: string[] }> = []
    const lookup: GemnasiumLookup = function lookup(ecosystem, packageNames) {
        calls.push({ ecosystem, names: packageNames })
        const forEco = answers[ecosystem] || {}
        const out = new Map<string, GemnasiumAdvisory[]>()
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

describe('createGemnasiumScanner — gating', function () {
    it('registers under the gemnasium name', function () {
        const { lookup } = recordingLookup({})
        const scanner = createGemnasiumScanner({ lookup, isSeeded: always(true), isEnabled: always(true) })
        expect(scanner.name).toBe(GEMNASIUM_SCANNER_NAME)
    })

    // The distinction that matters most: an unseeded cache must never be reported as zero findings.
    it('reports gemnasium_db_not_seeded rather than zero findings', async function () {
        const { lookup, calls } = recordingLookup({})
        const scanner = createGemnasiumScanner({ lookup, isSeeded: always(false), isEnabled: always(true) })
        const result = await scanner.scan('/p', contextFor([pkg('lodash', '4.17.20')]))
        expect(result.status).toBe('unauditable')
        expect(result.reasonCode).toBe('gemnasium_db_not_seeded')
        expect(result.findings).toEqual([])
        expect(calls).toEqual([])
    })

    // Unlike OSV, whose seed gate is per-ecosystem and therefore evaluated after the graph, gemnasium's
    // single cache means "not seeded" outranks everything — including a missing lockfile.
    it('reports the seed gate ahead of a missing lockfile', async function () {
        const { lookup } = recordingLookup({})
        const scanner = createGemnasiumScanner({ lookup, isSeeded: always(false), isEnabled: always(true) })
        const result = await scanner.scan('/p', { timeoutMs: 1000, resolvedGraph: null })
        expect(result.reasonCode).toBe('gemnasium_db_not_seeded')
    })

    // Fail open: no resolvable lockfile means we cannot claim anything, so say so rather than
    // reporting a clean bill of health.
    it('reports no_lockfile when there is no resolved graph', async function () {
        const { lookup, calls } = recordingLookup({})
        const scanner = createGemnasiumScanner({ lookup, isSeeded: always(true), isEnabled: always(true) })
        const result = await scanner.scan('/p', { timeoutMs: 1000, resolvedGraph: null })
        expect(result.status).toBe('unauditable')
        expect(result.reasonCode).toBe('no_lockfile')
        expect(calls).toEqual([])
    })

    it('reports no_lockfile for an undefined graph too', async function () {
        const { lookup } = recordingLookup({})
        const scanner = createGemnasiumScanner({ lookup, isSeeded: always(true), isEnabled: always(true) })
        const result = await scanner.scan('/p', { timeoutMs: 1000 })
        expect(result.reasonCode).toBe('no_lockfile')
    })

    // A disabled cell must produce nothing even though the shared cache is seeded for every ecosystem.
    it('never consults the lookup for a disabled ecosystem', async function () {
        const { lookup, calls } = recordingLookup({ npm: { lodash: [advisory()] } })
        const scanner = createGemnasiumScanner({ lookup, isSeeded: always(true), isEnabled: always(false) })
        const result = await scanner.scan('/p', contextFor([pkg('lodash', '4.17.20')]))
        expect(result.status).toBe('ok')
        expect(result.findings).toEqual([])
        expect(calls).toEqual([])
    })
})

describe('createGemnasiumScanner — results', function () {
    it('returns a finding for a seeded, enabled, vulnerable package', async function () {
        const { lookup } = recordingLookup({ npm: { lodash: [advisory()] } })
        const scanner = createGemnasiumScanner({ lookup, isSeeded: always(true), isEnabled: always(true) })
        const result = await scanner.scan('/p', contextFor([pkg('lodash', '4.17.20')]))
        expect(result.status).toBe('ok')
        expect(result.reasonCode).toBe('ok')
        expect(result.findings).toHaveLength(1)
        expect(result.findings[0]?.advisoryId).toBe('CVE-2024-1')
    })

    it('reports ok with no findings when the package is already patched', async function () {
        const { lookup } = recordingLookup({ npm: { lodash: [advisory()] } })
        const scanner = createGemnasiumScanner({ lookup, isSeeded: always(true), isEnabled: always(true) })
        const result = await scanner.scan('/p', contextFor([pkg('lodash', '4.17.21')]))
        expect(result.status).toBe('ok')
        expect(result.findings).toEqual([])
    })

    it('summarises the run in rawJson', async function () {
        const { lookup } = recordingLookup({ npm: { lodash: [advisory()] } })
        const scanner = createGemnasiumScanner({ lookup, isSeeded: always(true), isEnabled: always(true) })
        const result = await scanner.scan('/p', contextFor([pkg('lodash', '4.17.20'), pkg('express', '4.0.0')]))
        expect(JSON.parse(result.rawJson)).toMatchObject({
            source: 'gemnasium',
            packageCount: 2,
            findingCount: 1
        })
    })

    it('carries the resolver coverage through into rawJson', async function () {
        const { lookup } = recordingLookup({})
        const scanner = createGemnasiumScanner({ lookup, isSeeded: always(true), isEnabled: always(true) })
        const ctx: ScanContext = {
            ...contextFor([pkg('lodash', '4.17.20')]),
            coverage: [{ ecosystem: 'npm', status: 'ok' }]
        }
        const result = await scanner.scan('/p', ctx)
        expect(JSON.parse(result.rawJson).coverage).toHaveLength(1)
    })

    it('defaults coverage to an empty list when the runner supplied none', async function () {
        const { lookup } = recordingLookup({})
        const scanner = createGemnasiumScanner({ lookup, isSeeded: always(true), isEnabled: always(true) })
        const result = await scanner.scan('/p', contextFor([pkg('lodash', '4.17.20')]))
        expect(JSON.parse(result.rawJson).coverage).toEqual([])
    })

    // A corrupt, locked or removed cache throws inside the injected lookup. Recording it under
    // gemnasium's own reason code keeps the operator pointed at the gemnasium cache rather than at
    // the runner's generic npm-audit fallback.
    it('records a lookup failure under its own reason code', async function () {
        const lookup: GemnasiumLookup = function throwing() {
            throw new Error('database disk image is malformed')
        }
        const scanner = createGemnasiumScanner({ lookup, isSeeded: always(true), isEnabled: always(true) })
        const result = await scanner.scan('/p', contextFor([pkg('lodash', '4.17.20')]))
        expect(result.status).toBe('error')
        expect(result.reasonCode).toBe('gemnasium_db_unavailable')
        expect(result.errorText).toContain('malformed')
        expect(result.findings).toEqual([])
    })

    it('describes a thrown non-Error from the lookup', async function () {
        const lookup: GemnasiumLookup = function throwing() {
            throw 'not an Error instance'
        }
        const scanner = createGemnasiumScanner({ lookup, isSeeded: always(true), isEnabled: always(true) })
        const result = await scanner.scan('/p', contextFor([pkg('lodash', '4.17.20')]))
        expect(result.status).toBe('error')
        expect(result.errorText).toContain('not an Error instance')
    })
})

describe('matchPackages', function () {
    it('asks each ecosystem for only its own package names', function () {
        const { lookup, calls } = recordingLookup({})
        matchPackages([pkg('lodash', '1.0.0', 'npm'), pkg('django', '1.0.0', 'PyPI')], lookup)
        expect(calls).toHaveLength(2)
        expect(calls.find(function npm(c) { return c.ecosystem === 'npm' })?.names).toEqual(['lodash'])
        expect(calls.find(function py(c) { return c.ecosystem === 'PyPI' })?.names).toEqual(['django'])
    })

    it('deduplicates package names before querying', function () {
        const { lookup, calls } = recordingLookup({})
        matchPackages([pkg('lodash', '1.0.0'), pkg('lodash', '2.0.0')], lookup)
        expect(calls[0]?.names).toEqual(['lodash'])
    })

    it('skips an ecosystem with no comparator rather than mis-matching it', function () {
        const { lookup, calls } = recordingLookup({})
        matchPackages([pkg('some-lib', '1.0.0', 'NuGet')], lookup)
        expect(calls).toEqual([])
    })

    it('skips a disabled ecosystem while still querying an enabled one', function () {
        const { lookup, calls } = recordingLookup({})
        matchPackages(
            [pkg('lodash', '1.0.0', 'npm'), pkg('django', '1.0.0', 'PyPI')],
            lookup,
            function isEnabled(eco) {
                return eco === 'npm'
            }
        )
        expect(calls.map(function eco(c) { return c.ecosystem })).toEqual(['npm'])
    })

    it('matches an exact enumerated version as well as a range', function () {
        const { lookup } = recordingLookup({
            npm: { lodash: [advisory({ ranges: [], versions: ['4.17.20'] })] }
        })
        expect(matchPackages([pkg('lodash', '4.17.20')], lookup)).toHaveLength(1)
        expect(matchPackages([pkg('lodash', '4.17.21')], lookup)).toEqual([])
    })

    it('treats a null fixed bound as vulnerable with no known fix', function () {
        const { lookup } = recordingLookup({
            npm: { lodash: [advisory({ ranges: [{ introduced: '1.0.0', fixed: null }] })] }
        })
        expect(matchPackages([pkg('lodash', '99.0.0')], lookup)).toHaveLength(1)
    })

    // PyPI is matched with PEP 440 rather than semver, so a version the semver comparator could not
    // read still matches.
    it('uses the PEP 440 comparator for PyPI', function () {
        const { lookup } = recordingLookup({
            PyPI: { django: [advisory({ ranges: [{ introduced: '0', fixed: '3.2.14' }] })] }
        })
        expect(matchPackages([pkg('django', '3.2.13rc1', 'PyPI')], lookup)).toHaveLength(1)
    })

    it('returns nothing for an empty package list', function () {
        const { lookup, calls } = recordingLookup({})
        expect(matchPackages([], lookup)).toEqual([])
        expect(calls).toEqual([])
    })

    it('carries the advisory aliases through for later reconciliation', function () {
        const { lookup } = recordingLookup({ npm: { lodash: [advisory()] } })
        const findings = matchPackages([pkg('lodash', '4.17.20')], lookup)
        expect(findings[0]?.aliases).toContain('GHSA-aaaa-bbbb-cccc')
    })
})
