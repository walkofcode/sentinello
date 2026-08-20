import { describe, expect, it } from 'vitest'
import { GEMNASIUM_NORMALIZER_VERSION, OSV_NORMALIZER_VERSION } from './advisory-rows'
import { sourceNormalizerVersion } from './sources'

// The portal compares a mirrored SourceStatus.normalizerVersion against this to decide whether the
// scanner will actually match against the cache. Pinned against the constants rather than literals so
// a bump cannot make the mapping quietly disagree with what seedOsv/rebuildGemnasium stamp.
describe('sourceNormalizerVersion', function () {
    it('answers with the version each cache-backed source stamps its rows with', function () {
        expect(sourceNormalizerVersion('osv')).toBe(OSV_NORMALIZER_VERSION)
        expect(sourceNormalizerVersion('gemnasium')).toBe(GEMNASIUM_NORMALIZER_VERSION)
    })

    it('answers null for a source that keeps no cache', function () {
        expect(sourceNormalizerVersion('npm-audit')).toBeNull()
    })
})
