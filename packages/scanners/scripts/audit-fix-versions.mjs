// The fleet-wide re-check: does any active npm finding name a fix version npm never published? Reads a
// Sentinello database read-only, checks every distinct (package, fix_version) against the registry's
// version list, and reports the rows that name an unpublished one, by fix status:
//
//   released      — presented as "upgrade to X". The gate: there must be none (--assert-zero).
//   unverified    — the advisory's stated fix, labelled "not checked against the registry" everywhere.
//   none_released — never carries a version; counted for completeness.
//   legacy        — rows written before 3.7.0 (no fix status). The read model withholds their version
//                   ("rescan pending") until a scan settles them; their count is the before-and-after
//                   comparison with the 2026-10-03 baseline (35 tuples / 296 rows).
//
// Usage (Node 24, which ships node:sqlite):
//   node packages/scanners/scripts/audit-fix-versions.mjs --db <sentinello.sqlite> [--assert-zero] [--show <package>]...
//
//   --db           the database to read (opened read-only; never written)
//   --assert-zero  exit 1 when any released row names an unpublished version, or when one could not be checked
//   --show         also list every distinct (status, fix, range) of that package, e.g. --show qs
//
// The registry is SENTINELLO_NPM_REGISTRY_URL (default https://registry.npmjs.org), as for the worker.

/* global AbortSignal -- a Node 24 global; this package's lint config declares only the ones its library code uses */
import { DatabaseSync } from 'node:sqlite'
import { parseArgs } from 'node:util'

const STATUSES = ['released', 'unverified', 'none_released', 'legacy']
const CONCURRENCY = 8
const TIMEOUT_MS = 30_000

const { values } = parseArgs({
    options: {
        db: { type: 'string' },
        'assert-zero': { type: 'boolean', default: false },
        show: { type: 'string', multiple: true, default: [] }
    }
})
if (!values.db) {
    console.error('usage: audit-fix-versions.mjs --db <sentinello.sqlite> [--assert-zero] [--show <package>]...')
    process.exit(2)
}
const registry = (process.env.SENTINELLO_NPM_REGISTRY_URL || 'https://registry.npmjs.org').replace(/\/+$/, '')

const db = new DatabaseSync(values.db, { readOnly: true })
// A database still on a release before 3.7.0 has no fix_status column: every row in it is legacy.
const hasStatus = db.prepare("SELECT 1 FROM pragma_table_info('findings') WHERE name = 'fix_status'").get() !== undefined
const statusColumn = hasStatus ? "coalesce(fix_status, 'legacy')" : "'legacy'"
const rows = db.prepare(
    `SELECT ${statusColumn} AS status, scanner, package_name AS name, fix_version AS fix, vulnerable_range AS range, count(*) AS n
     FROM findings
     WHERE resolved_at IS NULL AND ecosystem = 'npm' AND fix_version IS NOT NULL
     GROUP BY 1, 2, 3, 4, 5`
).all()
db.close()

// One abbreviated packument per package: its version list is all this needs.
async function publishedVersions(name) {
    const url = registry + '/' + (name.startsWith('@') ? '@' + encodeURIComponent(name.slice(1)) : encodeURIComponent(name))
    try {
        const response = await fetch(url, { headers: { accept: 'application/vnd.npm.install-v1+json' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
        if (response.status === 404) {
            await response.body?.cancel()
            return { status: 'not_found' }
        }
        if (!response.ok) {
            await response.body?.cancel()
            return { status: 'error', reason: 'HTTP ' + response.status }
        }
        const body = await response.json()
        return { status: 'ok', versions: new Set(Object.keys(body.versions ?? {})) }
    } catch (err) {
        return { status: 'error', reason: err instanceof Error ? err.message : String(err) }
    }
}

const names = [...new Set(rows.map(function name(r) { return r.name }))].sort()
const answers = new Map()
let next = 0
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, names.length) }, async function worker() {
    for (let i = next++; i < names.length; i = next++) answers.set(names[i], await publishedVersions(names[i]))
}))

// A row's fix is published, unpublished, or could not be checked (the registry did not answer).
function verdictOf(row) {
    const answer = answers.get(row.name)
    if (answer.status === 'error') return 'unchecked'
    if (answer.status === 'not_found') return 'unpublished'
    return answer.versions.has(row.fix) ? 'published' : 'unpublished'
}

function tally() {
    return { tuples: 0, rows: 0 }
}
const byStatus = Object.fromEntries(STATUSES.map(function entry(s) { return [s, { all: tally(), unpublished: tally(), unchecked: tally() }] }))
const unpublishedSamples = []
const uncheckedReasons = new Map()
for (const row of rows) {
    const verdict = verdictOf(row)
    const bucket = byStatus[row.status] ?? (byStatus[row.status] = { all: tally(), unpublished: tally(), unchecked: tally() })
    bucket.all.tuples++
    bucket.all.rows += row.n
    if (verdict === 'published') continue
    bucket[verdict].tuples++
    bucket[verdict].rows += row.n
    if (verdict === 'unpublished') unpublishedSamples.push(row)
    else uncheckedReasons.set(row.name, answers.get(row.name).reason)
}

const total = rows.reduce(function sum(acc, r) { return { tuples: acc.tuples + 1, rows: acc.rows + r.n } }, tally())
const unpublishedAll = Object.values(byStatus).reduce(function sum(acc, b) { return { tuples: acc.tuples + b.unpublished.tuples, rows: acc.rows + b.unpublished.rows } }, tally())

console.log('database: ' + values.db + ' (read-only' + (hasStatus ? '' : '; schema before 3.7.0 — every row is legacy') + ')')
console.log('registry: ' + registry + ' · ' + names.length + ' packages checked on ' + new Date().toISOString())
console.log('active npm findings naming a fix version: ' + total.tuples + ' (scanner, package, fix, range) tuples, ' + total.rows + ' rows')
console.log('')
console.log('status          tuples    rows   unpublished tuples/rows   unchecked tuples/rows')
for (const [status, b] of Object.entries(byStatus)) {
    console.log(
        status.padEnd(14) + String(b.all.tuples).padStart(8) + String(b.all.rows).padStart(8) +
        (String(b.unpublished.tuples) + '/' + b.unpublished.rows).padStart(26) + (String(b.unchecked.tuples) + '/' + b.unchecked.rows).padStart(24)
    )
}
console.log('')
console.log('all stored fix versions not on the registry: ' + unpublishedAll.tuples + ' tuples / ' + unpublishedAll.rows + ' rows (2026-10-03 baseline: 35 tuples / 296 rows)')
if (unpublishedSamples.length > 0) {
    console.log('')
    console.log('unpublished, by status:')
    for (const r of unpublishedSamples.sort(function order(a, b) { return a.status.localeCompare(b.status) || b.n - a.n })) {
        console.log('  ' + r.status.padEnd(14) + r.scanner.padEnd(11) + r.name + ' ' + r.fix + '  (range ' + r.range + ', ' + r.n + ' rows)')
    }
}
if (uncheckedReasons.size > 0) {
    console.log('')
    console.log('not checked (the registry did not answer):')
    for (const [name, reason] of uncheckedReasons) console.log('  ' + name + ': ' + reason)
}
for (const name of values.show) {
    console.log('')
    console.log(name + ':')
    const mine = rows.filter(function of(r) { return r.name === name })
    if (mine.length === 0) console.log('  no active row names a fix version')
    for (const r of mine) console.log('  ' + r.status.padEnd(14) + r.scanner.padEnd(11) + r.fix + '  (range ' + r.range + ', ' + r.n + ' rows, ' + verdictOf(r) + ')')
}

const released = byStatus.released
console.log('')
console.log('unpublished fix versions: ' + released.unpublished.rows + (released.unchecked.rows > 0 ? ' (' + released.unchecked.rows + ' released rows could not be checked)' : ''))
if (values['assert-zero'] && (released.unpublished.rows > 0 || released.unchecked.rows > 0)) process.exit(1)
