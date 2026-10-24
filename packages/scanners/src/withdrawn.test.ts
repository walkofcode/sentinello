import type { OsvAdvisoryLink } from '@sentinello/core'
import { describe, expect, it } from 'vitest'
import { matchPackages, type GemnasiumAdvisory } from './gemnasium'
import type { ResolvedPackage } from './resolver/types'
import { stampWithdrawn, stampWithdrawnByPackage } from './withdrawn'

// gemnasium-db has no withdrawn field, so gemnasium advisories are stamped from the OSV records linked
// to them. The rule is deliberately narrow, and every edge of it is a way to get it wrong:
//   - linked means same package AND a shared identifier, in either direction (gemnasium keys by CVE and
//     aliases the GHSA; OSV keys by GHSA and aliases the CVE);
//   - stamped only when EVERY linked record is withdrawn, because GitHub withdraws a duplicate GHSA in
//     favour of another that aliases the same CVE, and the CVE is still real;
//   - no linked record means OSV says nothing, which is not a withdrawal.
// The fixture is the shape of the real case: CVE-2026-93687 in gemnasium, GHSA-vfj7-8cjw-p6xm in OSV.

const WITHDRAWN_AT = Date.UTC(2026, 9, 23, 12, 53, 2)

function advisory(overrides: Partial<GemnasiumAdvisory> = {}): GemnasiumAdvisory {
    return {
        advisoryId: 'CVE-2026-93687',
        aliases: ['GHSA-vfj7-8cjw-p6xm'],
        ranges: [{ introduced: '0', fixed: null, lastAffected: '3.0.3' }],
        versions: [],
        severity: 'high',
        summary: 'Uncontrolled resource consumption',
        url: 'https://example.test/advisory',
        withdrawn: null,
        ...overrides
    }
}

function link(overrides: Partial<OsvAdvisoryLink> = {}): OsvAdvisoryLink {
    return { advisoryId: 'GHSA-vfj7-8cjw-p6xm', aliases: ['CVE-2026-93687'], withdrawn: WITHDRAWN_AT, ...overrides }
}

function pkg(name: string, version: string): ResolvedPackage {
    return { ecosystem: 'npm', name, version, scope: { isProd: true, isDev: false, isOptional: false }, depPaths: [] }
}

describe('stampWithdrawn', function () {
    it('stamps an advisory whose only linked OSV record is withdrawn', function () {
        expect(stampWithdrawn([advisory()], [link()])[0]!.withdrawn).toBe(WITHDRAWN_AT)
    })

    it('links through the gemnasium alias matching the OSV id', function () {
        // gemnasium aliases the GHSA; the OSV record lists no aliases at all.
        expect(stampWithdrawn([advisory()], [link({ aliases: [] })])[0]!.withdrawn).toBe(WITHDRAWN_AT)
    })

    it('links through the OSV alias matching the gemnasium id', function () {
        // gemnasium lists no aliases; the OSV record aliases the CVE.
        expect(stampWithdrawn([advisory({ aliases: [] })], [link()])[0]!.withdrawn).toBe(WITHDRAWN_AT)
    })

    it('links through a shared alias when neither id names the other', function () {
        const gem = advisory({ advisoryId: 'GMS-2026-1', aliases: ['CVE-2026-93687'] })
        expect(stampWithdrawn([gem], [link()])[0]!.withdrawn).toBe(WITHDRAWN_AT)
    })

    it('stamps the latest withdrawal when every linked record is withdrawn', function () {
        const later = WITHDRAWN_AT + 3600_000
        const stamped = stampWithdrawn([advisory()], [link(), link({ advisoryId: 'GHSA-2222-3333-4444', withdrawn: later })])
        expect(stamped[0]!.withdrawn).toBe(later)
    })

    // The duplicate case: GHSA-A withdrawn in favour of GHSA-B, both aliasing the CVE. Still real.
    it('leaves the advisory live while any linked record is still active', function () {
        const stamped = stampWithdrawn([advisory()], [link(), link({ advisoryId: 'GHSA-2222-3333-4444', withdrawn: null })])
        expect(stamped[0]!.withdrawn).toBeNull()
    })

    it('leaves the advisory live when the active record comes first', function () {
        const stamped = stampWithdrawn([advisory()], [link({ advisoryId: 'GHSA-2222-3333-4444', withdrawn: null }), link()])
        expect(stamped[0]!.withdrawn).toBeNull()
    })

    it('leaves the advisory live when no OSV record links to it', function () {
        const stamped = stampWithdrawn([advisory()], [link({ advisoryId: 'GHSA-9999-9999-9999', aliases: ['CVE-2020-1'] })])
        expect(stamped[0]!.withdrawn).toBeNull()
    })

    it('leaves the advisory live when there are no OSV records at all', function () {
        expect(stampWithdrawn([advisory()], [])[0]!.withdrawn).toBeNull()
    })

    it('returns the advisory unchanged rather than a copy when nothing is stamped', function () {
        const live = advisory()
        expect(stampWithdrawn([live], [])[0]).toBe(live)
    })

    it('stamps each advisory of a package on its own links', function () {
        const other = advisory({ advisoryId: 'CVE-2024-4068', aliases: ['GHSA-grv7-fg5c-xmjg'] })
        const stamped = stampWithdrawn([advisory(), other], [link(), link({ advisoryId: 'GHSA-grv7-fg5c-xmjg', aliases: ['CVE-2024-4068'], withdrawn: null })])
        expect(stamped.map(function w(a) { return a.withdrawn })).toEqual([WITHDRAWN_AT, null])
    })
})

describe('stampWithdrawnByPackage', function () {
    it('scopes the links to their own package', function () {
        // The same GHSA withdrawn for braces says nothing about the same advisory on micromatch.
        const byPackage = new Map([['braces', [advisory()]], ['micromatch', [advisory()]]])
        const links = new Map([['braces', [link()]], ['micromatch', [link({ withdrawn: null })]]])
        const stamped = stampWithdrawnByPackage(byPackage, links)
        expect(stamped.get('braces')![0]!.withdrawn).toBe(WITHDRAWN_AT)
        expect(stamped.get('micromatch')![0]!.withdrawn).toBeNull()
    })

    it('does not borrow a withdrawal from a different package with the same id', function () {
        const stamped = stampWithdrawnByPackage(new Map([['braces', [advisory()]]]), new Map([['fill-range', [link()]]]))
        expect(stamped.get('braces')![0]!.withdrawn).toBeNull()
    })

    it('keeps every package of the input, linked or not', function () {
        const stamped = stampWithdrawnByPackage(new Map([['braces', [advisory()]], ['lodash', []]]), new Map())
        expect(Array.from(stamped.keys())).toEqual(['braces', 'lodash'])
    })
})

describe('a stamped advisory through the matcher', function () {
    function findingsFor(links: OsvAdvisoryLink[]) {
        return matchPackages([pkg('braces', '3.0.3')], function lookup() {
            return stampWithdrawnByPackage(new Map([['braces', [advisory()]]]), new Map([['braces', links]]))
        })
    }

    it('produces no finding when every linked record is withdrawn', function () {
        expect(findingsFor([link()])).toEqual([])
    })

    // A withdrawal that also stripped the affected ranges still names the package (SENTINEL-47), and the
    // row the normalizer keeps for it is all the evidence there is.
    it('produces no finding when the only linked record is a range-less withdrawal row', function () {
        expect(findingsFor([link({ aliases: [] })])).toEqual([])
    })

    it('still reports the advisory while a linked record is active', function () {
        const findings = findingsFor([link(), link({ advisoryId: 'GHSA-2222-3333-4444', withdrawn: null })])
        expect(findings.map(function id(f) { return f.advisoryId })).toEqual(['CVE-2026-93687'])
    })

    it('still reports the advisory when OSV has nothing linked', function () {
        expect(findingsFor([])).toHaveLength(1)
    })
})
