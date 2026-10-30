import { describe, expect, it } from 'vitest'
import { isInsideProject, isWithin } from './paths'

// SENTINEL-147: only a `..` path component leaves a directory.
describe('isWithin', function () {
    it.each([
        ['the directory itself', '/r', '/r', true],
        ['a child', '/r', '/r/app', true],
        ['a child named ..service', '/r', '/r/..service', true],
        ['a grandchild below ..ios', '/r/app', '/r/app/native/..ios/x', true],
        ['the parent', '/r/app', '/r', false],
        ['a sibling', '/r/app', '/r/other', false],
        ['a sibling reached through ..', '/r/app', '/r/app/../outside', false],
        ['a sibling named ..app', '/r/app', '/r/..app', false]
    ])('%s', function (_label, dir, path, expected) {
        expect(isWithin(dir, path)).toBe(expected)
    })

    it('reads a local dependency path from its own directory', function () {
        expect(isInsideProject('/r/app', '/r/app/crates/a', '../..b')).toBe(true)
        expect(isInsideProject('/r/app', '/r/app', '../outside')).toBe(false)
    })
})
