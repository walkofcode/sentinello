import { describe, expect, it } from 'vitest'
import {
    escalatedSeverity,
    findingIdentityKeys,
    reconcileAgainstReported,
    type ReportedAdvisory
} from './reconcile'
import type { RawFinding } from '../types'

// Reconciliation decides what ONE vulnerability looks like when three databases know about it. Getting
// it wrong is visible in both directions: too eager and a real advisory disappears behind an unrelated
// one, too timid and the same flaw is reported three times.
//
// What it no longer does is throw the duplicate away. Two thirds of findings on a real instance are
// reported by more than one source, and that agreement used to vanish silently — so a triple-confirmed
// critical rendered exactly like a lone unverified report. The finding is still one row; the agreement
// now travels with it, and the severity becomes the worst grade any source gave it.

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

function reported() {
    return new Map<string, Map<string, ReportedAdvisory>>()
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

describe('reconcileAgainstReported — which findings survive', function () {
    it('keeps a finding nothing has reported yet', function () {
        expect(reconcileAgainstReported([finding()], reported(), 'npm-audit').kept).toHaveLength(1)
    })

    it('records survivors so a later source reconciles against them', function () {
        const seen = reported()
        reconcileAgainstReported([finding({ advisoryId: 'GHSA-1' })], seen, 'npm-audit')
        expect(reconcileAgainstReported([finding({ advisoryId: 'GHSA-1' })], seen, 'osv').kept).toEqual([])
    })

    // The whole point of the alias set: npm-audit's id and OSV's GHSA id for one CVE must collapse.
    it('collapses a later finding that matches an earlier one only by alias', function () {
        const seen = reported()
        reconcileAgainstReported([finding({ advisoryId: '1234', aliases: ['CVE-2024-1'] })], seen, 'npm-audit')
        const second = reconcileAgainstReported([finding({ advisoryId: 'GHSA-9', aliases: ['CVE-2024-1'] })], seen, 'osv')
        expect(second.kept).toEqual([])
    })

    // The pairing this whole mechanism was written for, and the one it never actually served. npm audit
    // keys an advisory by npm's numeric id while OSV keys it by GHSA, so until npm-audit findings
    // started carrying the GHSA from their own advisory URL these two identity sets could not
    // intersect — every advisory both sources knew was stored twice, counted twice, and notified twice,
    // and the corroboration badge could not appear on the pairing it exists to show.
    it('collapses npm audit’s numeric id against OSV’s GHSA for the same advisory', function () {
        const seen = reported()
        const npmAudit = finding({ advisoryId: '1093507', aliases: ['GHSA-7px7-7xjx-hxm8'] })
        const osv = finding({ advisoryId: 'GHSA-7px7-7xjx-hxm8', aliases: ['CVE-2024-9999'] })

        expect(reconcileAgainstReported([npmAudit], seen, 'npm-audit').kept).toHaveLength(1)
        const second = reconcileAgainstReported([osv], seen, 'osv')

        expect(second.kept).toEqual([])
        expect(second.corroborations).toHaveLength(1)
    })

    it('ignores casing when matching ids and aliases', function () {
        const seen = reported()
        reconcileAgainstReported([finding({ advisoryId: 'ghsa-1' })], seen, 'npm-audit')
        expect(reconcileAgainstReported([finding({ advisoryId: 'GHSA-1' })], seen, 'osv').kept).toEqual([])
    })

    it('keeps a different advisory for the same package', function () {
        const seen = reported()
        reconcileAgainstReported([finding({ advisoryId: 'GHSA-1' })], seen, 'npm-audit')
        expect(reconcileAgainstReported([finding({ advisoryId: 'GHSA-2' })], seen, 'osv').kept).toHaveLength(1)
    })

    it('keeps the same advisory reported for a different package', function () {
        const seen = reported()
        reconcileAgainstReported([finding({ packageName: 'lodash' })], seen, 'npm-audit')
        expect(reconcileAgainstReported([finding({ packageName: 'axios' })], seen, 'osv').kept).toHaveLength(1)
    })

    // Dedup is scoped to a LIBRARY, and a library is (ecosystem, packageName) — never the bare name.
    // An npm `requests` and a PyPI `requests` sharing a CVE alias are different libraries.
    it('does not let one ecosystem suppress a same-named package in another', function () {
        const seen = reported()
        const npmFinding = finding({ packageName: 'requests', ecosystem: 'npm', aliases: ['CVE-2024-1'] })
        const pypiFinding = finding({ packageName: 'requests', ecosystem: 'PyPI', aliases: ['CVE-2024-1'] })
        reconcileAgainstReported([npmFinding], seen, 'osv')
        expect(reconcileAgainstReported([pypiFinding], seen, 'osv').kept).toHaveLength(1)
    })

    // npm-audit findings carry no ecosystem, so they must fall back to npm — otherwise their dedup
    // against OSV's npm findings silently stops working.
    it('treats a finding with no ecosystem as npm', function () {
        const seen = reported()
        reconcileAgainstReported([finding({ ecosystem: undefined })], seen, 'npm-audit')
        expect(reconcileAgainstReported([finding({ ecosystem: 'npm' })], seen, 'osv').kept).toEqual([])
    })

    it('collapses duplicates within a single batch as well as across batches', function () {
        const seen = reported()
        const result = reconcileAgainstReported([finding({ advisoryId: 'GHSA-1' }), finding({ advisoryId: 'GHSA-1' })], seen, 'osv')
        expect(result.kept).toHaveLength(1)
    })

    // First writer wins, and sources run in a fixed authoritative order, so the survivor is
    // deterministic rather than dependent on which scanner happened to finish first.
    it('keeps the first occurrence, not the last', function () {
        const seen = reported()
        const first = finding({ advisoryId: 'GHSA-1', severity: 'critical' })
        const second = finding({ advisoryId: 'GHSA-1', severity: 'low' })
        expect(reconcileAgainstReported([first, second], seen, 'osv').kept[0]?.severity).toBe('critical')
    })
})

describe('reconcileAgainstReported — corroboration', function () {
    it('reports no corroboration for a finding only one source has', function () {
        expect(reconcileAgainstReported([finding()], reported(), 'npm-audit').corroborations).toEqual([])
    })

    // The information that used to be discarded: WHO else saw it, under WHICH id, and at WHAT grade.
    it('records the source, its own advisory id and its own severity', function () {
        const seen = reported()
        reconcileAgainstReported([finding({ advisoryId: '1234', aliases: ['CVE-2024-1'], severity: 'high' })], seen, 'npm-audit')
        const second = reconcileAgainstReported(
            [finding({ advisoryId: 'GMS-2021-3', aliases: ['CVE-2024-1'], severity: 'critical' })],
            seen,
            'gemnasium'
        )
        expect(second.corroborations).toHaveLength(1)
        expect(second.corroborations[0]?.by).toEqual({ source: 'gemnasium', advisoryId: 'GMS-2021-3', severity: 'critical' })
        expect(second.corroborations[0]?.target).toMatchObject({
            source: 'npm-audit',
            advisoryId: '1234',
            packageName: 'lodash',
            ecosystem: 'npm',
            severity: 'high'
        })
    })

    // gemnasium routinely identifies a vulnerability under its own GMS- id where npm-audit has a CVE.
    // Copying the survivor's id would make that source's writeup unfindable.
    it("keeps the corroborating source's own advisory id, not the survivor's", function () {
        const seen = reported()
        reconcileAgainstReported([finding({ advisoryId: 'CVE-2021-3' })], seen, 'npm-audit')
        const second = reconcileAgainstReported([finding({ advisoryId: 'GMS-2021-3', aliases: ['CVE-2021-3'] })], seen, 'gemnasium')
        expect(second.corroborations[0]?.by.advisoryId).toBe('GMS-2021-3')
    })

    it('points the corroboration at the finding that survived', function () {
        const seen = reported()
        reconcileAgainstReported([finding({ advisoryId: 'GHSA-1', packageName: 'axios', ecosystem: 'npm' })], seen, 'npm-audit')
        const second = reconcileAgainstReported([finding({ advisoryId: 'GHSA-1', packageName: 'axios', ecosystem: 'npm' })], seen, 'osv')
        expect(second.corroborations[0]?.target).toMatchObject({
            source: 'npm-audit',
            advisoryId: 'GHSA-1',
            packageName: 'axios',
            ecosystem: 'npm',
            severity: 'high'
        })
    })

    // A third source agreeing is a third corroboration, not a replacement for the second.
    it('yields one corroboration per agreeing source', function () {
        const seen = reported()
        reconcileAgainstReported([finding({ aliases: ['CVE-1'] })], seen, 'npm-audit')
        const osv = reconcileAgainstReported([finding({ advisoryId: 'GHSA-9', aliases: ['CVE-1'] })], seen, 'osv')
        const gem = reconcileAgainstReported([finding({ advisoryId: 'GMS-9', aliases: ['CVE-1'] })], seen, 'gemnasium')
        expect(osv.corroborations).toHaveLength(1)
        expect(gem.corroborations).toHaveLength(1)
        expect(gem.corroborations[0]?.by.source).toBe('gemnasium')
    })

    // The CLI has no database: it reports straight from the objects reconcile hands back, so agreement
    // and the re-grade have to be visible on the survivor itself.
    it('attaches the agreement to the surviving finding and re-grades it in place', function () {
        const seen = reported()
        const survivor = finding({ advisoryId: 'CVE-1', severity: 'high' })
        reconcileAgainstReported([survivor], seen, 'npm-audit')
        reconcileAgainstReported([finding({ advisoryId: 'GMS-1', aliases: ['CVE-1'], severity: 'critical' })], seen, 'gemnasium')
        expect(survivor.severity).toBe('critical')
        expect(survivor.corroborations).toEqual([{ source: 'gemnasium', advisoryId: 'GMS-1', severity: 'critical' }])
    })

    // Escalation must not ratchet: it is always computed from the surviving source's ORIGINAL grade, so a
    // source that softens its assessment can bring the finding back down on the next scan.
    it('re-grades from the survivor original severity, not from an earlier escalation', function () {
        const seen = reported()
        const survivor = finding({ advisoryId: 'CVE-1', severity: 'low' })
        reconcileAgainstReported([survivor], seen, 'npm-audit')
        reconcileAgainstReported([finding({ advisoryId: 'GMS-1', aliases: ['CVE-1'], severity: 'critical' })], seen, 'gemnasium')
        expect(survivor.severity).toBe('critical')
        // A third source grading it moderate must not pull the result below critical, but the baseline
        // used is still the original 'low' rather than the escalated value.
        reconcileAgainstReported([finding({ advisoryId: 'GHSA-1', aliases: ['CVE-1'], severity: 'moderate' })], seen, 'osv')
        expect(survivor.severity).toBe('critical')
        expect(survivor.corroborations).toHaveLength(2)
    })

    // Two sources reporting DIFFERENT advisories for one package are two findings, not agreement.
    it('does not treat an unrelated advisory as agreement', function () {
        const seen = reported()
        reconcileAgainstReported([finding({ advisoryId: 'GHSA-1' })], seen, 'npm-audit')
        const second = reconcileAgainstReported([finding({ advisoryId: 'GHSA-2' })], seen, 'osv')
        expect(second.corroborations).toEqual([])
        expect(second.kept).toHaveLength(1)
    })
})

// Sources genuinely disagree: gemnasium computes severity from the CVSS vector while npm-audit takes
// GHSA's bucket. For a scanner the cautious reading is the right one — if any database calls a flaw
// critical, treating it as critical is the error that costs least. Deliberately not display-only: it
// moves the finding between buckets in the dashboard, the CLI's --fail-on gate and notifications alike.
describe('escalatedSeverity', function () {
    it('leaves an uncorroborated finding at its own grade', function () {
        expect(escalatedSeverity('high', [])).toBe('high')
    })

    it('takes the worst grade when a source disagrees upward', function () {
        expect(escalatedSeverity('high', [{ source: 'gemnasium', advisoryId: 'GMS-1', severity: 'critical' }])).toBe('critical')
    })

    it('keeps its own grade when a source disagrees downward', function () {
        expect(escalatedSeverity('critical', [{ source: 'osv', advisoryId: 'GHSA-1', severity: 'low' }])).toBe('critical')
    })

    it('takes the worst across several disagreeing sources', function () {
        expect(escalatedSeverity('low', [
            { source: 'osv', advisoryId: 'GHSA-1', severity: 'moderate' },
            { source: 'gemnasium', advisoryId: 'GMS-1', severity: 'high' }
        ])).toBe('high')
    })

    it('is unchanged when every source agrees', function () {
        expect(escalatedSeverity('moderate', [{ source: 'osv', advisoryId: 'GHSA-1', severity: 'moderate' }])).toBe('moderate')
    })
})
