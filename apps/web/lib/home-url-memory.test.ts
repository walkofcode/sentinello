import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    recallLibrariesUrl,
    recallProjectsUrl,
    rememberLibrariesUrl,
    rememberProjectsUrl
} from './home-url-memory'

// Remembers the last filter/sort URL per listing so the back-link from a detail page returns you to
// the view you left rather than a reset one.
//
// The suite runs under vitest's `node` environment, so `window` is genuinely undefined by default —
// which means the SSR guard is the DEFAULT branch here, not an edge case, and it gets tested for free.
// The browser branches are reached by stubbing a window object rather than pulling in a full DOM: the
// module touches exactly one API (window.sessionStorage), so a jsdom instance would add a dependency
// and a per-file environment override to exercise two method calls.

type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void }

function withStorage(storage: Store): void {
    vi.stubGlobal('window', { sessionStorage: storage })
}

function memoryStorage(): Store & { data: Map<string, string> } {
    const data = new Map<string, string>()
    return {
        data,
        getItem: function getItem(key) {
            return data.get(key) ?? null
        },
        setItem: function setItem(key, value) {
            data.set(key, value)
        }
    }
}

// Privacy mode and quota exhaustion both surface as a throw from the storage call itself.
function throwingStorage(): Store {
    return {
        getItem: function getItem(): string | null {
            throw new DOMException('The operation is insecure.', 'SecurityError')
        },
        setItem: function setItem(): void {
            throw new DOMException('The operation is insecure.', 'SecurityError')
        }
    }
}

afterEach(function teardown() {
    vi.unstubAllGlobals()
})

describe('server-side rendering', function () {
    // These helpers are imported by components that render on the server first. Touching `window`
    // there would throw during SSR and take the page down, so absence must be a silent no-op.
    it('recalls nothing when there is no window', function () {
        expect(recallProjectsUrl()).toBeNull()
        expect(recallLibrariesUrl()).toBeNull()
    })

    it('remembers without throwing when there is no window', function () {
        expect(function remember() {
            rememberProjectsUrl('/projects?sort=name')
            rememberLibrariesUrl('/libraries?sort=name')
        }).not.toThrow()
    })
})

describe('in the browser', function () {
    it('round-trips the projects URL', function () {
        withStorage(memoryStorage())
        rememberProjectsUrl('/projects?depType=dev&sort=name')
        expect(recallProjectsUrl()).toBe('/projects?depType=dev&sort=name')
    })

    it('round-trips the libraries URL', function () {
        withStorage(memoryStorage())
        rememberLibrariesUrl('/libraries?minSeverity=high')
        expect(recallLibrariesUrl()).toBe('/libraries?minSeverity=high')
    })

    // Two listings, two independent memories — returning from a library must not land on the projects
    // view or vice versa.
    it('keeps the two listings under separate keys', function () {
        const storage = memoryStorage()
        withStorage(storage)
        rememberProjectsUrl('/projects?sort=name')
        rememberLibrariesUrl('/libraries?sort=severity')

        expect(recallProjectsUrl()).toBe('/projects?sort=name')
        expect(recallLibrariesUrl()).toBe('/libraries?sort=severity')
        expect(Array.from(storage.data.keys()).sort()).toEqual([
            'sentinello:home-url:libraries',
            'sentinello:home-url:projects'
        ])
    })

    it('overwrites a previously remembered URL', function () {
        withStorage(memoryStorage())
        rememberProjectsUrl('/projects?sort=name')
        rememberProjectsUrl('/projects?sort=severity')
        expect(recallProjectsUrl()).toBe('/projects?sort=severity')
    })

    it('recalls null before anything has been remembered', function () {
        withStorage(memoryStorage())
        expect(recallProjectsUrl()).toBeNull()
        expect(recallLibrariesUrl()).toBeNull()
    })
})

describe('when sessionStorage is unavailable', function () {
    // Safari private mode and a full quota both throw rather than returning null. A remembered URL is
    // a convenience, so losing it must never break navigation.
    it('swallows a throwing setItem', function () {
        withStorage(throwingStorage())
        expect(function remember() {
            rememberProjectsUrl('/projects?sort=name')
            rememberLibrariesUrl('/libraries?sort=name')
        }).not.toThrow()
    })

    it('recalls null when getItem throws', function () {
        withStorage(throwingStorage())
        expect(recallProjectsUrl()).toBeNull()
        expect(recallLibrariesUrl()).toBeNull()
    })
})
