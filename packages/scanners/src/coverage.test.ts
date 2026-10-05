import { describe, expect, it } from 'vitest'
import { unresolvedGraphReason, unresolvedGraphRawJson } from './coverage'

describe('unresolvedGraphReason', function () {
    it('is no_lockfile when the resolver recorded nothing', function () {
        expect(unresolvedGraphReason(undefined)).toBe('no_lockfile')
        expect(unresolvedGraphReason([])).toBe('no_lockfile')
    })

    it('takes the first unreadable ecosystem reason', function () {
        expect(unresolvedGraphReason([
            { ecosystem: 'npm', status: 'ok' },
            { ecosystem: 'PyPI', status: 'partial', reasonCode: 'partial_dependency_graph' },
            { ecosystem: 'Go', status: 'unauditable' },
            { ecosystem: 'crates.io', status: 'unauditable', reasonCode: 'unsupported_lockfile' }
        ])).toBe('unsupported_lockfile')
    })
})

describe('unresolvedGraphRawJson', function () {
    it('records the coverage it was given, or none', function () {
        expect(JSON.parse(unresolvedGraphRawJson('osv', undefined))).toEqual({ source: 'osv', packageCount: null, findingCount: 0, coverage: [] })
    })
})
