// Freezes the real advisory corpus the fix-picker sweep runs over (src/version-fix-corpus.test.ts): every
// distinct (source, ecosystem, ranges, exact versions, malicious) record in the osv and gemnasium caches.
// Read-only against the caches; the output is a gzipped ndjson so the test stays hermetic.
//
// Usage (Node 24, which ships node:sqlite):
//   node packages/scanners/scripts/freeze-fix-corpus.mjs [dataDir]
// dataDir defaults to ~/Apps/sentinello/data, the live instance's feed caches.

import { DatabaseSync } from 'node:sqlite'
import { writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dataDir = process.argv[2] ?? join(homedir(), 'Apps', 'sentinello', 'data')
const outPath = fileURLToPath(new URL('../src/fixtures/fix-corpus.ndjson.gz', import.meta.url))

const SOURCES = [
    { source: 'osv', file: 'osv.db', table: 'osv_advisories' },
    { source: 'gemnasium', file: 'gemnasium.db', table: 'gemnasium_advisories' }
]

const lines = []
const counts = {}
for (const { source, file, table } of SOURCES) {
    const db = new DatabaseSync(join(dataDir, file), { readOnly: true })
    const rows = db
        .prepare(`SELECT DISTINCT ecosystem, ranges_json, versions_json, malicious FROM ${table} WHERE withdrawn IS NULL ORDER BY ecosystem, ranges_json, versions_json, malicious`)
        .all()
    for (const row of rows) {
        lines.push(JSON.stringify({
            source,
            ecosystem: row.ecosystem,
            ranges: JSON.parse(row.ranges_json),
            versions: JSON.parse(row.versions_json),
            malicious: row.malicious === 1
        }))
        const key = source + '/' + row.ecosystem
        counts[key] = (counts[key] ?? 0) + 1
    }
    db.close()
}

writeFileSync(outPath, gzipSync(lines.join('\n') + '\n', { level: 9 }))
console.log(JSON.stringify({ outPath, records: lines.length, counts }))
