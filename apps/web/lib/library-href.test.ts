import { describe, expect, test } from 'vitest'
import { libraryDetailHref, libraryHref } from './library-href'

describe('libraryHref', function suite() {
    test('encodes both segments', function encodes() {
        expect(libraryHref('crates.io', '@scope/pkg')).toBe('/libraries/crates.io/%40scope%2Fpkg')
    })
})

describe('libraryDetailHref', function suite() {
    test('is the bare path on the default dep type', function defaults() {
        expect(libraryDetailHref('npm', 'lodash', 'prod', 'prod')).toBe('/libraries/npm/lodash')
    })

    test('carries any other dep type as ?dep', function carried() {
        expect(libraryDetailHref('npm', 'lodash', 'all', 'prod')).toBe('/libraries/npm/lodash?dep=all')
    })
})
