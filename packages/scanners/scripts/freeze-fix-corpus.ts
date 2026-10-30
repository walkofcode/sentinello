// Freezes the two real-advisory corpora the generated sweeps run over, so the tests stay hermetic:
//
//   packages/scanners/src/fixtures/fix-corpus.ndjson.gz — every distinct (source, ecosystem, ranges, exact
//     versions, malicious) record, as the CURRENT normalizers produce it, for the fix-derivation sweep
//     (src/version-fix-corpus.test.ts);
//   packages/feeds/src/gemnasium/ranges.fixture.json — every distinct raw `affected_range` gemnasium-db
//     states, per ecosystem, for the range-fidelity sweep (feeds/src/gemnasium/range-fidelity.test.ts).
//
// Inputs, all read-only:
//   <exportDir>/osv/<OSV ecosystem>/*.json  — the per-ecosystem OSV exports (all.zip, unzipped), for every
//                                             ecosystem but npm;
//   <exportDir>/gemnasium/<root>/<type>/…    — the gemnasium-db repository archive, unzipped;
//   <exportDir>/gemnasium.sha                — the commit the archive was fetched at;
//   <dataDir>/osv.db                         — a portal's OSV cache, for npm only: npm's export is over
//                                             200 MB, and its normalizer did not change, so the cached rows
//                                             ARE what the current normalizer produces.
// The exports are downloaded once by hand (the URLs are in packages/feeds/src/osv/feed.ts and gemnasium/feed.ts)
// and are untrusted data: this only parses them as JSON and YAML.
//
// Usage (Node 24, which ships node:sqlite), from the repo root:
//   pnpm --filter @sentinello/worker exec tsx ../../packages/scanners/scripts/freeze-fix-corpus.ts <exportDir> [dataDir]
// dataDir defaults to ~/Apps/sentinello/data, the live instance's feed caches.

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { ECOSYSTEMS } from '../../core/src/ecosystems'
import { normalizeGemnasiumRecord } from '../../feeds/src/gemnasium/normalize'
import { normalizeOsvRecord } from '../../feeds/src/osv/normalize'

const feedsRequire = createRequire(new URL('../../feeds/package.json', import.meta.url))
const yaml = feedsRequire('js-yaml') as { load(text: string): unknown }

const exportDir = process.argv[2]
if (!exportDir) throw new Error('usage: freeze-fix-corpus.ts <exportDir> [dataDir]')
const dataDir = process.argv[3] ?? join(homedir(), 'Apps', 'sentinello', 'data')
const corpusPath = fileURLToPath(new URL('../src/fixtures/fix-corpus.ndjson.gz', import.meta.url))
const rangesPath = fileURLToPath(new URL('../../feeds/src/gemnasium/ranges.fixture.json', import.meta.url))

type Row = { ecosystem: string; ranges: unknown[]; versions: string[]; malicious: boolean; withdrawn: number | null }

const records = new Map<string, string>()
const counts: Record<string, number> = {}
function add(source: string, row: Row): void {
    if (row.withdrawn !== null) return
    const line = JSON.stringify({ source, ecosystem: row.ecosystem, ranges: row.ranges, versions: row.versions, malicious: row.malicious })
    if (records.has(line)) return
    records.set(line, source + '/' + row.ecosystem)
    counts[source + '/' + row.ecosystem] = (counts[source + '/' + row.ecosystem] ?? 0) + 1
}

// OSV npm, from the cache.
const osvDb = new DatabaseSync(join(dataDir, 'osv.db'), { readOnly: true })
const npmRows = osvDb
    .prepare("SELECT DISTINCT ecosystem, ranges_json, versions_json, malicious FROM osv_advisories WHERE withdrawn IS NULL AND ecosystem = 'npm'")
    .all() as Array<{ ecosystem: string; ranges_json: string; versions_json: string; malicious: number }>
for (const row of npmRows) {
    add('osv', { ecosystem: row.ecosystem, ranges: JSON.parse(row.ranges_json) as unknown[], versions: JSON.parse(row.versions_json) as string[], malicious: row.malicious === 1, withdrawn: null })
}
osvDb.close()

// OSV, every other ecosystem, from its export.
for (const eco of ECOSYSTEMS) {
    if (eco.id === 'npm') continue
    const dir = join(exportDir, 'osv', eco.osvEcosystem)
    for (const file of readdirSync(dir)) {
        if (!file.endsWith('.json')) continue
        for (const row of normalizeOsvRecord(JSON.parse(readFileSync(join(dir, file), 'utf8')), eco.osvEcosystem)) add('osv', row)
    }
}

// gemnasium, every ecosystem, from the archive — normalized rows for the fix corpus, raw ranges for the
// range-fidelity corpus.
const archiveRoot = join(exportDir, 'gemnasium', readdirSync(join(exportDir, 'gemnasium'))[0] as string)
const rawRanges: Record<string, Set<string>> = {}
for (const eco of ECOSYSTEMS) {
    const ranges = new Set<string>()
    rawRanges[eco.id] = ranges
    for (const path of walk(join(archiveRoot, eco.gemnasiumPackageType))) {
        if (!path.endsWith('.yml')) continue
        let parsed: unknown
        try {
            parsed = yaml.load(readFileSync(path, 'utf8'))
        } catch {
            continue
        }
        const range = (parsed as { affected_range?: unknown } | null)?.affected_range
        if (typeof range === 'string') ranges.add(range)
        for (const row of normalizeGemnasiumRecord(parsed, eco.id, eco.gemnasiumPackageType + '/')) add('gemnasium', row)
    }
}

function* walk(dir: string): Generator<string> {
    for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) yield* walk(path)
        else yield path
    }
}

const lines = [...records.keys()].sort()
writeFileSync(corpusPath, gzipSync(lines.join('\n') + '\n', { level: 9 }))

const sha = readFileSync(join(exportDir, 'gemnasium.sha'), 'utf8').trim()
const fixture = {
    sha,
    counts: Object.fromEntries(ECOSYSTEMS.map(function count(eco) { return [eco.id, (rawRanges[eco.id] as Set<string>).size] })),
    ranges: Object.fromEntries(ECOSYSTEMS.map(function sorted(eco) { return [eco.id, [...(rawRanges[eco.id] as Set<string>)].sort()] }))
}
writeFileSync(rangesPath, JSON.stringify(fixture) + '\n')
console.log(JSON.stringify({ corpusPath, records: lines.length, counts, rangesPath, rangeCounts: fixture.counts }))
