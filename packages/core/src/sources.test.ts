import { describe, expect, it } from 'vitest'
import { GEMNASIUM_NORMALIZER_VERSION, OSV_NORMALIZER_VERSIONS, osvNormalizerVersion } from './advisory-rows'
import { ECOSYSTEMS } from './ecosystems'
import { sourceNormalizerVersion } from './sources'

// The portal compares a mirrored SourceStatus.normalizerVersion against this to decide whether the
// scanner will actually match against the cache. Pinned against the constants rather than literals so
// a bump cannot make the mapping quietly disagree with what seedOsv/rebuildGemnasium stamp.
describe('sourceNormalizerVersion', function () {
    it('answers with the version each cache-backed source stamps its rows with', function () {
        for (const eco of ECOSYSTEMS) {
            expect(sourceNormalizerVersion('osv', eco.id)).toBe(OSV_NORMALIZER_VERSIONS[eco.id])
            expect(sourceNormalizerVersion('gemnasium', eco.id)).toBe(GEMNASIUM_NORMALIZER_VERSION)
        }
    })

    it('answers null for a source that keeps no cache', function () {
        expect(sourceNormalizerVersion('npm-audit', 'npm')).toBeNull()
    })
})

// Per ecosystem, so a change that re-derives only PyPI rows re-seeds PyPI alone and npm's 200 MB export is
// never fetched again for it.
describe('osvNormalizerVersion', function () {
    it('answers per ecosystem, npm unchanged by 3.8', function () {
        expect(osvNormalizerVersion('npm')).toBe(7)
        for (const id of ['PyPI', 'Go', 'crates.io', 'RubyGems']) expect(osvNormalizerVersion(id)).toBe(8)
    })

    it('fails loudly for an ecosystem the registry does not know', function () {
        expect(function unknown() { return osvNormalizerVersion('maven') }).toThrow('unknown ecosystem "maven"')
    })
})
