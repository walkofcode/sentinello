import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { semverComparator, type VersionRange } from '@sentinello/versions'
import { matchAdvisories } from './engine/matcher'
import { normalizeOneVulnerability, type DepClassifier, type Vulnerability } from './npm-audit-parse'
import type { RawFinding } from './types'
import { pickReleasedFix, type PublishedVersion } from './version-fix'

// The 35 fixes the live instance was recommending on 2026-10-03 that npm never published — 296 active
// findings. Each tuple is pushed back through the code path that produced it (npm-audit's normalizer or the
// OSV matcher) and then settled against the registry's real version list from the same day. The two halves
// prove different things: the scanners no longer invent (causes A and B), and a stated-but-unpublished fix
// (cause C) is kept only as a statement that the registry check then refuses.

type Tuple = {
    source: 'npm-audit' | 'osv'
    package: string
    inventedFix: string
    vulnerableRange: string
    installed: string
    rows: number
    cause: 'A' | 'B' | 'C'
}

type Fixture = {
    tuples: Tuple[]
    published: Record<string, { versions: string[]; deprecated: string[] }>
}

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/invented-fixes-2026-10-03.json', import.meta.url), 'utf8')) as Fixture

const CLASSIFIER: DepClassifier = {
    classify() {
        return { isProd: true, isDev: false }
    }
}

function publishedFor(name: string): PublishedVersion[] {
    const entry = FIXTURE.published[name]
    if (!entry) throw new Error('fixture has no registry entry for ' + name)
    const deprecated = new Set(entry.deprecated)
    return entry.versions.map(function toPublished(version) {
        return { version, deprecated: deprecated.has(version) }
    })
}

// npm-audit, as `npm audit --json` reports it: the installed copies via lockfile nodes, and for cause B a
// fixAvailable whose version belongs to a parent package.
function viaNpmAudit(t: Tuple): RawFinding {
    const copies = t.installed.split(', ')
    const nodes = copies.map(function node(_v, i) {
        return 'node_modules/copy' + i + '/node_modules/' + t.package
    })
    const vuln: Vulnerability = {
        name: t.package,
        via: [{ source: 1, title: 'fixture', url: 'https://github.com/advisories/GHSA-fixture', range: t.vulnerableRange, severity: 'high' }],
        range: t.vulnerableRange,
        nodes,
        fixAvailable: t.cause === 'B' ? { name: 'parent-of-' + t.package, version: t.inventedFix, isSemVerMajor: true } : false
    }
    const installedVersions = new Map(nodes.map(function entry(node, i) {
        return [node, copies[i] ?? ''] as [string, string]
    }))
    const [finding] = normalizeOneVulnerability(vuln, t.package, installedVersions, CLASSIFIER).findings
    if (!finding) throw new Error('npm-audit produced no finding for ' + t.package)
    return finding
}

// OSV stores these as `introduced 0, lastAffected X`; the display range is `>=0 <=X`.
function viaOsv(t: Tuple): RawFinding {
    const lastAffected = t.vulnerableRange.replace('>=0 <=', '')
    const range: VersionRange = { type: 'SEMVER', introduced: '0', fixed: null, lastAffected }
    const advisory = {
        id: 'GHSA-fixture',
        source: 'osv',
        aliases: [],
        ecosystem: 'npm',
        packageName: t.package,
        affected: { ranges: [range], exactVersions: [] },
        kind: 'vulnerability' as const,
        severity: 'HIGH',
        summary: null,
        url: null,
        withdrawn: null
    }
    const pkg = { ecosystem: 'npm', name: t.package, version: t.installed, scope: { isProd: true, isDev: false, isOptional: false }, depPaths: [] }
    const [finding] = matchAdvisories([pkg], new Map([[t.package, [advisory]]]), semverComparator, ['SEMVER'])
    if (!finding) throw new Error('osv produced no finding for ' + t.package)
    return finding
}

function rescan(t: Tuple): RawFinding {
    return t.source === 'osv' ? viaOsv(t) : viaNpmAudit(t)
}

describe('the 35 unpublished fixes of 2026-10-03', function () {
    it('loaded the whole table', function () {
        expect(FIXTURE.tuples).toHaveLength(35)
        expect(FIXTURE.tuples.reduce(function sum(n, t) { return n + t.rows }, 0)).toBe(296)
    })

    // Causes A and B were invention: the scanners must no longer state those versions at all.
    it.each(FIXTURE.tuples.filter(function invented(t) { return t.cause !== 'C' }).map(function row(t) {
        return [t.source + ' ' + t.package + ' ' + t.inventedFix + ' (' + t.cause + ')', t] as const
    }))('no longer states %s', function (_label, t) {
        const finding = rescan(t)
        expect(finding.fixVersion).not.toBe(t.inventedFix)
        expect(finding.fixInputs.statedFix).not.toBe(t.inventedFix)
    })

    // Cause C is a real statement from the source (`<7.23.2` names 7.23.2), so it survives as the stated
    // fix — shown unverified until the registry refuses it below.
    it.each(FIXTURE.tuples.filter(function stated(t) { return t.cause === 'C' }).map(function row(t) {
        return [t.package + ' ' + t.inventedFix, t] as const
    }))('keeps %s only as the source’s statement', function (_label, t) {
        expect(rescan(t).fixVersion).toBe(t.inventedFix)
    })

    // Settled against the registry, no tuple's answer is ever the unpublished version, and a released
    // answer is always on the version list.
    it.each(FIXTURE.tuples.map(function row(t) {
        return [t.source + ' ' + t.package + ' ' + t.inventedFix, t] as const
    }))('settles %s to a published version or to no fix', function (_label, t) {
        const finding = rescan(t)
        const versions = publishedFor(t.package)
        const result = pickReleasedFix({ published: versions, evidence: [finding.fixInputs], installed: finding.fixInputs.installed })
        if (result.kind === 'released') {
            expect(result.version).not.toBe(t.inventedFix)
            expect(versions.map(function v(p) { return p.version })).toContain(result.version)
        }
    })

    function settle(source: Tuple['source'], name: string, invented: string) {
        const t = FIXTURE.tuples.find(function match(x) {
            return x.source === source && x.package === name && x.inventedFix === invented
        })
        if (!t) throw new Error('no tuple ' + source + ' ' + name + ' ' + invented)
        const finding = rescan(t)
        return pickReleasedFix({ published: publishedFor(name), evidence: [finding.fixInputs], installed: finding.fixInputs.installed })
    }

    // The request's two packages: no fixed version is released, from either source.
    it.each([
        ['npm-audit', 'braces', '3.0.4'],
        ['osv', 'braces', '3.0.4'],
        ['npm-audit', 'node-forge', '1.4.1'],
        ['osv', 'node-forge', '1.4.1']
    ] as const)('%s %s settles to none', function (source, name, invented) {
        expect(settle(source, name, invented)).toEqual({ kind: 'none' })
    })

    // qs: a real fix exists, and it is 6.16.0 — not the 6.15.4 that was being recommended to 113 findings.
    it('settles qs >=6.14.2 <=6.15.3 to 6.16.0', function () {
        expect(settle('npm-audit', 'qs', '6.15.4')).toEqual({ kind: 'released', version: '6.16.0' })
    })

    // request's npm-audit row had no lockfile behind it, so its "installed" was `*` — unknown, not none.
    it('settles an unparseable install to unknown', function () {
        expect(settle('npm-audit', 'request', '2.88.3')).toEqual({ kind: 'unknown', reason: 'installed_unknown' })
    })
})
