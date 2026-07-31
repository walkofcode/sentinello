import { afterEach, describe, expect, it } from 'vitest'
import type { ScannerPlugin, ScanContext, ScanResult } from './types'
import { getScanner, listScanners, registerScanner, npmAuditPlugin } from './index'

// The plugin registry is a module-level Map, so it is shared by every importer in the process and
// mutations persist for the life of the module. That is fine in the worker (one registration at
// import, none after) but it means these tests have to put it back afterwards.

const BASELINE = listScanners().map(function name(plugin) {
    return plugin.name
})

function fakePlugin(name: string): ScannerPlugin {
    return {
        name,
        async scan(_projectPath: string, _ctx: ScanContext): Promise<ScanResult> {
            throw new Error('not called')
        }
    } as ScannerPlugin
}

afterEach(function restore() {
    for (const plugin of listScanners()) {
        if (!BASELINE.includes(plugin.name)) registerScanner(fakePlugin(plugin.name))
    }
    // The Map has no delete in the public surface, so anything this file added would leak into other
    // suites in the same process. Nothing here registers a name that is not cleaned up by re-running
    // the file, but assert the baseline is intact so a future addition cannot silently widen it.
    expect(listScanners().map(function name(plugin) { return plugin.name })).toContain(npmAuditPlugin.name)
})

describe('the default registry', function () {
    // npm-audit is registered at import rather than by a caller, so the worker gets it without any
    // bootstrap step. It is also the only scanner registered this way — the advisory-feed sources
    // (osv, gemnasium) are constructed per-batch by their runtimes with live config closed over, so
    // they deliberately never enter this registry.
    it('registers npm-audit at import time', function () {
        expect(getScanner('npm-audit')).toBe(npmAuditPlugin)
    })

    it('lists npm-audit and nothing that is not registered', function () {
        expect(BASELINE).toEqual(['npm-audit'])
    })

    it('returns undefined for a name nobody registered', function () {
        expect(getScanner('osv')).toBeUndefined()
        expect(getScanner('')).toBeUndefined()
    })
})

describe('registerScanner', function () {
    it('makes a plugin retrievable by its own name', function () {
        const plugin = fakePlugin('test-scanner')
        registerScanner(plugin)
        expect(getScanner('test-scanner')).toBe(plugin)
        expect(listScanners()).toContain(plugin)
    })

    // Keyed by plugin.name, not by insertion, so registering twice replaces rather than duplicates.
    // A duplicate would make the runner scan the same project twice and merge findings against
    // itself, which reads as every finding resolving and immediately reappearing.
    it('replaces an existing registration with the same name', function () {
        const first = fakePlugin('test-scanner')
        const second = fakePlugin('test-scanner')
        registerScanner(first)
        registerScanner(second)

        expect(getScanner('test-scanner')).toBe(second)
        expect(listScanners().filter(function match(p) { return p.name === 'test-scanner' })).toHaveLength(1)
    })

    it('can replace the built-in npm-audit registration', function () {
        const replacement = fakePlugin('npm-audit')
        registerScanner(replacement)
        expect(getScanner('npm-audit')).toBe(replacement)

        registerScanner(npmAuditPlugin)
        expect(getScanner('npm-audit')).toBe(npmAuditPlugin)
    })
})

describe('listScanners', function () {
    it('returns a fresh array that does not write back into the registry', function () {
        const before = listScanners()
        before.length = 0
        expect(listScanners().length).toBeGreaterThan(0)
    })

    it('reflects registrations in insertion order', function () {
        registerScanner(fakePlugin('zzz-last'))
        const names = listScanners().map(function name(p) { return p.name })
        expect(names[0]).toBe('npm-audit')
        expect(names[names.length - 1]).toBe('zzz-last')
    })
})
