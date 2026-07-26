import { describe, expect, it } from 'vitest'
import { matchAdvisories } from './matcher'
import { semverComparator } from './comparators/semver'
import type { CanonicalAdvisory, CanonicalRange } from './types'
import type { ResolvedPackage } from '../resolver/types'

const SEMVER_TYPES = ['SEMVER', 'ECOSYSTEM']

function pkg(name: string, version: string): ResolvedPackage {
    return {
        ecosystem: 'npm',
        name,
        version,
        scope: { isProd: true, isDev: false, isOptional: false },
        depPaths: [name]
    }
}

function advisory(id: string, overrides: Partial<CanonicalAdvisory> = {}): CanonicalAdvisory {
    return {
        id,
        source: 'osv',
        aliases: [],
        ecosystem: 'npm',
        packageName: 'lodash',
        affected: { ranges: [], exactVersions: [] },
        kind: 'vulnerability',
        severity: 'HIGH',
        summary: 'a summary',
        url: 'https://osv.dev/vulnerability/' + id,
        withdrawn: null,
        ...overrides
    }
}

function range(introduced: string, fixed: string | null, overrides: Partial<CanonicalRange> = {}): CanonicalRange {
    return { type: 'SEMVER', introduced, fixed, ...overrides }
}

function match(packages: ResolvedPackage[], advisories: CanonicalAdvisory[], acceptedTypes?: string[]) {
    const byPackage = new Map<string, CanonicalAdvisory[]>()
    for (const adv of advisories) {
        const existing = byPackage.get(adv.packageName)
        if (existing) {
            existing.push(adv)
            continue
        }
        byPackage.set(adv.packageName, [adv])
    }
    return matchAdvisories(packages, byPackage, semverComparator, acceptedTypes)
}

describe('matchAdvisories — half-open [introduced, fixed) ranges', function () {
    it('flags a version inside the range', function () {
        const findings = match([pkg('lodash', '4.17.11')], [advisory('GHSA-1', { affected: { ranges: [range('4.0.0', '4.17.21')], exactVersions: [] } })])
        expect(findings).toHaveLength(1)
        expect(findings[0]?.packageName).toBe('lodash')
        expect(findings[0]?.installedVersion).toBe('4.17.11')
    })

    // The upper bound is EXCLUSIVE. This is the single most consequential assertion in the engine:
    // getting it wrong reports every already-patched install as vulnerable.
    it('does not flag the fixed version itself', function () {
        const findings = match([pkg('lodash', '4.17.21')], [advisory('GHSA-1', { affected: { ranges: [range('4.0.0', '4.17.21')], exactVersions: [] } })])
        expect(findings).toEqual([])
    })

    it('does not flag a version above the fix', function () {
        const findings = match([pkg('lodash', '4.17.22')], [advisory('GHSA-1', { affected: { ranges: [range('4.0.0', '4.17.21')], exactVersions: [] } })])
        expect(findings).toEqual([])
    })

    it('flags the introduced version itself, since the lower bound is inclusive', function () {
        const findings = match([pkg('lodash', '4.0.0')], [advisory('GHSA-1', { affected: { ranges: [range('4.0.0', '4.17.21')], exactVersions: [] } })])
        expect(findings).toHaveLength(1)
    })

    it('does not flag a version below the introduced bound', function () {
        const findings = match([pkg('lodash', '3.9.9')], [advisory('GHSA-1', { affected: { ranges: [range('4.0.0', '4.17.21')], exactVersions: [] } })])
        expect(findings).toEqual([])
    })

    // OSV writes an unbounded lower edge as the literal string '0', which is not valid semver.
    it("treats an introduced bound of '0' as 0.0.0", function () {
        const findings = match([pkg('lodash', '0.1.0')], [advisory('GHSA-1', { affected: { ranges: [range('0', '1.0.0')], exactVersions: [] } })])
        expect(findings).toHaveLength(1)
        expect(findings[0]?.vulnerableRange).toBe('>=0 <1.0.0')
    })
})

describe('matchAdvisories — open-ended and last_affected ranges', function () {
    // last_affected is INCLUSIVE, unlike fixed. Used by ecosystems whose advisories have no clean fix.
    it('treats lastAffected as an inclusive upper bound', function () {
        const adv = advisory('GHSA-1', {
            affected: { ranges: [range('1.0.0', null, { lastAffected: '1.5.0' })], exactVersions: [] }
        })
        expect(match([pkg('lodash', '1.5.0')], [adv])).toHaveLength(1)
        expect(match([pkg('lodash', '1.5.1')], [adv])).toEqual([])
    })

    it('flags everything at or above introduced when neither fixed nor lastAffected is given', function () {
        const adv = advisory('GHSA-1', { affected: { ranges: [range('1.0.0', null)], exactVersions: [] } })
        expect(match([pkg('lodash', '99.0.0')], [adv])).toHaveLength(1)
        expect(match([pkg('lodash', '0.9.0')], [adv])).toEqual([])
    })

    it('reports no fix for an open-ended range', function () {
        const adv = advisory('GHSA-1', { affected: { ranges: [range('1.0.0', null)], exactVersions: [] } })
        const findings = match([pkg('lodash', '2.0.0')], [adv])
        expect(findings[0]?.fixAvailable).toBe(false)
        expect(findings[0]?.fixVersion).toBeNull()
    })
})

describe('matchAdvisories — fix selection across multiple ranges', function () {
    it('uses the single fixed boundary when there is only one range', function () {
        const adv = advisory('GHSA-1', { affected: { ranges: [range('1.0.0', '2.0.0')], exactVersions: [] } })
        const findings = match([pkg('lodash', '1.5.0')], [adv])
        expect(findings[0]?.fixVersion).toBe('2.0.0')
        expect(findings[0]?.fixAvailable).toBe(true)
    })

    // The suggested fix must escape the ENTIRE vulnerable union, not merely the lowest `fixed`
    // boundary. With overlapping ranges the union here spans [1.0.0, 4.0.0), so 2.0.0 and 3.0.0 are
    // both still vulnerable and must be rejected even though 2.0.0 is the lowest boundary present.
    it('rejects a boundary that is still inside another overlapping range', function () {
        const adv = advisory('GHSA-1', {
            affected: {
                ranges: [range('1.0.0', '3.0.0'), range('1.0.0', '2.0.0'), range('1.0.0', '4.0.0')],
                exactVersions: []
            }
        })
        const findings = match([pkg('lodash', '1.5.0')], [adv])
        expect(findings).toHaveLength(1)
        expect(findings[0]?.fixVersion).toBe('4.0.0')
    })

    // Disjoint ranges leave a genuine gap, so the lower boundary really is safe and wins.
    it('picks the lowest safe boundary when the ranges are disjoint', function () {
        const adv = advisory('GHSA-1', {
            affected: { ranges: [range('1.0.0', '2.0.0'), range('5.0.0', '6.0.0')], exactVersions: [] }
        })
        const findings = match([pkg('lodash', '1.5.0')], [adv])
        expect(findings[0]?.fixVersion).toBe('2.0.0')
    })

    // Never suggest a downgrade: the installed version is a floor.
    it('never suggests a version below the installed one', function () {
        const adv = advisory('GHSA-1', {
            affected: { ranges: [range('1.0.0', '2.0.0'), range('5.0.0', '6.0.0')], exactVersions: [] }
        })
        const findings = match([pkg('lodash', '5.5.0')], [adv])
        expect(findings[0]?.fixVersion).toBe('6.0.0')
    })
})

describe('matchAdvisories — enumerated exact versions', function () {
    it('flags an exactly enumerated version', function () {
        const adv = advisory('MAL-1', { affected: { ranges: [], exactVersions: ['4.4.2'] } })
        expect(match([pkg('lodash', '4.4.2')], [adv])).toHaveLength(1)
    })

    it('does not flag a neighbouring version', function () {
        const adv = advisory('MAL-1', { affected: { ranges: [], exactVersions: ['4.4.2'] } })
        expect(match([pkg('lodash', '4.4.3')], [adv])).toEqual([])
    })

    // Enumerated versions match either raw-equal or normalized-equal, so a 'v'-prefixed record still hits.
    it('matches after normalisation, so a v-prefix still counts', function () {
        const adv = advisory('MAL-1', { affected: { ranges: [], exactVersions: ['v4.4.2'] } })
        expect(match([pkg('lodash', '4.4.2')], [adv])).toHaveLength(1)
    })

    it('renders enumerated versions with an = prefix', function () {
        const adv = advisory('MAL-1', { affected: { ranges: [], exactVersions: ['4.4.2'] } })
        expect(match([pkg('lodash', '4.4.2')], [adv])[0]?.vulnerableRange).toBe('=4.4.2')
    })
})

describe('matchAdvisories — malware', function () {
    it('forces critical severity regardless of the advisory severity', function () {
        const adv = advisory('MAL-1', {
            kind: 'malware',
            severity: 'LOW',
            affected: { ranges: [], exactVersions: ['1.0.0'] }
        })
        expect(match([pkg('discord.dll', '1.0.0')], [{ ...adv, packageName: 'discord.dll' }])[0]?.severity).toBe('critical')
    })

    // A known-bad package with an unbounded record is better loud than silent.
    it('surfaces a malware advisory that carries no version data at all', function () {
        const adv = advisory('MAL-1', { kind: 'malware', affected: { ranges: [], exactVersions: [] } })
        const findings = match([pkg('lodash', '1.0.0')], [adv])
        expect(findings).toHaveLength(1)
        expect(findings[0]?.severity).toBe('critical')
        expect(findings[0]?.vulnerableRange).toBe('*')
    })

    // ...but a regular vulnerability with no version data must NOT claim a clean version is affected.
    it('skips a non-malware advisory that carries no version data', function () {
        const adv = advisory('GHSA-1', { affected: { ranges: [], exactVersions: [] } })
        expect(match([pkg('lodash', '1.0.0')], [adv])).toEqual([])
    })

    // Malware is otherwise matched by version like anything else — flagging by package presence alone
    // is what previously reported clean installs as compromised.
    it('still respects the version list for malware that enumerates versions', function () {
        const adv = advisory('MAL-1', { kind: 'malware', affected: { ranges: [], exactVersions: ['1.0.0'] } })
        expect(match([pkg('lodash', '2.0.0')], [adv])).toEqual([])
    })
})

describe('matchAdvisories — range type filtering', function () {
    it('drops a range whose type the comparator does not accept', function () {
        const adv = advisory('GHSA-1', {
            affected: { ranges: [range('1.0.0', '2.0.0', { type: 'GIT' })], exactVersions: [] }
        })
        expect(match([pkg('lodash', '1.5.0')], [adv], SEMVER_TYPES)).toEqual([])
    })

    it('drops an untyped range when filtering is active', function () {
        const adv = advisory('GHSA-1', {
            affected: { ranges: [{ introduced: '1.0.0', fixed: '2.0.0' }], exactVersions: [] }
        })
        expect(match([pkg('lodash', '1.5.0')], [adv], SEMVER_TYPES)).toEqual([])
    })

    it('keeps every range when no accepted types are given', function () {
        const adv = advisory('GHSA-1', {
            affected: { ranges: [{ introduced: '1.0.0', fixed: '2.0.0' }], exactVersions: [] }
        })
        expect(match([pkg('lodash', '1.5.0')], [adv])).toHaveLength(1)
    })

    it('accepts ECOSYSTEM as well as SEMVER for a semver ecosystem', function () {
        const adv = advisory('GHSA-1', {
            affected: { ranges: [range('1.0.0', '2.0.0', { type: 'ECOSYSTEM' })], exactVersions: [] }
        })
        expect(match([pkg('lodash', '1.5.0')], [adv], SEMVER_TYPES)).toHaveLength(1)
    })

    // A dropped range must not leak into the display string or the fix derivation either.
    it('keeps a dropped range out of the rendered vulnerable range', function () {
        const adv = advisory('GHSA-1', {
            affected: {
                ranges: [range('1.0.0', '2.0.0', { type: 'GIT' }), range('1.0.0', '3.0.0')],
                exactVersions: []
            }
        })
        const findings = match([pkg('lodash', '1.5.0')], [adv], SEMVER_TYPES)
        expect(findings).toHaveLength(1)
        expect(findings[0]?.vulnerableRange).toBe('>=1.0.0 <3.0.0')
        expect(findings[0]?.fixVersion).toBe('3.0.0')
    })
})

describe('matchAdvisories — severity mapping', function () {
    function severityFor(raw: string | null): string {
        const adv = advisory('GHSA-1', {
            severity: raw,
            affected: { ranges: [range('1.0.0', '2.0.0')], exactVersions: [] }
        })
        return match([pkg('lodash', '1.5.0')], [adv])[0]?.severity ?? 'MISSING'
    }

    it('lowercases the source vocabulary', function () {
        expect(severityFor('CRITICAL')).toBe('critical')
        expect(severityFor('HIGH')).toBe('high')
        expect(severityFor('MODERATE')).toBe('moderate')
        expect(severityFor('LOW')).toBe('low')
    })

    it('maps MEDIUM onto moderate and NONE onto info', function () {
        expect(severityFor('MEDIUM')).toBe('moderate')
        expect(severityFor('NONE')).toBe('info')
    })

    // Never silently downgrade a real advisory to info just because the vocabulary was unfamiliar.
    it('falls back to moderate for an unknown or absent severity', function () {
        expect(severityFor('spicy')).toBe('moderate')
        expect(severityFor(null)).toBe('moderate')
        expect(severityFor('')).toBe('moderate')
    })
})

describe('matchAdvisories — iteration behaviour', function () {
    it('returns nothing for a package with no advisories', function () {
        expect(match([pkg('lodash', '1.0.0')], [])).toEqual([])
    })

    it('reports the same advisory id only once per package', function () {
        const one = advisory('GHSA-1', { affected: { ranges: [range('1.0.0', '2.0.0')], exactVersions: [] } })
        const duplicate = advisory('GHSA-1', { affected: { ranges: [range('1.0.0', '3.0.0')], exactVersions: [] } })
        expect(match([pkg('lodash', '1.5.0')], [one, duplicate])).toHaveLength(1)
    })

    it('reports distinct advisory ids separately', function () {
        const one = advisory('GHSA-1', { affected: { ranges: [range('1.0.0', '2.0.0')], exactVersions: [] } })
        const two = advisory('GHSA-2', { affected: { ranges: [range('1.0.0', '2.0.0')], exactVersions: [] } })
        expect(match([pkg('lodash', '1.5.0')], [one, two])).toHaveLength(2)
    })

    it('carries the resolved package ecosystem, aliases and dep scope onto the finding', function () {
        const adv = advisory('GHSA-1', {
            aliases: ['CVE-2024-1'],
            affected: { ranges: [range('1.0.0', '2.0.0')], exactVersions: [] }
        })
        const findings = match([pkg('lodash', '1.5.0')], [adv])
        expect(findings[0]?.ecosystem).toBe('npm')
        expect(findings[0]?.aliases).toEqual(['CVE-2024-1'])
        expect(findings[0]?.isProd).toBe(true)
        expect(findings[0]?.isDev).toBe(false)
        expect(findings[0]?.depPath).toEqual(['lodash'])
    })

    // An unparseable installed version must yield no match rather than a false positive.
    it('does not match when the installed version cannot be normalised', function () {
        const adv = advisory('GHSA-1', { affected: { ranges: [range('1.0.0', '2.0.0')], exactVersions: [] } })
        expect(match([pkg('lodash', 'not-a-version')], [adv])).toEqual([])
    })
})
