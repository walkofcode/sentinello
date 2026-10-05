import { describe, expect, it } from 'vitest'
import { createMemoryRegistryStore } from './memory-store'

const ROW = { name: 'a', status: 'ok' as const, summaryJson: '{}', checkedAt: 1, etag: '"e"', weeklyDownloads: 5, downloadsCheckedAt: 2 }

describe('createMemoryRegistryStore', function () {
    it('answers only the names it holds, starting from the rows it was given', function () {
        const store = createMemoryRegistryStore([ROW])
        expect(Object.fromEntries(store.get(['a', 'missing']))).toEqual({ a: ROW })
    })

    it('replaces an answer but keeps its download count, and starts a new one without a count', function () {
        const store = createMemoryRegistryStore([ROW])
        store.put({ name: 'a', status: 'not_found', summaryJson: null, checkedAt: 9, etag: null })
        store.put({ name: 'b', status: 'ok', summaryJson: '{}', checkedAt: 9, etag: null })
        expect(store.get(['a']).get('a')).toEqual({ name: 'a', status: 'not_found', summaryJson: null, checkedAt: 9, etag: null, weeklyDownloads: 5, downloadsCheckedAt: 2 })
        expect(store.get(['b']).get('b')).toMatchObject({ weeklyDownloads: null, downloadsCheckedAt: null })
    })

    it('records a count only beside an answer', function () {
        const store = createMemoryRegistryStore([ROW])
        store.setDownloads('a', 42, 7)
        store.setDownloads('missing', 1, 7)
        expect(store.get(['a']).get('a')).toMatchObject({ weeklyDownloads: 42, downloadsCheckedAt: 7 })
        expect(store.get(['missing']).size).toBe(0)
    })

    it('copies rows in and out, so a reader never holds the stored row', function () {
        const given = { ...ROW }
        const store = createMemoryRegistryStore([given])
        given.checkedAt = 99
        const read = store.get(['a']).get('a')
        if (read) read.checkedAt = 100
        expect(store.get(['a']).get('a')?.checkedAt).toBe(1)
    })
})
