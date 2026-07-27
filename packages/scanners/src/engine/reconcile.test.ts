import { describe, expect, it } from 'vitest'
import { findingIdentityKeys, reconcileAgainstReported } from './reconcile'
import type { RawFinding } from '../types'

function finding(overrides: Partial<RawFinding> = {}): RawFinding {
    return {
        advisoryId: 'GHSA-1',
        advisoryTitle: null,
        advisoryUrl: null,
        packageName: 'lodash',
        installedVersion: '1.0.0',
        vulnerableRange: '>=1.0.0 <2.0.0',
        severity: 'high',
        fixAvailable: false,
        fixVersion: null,
        depPath: [],
        isProd: true,
        isDev: false,
        ...overrides
    }
}

describe('findingIdentityKeys', function () {
    it('includes the advisory id, lower-cased', function () {
        expect(findingIdentityKeys(finding({ advisoryId: 'GHSA-ABC' }))).toEqual(['ghsa-abc'])
    })

    it('includes every alias, lower-cased', function () {
        const keys = findingIdentityKeys(finding({ advisoryId: 'GHSA-1', aliases: ['CVE-2024-1', 'GHSA-2'] }))
        expect(keys).toEqual(['ghsa-1', 'cve-2024-1', 'ghsa-2'])
    })
})

describe('reconcileAgainstReported', function () {
    it('keeps a finding nothing has reported yet', function () {
        const reported = new Map<string, Set<string>>()
        expect(reconcileAgainstReported([finding()], reported)).toHaveLength(1)
    })

    it('records survivors so a later pass dedups against them', function () {
        const reported = new Map<string, Set<string>>()
        reconcileAgainstReported([finding({ advisoryId: 'GHSA-1' })], reported)
        expect(reconcileAgainstReported([finding({ advisoryId: 'GHSA-1' })], reported)).toEqual([])
    })

    // The whole point of the alias set: npm-audit's id and OSV's GHSA id for one CVE must collapse.
    it('drops a later finding that matches an earlier one only by alias', function () {
        const reported = new Map<string, Set<string>>()
        reconcileAgainstReported([finding({ advisoryId: '1234', aliases: ['CVE-2024-1'] })], reported)
        const second = reconcileAgainstReported([finding({ advisoryId: 'GHSA-9', aliases: ['CVE-2024-1'] })], reported)
        expect(second).toEqual([])
    })

    it('ignores casing when matching ids and aliases', function () {
        const reported = new Map<string, Set<string>>()
        reconcileAgainstReported([finding({ advisoryId: 'ghsa-1' })], reported)
        expect(reconcileAgainstReported([finding({ advisoryId: 'GHSA-1' })], reported)).toEqual([])
    })

    it('keeps a different advisory for the same package', function () {
        const reported = new Map<string, Set<string>>()
        reconcileAgainstReported([finding({ advisoryId: 'GHSA-1' })], reported)
        expect(reconcileAgainstReported([finding({ advisoryId: 'GHSA-2' })], reported)).toHaveLength(1)
    })

    it('keeps the same advisory reported for a different package', function () {
        const reported = new Map<string, Set<string>>()
        reconcileAgainstReported([finding({ packageName: 'lodash' })], reported)
        expect(reconcileAgainstReported([finding({ packageName: 'axios' })], reported)).toHaveLength(1)
    })

    // Dedup is scoped to a LIBRARY, and a library is (ecosystem, packageName) — never the bare name.
    // An npm `requests` and a PyPI `requests` sharing a CVE alias are different libraries.
    it('does not let one ecosystem suppress a same-named package in another', function () {
        const reported = new Map<string, Set<string>>()
        const npmFinding = finding({ packageName: 'requests', ecosystem: 'npm', aliases: ['CVE-2024-1'] })
        const pypiFinding = finding({ packageName: 'requests', ecosystem: 'PyPI', aliases: ['CVE-2024-1'] })
        reconcileAgainstReported([npmFinding], reported)
        expect(reconcileAgainstReported([pypiFinding], reported)).toHaveLength(1)
    })

    // npm-audit findings carry no ecosystem, so they must fall back to npm — otherwise their dedup
    // against OSV's npm findings silently stops working.
    it('treats a finding with no ecosystem as npm', function () {
        const reported = new Map<string, Set<string>>()
        reconcileAgainstReported([finding({ ecosystem: undefined })], reported)
        expect(reconcileAgainstReported([finding({ ecosystem: 'npm' })], reported)).toEqual([])
    })

    it('dedups within a single batch as well as across batches', function () {
        const reported = new Map<string, Set<string>>()
        const kept = reconcileAgainstReported([finding({ advisoryId: 'GHSA-1' }), finding({ advisoryId: 'GHSA-1' })], reported)
        expect(kept).toHaveLength(1)
    })

    // First writer wins, and sources are run in a fixed authoritative order, so the survivor is
    // deterministic rather than dependent on which scanner happened to finish first.
    it('keeps the first occurrence, not the last', function () {
        const reported = new Map<string, Set<string>>()
        const first = finding({ advisoryId: 'GHSA-1', severity: 'critical' })
        const second = finding({ advisoryId: 'GHSA-1', severity: 'low' })
        const kept = reconcileAgainstReported([first, second], reported)
        expect(kept[0]?.severity).toBe('critical')
    })
})
