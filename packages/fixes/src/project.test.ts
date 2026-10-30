import { describe, expect, it } from 'vitest'
import type { NpmPackageSummary } from '@sentinello/feeds'
import { versionSetFromSemverRange, type FixEvidence, type VersionSet } from '@sentinello/scanners'
import { createGoRegistryClient } from './go-registry'
import { createMemoryRegistryStore } from './memory-store'
import { fixEvidenceKey, npmOnlyWayOut, settleProject, WAY_OUT_NPM_ONLY, type FixIdentity } from './project'
import { createPublishedRegistryClient, publishedVersions, registryView, type PublicationClient } from './published-registry'
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
    return { source: 'osv', installed: [installed], affected: versionSetFromSemverRange(ranges), patched: null, patchedSet: null, statedFix: null, fixViaParent: false }
}

// A PyPI source's evidence: its affected set in PEP 440, as the matcher builds it.
function pep440Evidence(ranges: string, installed: string): FixEvidence {
    return { ...evidence(ranges, installed), affected: { ...versionSetFromSemverRange(ranges), comparator: 'pep440' } }
}

function evidenceFor(entries: [FixIdentity, FixEvidence][]): Map<string, FixEvidence[]> {
    return new Map(entries.map(function keyed([id, e]) { return [fixEvidenceKey(id), [e]] as const }))
}

describe('settleProject', function () {
    it('settles nothing and asks nothing for a project with no findings', async function () {
        const registry = fakeRegistry({})
        expect(await settleProject({ findings: [], evidence: new Map(), graph: null, registry: { npm: registry }, checkedAt: CHECKED_AT }))
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
            evidence: evidenceFor([[braces, evidence('<=3.0.3', '3.0.3')], [pkg, evidence('<1.1.0', '1.0.0')], [pypi, pep440Evidence('<=3.0.3', '3.0.3')]]),
            graph: null,
            registry: { npm: fakeRegistry({ braces: BRACES, pkg: PKG }) },
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

    it('offline: asks nothing, settles every ecosystem unverified marked offline, and has no way out', async function () {
        const braces = identity()
        const pypi = identity({ ecosystem: 'PyPI', advisoryId: 'PYSEC-1' })
        const out = await settleProject({
            findings: [braces, pypi],
            evidence: evidenceFor([[braces, evidence('<=3.0.3', '3.0.3')], [pypi, pep440Evidence('<=3.0.3', '3.0.3')]]),
            graph: null,
            registry: null,
            checkedAt: CHECKED_AT
        })
        expect(out.settlements.get(fixEvidenceKey(braces))).toMatchObject({ fixStatus: 'unverified', fixCheck: { registry: 'offline', packageDataAsOf: null } })
        expect(out.settlements.get(fixEvidenceKey(pypi))).toMatchObject({ fixStatus: 'unverified', fixCheck: { registry: 'offline' } })
        expect(out.remediations.size).toBe(0)
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
            registry: { npm: registry },
            checkedAt: CHECKED_AT,
            dataset: NO_DATASET
        })
        expect(out.remediations.get(fixEvidenceKey(a))).toBe(out.remediations.get(fixEvidenceKey(b)))
    })

    it('makes no way-out lookups when nothing is none_released', async function () {
        const pkg = identity({ packageName: 'pkg' })
        const registry = fakeRegistry({ pkg: PKG })
        const out = await settleProject({ findings: [pkg], evidence: evidenceFor([[pkg, evidence('<1.1.0', '1.0.0')]]), graph: null, registry: { npm: registry }, checkedAt: CHECKED_AT })
        expect(out.remediations.size).toBe(0)
        expect(registry.lookups).toEqual(['pkg'])
    })

    // The way out failing must not cost the settlements: braces still says no fixed version is released.
    it('keeps the settlements and returns the error when the way out cannot be computed', async function () {
        const braces = identity()
        const registry = fakeRegistry({ braces: BRACES })
        registry.weeklyDownloads = async function broken() { throw new Error('database is locked') }
        const out = await settleProject({ findings: [braces], evidence: evidenceFor([[braces, evidence('<=3.0.3', '3.0.3')]]), graph: null, registry: { npm: registry }, checkedAt: CHECKED_AT, dataset: NO_DATASET })
        expect(out.settlements.get(fixEvidenceKey(braces))).toMatchObject({ fixStatus: 'none_released' })
        expect(out.remediations.size).toBe(0)
        expect(out.wayOutError).toBe('database is locked')
    })

    it('rejects when the registry client itself fails', async function () {
        const registry = fakeRegistry({})
        registry.lookup = async function broken() { throw new Error('database is locked') }
        await expect(settleProject({ findings: [identity()], evidence: new Map(), graph: null, registry: { npm: registry }, checkedAt: CHECKED_AT })).rejects.toThrow('database is locked')
    })
})

describe('settleProject — every ecosystem against its own registry', function () {
    const PYPI_AT = CHECKED_AT - 60_000

    // A PyPI registry over a memory store, answering from a table of release lists.
    function pypiRegistry(table: Record<string, string[]>, yanked: string[] = []): PublicationClient & { asked: string[] } {
        const asked: string[] = []
        const client = createPublishedRegistryClient(createMemoryRegistryStore(), async function fetchPackage(name) {
            asked.push(name)
            const releases = table[name]
            if (releases === undefined) return { status: 'not_found' }
            return { status: 'ok', etag: null, summary: { v: 1, name, versions: Object.fromEntries(releases.map(function r(v) { return [v, { yanked: yanked.includes(v) }] })) } }
        }, { now: () => PYPI_AT })
        return { asked, published: client.published }
    }

    it('settles a PyPI finding released or none_released against PyPI, and gives the none_released one the npm-only way out', async function () {
        const django = identity({ ecosystem: 'PyPI', advisoryId: 'PYSEC-1', packageName: 'django' })
        const flask = identity({ ecosystem: 'PyPI', advisoryId: 'PYSEC-2', packageName: 'flask' })
        const pypi = pypiRegistry({ django: ['4.2.10', '4.2.11', '4.2.12'], flask: ['2.0.0', '2.0.1'] }, ['4.2.11'])
        const out = await settleProject({
            findings: [django, flask, flask],
            evidence: evidenceFor([[django, pep440Evidence('<4.2.11', '4.2.10')], [flask, pep440Evidence('<=2.0.1', '2.0.0')]]),
            graph: null,
            registry: { PyPI: pypi },
            checkedAt: CHECKED_AT
        })
        // 4.2.11 is yanked, so the fix is the next live release.
        expect(out.settlements.get(fixEvidenceKey(django))).toMatchObject({ fixStatus: 'released', fixVersion: '4.2.12', fixCheck: { registry: 'ok', packageDataAsOf: PYPI_AT } })
        expect(out.settlements.get(fixEvidenceKey(flask))).toMatchObject({ fixStatus: 'none_released' })
        expect(pypi.asked.sort()).toEqual(['django', 'flask'])
        expect([...out.remediations.keys()]).toEqual([fixEvidenceKey(flask)])
        expect(out.remediations.get(fixEvidenceKey(flask))).toEqual(npmOnlyWayOut('flask', CHECKED_AT))
        expect(out.remediations.get(fixEvidenceKey(flask))?.chains[0]?.verdict).toEqual({ kind: 'unknown', at: 'flask', reason: WAY_OUT_NPM_ONLY })
        expect(out.wayOutError).toBeNull()
    })

    it('computes npm\'s way out beside another ecosystem\'s npm-only one', async function () {
        const braces = identity()
        const flask = identity({ ecosystem: 'PyPI', advisoryId: 'PYSEC-2', packageName: 'flask' })
        const out = await settleProject({
            findings: [braces, flask],
            evidence: evidenceFor([[braces, evidence('<=3.0.3', '3.0.3')], [flask, pep440Evidence('<=2.0.1', '2.0.0')]]),
            graph: null,
            registry: { npm: fakeRegistry({ braces: BRACES }), PyPI: pypiRegistry({ flask: ['2.0.1'] }) },
            checkedAt: CHECKED_AT,
            dataset: NO_DATASET
        })
        expect(out.remediations.get(fixEvidenceKey(braces))).toMatchObject({ package: 'braces' })
        expect(out.remediations.get(fixEvidenceKey(braces))?.chains[0]?.verdict).not.toMatchObject({ reason: WAY_OUT_NPM_ONLY })
        expect(out.remediations.get(fixEvidenceKey(flask))).toEqual(npmOnlyWayOut('flask', CHECKED_AT))
    })

    // SENTINEL-126: the list omits pseudo-versions; the stated one is confirmed with its own .info request.
    it('asks Go\'s proxy about the stated pseudo-version the list omits, and releases it once confirmed', async function () {
        const pseudo = '0.0.0-20200622213623-75b288015ac9'
        const crypto = identity({ ecosystem: 'Go', advisoryId: 'GO-2020-1', packageName: 'golang.org/x/crypto' })
        const affected: VersionSet = { comparator: 'go', ranges: [{ introduced: '0', fixed: pseudo, lastAffected: null }], exact: [], complete: true }
        const goEvidence: FixEvidence = { source: 'osv', installed: ['v0.0.0-20200101000000-aaaaaaaaaaaa'], affected, patched: null, patchedSet: null, statedFix: null, fixViaParent: false }
        const checked: string[] = []
        const go = createGoRegistryClient(createMemoryRegistryStore(), {
            now: () => CHECKED_AT,
            fetchList: async function list(module) { return { status: 'ok', etag: null, summary: { v: 1, name: module, versions: {} } } },
            fetchInfo: async function info(_module, version) {
                checked.push(version)
                return { status: 'published' }
            }
        })
        const out = await settleProject({ findings: [crypto], evidence: evidenceFor([[crypto, goEvidence]]), graph: null, registry: { Go: go }, checkedAt: CHECKED_AT })
        expect(checked).toEqual(['v' + pseudo])
        expect(out.settlements.get(fixEvidenceKey(crypto))).toMatchObject({ fixStatus: 'released', fixVersion: 'v' + pseudo })
    })

    it('skips an ecosystem the map has no client for, npm included, and reads a package its client left out as an error', async function () {
        const braces = identity()
        const crate = identity({ ecosystem: 'crates.io', advisoryId: 'RUSTSEC-1', packageName: 'time' })
        const silent: PublicationClient = { published: async function nothing() { return new Map() } }
        const out = await settleProject({
            findings: [braces, crate],
            evidence: evidenceFor([[braces, evidence('<=3.0.3', '3.0.3')], [crate, evidence('<0.2.23', '0.2.22')]]),
            graph: null,
            registry: { 'crates.io': silent },
            checkedAt: CHECKED_AT
        })
        expect(out.settlements.get(fixEvidenceKey(braces))).toMatchObject({ fixStatus: 'unverified', fixCheck: { registry: 'skipped' } })
        expect(out.settlements.get(fixEvidenceKey(crate))).toMatchObject({ fixStatus: 'unverified', fixVersion: null, fixCheck: { registry: 'error' } })
    })

    it('rejects a finding of an ecosystem the registry does not know', async function () {
        const hex = identity({ ecosystem: 'Hex', advisoryId: 'X', packageName: 'plug' })
        await expect(settleProject({ findings: [hex], evidence: new Map(), graph: null, registry: {}, checkedAt: CHECKED_AT })).rejects.toThrow('unknown ecosystem "Hex"')
    })
})

describe('registryView / publishedVersions', function () {
    function summary(versions: string[], deprecated: string[] = []): NpmPackageSummary {
        const out: NpmPackageSummary['versions'] = {}
        for (const v of versions) out[v] = { publishedAt: CHECKED_AT, deprecated: deprecated.includes(v) ? 'old' : null, edges: null }
        return { v: 2, name: 'p', latest: null, modified: CHECKED_AT, maintainers: 1, repository: null, versions: out, prereleases: {}, edges: [] }
    }

    it('maps every registry answer onto what settlement may conclude from it', function () {
        expect(registryView(undefined, publishedVersions)).toEqual({ status: 'error' })
        expect(registryView({ status: 'error', reason: 'x' }, publishedVersions)).toEqual({ status: 'error' })
        expect(registryView({ status: 'not_found', checkedAt: 5, origin: 'cache' }, publishedVersions)).toEqual({ status: 'not_found', dataAsOf: 5 })
        expect(registryView({ status: 'ok', summary: summary(['1.0.0'], ['1.0.0']), checkedAt: 7, origin: 'cache' }, publishedVersions))
            .toEqual({ status: 'ok', published: [{ version: '1.0.0', deprecated: true }], dataAsOf: 7 })
        expect(publishedVersions(summary(['1.0.0', '2.0.0']))).toEqual([
            { version: '1.0.0', deprecated: false },
            { version: '2.0.0', deprecated: false }
        ])
    })
})
