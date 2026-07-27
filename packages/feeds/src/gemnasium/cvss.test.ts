import { describe, expect, it } from 'vitest'
import { severityFromCvss } from './cvss'

// gemnasium ships CVSS vectors rather than a bucketed severity, so these buckets are computed from
// the v3.1 / v2.0 base-score formulas. The vectors below are canonical published examples whose
// official scores are well known, which is what makes them useful as a regression net: an arithmetic
// slip anywhere in the formula moves one of these off its documented band.
describe('severityFromCvss — CVSS v3.1 base vectors', function () {
    it('scores a full-impact network attack as critical (9.8)', function () {
        expect(severityFromCvss('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', null)).toBe('critical')
    })

    it('scores a network denial of service as high (7.5)', function () {
        expect(severityFromCvss('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H', null)).toBe('high')
    })

    it('scores a local privilege escalation as high (7.8)', function () {
        expect(severityFromCvss('CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H', null)).toBe('high')
    })

    // The canonical reflected-XSS vector, and the only one here that exercises the scope-changed
    // branch (S:C swaps the privileges-required table and applies the 1.08 multiplier).
    it('scores reflected XSS as moderate (6.1) via the scope-changed branch', function () {
        expect(severityFromCvss('CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N', null)).toBe('moderate')
    })

    it('scores a hard-to-exploit partial availability hit as low (3.7)', function () {
        expect(severityFromCvss('CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:N/I:N/A:L', null)).toBe('low')
    })

    // Zero impact short-circuits before the exploitability term is added.
    it('scores a no-impact vector as none (0.0)', function () {
        expect(severityFromCvss('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N', null)).toBe('none')
    })

    it('accepts a 3.0 prefix and a vector with no prefix at all', function () {
        expect(severityFromCvss('CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', null)).toBe('critical')
        expect(severityFromCvss('AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', null)).toBe('critical')
    })

    it('uppercases metric values before looking them up', function () {
        expect(severityFromCvss('CVSS:3.1/AV:n/AC:l/PR:n/UI:n/S:u/C:h/I:h/A:h', null)).toBe('critical')
    })
})

describe('severityFromCvss — CVSS v2.0 fallback', function () {
    it('scores a complete-compromise vector as high (10.0)', function () {
        expect(severityFromCvss(null, 'AV:N/AC:L/Au:N/C:C/I:C/A:C')).toBe('high')
    })

    it('scores a partial confidentiality leak as moderate (4.3)', function () {
        expect(severityFromCvss(null, 'AV:N/AC:M/Au:N/C:P/I:N/A:N')).toBe('moderate')
    })

    it('accepts the Au metric in either casing', function () {
        expect(severityFromCvss(null, 'AV:N/AC:L/AU:N/C:C/I:C/A:C')).toBe('high')
    })

    // v2's qualitative map has no critical band — it tops out at High. A v2-scored advisory can
    // therefore never reach 'critical', which is why v3 is preferred whenever it is present.
    it('never returns critical, because v2 has no such band', function () {
        expect(severityFromCvss(null, 'AV:N/AC:L/Au:N/C:C/I:C/A:C')).not.toBe('critical')
    })

    // Unlike v3, a zero v2 score buckets as 'low' rather than 'none'.
    it('buckets a zero score as low rather than none', function () {
        expect(severityFromCvss(null, 'AV:N/AC:L/Au:N/C:N/I:N/A:N')).toBe('low')
    })
})

describe('severityFromCvss — source preference and failure modes', function () {
    it('prefers v3 when both vectors are present', function () {
        // v3 here is critical; v2 here is moderate. v3 must win.
        const result = severityFromCvss('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', 'AV:N/AC:M/Au:N/C:P/I:N/A:N')
        expect(result).toBe('critical')
    })

    // A v3 vector missing a required base metric yields no score, so v2 must still be consulted
    // rather than the whole record degrading to null.
    it('falls back to v2 when the v3 vector is incomplete', function () {
        expect(severityFromCvss('CVSS:3.1/AV:N/AC:L', 'AV:N/AC:M/Au:N/C:P/I:N/A:N')).toBe('moderate')
    })

    it('returns null when neither vector is usable', function () {
        expect(severityFromCvss(null, null)).toBeNull()
        expect(severityFromCvss('', '')).toBeNull()
        expect(severityFromCvss('   ', null)).toBeNull()
        expect(severityFromCvss('nonsense', null)).toBeNull()
    })

    it('returns null for a vector missing required metrics', function () {
        expect(severityFromCvss('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U', null)).toBeNull()
    })

    // An unrecognised metric VALUE is not the same as an absent metric; both must decline to score
    // rather than substituting a default weight.
    it('returns null for an unrecognised metric value', function () {
        expect(severityFromCvss('CVSS:3.1/AV:Z/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', null)).toBeNull()
    })
})
