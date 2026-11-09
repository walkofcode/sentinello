import { describe, expect, it } from 'vitest'
import { baselineCovers, CAPABILITIES } from './capabilities'

describe('baselineCovers', function () {
    it('holds a release capability by ecosystem, whichever source reports it', function () {
        const capability = CAPABILITIES[0]!
        expect(baselineCovers(capability, 'osv', 'PyPI')).toBe(true)
        expect(baselineCovers(capability, 'gemnasium', 'PyPI')).toBe(true)
        expect(baselineCovers(capability, 'npm-audit', 'npm')).toBe(false)
    })

    it('holds an operator baseline by its cells alone', function () {
        const capability = { id: 'sources-1', since: null, ecosystems: ['PyPI' as const], cells: [{ source: 'osv' as const, ecosystem: 'PyPI' as const }] }
        expect(baselineCovers(capability, 'osv', 'PyPI')).toBe(true)
        expect(baselineCovers(capability, 'gemnasium', 'PyPI')).toBe(false)
        expect(baselineCovers(capability, 'osv', 'npm')).toBe(false)
    })
})
