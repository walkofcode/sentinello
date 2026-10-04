import { describe, expect, it } from 'vitest'
import type { NpmPackageSummary } from '@sentinello/feeds'
import type { FixEvidence } from '@sentinello/scanners'
import { fixEvidenceKey, publishedVersions, registryView, settleProject, type FixIdentity } from './project'
import { fakeRegistry, type FakePackage } from './registry-fake.fixture'
import type { ReplacementDataset } from './replacements'

// settleProject is the one entry point the worker and the CLI share: every finding settled, then the way
// out for each one settled none_released, returned keyed by finding identity and written nowhere.

const CHECKED_AT = Date.UTC(2026, 9, 3)
const NO_DATASET: ReplacementDataset = function none() { return null }
const BRACES: FakePackage = { latest: '3.0.3', releases: { '3.0.2': {}, '3.0.3': {} } }
const PKG: FakePackage = { releases: { '1.0.0': {}, '1.1.0': {} } }

function identity(overrides: Partial<FixIdentity> = {}): FixIdentity {
    return { source: 'osv', ecosystem: 'npm', advisoryId: 'GHSA-vfj7', packageName: 'braces', ...overrides }
}

function evidence(ranges: string, installed: string): FixEvidence {
    return { source: 'osv', installed: [installed], affected: { ranges, exact: [], complete: true }, patched: null, statedFix: null, fixViaParent: false }
}

function evidenceFor(entries: [FixIdentity, FixEvidence][]): Map<string, FixEvidence[]> {
    return new Map(entries.map(function keyed([id, e]) { return [fixEvidenceKey(id), [e]] as const }))
}

describe('settleProject', function () {
    it('settles nothing and asks nothing for a project with no findings', async function () {
        const registry = fakeRegistry({})
        expect(await settleProject({ findings: [], evidence: new Map(), graph: null, registry, checkedAt: CHECKED_AT }))
            .toEqual({ settlements: new Map(), remediations: new Map(), wayOutError: null })
        expect(registry.lookups).toEqual([])
    })

    it('settles every identity once, and gives a way out only to the none_released npm ones', async function () {
        const braces = identity()
        const pkg = identity({ advisoryId: 'GHSA-pkg', packageName: 'pkg' })
        const pypi = identity({ ecosystem: 'PyPI', advisoryId: 'PYSEC-1', packageName: 'braces' })
        const out = await settleProject({
            // braces twice: two rows of one identity share one settlement and one way out.
            findings: [braces, braces, pkg, pypi],
            evidence: evidenceFor([[braces, evidence('<=3.0.3', '3.0.3')], [pkg, evidence('<1.1.0', '1.0.0')], [pypi, evidence('<=3.0.3', '3.0.3')]]),
            graph: null,
            registry: fakeRegistry({ braces: BRACES, pkg: PKG }),
            checkedAt: CHECKED_AT,
            dataset: NO_DATASET
        })
        expect([...out.settlements.keys()]).toEqual([fixEvidenceKey(braces), fixEvidenceKey(pkg), fixEvidenceKey(pypi)])
        expect(out.settlements.get(fixEvidenceKey(braces))).toMatchObject({ fixStatus: 'none_released', fixVersion: null })
        expect(out.settlements.get(fixEvidenceKey(pkg))).toMatchObject({ fixStatus: 'released', fixVersion: '1.1.0' })
        expect(out.settlements.get(fixEvidenceKey(pypi))).toMatchObject({ fixStatus: 'unverified', fixCheck: { registry: 'skipped' } })
        expect([...out.remediations.keys()]).toEqual([fixEvidenceKey(braces)])
        expect(out.remediations.get(fixEvidenceKey(braces))).toMatchObject({ v: 1, package: 'braces', checkedAt: CHECKED_AT })
        expect(out.wayOutError).toBeNull()
    })

    it('computes one way out for identities that carry the same evidence', async function () {
        const a = identity()
        const b = identity({ advisoryId: 'GHSA-other' })
        const registry = fakeRegistry({ braces: BRACES })
        const out = await settleProject({
            findings: [a, b],
            evidence: evidenceFor([[a, evidence('<=3.0.3', '3.0.3')], [b, evidence('<=3.0.3', '3.0.3')]]),
            graph: null,
            registry,
            checkedAt: CHECKED_AT,
            dataset: NO_DATASET
        })
        expect(out.remediations.get(fixEvidenceKey(a))).toBe(out.remediations.get(fixEvidenceKey(b)))
    })

    it('makes no way-out lookups when nothing is none_released', async function () {
        const pkg = identity({ packageName: 'pkg' })
        const registry = fakeRegistry({ pkg: PKG })
        const out = await settleProject({ findings: [pkg], evidence: evidenceFor([[pkg, evidence('<1.1.0', '1.0.0')]]), graph: null, registry, checkedAt: CHECKED_AT })
        expect(out.remediations.size).toBe(0)
        expect(registry.lookups).toEqual(['pkg'])
    })

    // The way out failing must not cost the settlements: braces still says no fixed version is released.
    it('keeps the settlements and returns the error when the way out cannot be computed', async function () {
        const braces = identity()
        const registry = fakeRegistry({ braces: BRACES })
        registry.weeklyDownloads = async function broken() { throw new Error('database is locked') }
        const out = await settleProject({ findings: [braces], evidence: evidenceFor([[braces, evidence('<=3.0.3', '3.0.3')]]), graph: null, registry, checkedAt: CHECKED_AT, dataset: NO_DATASET })
        expect(out.settlements.get(fixEvidenceKey(braces))).toMatchObject({ fixStatus: 'none_released' })
        expect(out.remediations.size).toBe(0)
        expect(out.wayOutError).toBe('database is locked')
    })

    it('rejects when the registry client itself fails', async function () {
        const registry = fakeRegistry({})
        registry.lookup = async function broken() { throw new Error('database is locked') }
        await expect(settleProject({ findings: [identity()], evidence: new Map(), graph: null, registry, checkedAt: CHECKED_AT })).rejects.toThrow('database is locked')
    })
})

describe('registryView / publishedVersions', function () {
    function summary(versions: string[], deprecated: string[] = []): NpmPackageSummary {
        const out: NpmPackageSummary['versions'] = {}
        for (const v of versions) out[v] = { publishedAt: CHECKED_AT, deprecated: deprecated.includes(v) ? 'old' : null, edges: null }
        return { v: 1, name: 'p', latest: null, modified: CHECKED_AT, maintainers: 1, repository: null, versions: out, edges: [] }
    }

    it('maps every registry answer onto what settlement may conclude from it', function () {
        expect(registryView(undefined)).toEqual({ status: 'error' })
        expect(registryView({ status: 'error', reason: 'x' })).toEqual({ status: 'error' })
        expect(registryView({ status: 'not_found', checkedAt: 5, origin: 'cache' })).toEqual({ status: 'not_found', dataAsOf: 5 })
        expect(registryView({ status: 'ok', summary: summary(['1.0.0'], ['1.0.0']), checkedAt: 7, origin: 'cache' }))
            .toEqual({ status: 'ok', published: [{ version: '1.0.0', deprecated: true }], dataAsOf: 7 })
        expect(publishedVersions(summary(['1.0.0', '2.0.0']))).toEqual([
            { version: '1.0.0', deprecated: false },
            { version: '2.0.0', deprecated: false }
        ])
    })
})
