import { describe, expect, it, vi } from 'vitest'
import type { ResolvedPackage } from './resolver/types'

// One tripwire, in its own file because it needs the comparator registry intercepted — osv.test.ts
// deliberately mocks nothing, since the scanner is already dependency-injected everywhere else.
//
// matchPackages asks the registry for the OSV range types an ecosystem's comparator may evaluate. That
// answer is non-null for every ecosystem that HAS a comparator today, because both come from the same
// registry entry — so the `?? []` beside it is unreachable from any real configuration. It is kept
// because of which way it fails: a comparator registered without a declared accepted-types entry would,
// without the guard, evaluate range types its version semantics do not understand, and match the wrong
// versions rather than throwing. Refusing to match anything is the safe direction, and this asserts the
// guard actually points that way.

vi.mock('./engine/comparators', async function mockComparators(importOriginal) {
    const actual = await importOriginal<typeof import('./engine/comparators')>()
    return {
        ...actual,
        // The comparator still resolves — this is the exact "registered, but nobody declared its range
        // types" shape, not a missing comparator (which the guard above this one already handles).
        acceptedRangeTypesForEcosystem: function acceptedRangeTypesForEcosystem() {
            return null
        }
    }
})

const { matchPackages } = await import('./osv')

function pkg(name: string, version: string): ResolvedPackage {
    return {
        ecosystem: 'npm',
        name,
        version,
        scope: { isProd: true, isDev: false, isOptional: false },
        depPaths: []
    }
}

describe('a comparator with no declared accepted range types', function () {
    it('matches nothing rather than evaluating range types it cannot interpret', function () {
        const advisories = new Map([
            [
                'lodash',
                [
                    {
                        advisoryId: 'GHSA-1',
                        aliases: [],
                        // A range the semver comparator would ordinarily match 4.17.11 against.
                        ranges: [{ type: 'SEMVER', introduced: '0', fixed: '4.17.21', lastAffected: null }],
                        versions: [],
                        severity: 'high',
                        summary: null,
                        url: null,
                        malicious: false,
                        withdrawn: null
                    }
                ]
            ]
        ])

        const findings = matchPackages([pkg('lodash', '4.17.11')], function lookup() {
            return advisories as never
        })

        expect(findings).toEqual([])
    })
})
