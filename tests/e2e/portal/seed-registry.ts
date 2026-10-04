import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DrizzleDb } from '../../../packages/db/src/client'
import { setRegistryDownloads, upsertRegistryPackage } from '../../../packages/db/src/queries/registry-packages'
import { summarizePackument } from '../../../packages/feeds/src/registry/npm'

// Seeds the worker's npm registry cache (registry_packages) so fix settlement and the way-out guidance run
// entirely offline. The worker settles every npm finding against the registry after each scan; with the
// registry URLs pointed at a port that refuses (playwright.config.ts) and every package the fixture tree
// needs answered from this cache, no scan in the suite reaches registry.npmjs.org, and every fix status
// is the same on every run.
//
// Two kinds of entries, both reduced by the worker's own summarizePackument so the cache holds exactly
// what a real fetch would have stored:
//   - the packuments recorded from registry.npmjs.org on 2026-10-03 for the worker's --fixture smokes
//     (apps/worker/test/fixtures/registry/base): braces, node-forge and every package the nodemon chain's
//     way-out walk reads. watch-tools' braces and node-forge findings settle against these.
//   - small packuments for the advisory fixtures the other projects match (lodash, minimist, axios,
//     fixture-pkg-01..30, totally-not-malware): each publishes the installed version and the advisory's
//     fix, so those findings settle `released` exactly as they do against the real registry.
//
// A package absent from both is answered by nothing: its lookup fails at the refused port and the
// finding settles `unverified` — never a network call.

const HERE = dirname(fileURLToPath(import.meta.url))
const RECORDED = resolve(HERE, '..', '..', '..', 'apps', 'worker', 'test', 'fixtures', 'registry', 'base')
const NPM = 'npm'

// Published versions per fixture package, oldest first; the last is the latest tag.
const FIXTURE_RELEASES: Record<string, string[]> = {
    lodash: ['4.17.11', '4.17.21'],
    minimist: ['1.2.0', '1.2.6'],
    axios: ['1.6.0', '1.7.0'],
    'totally-not-malware': ['1.0.0'],
    'fixture-pkg-safe': ['1.0.0']
}
for (let i = 1; i <= 30; i++) FIXTURE_RELEASES['fixture-pkg-' + String(i).padStart(2, '0')] = ['1.0.0', '2.0.0']

// Fixed publish dates for the fixture packages, a day apart. None of them reaches the way-out guidance
// (each has a released fix), so no "months since" is ever computed from them.
const FIXTURE_PUBLISHED = Date.UTC(2026, 0, 1)

function fixturePackument(name: string, versions: string[]): Record<string, unknown> {
    return {
        name,
        'dist-tags': { latest: versions[versions.length - 1] },
        maintainers: [{ name: 'fixture' }],
        time: Object.fromEntries(versions.map(function at(v, i) { return [v, new Date(FIXTURE_PUBLISHED + i * 86_400_000).toISOString()] })),
        versions: Object.fromEntries(versions.map(function manifest(v) { return [v, { name, version: v }] }))
    }
}

export function seedRegistryCache(db: DrizzleDb, checkedAt: number): { packages: number } {
    const packuments = new Map<string, unknown>()
    for (const file of readdirSync(RECORDED)) {
        if (!file.endsWith('.json') || file.startsWith('_')) continue
        const body = JSON.parse(readFileSync(join(RECORDED, file), 'utf8')) as { name: string }
        packuments.set(body.name, body)
    }
    for (const [name, versions] of Object.entries(FIXTURE_RELEASES)) packuments.set(name, fixturePackument(name, versions))

    for (const [name, body] of packuments) {
        const summary = summarizePackument(name, body)
        if (summary === null) throw new Error('[e2e] the registry fixture for ' + name + ' does not reduce to a summary')
        upsertRegistryPackage(db, { ecosystem: NPM, name, status: 'ok', summaryJson: JSON.stringify(summary), checkedAt })
    }
    const downloads = JSON.parse(readFileSync(join(RECORDED, '_downloads.json'), 'utf8')) as Record<string, number>
    for (const [name, count] of Object.entries(downloads)) setRegistryDownloads(db, NPM, name, count, checkedAt)
    return { packages: packuments.size }
}
