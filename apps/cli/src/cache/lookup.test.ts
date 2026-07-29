import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { GemnasiumAdvisoryRow, OsvAdvisoryRow } from '@sentinello/core'
import { advisoryFilePath, ensureCacheDir, type SourceId } from './meta'
import { createRowWriter } from './store'
import { cacheEcosystemKey, loadCacheForPackages } from './lookup'

// The adapter that lets one matching engine serve both the portal (SQLite) and the CLI (gzipped ndjson).
// Because OsvLookup is a plain injected function, neither scanner can tell which side it is talking to —
// which is what makes CLI-versus-portal equivalence a testable property rather than a hope. These tests
// drive the real writer and the real reader over real files; there is no seam worth stubbing.

let dir: string

function osvRow(overrides: Partial<OsvAdvisoryRow> = {}): OsvAdvisoryRow {
    return {
        advisoryId: 'GHSA-aaaa',
        ecosystem: 'npm',
        packageName: 'lodash',
        aliases: ['CVE-2024-1'],
        ranges: [{ type: 'SEMVER', introduced: '0', fixed: '4.17.21' }],
        versions: [],
        severity: 'high',
        summary: 'Prototype pollution',
        url: 'https://example.test/GHSA-aaaa',
        malicious: false,
        // An epoch-ms timestamp, not a flag — a boolean is not bindable and the column is nullable.
        withdrawn: null,
        ...overrides
    } as OsvAdvisoryRow
}

function gemRow(overrides: Partial<GemnasiumAdvisoryRow> = {}): GemnasiumAdvisoryRow {
    return {
        advisoryId: 'GMS-2024-1',
        ecosystem: 'npm',
        packageName: 'lodash',
        aliases: ['CVE-2024-1'],
        ranges: [{ type: 'SEMVER', introduced: '0', fixed: '4.17.21' }],
        versions: [],
        severity: 'high',
        summary: 'Prototype pollution',
        url: 'https://example.test/GMS-2024-1',
        ...overrides
    } as GemnasiumAdvisoryRow
}

async function seed(source: SourceId, rows: readonly object[], ecosystem = 'npm'): Promise<void> {
    await ensureCacheDir(dir)
    const writer = createRowWriter(advisoryFilePath(dir, source, ecosystem))
    await writer.write(rows as never)
    await writer.commit()
}

beforeEach(async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-lookup-'))
})

afterEach(async function teardown() {
    await rm(dir, { recursive: true, force: true })
})

describe('loadCacheForPackages', function () {
    it('returns rows for the requested packages, keyed by name', async function () {
        await seed('osv', [osvRow(), osvRow({ advisoryId: 'GHSA-bbbb' }), osvRow({ packageName: 'express' })])
        const cache = await loadCacheForPackages(dir, 'npm', ['lodash'], ['osv'])
        expect(cache.osv.get('lodash')).toHaveLength(2)
        expect(cache.osv.has('express')).toBe(false)
    })

    // The npm corpus holds ~217k names; a real project resolves under a thousand. Discarding the rest
    // without parsing it is the whole reason for the line format.
    it('does not parse rows for packages that were not asked for', async function () {
        await seed('osv', [osvRow({ packageName: 'unwanted', summary: 'not parsed' })])
        const cache = await loadCacheForPackages(dir, 'npm', ['lodash'], ['osv'])
        expect(cache.osv.size).toBe(0)
    })

    it('reads nothing for a source that is not enabled', async function () {
        await seed('osv', [osvRow()])
        await seed('gemnasium', [gemRow()])
        const osvOnly = await loadCacheForPackages(dir, 'npm', ['lodash'], ['osv'])
        expect(osvOnly.osv.size).toBe(1)
        expect(osvOnly.gemnasium.size).toBe(0)
        const gemOnly = await loadCacheForPackages(dir, 'npm', ['lodash'], ['gemnasium'])
        expect(gemOnly.osv.size).toBe(0)
        expect(gemOnly.gemnasium.size).toBe(1)
    })

    it('returns both maps empty when no source is enabled', async function () {
        await seed('osv', [osvRow()])
        const cache = await loadCacheForPackages(dir, 'npm', ['lodash'], [])
        expect(cache.osv.size).toBe(0)
        expect(cache.gemnasium.size).toBe(0)
    })

    // A cold cache is a normal state, not an error — the first run has no files at all.
    it('returns empty maps when the cache files do not exist', async function () {
        const cache = await loadCacheForPackages(dir, 'npm', ['lodash'], ['osv', 'gemnasium'])
        expect(cache.osv.size).toBe(0)
        expect(cache.gemnasium.size).toBe(0)
    })

    it('returns empty maps when no packages were requested', async function () {
        await seed('osv', [osvRow()])
        const cache = await loadCacheForPackages(dir, 'npm', [], ['osv'])
        expect(cache.osv.size).toBe(0)
    })

    it('carries every OSV matching field through to the scanner shape', async function () {
        await seed('osv', [osvRow({ malicious: true, versions: ['4.4.2'] })])
        const cache = await loadCacheForPackages(dir, 'npm', ['lodash'], ['osv'])
        expect(cache.osv.get('lodash')?.[0]).toEqual({
            advisoryId: 'GHSA-aaaa',
            aliases: ['CVE-2024-1'],
            ranges: [{ type: 'SEMVER', introduced: '0', fixed: '4.17.21' }],
            versions: ['4.4.2'],
            severity: 'high',
            summary: 'Prototype pollution',
            url: 'https://example.test/GHSA-aaaa',
            malicious: true
        })
    })

    // gemnasium carries no malware threat class, so the flag is dropped rather than invented as false.
    it('omits `malicious` from gemnasium advisories entirely', async function () {
        await seed('gemnasium', [gemRow()])
        const cache = await loadCacheForPackages(dir, 'npm', ['lodash'], ['gemnasium'])
        const advisory = cache.gemnasium.get('lodash')?.[0]
        expect(advisory).not.toHaveProperty('malicious')
        expect(advisory?.advisoryId).toBe('GMS-2024-1')
    })

    it('reads each source from its own ecosystem-scoped file', async function () {
        await seed('osv', [osvRow({ packageName: 'flask', ecosystem: 'PyPI' })], 'PyPI')
        const npmCache = await loadCacheForPackages(dir, 'npm', ['flask'], ['osv'])
        expect(npmCache.osv.size).toBe(0)
        const pypiCache = await loadCacheForPackages(dir, 'PyPI', ['flask'], ['osv'])
        expect(pypiCache.osv.size).toBe(1)
    })

    // Ecosystem ids can contain characters that are awkward in filenames, so the path slugs them —
    // 'crates.io' keeps its dot, but anything outside [A-Za-z0-9._-] collapses to a dash.
    it('round-trips an ecosystem id that needs slugging in the filename', async function () {
        await seed('osv', [osvRow({ packageName: 'serde', ecosystem: 'crates.io' })], 'crates.io')
        const cache = await loadCacheForPackages(dir, 'crates.io', ['serde'], ['osv'])
        expect(cache.osv.get('serde')).toHaveLength(1)
    })
})

describe('cacheEcosystemKey', function () {
    // EcosystemId is currently spelled with the canonical OSV ids themselves ('PyPI', 'Go', 'crates.io' —
    // not lowercase slugs), so this resolves to an identity for every registered ecosystem. That is worth
    // stating rather than assuming: the registry lookup exists so that if the internal id and the feed id
    // ever diverge, the cache keeps being keyed by the feed id instead of silently missing every advisory.
    it.each(['npm', 'PyPI', 'Go', 'crates.io'])('resolves the registered ecosystem %s through the registry', function (id) {
        expect(cacheEcosystemKey(id)).toBe(id)
    })

    it('passes an unregistered ecosystem through unchanged', function () {
        expect(cacheEcosystemKey('nuget')).toBe('nuget')
    })

    // The registry is case-sensitive, so a lowercase slug is NOT recognised and falls through unmapped.
    // Anything constructing a cache key by lowercasing would therefore read the wrong file.
    it('does not recognise a lowercased id', function () {
        expect(cacheEcosystemKey('pypi')).toBe('pypi')
    })
})
